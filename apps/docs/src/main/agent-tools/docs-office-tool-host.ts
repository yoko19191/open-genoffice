import { randomUUID } from 'node:crypto'
import type { OfficeToolInvocation, OfficeToolReceipt } from '@genoffice/agent-runtime-protocol'
import {
  DOCS_OFFICE_TOOL_DEFINITIONS,
  parseDocsOfficeToolInput,
} from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type { OpenedScopedImage } from '@genoffice/agent-resource'
import {
  OfficeToolBroker,
  type OfficeMutationBoundary,
  type OfficeToolDescriptor,
} from '@genoffice/electron-utils'
import type { DocsOfficeEditSnapshot, DocsOfficeImagePayload } from '../../shared/docs-office-tools'
import type { DocsOfficeToolRendererClient } from './renderer-client'

type RendererClient = Pick<DocsOfficeToolRendererClient, 'request'>

export interface DocsOfficeToolHostOptions {
  resolveRenderer(documentId: string): RendererClient | undefined
  validateBinding(request: OfficeToolInvocation): Promise<boolean>
  validatePermissionSnapshot(request: OfficeToolInvocation): Promise<boolean>
  authorizeMutationGrant(
    request: OfficeToolInvocation,
    descriptor: Extract<OfficeToolDescriptor, { effect: 'mutation' }>,
  ): Promise<boolean>
  openImage(input: {
    artifactId: string
    documentId: string
    runId: string
  }): Promise<OpenedScopedImage>
}

type SnapshotRecord = {
  documentId: string
  parentRunId: string
  snapshot: DocsOfficeEditSnapshot
}

function descriptor(toolId: string): OfficeToolDescriptor | undefined {
  const definition = DOCS_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  if (!definition) return undefined
  return definition.effect === 'mutation'
    ? { id: definition.id, effect: 'mutation', mutationBoundary: 'snapshot' }
    : { id: definition.id, effect: definition.effect, mutationBoundary: 'none' }
}

function parentRunId(request: OfficeToolInvocation): string {
  return request.actor.type === 'subagent' ? request.actor.parentRunId : request.runId
}

export class DocsOfficeToolHost {
  private readonly snapshots = new Map<string, SnapshotRecord>()
  private readonly abortedOperations = new Map<string, string>()
  private readonly broker: OfficeToolBroker

  constructor(private readonly options: DocsOfficeToolHostOptions) {
    this.broker = new OfficeToolBroker({
      resolveDescriptor: descriptor,
      validateBinding: (request) => this.options.validateBinding(request),
      validatePermissionSnapshot: (request) => this.options.validatePermissionSnapshot(request),
      authorizeActor: async (request, resolved) =>
        request.actor.type === 'parent' || resolved.effect !== 'external',
      authorizeMutationGrant: (request, resolved) =>
        this.options.authorizeMutationGrant(request, resolved),
      captureSnapshot: (request) => this.captureSnapshot(request),
      restoreSnapshot: (input) => this.restoreSnapshot(input),
      execute: (request, resolved, boundary) => this.execute(request, resolved, boundary),
    })
  }

  invoke(request: OfficeToolInvocation): Promise<OfficeToolReceipt> {
    if (!descriptor(request.toolId)) return this.broker.invoke(request)
    try {
      parseDocsOfficeToolInput(request.toolId, request.input)
    } catch {
      return Promise.resolve(this.failedReceipt(request, 'invalid_tool_arguments'))
    }
    return this.broker.invoke(request)
  }

  rollback(documentId: string, runId: string): Promise<boolean> {
    return this.broker.rollback(documentId, runId)
  }

  async abort(input: { operationId: string; documentId: string }): Promise<boolean> {
    this.abortedOperations.set(input.operationId, input.documentId)
    const renderer = this.options.resolveRenderer(input.documentId)
    if (!renderer) return false
    const response = await renderer.request({
      kind: 'abort',
      operationId: input.operationId,
      documentId: input.documentId,
    })
    return response.ok && response.result.kind === 'aborted' && response.result.aborted
  }

  private renderer(documentId: string): RendererClient {
    const renderer = this.options.resolveRenderer(documentId)
    if (!renderer) throw new Error('executor_unavailable')
    return renderer
  }

  private async captureSnapshot(
    request: OfficeToolInvocation,
  ): Promise<{ kind: 'snapshot'; snapshotId: string }> {
    const response = await this.renderer(request.documentId).request({
      kind: 'capture_snapshot',
      documentId: request.documentId,
    })
    if (!response.ok || response.result.kind !== 'snapshot') {
      throw new Error('executor_unavailable')
    }
    const snapshotId = randomUUID()
    this.snapshots.set(snapshotId, {
      documentId: request.documentId,
      parentRunId: parentRunId(request),
      snapshot: response.result.snapshot,
    })
    return { kind: 'snapshot', snapshotId }
  }

