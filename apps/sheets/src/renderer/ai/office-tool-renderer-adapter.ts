import { SHEETS_OFFICE_TOOL_DEFINITIONS } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type {
  SheetsOfficeContextSnapshot,
  SheetsOfficeEditSnapshot,
  SheetsOfficeImagePayload,
  SheetsOfficeToolRequest,
  SheetsOfficeToolResponse,
} from '../../shared/sheets-office-tools'
import type { WorkbookArtifactImage, ToolExecution } from './tools'

export interface SheetsOfficeToolRendererDependencies {
  contextVersion(): string
  advanceContextVersion(): string
  contextContent(): string
  contextDetails(): SheetsOfficeContextSnapshot['details']
  undoMutations(count: number): Promise<void>
  execute(
    modelAlias: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    artifactImages: ReadonlyMap<string, WorkbookArtifactImage>,
  ): Promise<ToolExecution>
  randomUUID?(): string
}

type SnapshotState = {
  mutationCount: number
  expectedContextVersion: string
}

function dataUrl(image: SheetsOfficeImagePayload): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < image.bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...image.bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${image.mediaType};base64,${btoa(binary)}`
}

function artifactImages(
  images: readonly SheetsOfficeImagePayload[] | undefined,
): ReadonlyMap<string, WorkbookArtifactImage> {
  return new Map(
    (images ?? []).map((image) => [
      image.artifactId,
      {
        dataUrl: dataUrl(image),
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
      },
    ]),
  )
}

export function createSheetsOfficeToolRendererHandler(
  dependencies: SheetsOfficeToolRendererDependencies,
): (request: SheetsOfficeToolRequest) => Promise<SheetsOfficeToolResponse> {
  const active = new Map<string, AbortController>()
  const snapshots = new Map<string, SnapshotState>()
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())

  return async (request) => {
    if (request.kind === 'context') {
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId: request.documentId,
            contextVersion: dependencies.contextVersion(),
            modelContent: dependencies.contextContent(),
            details: dependencies.contextDetails(),
          },
        },
      }
    }
    if (request.kind === 'capture_snapshot') {
      const snapshot: SheetsOfficeEditSnapshot = { token: randomUUID() }
      snapshots.set(snapshot.token, {
        mutationCount: 0,
        expectedContextVersion: dependencies.contextVersion(),
      })
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'snapshot', snapshot },
      }
    }
    if (request.kind === 'restore_snapshot') {
      const snapshot = snapshots.get(request.snapshot.token)
      if (!snapshot) {
        return { requestId: request.requestId, ok: false, errorCode: 'executor_unavailable' }
      }
      if (snapshot.expectedContextVersion !== dependencies.contextVersion()) {
        return { requestId: request.requestId, ok: false, errorCode: 'stale_context' }
      }
      try {
        await dependencies.undoMutations(snapshot.mutationCount)
        snapshots.delete(request.snapshot.token)
        return {
          requestId: request.requestId,
          ok: true,
          result: { kind: 'restored', contextVersion: dependencies.advanceContextVersion() },
        }
      } catch {
        return { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }
      }
    }
    if (request.kind === 'abort') {
      const controller = active.get(request.operationId)
      controller?.abort()
      return {
        requestId: request.requestId,
        ok: true,
        result: { kind: 'aborted', aborted: controller !== undefined },
      }
    }

    const definition = SHEETS_OFFICE_TOOL_DEFINITIONS.find(({ id }) => id === request.toolId)
    if (!definition) {
      return { requestId: request.requestId, ok: false, errorCode: 'unsupported_office_feature' }
    }
    if (
      definition.effect === 'mutation' &&
      (!request.contextVersion || request.contextVersion !== dependencies.contextVersion())
    ) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    }
    const snapshot = request.snapshot ? snapshots.get(request.snapshot.token) : undefined
    if (definition.effect === 'mutation' && !snapshot) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'executor_unavailable',
        mutationOutcome: 'not_started',
      }
    }
    if (snapshot && snapshot.expectedContextVersion !== dependencies.contextVersion()) {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    }

    const controller = new AbortController()
    active.set(request.operationId, controller)
    try {
      const executed = await dependencies.execute(
        definition.modelAlias,
        request.input as Record<string, unknown>,
        controller.signal,
        artifactImages(request.images),
      )
      if (executed.isError) {
        return {
          requestId: request.requestId,
          ok: false,
          errorCode: 'tool_failed',
          ...(definition.effect === 'mutation'
            ? { mutationOutcome: executed.mutationOutcome ?? ('not_started' as const) }
            : {}),
        }
      }
      const contextVersionAfter = executed.mutated
        ? dependencies.advanceContextVersion()
        : dependencies.contextVersion()
      if (executed.mutated && snapshot) {
        snapshot.mutationCount += 1
        snapshot.expectedContextVersion = contextVersionAfter
      }
      return {
        requestId: request.requestId,
        ok: true,
        result: {
          kind: 'executed',
          output: executed.output,
          details: { summary: executed.summary },
          contextVersionAfter,
          ...(executed.mutated ? { mutationOutcome: 'committed' as const } : {}),
        },
      }
    } catch {
      return {
        requestId: request.requestId,
        ok: false,
        errorCode: 'tool_failed',
        ...(definition.effect === 'mutation' ? { mutationOutcome: 'unknown' as const } : {}),
      }
    } finally {
      active.delete(request.operationId)
    }
  }
}
