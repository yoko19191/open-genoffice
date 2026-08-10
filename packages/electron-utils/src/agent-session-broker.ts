import type {
  AgentSessionCommand,
  AgentSessionConnectReceipt,
  AgentSessionConnectRequest,
  EventEnvelope,
  SessionConnectionReceipt,
  SessionAbortReceipt,
  SessionForkReceipt,
  SessionNavigateReceipt,
  SessionPromptReceipt,
  SessionSubagentResumeReceipt,
  SessionMutationGrantReceipt,
  SessionSubscriptionReceipt,
  MutationGrantReceipt,
  OfficeToolCatalogBinding,
  OfficeRollbackReceipt,
} from '@genoffice/agent-runtime-protocol'

export type AgentSessionTransport = {
  createSession(input: {
    operationId: string
    documentId: string
    officeToolCatalog?: OfficeToolCatalogBinding
  }): Promise<SessionConnectionReceipt>
  openSession(input: {
    operationId: string
    sessionId: string
    documentId: string
    officeToolCatalog?: OfficeToolCatalogBinding
  }): Promise<SessionConnectionReceipt>
  subscribeSession(input: {
    sessionId: string
    documentId: string
    afterCursor?: string
  }): Promise<SessionSubscriptionReceipt>
  promptSession(input: {
    operationId: string
    sessionId: string
    documentId: string
    text: string
    projectRoot?: string
  }): Promise<SessionPromptReceipt>
  abortSession(input: {
    operationId: string
    sessionId: string
    documentId: string
    runId: string
  }): Promise<SessionAbortReceipt>
  resumeSubagent(input: {
    operationId: string
    sessionId: string
    documentId: string
    runId: string
  }): Promise<SessionSubagentResumeReceipt>
  issueMutationGrant(input: {
    operationId: string
    sessionId: string
    documentId: string
    requestId: string
    receipt: MutationGrantReceipt
  }): Promise<SessionMutationGrantReceipt>
  denyMutationGrant(input: {
    operationId: string
    sessionId: string
    documentId: string
    requestId: string
    userActionId: string
  }): Promise<SessionMutationGrantReceipt>
  revokeMutationGrant(input: {
    operationId: string
    sessionId: string
    documentId: string
    grantId: string
    userActionId: string
  }): Promise<SessionMutationGrantReceipt>
  revokeDocumentMutationGrants(input: {
    operationId: string
    sessionId: string
    documentId: string
  }): Promise<{ revoked: true }>
  forkSession(input: {
    operationId: string
    sessionId: string
    documentId: string
  }): Promise<SessionForkReceipt>
  navigateSession(input: {
    operationId: string
    sessionId: string
    documentId: string
    targetEntryId: string
  }): Promise<SessionNavigateReceipt>
  onSessionEvent(listener: (event: EventEnvelope) => void): (() => void) | Promise<() => void>
}

export type AgentSessionBrokerOptions<ClientId> = {
  authorize(clientId: ClientId, documentId: string): boolean | Promise<boolean>
  randomUUID: () => string
  resolveProjectRoot?: (documentId: string) => Promise<string | undefined>
  resolveOfficeToolCatalog?: (
    clientId: ClientId,
    documentId: string,
  ) => OfficeToolCatalogBinding | undefined | Promise<OfficeToolCatalogBinding | undefined>
  replayWindowSize?: number
  currentSessions?: {
    resolveCurrent(documentId: string, create: () => Promise<string>): Promise<string>
    assertCurrent(documentId: string, sessionId: string): Promise<unknown>
    advanceCurrent(
      documentId: string,
      expectedSessionId: string,
      sessionId: string,
    ): Promise<unknown>
  }
  now?: () => Date
  mutationGrantTtlMs?: number
  trustedGestureTtlMs?: number
  rollbackRun?: (documentId: string, runId: string) => Promise<boolean>
}

type SessionStream = {
  documentId: string
  events: EventEnvelope[]
  eventIds: Set<string>
  highestSequence?: number
  gapDetected: boolean
}

type RendererConnection<ClientId> = {
  clientId: ClientId
  sessionId: string
  documentId: string
  nextSequence: number
  deliver: (event: EventEnvelope) => void
}

function compareEvents(left: EventEnvelope, right: EventEnvelope): number {
  return left.sequence - right.sequence
}

export class AgentSessionBroker<ClientId = number> {
  private readonly connections = new Map<ClientId, RendererConnection<ClientId>>()
  private readonly streams = new Map<string, SessionStream>()
  private readonly replayWindowSize: number
  private listenPromise: Promise<void> | undefined
  private unsubscribe: (() => void) | undefined
  private readonly now: () => Date
  private readonly mutationGrantTtlMs: number
  private readonly trustedGestureTtlMs: number
  private readonly trustedGestures = new Map<
    ClientId,
    { userActionId: string; expiresAt: number }
  >()
  private readonly activeMutationGrants = new Map<string, MutationGrantReceipt>()

