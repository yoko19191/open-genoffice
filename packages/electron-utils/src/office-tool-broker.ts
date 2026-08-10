import { createHash } from 'node:crypto'
import type {
  OfficeToolInvocation as ProtocolOfficeToolInvocation,
  OfficeToolReceipt as ProtocolOfficeToolReceipt,
} from '@genoffice/agent-runtime-protocol'

export type OfficeToolInvocation = ProtocolOfficeToolInvocation
export type OfficeToolReceipt = ProtocolOfficeToolReceipt
export type OfficeToolActor = OfficeToolInvocation['actor']
export type OfficePermissionSnapshot = OfficeToolInvocation['permissionSnapshot']
export type OfficeMutationOutcome = NonNullable<OfficeToolReceipt['mutationOutcome']>

export type OfficeToolDescriptor =
  | { id: string; effect: 'read'; mutationBoundary: 'none' }
  | { id: string; effect: 'mutation'; mutationBoundary: 'snapshot' | 'atomic' }

export type OfficeMutationBoundary = { kind: 'snapshot'; snapshotId: string } | { kind: 'atomic' }

export type OfficeToolBrokerDependencies = {
  resolveDescriptor(toolId: string): OfficeToolDescriptor | undefined
  validateBinding(request: OfficeToolInvocation): Promise<boolean>
  validatePermissionSnapshot(
    request: OfficeToolInvocation,
    descriptor: OfficeToolDescriptor,
  ): Promise<boolean>
  authorizeActor(request: OfficeToolInvocation, descriptor: OfficeToolDescriptor): Promise<boolean>
  authorizeMutationGrant(
    request: OfficeToolInvocation,
    descriptor: Extract<OfficeToolDescriptor, { effect: 'mutation' }>,
  ): Promise<boolean>
  captureSnapshot(request: OfficeToolInvocation): Promise<{ kind: 'snapshot'; snapshotId: string }>
  execute(
    request: OfficeToolInvocation,
    descriptor: OfficeToolDescriptor,
    boundary?: OfficeMutationBoundary,
  ): Promise<{
    output: string
    details?: unknown
    mutationOutcome?: OfficeMutationOutcome
  }>
}

type OperationEntry = { hash: string; result: Promise<OfficeToolReceipt> }