  private async restoreSnapshot(input: {
    documentId: string
    parentRunId: string
    boundary: OfficeMutationBoundary
  }): Promise<void> {
    if (input.boundary.kind !== 'snapshot') throw new Error('unsupported_office_feature')
    const record = this.snapshots.get(input.boundary.snapshotId)
    if (
      !record ||
      record.documentId !== input.documentId ||
      record.parentRunId !== input.parentRunId
    ) {
      throw new Error('executor_unavailable')
    }
    const response = await this.renderer(input.documentId).request({
      kind: 'restore_snapshot',
      documentId: input.documentId,
      snapshot: record.snapshot,
    })
    if (!response.ok || response.result.kind !== 'restored') {
      throw new Error('executor_unavailable')
    }
    this.snapshots.delete(input.boundary.snapshotId)
  }

  private async execute(
    request: OfficeToolInvocation,
    resolved: OfficeToolDescriptor,
    boundary?: OfficeMutationBoundary,
  ) {
    if (this.abortedOperations.get(request.operationId) === request.documentId) {
      this.abortedOperations.delete(request.operationId)
      return {
        output: '',
        errorCode: 'tool_failed' as const,
        ...(resolved.effect === 'mutation' ? { mutationOutcome: 'not_started' as const } : {}),
      }
    }
    try {
      return await this.executeUnaborted(request, resolved, boundary)
    } finally {
      this.abortedOperations.delete(request.operationId)
    }
  }

  private async executeUnaborted(
    request: OfficeToolInvocation,
    resolved: OfficeToolDescriptor,
    boundary?: OfficeMutationBoundary,
  ) {
    let image: DocsOfficeImagePayload | undefined
    if (request.toolId === 'office:docs:insert_image') {
      try {
        const input = request.input as { artifactId: string }
        const opened = await this.options.openImage({
          artifactId: input.artifactId,
          documentId: request.documentId,
          runId: request.runId,
        })
        image = {
          bytes: opened.bytes,
          mediaType: opened.artifact.mediaType,
          width: opened.width,
          height: opened.height,
          sha256: opened.artifact.sha256,
        }
      } catch {
        if (boundary?.kind === 'snapshot') this.snapshots.delete(boundary.snapshotId)
        return {
          output: '',
          errorCode: 'artifact_invalid' as const,
          mutationOutcome: 'not_started' as const,
        }
      }
    }

    const renderer = this.renderer(request.documentId)
    const response = await renderer.request({
      kind: 'execute',
      operationId: request.operationId,
      documentId: request.documentId,
      toolId: request.toolId,
      input: request.input,
      ...(request.contextVersion ? { contextVersion: request.contextVersion } : {}),
      ...(image ? { image } : {}),
    })
    if (!response.ok) {
      if (
        resolved.effect === 'mutation' &&
        boundary?.kind === 'snapshot' &&
        response.mutationOutcome === 'not_started'
      ) {
        this.snapshots.delete(boundary.snapshotId)
      }
      return {
        output: '',
        errorCode: response.errorCode,
        ...(response.mutationOutcome ? { mutationOutcome: response.mutationOutcome } : {}),
      }
    }
    if (response.result.kind !== 'executed') throw new Error('executor_unavailable')
    let contextSnapshot
    if (resolved.effect === 'read') {
      const context = await renderer.request({ kind: 'context', documentId: request.documentId })
      if (!context.ok || context.result.kind !== 'context') throw new Error('executor_unavailable')
      contextSnapshot = context.result.snapshot
    }
    if (
      resolved.effect === 'mutation' &&
      boundary?.kind === 'snapshot' &&
      response.result.mutationOutcome !== 'committed'
    ) {
      this.snapshots.delete(boundary.snapshotId)
    }
    const executorDetails =
      typeof response.result.details === 'object' && response.result.details !== null
        ? response.result.details
        : {}
    return {
      output: contextSnapshot
        ? `${contextSnapshot.modelContent}\n\n${response.result.output}`
        : response.result.output,
      ...(contextSnapshot
        ? { details: { ...executorDetails, context: contextSnapshot.details } }
        : response.result.details === undefined
          ? {}
          : { details: response.result.details }),
      contextVersionAfter: contextSnapshot
        ? contextSnapshot.contextVersion
        : response.result.contextVersionAfter,
      ...(response.result.mutationOutcome
        ? { mutationOutcome: response.result.mutationOutcome }
        : {}),
    }
  }

  private failedReceipt(
    request: OfficeToolInvocation,
    errorCode: NonNullable<OfficeToolReceipt['errorCode']>,
  ): OfficeToolReceipt {
    const isMutation = descriptor(request.toolId)?.effect === 'mutation'
    return {
      operationId: request.operationId,
      toolCallId: request.toolCallId,
      toolId: request.toolId,
      status: 'failed',
      output: '',
      ...(isMutation ? { mutationOutcome: 'not_started' as const } : {}),
      errorCode,
      provenance: {
        actorId: request.actor.actorId,
        runId: request.runId,
        documentId: request.documentId,
        ...(request.mutationGrantId ? { mutationGrantId: request.mutationGrantId } : {}),
      },
    }
  }
}