  constructor(
    private readonly transport: AgentSessionTransport,
    private readonly options: AgentSessionBrokerOptions<ClientId>,
  ) {
    this.replayWindowSize = Math.max(1, options.replayWindowSize ?? 512)
    this.now = options.now ?? (() => new Date())
    this.mutationGrantTtlMs = Math.max(1_000, options.mutationGrantTtlMs ?? 5 * 60 * 1_000)
    this.trustedGestureTtlMs = Math.max(100, options.trustedGestureTtlMs ?? 1_500)
  }

  recordTrustedUserGesture(clientId: ClientId, input: { type: string; key?: string }): void {
    const activates =
      input.type === 'mouseUp' ||
      (input.type === 'keyUp' && (input.key === 'Enter' || input.key === ' '))
    if (!activates) return
    this.trustedGestures.set(clientId, {
      userActionId: this.options.randomUUID(),
      expiresAt: this.now().getTime() + this.trustedGestureTtlMs,
    })
  }

  async connect(
    clientId: ClientId,
    request: AgentSessionConnectRequest,
    deliver: (event: EventEnvelope) => void,
  ): Promise<AgentSessionConnectReceipt> {
    if (!(await this.options.authorize(clientId, request.documentId))) {
      throw new Error('document_access_denied')
    }

    await this.ensureListening()
    this.disconnect(clientId)
    const opened = await this.openCurrentSession(clientId, request)
    this.assertBinding(opened, opened.sessionId, request.documentId)

    const subscription = await this.transport.subscribeSession({
      sessionId: opened.sessionId,
      documentId: request.documentId,
      ...(request.afterCursor ? { afterCursor: request.afterCursor } : {}),
    })
    this.assertBinding(subscription.snapshot, opened.sessionId, request.documentId)

    const stream = this.streamFor(opened.sessionId, request.documentId)
    let currentSubscription = subscription
    let events = this.eventsAfterSnapshot(currentSubscription, stream)
    const gapDetected =
      stream.gapDetected || !this.isContinuous(subscription.snapshot.lastSequence, events)
    if (gapDetected && !currentSubscription.resetRequired) {
      currentSubscription = await this.transport.subscribeSession({
        sessionId: opened.sessionId,
        documentId: request.documentId,
      })
      this.assertBinding(currentSubscription.snapshot, opened.sessionId, request.documentId)
      events = this.eventsAfterSnapshot(currentSubscription, stream)
    }
    const remainingGap = !this.isContinuous(currentSubscription.snapshot.lastSequence, events)
    const resetRequired = currentSubscription.resetRequired || gapDetected || remainingGap
    const acceptedEvents = remainingGap ? [] : events
    const connectionId = this.options.randomUUID()
    this.connections.set(clientId, {
      clientId,
      sessionId: opened.sessionId,
      documentId: request.documentId,
      nextSequence:
        (acceptedEvents.at(-1)?.sequence ?? currentSubscription.snapshot.lastSequence) + 1,
      deliver,
    })
    if (!remainingGap) {
      stream.gapDetected = false
      stream.highestSequence = Math.max(
        stream.highestSequence ?? 0,
        acceptedEvents.at(-1)?.sequence ?? currentSubscription.snapshot.lastSequence,
      )
    }

    return {
      connectionId,
      sessionId: opened.sessionId,
      documentId: request.documentId,
      resetRequired,
      snapshot: currentSubscription.snapshot,
      events: acceptedEvents,
    }
  }

