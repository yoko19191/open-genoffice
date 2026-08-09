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
  SessionSubscriptionReceipt,
} from '@genoffice/agent-runtime-protocol'

export type AgentSessionTransport = {
  createSession(input: {
    operationId: string
    documentId: string
  }): Promise<SessionConnectionReceipt>
  openSession(input: {
    operationId: string
    sessionId: string
    documentId: string
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

  constructor(
    private readonly transport: AgentSessionTransport,
    private readonly options: AgentSessionBrokerOptions<ClientId>,
  ) {
    this.replayWindowSize = Math.max(1, options.replayWindowSize ?? 512)
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
    const opened = await this.openCurrentSession(request)
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
    SessionPromptReceipt | SessionAbortReceipt | SessionForkReceipt | SessionNavigateReceipt
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
    this.connections.delete(clientId)
  }

  async close(): Promise<void> {
    this.connections.clear()
    this.streams.clear()
    await this.listenPromise
    this.unsubscribe?.()
    this.unsubscribe = undefined
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
    request: AgentSessionConnectRequest,
  ): Promise<SessionConnectionReceipt> {
    if (request.sessionId) {
      await this.options.currentSessions?.assertCurrent(request.documentId, request.sessionId)
      return this.transport.openSession({
        operationId: this.options.randomUUID(),
        sessionId: request.sessionId,
        documentId: request.documentId,
      })
    }
    if (!this.options.currentSessions) {
      return this.transport.createSession({
        operationId: this.options.randomUUID(),
        documentId: request.documentId,
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
