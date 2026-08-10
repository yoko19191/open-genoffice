import type {
  AgentSessionCommand,
  AgentSessionConnectReceipt,
  EventEnvelope,
  SessionAbortReceipt,
  SessionForkReceipt,
  SessionNavigateReceipt,
  SessionPromptReceipt,
  SessionSubagentResumeReceipt,
  SessionMutationGrantReceipt,
  OfficeRollbackReceipt,
} from '@genoffice/agent-runtime-protocol'
import {
  applyAgentSessionEvent,
  restoreAgentSessionProjection,
  type AgentSessionProjection,
} from './agent-session-projection'

export interface AgentSessionClient {
  documentId(): Promise<string>
  connect(input: { documentId: string; afterCursor?: string }): Promise<AgentSessionConnectReceipt>
  command(
    command: AgentSessionCommand,
  ): Promise<
    | SessionPromptReceipt
    | SessionAbortReceipt
    | SessionSubagentResumeReceipt
    | SessionMutationGrantReceipt
    | OfficeRollbackReceipt
    | SessionForkReceipt
    | SessionNavigateReceipt
  >
  disconnect(): void
  onEvent(handler: (event: EventEnvelope) => void): () => void
}

export type AgentSessionControllerOptions = {
  randomUUID?: () => string
}

/**
 * Renderer-side owner of the narrow Agent Session bridge.
 *
 * The Runtime snapshot and event journal remain authoritative. This controller keeps no local
 * transcript and deliberately subscribes before the connect handshake so an event cannot fall
 * into the snapshot/subscription gap.
 */
export class AgentSessionController {
  private projection: AgentSessionProjection | undefined
  private readonly listeners = new Set<(projection: AgentSessionProjection) => void>()
  private queuedEvents: EventEnvelope[] | undefined
  private removeEventListener: (() => void) | undefined
  private readonly randomUUID: () => string

  constructor(
    private readonly client: AgentSessionClient,
    options: AgentSessionControllerOptions = {},
  ) {
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
  }

  snapshot(): AgentSessionProjection | undefined {
    return this.projection
  }

  subscribe(listener: (projection: AgentSessionProjection) => void): () => void {
    this.listeners.add(listener)
    if (this.projection) listener(this.projection)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<AgentSessionProjection> {
    this.removeEventListener ??= this.client.onEvent((event) => this.receive(event))
    const documentId = await this.client.documentId()
    const previous = this.projection
    this.queuedEvents = []
    let receipt: AgentSessionConnectReceipt
    try {
      receipt = await this.client.connect({
        documentId,
        ...(previous ? { afterCursor: previous.cursor } : {}),
      })
    } catch (error) {
      this.queuedEvents = undefined
      throw error
    }
    if (previous && receipt.snapshot.lastSequence < previous.lastSequence) {
      this.queuedEvents = undefined
      throw new Error('agent_session_snapshot_stale')
    }

    let projection = restoreAgentSessionProjection(receipt)
    for (const event of this.queuedEvents) {
      if (event.sequence > projection.lastSequence) {
        projection = applyAgentSessionEvent(projection, event)
      }
    }
    this.queuedEvents = undefined
    this.projection = projection
    this.emit()
    return projection
  }

  async prompt(text: string): Promise<SessionPromptReceipt> {
    const projection = this.requireProjection()
    const instruction = text.trim()
    if (!instruction) throw new Error('agent_prompt_empty')
    return (await this.client.command({
      type: 'prompt',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      text: instruction,
    })) as SessionPromptReceipt
  }

  async abort(): Promise<SessionAbortReceipt> {
    const projection = this.requireProjection()
    const activeRun = projection.activeRun
    if (
      !activeRun ||
      (activeRun.state !== 'queued' &&
        activeRun.state !== 'running' &&
        activeRun.state !== 'cancelling')
    ) {
      throw new Error('agent_run_not_active')
    }
    return (await this.client.command({
      type: 'abort',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      runId: activeRun.runId,
    })) as SessionAbortReceipt
  }

  async resumeSubagent(runId: string): Promise<SessionSubagentResumeReceipt> {
    const projection = this.requireProjection()
    const child = projection.subagents.find((candidate) => candidate.runId === runId)
    if (!child || child.status !== 'resumable') {
      throw new Error('subagent_run_not_resumable')
    }
    return (await this.client.command({
      type: 'resumeSubagent',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      runId,
    })) as SessionSubagentResumeReceipt
  }

  async grantMutation(requestId: string): Promise<SessionMutationGrantReceipt> {
    const projection = this.requireProjection()
    const request = projection.mutationGrants.find(
      (candidate) => candidate.requestId === requestId && candidate.status === 'pending',
    )
    if (!request) throw new Error('mutation_grant_request_not_pending')
    return (await this.client.command({
      type: 'grantMutation',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      requestId: request.requestId,
      subagentRunId: request.subagentRunId,
      exactToolIds: [...request.exactToolIds],
    })) as SessionMutationGrantReceipt
  }

  async denyMutation(requestId: string): Promise<SessionMutationGrantReceipt> {
    const projection = this.requireProjection()
    const request = projection.mutationGrants.find(
      (candidate) => candidate.requestId === requestId && candidate.status === 'pending',
    )
    if (!request) throw new Error('mutation_grant_request_not_pending')
    return (await this.client.command({
      type: 'denyMutation',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      requestId: request.requestId,
    })) as SessionMutationGrantReceipt
  }

  async revokeMutation(grantId: string): Promise<SessionMutationGrantReceipt> {
    const projection = this.requireProjection()
    const grant = projection.mutationGrants.find(
      (candidate) => candidate.grantId === grantId && candidate.status === 'active',
    )
    if (!grant) throw new Error('mutation_grant_not_active')
    return (await this.client.command({
      type: 'revokeMutation',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      grantId,
    })) as SessionMutationGrantReceipt
  }

  async rollbackLastRun(): Promise<OfficeRollbackReceipt> {
    const projection = this.requireProjection()
    const runId = projection.rollbackRunId
    if (!runId) throw new Error('office_rollback_unavailable')
    const receipt = (await this.client.command({
      type: 'rollbackRun',
      operationId: this.randomUUID(),
      sessionId: projection.sessionId,
      documentId: projection.documentId,
      runId,
    })) as OfficeRollbackReceipt
    if (receipt.rolledBack) {
      this.projection = { ...projection, rollbackRunId: undefined }
      this.emit()
    }
    return receipt
  }

  disconnect(): void {
    this.removeEventListener?.()
    this.removeEventListener = undefined
    this.queuedEvents = undefined
    this.projection = undefined
    this.client.disconnect()
  }

  private receive(event: EventEnvelope): void {
    if (this.queuedEvents) {
      this.queuedEvents.push(event)
      return
    }
    if (!this.projection || event.sequence <= this.projection.lastSequence) return
    this.projection = applyAgentSessionEvent(this.projection, event)
    this.emit()
  }

  private requireProjection(): AgentSessionProjection {
    if (!this.projection) throw new Error('agent_session_not_connected')
    return this.projection
  }

  private emit(): void {
    if (!this.projection) return
    for (const listener of this.listeners) listener(this.projection)
  }
}