  async command(
    clientId: ClientId,
    command: AgentSessionCommand,
  ): Promise<
    | SessionPromptReceipt
    | SessionAbortReceipt
    | SessionSubagentResumeReceipt
    | SessionMutationGrantReceipt
    | OfficeRollbackReceipt
    | SessionForkReceipt
    | SessionNavigateReceipt
  > {
    if (!(await this.options.authorize(clientId, command.documentId))) {
      throw new Error('document_access_denied')
    }
    const connection = this.connections.get(clientId)
    if (
      !connection ||
      connection.sessionId !== command.sessionId ||
      connection.documentId !== command.documentId
    ) {
      throw new Error('agent_session_not_connected')
    }
    await this.options.currentSessions?.assertCurrent(command.documentId, command.sessionId)
    if (command.type === 'prompt') {
      const projectRoot = await this.options.resolveProjectRoot?.(command.documentId)
      return this.transport.promptSession({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        text: command.text,
        ...(projectRoot ? { projectRoot } : {}),
      })
    }
    if (command.type === 'abort') {
      return this.transport.abortSession({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        runId: command.runId,
      })
    }
    if (command.type === 'resumeSubagent') {
      return this.transport.resumeSubagent({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        runId: command.runId,
      })
    }
    if (command.type === 'grantMutation') {
      const userActionId = this.consumeTrustedUserGesture(clientId)
      const issuedAt = this.now()
      const receipt: MutationGrantReceipt = {
        grantId: this.options.randomUUID(),
        subagentRunId: command.subagentRunId,
        documentId: command.documentId,
        exactToolIds: [...command.exactToolIds],
        issuedByUserActionId: userActionId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + this.mutationGrantTtlMs).toISOString(),
        status: 'active',
      }
      const result = await this.transport.issueMutationGrant({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        requestId: command.requestId,
        receipt,
      })
      if (result.grant.status === 'active') this.activeMutationGrants.set(receipt.grantId, receipt)
      return result
    }
    if (command.type === 'denyMutation') {
      return this.transport.denyMutationGrant({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        requestId: command.requestId,
        userActionId: this.consumeTrustedUserGesture(clientId),
      })
    }
    if (command.type === 'revokeMutation') {
      const result = await this.transport.revokeMutationGrant({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        grantId: command.grantId,
        userActionId: this.consumeTrustedUserGesture(clientId),
      })
      this.activeMutationGrants.delete(command.grantId)
      return result
    }
    if (command.type === 'rollbackRun') {
      this.consumeTrustedUserGesture(clientId)
      if (!this.options.rollbackRun) throw new Error('office_rollback_unavailable')
      return {
        documentId: command.documentId,
        runId: command.runId,
        rolledBack: await this.options.rollbackRun(command.documentId, command.runId),
      }
    }
    if (command.type === 'navigate') {
      const receipt = await this.transport.navigateSession({
        operationId: command.operationId,
        sessionId: command.sessionId,
        documentId: command.documentId,
        targetEntryId: command.targetEntryId,
      })
      this.assertBinding(receipt, command.sessionId, command.documentId)
      connection.nextSequence = receipt.snapshot.lastSequence + 1
      return receipt
    }
    const receipt = await this.transport.forkSession({
      operationId: command.operationId,
      sessionId: command.sessionId,
      documentId: command.documentId,
    })
    this.assertBinding(receipt, receipt.sessionId, command.documentId)
    if (receipt.parentSessionId !== command.sessionId || receipt.sessionId === command.sessionId) {
      throw new Error('document_binding_mismatch')
    }
    await this.options.currentSessions?.advanceCurrent(
      command.documentId,
      command.sessionId,
      receipt.sessionId,
    )
    connection.sessionId = receipt.sessionId
    connection.nextSequence = receipt.snapshot.lastSequence + 1
    return receipt
  }

  disconnect(clientId: ClientId): void {
    const connection = this.connections.get(clientId)
    this.connections.delete(clientId)
    this.trustedGestures.delete(clientId)
    if (connection) {
      this.deleteDocumentMutationGrants(connection.documentId)
      void this.transport
        .revokeDocumentMutationGrants({
          operationId: this.options.randomUUID(),
          sessionId: connection.sessionId,
          documentId: connection.documentId,
        })
        .catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.trustedGestures.clear()
    this.activeMutationGrants.clear()
    await Promise.allSettled(
      connections.map((connection) =>
        this.transport.revokeDocumentMutationGrants({
          operationId: this.options.randomUUID(),
          sessionId: connection.sessionId,
          documentId: connection.documentId,
        }),
      ),
    )
    this.streams.clear()
    await this.listenPromise
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  authorizeMutationGrant(input: {
    grantId: string
    subagentRunId: string
    documentId: string
    toolId: string
  }): boolean {
    const grant = this.activeMutationGrants.get(input.grantId)
    if (!grant) return false
    if (new Date(grant.expiresAt).getTime() <= this.now().getTime()) {
      this.activeMutationGrants.delete(input.grantId)
      return false
    }
    return (
      grant.status === 'active' &&
      grant.subagentRunId === input.subagentRunId &&
      grant.documentId === input.documentId &&
      grant.exactToolIds.includes(input.toolId)
    )
  }

  private deleteDocumentMutationGrants(documentId: string): void {
    for (const [grantId, grant] of this.activeMutationGrants) {
      if (grant.documentId === documentId) this.activeMutationGrants.delete(grantId)
    }
  }

  private consumeTrustedUserGesture(clientId: ClientId): string {
    const gesture = this.trustedGestures.get(clientId)
    this.trustedGestures.delete(clientId)
    if (!gesture || this.now().getTime() > gesture.expiresAt) {
      throw new Error('trusted_user_gesture_required')
    }
    return gesture.userActionId
  }

  private async ensureListening(): Promise<void> {
    this.listenPromise ??= Promise.resolve(
      this.transport.onSessionEvent((event) => this.onEvent(event)),
    ).then((unsubscribe) => {
      this.unsubscribe = unsubscribe
    })
    await this.listenPromise
  }

  private async openCurrentSession(
    clientId: ClientId,
    request: AgentSessionConnectRequest,
  ): Promise<SessionConnectionReceipt> {
    const officeToolCatalog = await this.options.resolveOfficeToolCatalog?.(
      clientId,
      request.documentId,
    )
    if (request.sessionId) {
      await this.options.currentSessions?.assertCurrent(request.documentId, request.sessionId)
      return this.transport.openSession({
        operationId: this.options.randomUUID(),
        sessionId: request.sessionId,
        documentId: request.documentId,
        ...(officeToolCatalog ? { officeToolCatalog } : {}),
      })
    }
    if (!this.options.currentSessions) {
      return this.transport.createSession({
        operationId: this.options.randomUUID(),
        documentId: request.documentId,
        ...(officeToolCatalog ? { officeToolCatalog } : {}),
      })
    }
    let created: SessionConnectionReceipt | undefined
    const sessionId = await this.options.currentSessions.resolveCurrent(
      request.documentId,
      async () => {
        created = await this.transport.createSession({
          operationId: this.options.randomUUID(),
          documentId: request.documentId,
        })
        this.assertBinding(created, created.sessionId, request.documentId)
        return created.sessionId
      },
    )
    return (
      created ??
      (await this.transport.openSession({
        operationId: this.options.randomUUID(),
        sessionId,
        documentId: request.documentId,
        ...(officeToolCatalog ? { officeToolCatalog } : {}),
      }))
    )
  }

  private onEvent(event: EventEnvelope): void {
    const existing = this.streams.get(event.sessionId)
    if (existing?.documentId && existing.documentId !== event.documentId) return
    const stream = this.streamFor(event.sessionId, event.documentId)
    if (stream.eventIds.has(event.eventId)) return
    if (stream.highestSequence !== undefined && event.sequence !== stream.highestSequence + 1) {
      if (event.sequence <= stream.highestSequence) return
      stream.gapDetected = true
    }
    stream.highestSequence = event.sequence
    stream.events.push(event)
    stream.eventIds.add(event.eventId)
    while (stream.events.length > this.replayWindowSize) {
      stream.eventIds.delete(stream.events.shift()!.eventId)
    }

    for (const connection of this.connections.values()) {
      if (connection.sessionId !== event.sessionId || connection.documentId !== event.documentId) {
        continue
      }
      if (event.sequence < connection.nextSequence) continue
      if (event.sequence !== connection.nextSequence) stream.gapDetected = true
      if (stream.gapDetected) continue
      connection.deliver(event)
      connection.nextSequence += 1
    }
  }

  private streamFor(sessionId: string, documentId: string): SessionStream {
    const stream = this.streams.get(sessionId)
    if (!stream) {
      const created: SessionStream = {
        documentId,
        events: [],
        eventIds: new Set(),
        gapDetected: false,
      }
      this.streams.set(sessionId, created)
      return created
    } else if (stream.documentId !== documentId) {
      throw new Error('document_binding_mismatch')
    }
    return stream
  }

  private eventsAfterSnapshot(
    subscription: SessionSubscriptionReceipt,
    stream: SessionStream,
  ): EventEnvelope[] {
    const byId = new Map<string, EventEnvelope>()
    for (const event of [...subscription.events, ...stream.events]) {
      this.assertBinding(event, subscription.snapshot.sessionId, subscription.snapshot.documentId)
      if (event.sequence > subscription.snapshot.lastSequence) byId.set(event.eventId, event)
    }
    return [...byId.values()].sort(compareEvents)
  }

  private isContinuous(afterSequence: number, events: EventEnvelope[]): boolean {
    let expected = afterSequence + 1
    for (const event of events) {
      if (event.sequence !== expected) return false
      expected += 1
    }
    return true
  }

  private assertBinding(
    value: { sessionId: string; documentId: string },
    sessionId: string,
    documentId: string,
  ): void {
    if (value.sessionId !== sessionId || value.documentId !== documentId) {
      throw new Error('document_binding_mismatch')
    }
  }
}