export class OfficeToolBrokerError extends Error {
  constructor(
    public readonly code:
      | 'document_mismatch'
      | 'tool_not_in_snapshot'
      | 'permission_denied'
      | 'duplicate_operation_mismatch',
  ) {
    super(code)
    this.name = 'OfficeToolBrokerError'
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`
}

function requestHash(request: OfficeToolInvocation): string {
  return createHash('sha256').update(canonicalize(request)).digest('hex')
}

export class OfficeToolBroker {
  private readonly operations = new Map<string, OperationEntry>()
  private readonly documentTails = new Map<string, Promise<void>>()
  private readonly mutationBoundaries = new Map<string, Promise<OfficeMutationBoundary>>()
  private readonly blockedDocuments = new Set<string>()

  constructor(private readonly dependencies: OfficeToolBrokerDependencies) {}

  invoke(request: OfficeToolInvocation): Promise<OfficeToolReceipt> {
    const hash = requestHash(request)
    const existing = this.operations.get(request.operationId)
    if (existing) {
      if (existing.hash !== hash) throw new OfficeToolBrokerError('duplicate_operation_mismatch')
      return existing.result
    }

    const descriptor = this.dependencies.resolveDescriptor(request.toolId)
    const result = descriptor
      ? descriptor.effect === 'mutation'
        ? this.enqueueMutation(request.documentId, () => this.execute(request, descriptor))
        : this.execute(request, descriptor)
      : Promise.reject(new OfficeToolBrokerError('tool_not_in_snapshot'))
    this.operations.set(request.operationId, { hash, result })
    return result
  }

  private enqueueMutation(
    documentId: string,
    execute: () => Promise<OfficeToolReceipt>,
  ): Promise<OfficeToolReceipt> {
    const previous = this.documentTails.get(documentId) ?? Promise.resolve()
    const result = previous.then(execute)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.documentTails.set(documentId, tail)
    void tail.then(() => {
      if (this.documentTails.get(documentId) === tail) this.documentTails.delete(documentId)
    })
    return result
  }

  private async execute(
    request: OfficeToolInvocation,
    descriptor: OfficeToolDescriptor,
  ): Promise<OfficeToolReceipt> {
    await this.revalidate(request, descriptor)
    if (descriptor.effect === 'mutation' && this.blockedDocuments.has(request.documentId)) {
      return this.receipt(request, {
        status: 'failed',
        output: '',
        mutationOutcome: 'not_started',
        errorCode: 'mutation_outcome_unknown',
      })
    }

    let boundary: OfficeMutationBoundary | undefined
    if (descriptor.effect === 'mutation') {
      if (descriptor.mutationBoundary === 'snapshot') {
        try {
          boundary = await this.snapshotBoundary(request)
        } catch {
          return this.receipt(request, {
            status: 'failed',
            output: '',
            mutationOutcome: 'not_started',
            errorCode: 'tool_failed',
          })
        }
      } else {
        boundary = { kind: 'atomic' }
      }
    }

    try {
      const executed = await this.dependencies.execute(request, descriptor, boundary)
      if (descriptor.effect === 'read') {
        return this.receipt(request, { status: 'completed', ...executed })
      }
      const mutationOutcome = executed.mutationOutcome ?? 'unknown'
      if (mutationOutcome === 'unknown') this.blockedDocuments.add(request.documentId)
      return this.receipt(request, {
        status: mutationOutcome === 'unknown' ? 'failed' : 'completed',
        ...executed,
        mutationOutcome,
        ...(mutationOutcome === 'unknown' ? { errorCode: 'mutation_outcome_unknown' } : {}),
      })
    } catch {
      if (descriptor.effect === 'mutation') {
        this.blockedDocuments.add(request.documentId)
        return this.receipt(request, {
          status: 'failed',
          output: '',
          mutationOutcome: 'unknown',
          errorCode: 'mutation_outcome_unknown',
        })
      }
      return this.receipt(request, { status: 'failed', output: '', errorCode: 'tool_failed' })
    }
  }

  private async revalidate(
    request: OfficeToolInvocation,
    descriptor: OfficeToolDescriptor,
  ): Promise<void> {
    if (!(await this.dependencies.validateBinding(request))) {
      throw new OfficeToolBrokerError('document_mismatch')
    }
    const subagentMutation = request.actor.type === 'subagent' && descriptor.effect === 'mutation'
    if (
      descriptor.id !== request.toolId ||
      request.permissionSnapshot.createdForRunId !== request.runId
    ) {
      throw new OfficeToolBrokerError('tool_not_in_snapshot')
    }
    if (subagentMutation) {
      if (
        request.permissionSnapshot.toolIds.includes(request.toolId) ||
        request.mutationGrantId === undefined ||
        !(await this.dependencies.authorizeMutationGrant(request, descriptor))
      ) {
        throw new OfficeToolBrokerError('permission_denied')
      }
    } else if (
      request.mutationGrantId !== undefined ||
      !request.permissionSnapshot.toolIds.includes(request.toolId)
    ) {
      throw new OfficeToolBrokerError(
        request.mutationGrantId === undefined ? 'tool_not_in_snapshot' : 'permission_denied',
      )
    }
    if (!(await this.dependencies.validatePermissionSnapshot(request, descriptor))) {
      throw new OfficeToolBrokerError('permission_denied')
    }
    if (!(await this.dependencies.authorizeActor(request, descriptor))) {
      throw new OfficeToolBrokerError('permission_denied')
    }
  }

  private snapshotBoundary(request: OfficeToolInvocation): Promise<OfficeMutationBoundary> {
    const parentRunId =
      request.actor.type === 'subagent' ? request.actor.parentRunId : request.runId
    const key = `${request.documentId}:${parentRunId}`
    const existing = this.mutationBoundaries.get(key)
    if (existing) return existing
    const created = this.dependencies.captureSnapshot(request)
    this.mutationBoundaries.set(key, created)
    void created.catch(() => {
      if (this.mutationBoundaries.get(key) === created) this.mutationBoundaries.delete(key)
    })
    return created
  }

  private receipt(
    request: OfficeToolInvocation,
    result: Omit<OfficeToolReceipt, 'operationId' | 'toolCallId' | 'toolId' | 'provenance'>,
  ): OfficeToolReceipt {
    return {
      operationId: request.operationId,
      toolCallId: request.toolCallId,
      toolId: request.toolId,
      ...result,
      provenance: {
        actorId: request.actor.actorId,
        runId: request.runId,
        documentId: request.documentId,
        ...(request.mutationGrantId === undefined
          ? {}
          : { mutationGrantId: request.mutationGrantId }),
      },
    }
  }
}
