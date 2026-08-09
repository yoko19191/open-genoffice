import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type {
  EventEnvelope,
  SessionMessageProjection,
  SessionSnapshot,
} from '@genoffice/agent-runtime-protocol'
import {
  createDeterministicPiSession,
  type CreatePiSessionOptions,
  type PiSessionHandle,
} from './pi-session-factory'

type Binding = {
  version: 1
  sessionId: string
  documentId: string
  sessionFile: string
}

type CreateInput = { operationId: string; documentId: string }
type OpenInput = CreateInput & { sessionId: string }
type PromptInput = OpenInput & { text: string }
type BoundInput = { sessionId: string; documentId: string }
type SubscribeInput = BoundInput & { afterCursor?: string }

type CreateReceipt = {
  sessionId: string
  documentId: string
  snapshot: SessionSnapshot
  cursor: string
}
type OpenReceipt = {
  sessionId: string
  documentId: string
  snapshot: SessionSnapshot
  cursor: string
}
type PromptReceipt = { runId: string; acceptedCursor: string }
type OperationEntry = { hash: string; result: Promise<unknown> }

type SessionRecord = {
  binding: Binding
  pi: PiSessionHandle
  unsubscribe: () => void
  sequence: number
  eventQueue: Promise<void>
  activeRun?: {
    runId: string
    state: NonNullable<SessionSnapshot['activeRun']>['state']
    promise?: Promise<void>
  }
  activeMessageId?: string
  pendingTerminalState?: 'completed' | 'failed' | 'aborted'
}

export type SessionRegistryOptions = {
  dataRoot?: string
  instanceId: string
  cursorSecret: Buffer
  replayWindowSize?: number
  randomUUID?: () => string
  now?: () => Date
  createPiSession?: (options: CreatePiSessionOptions) => Promise<PiSessionHandle>
}

export class RuntimeSessionError extends Error {
  constructor(
    public readonly code:
      'session_not_found' | 'document_mismatch' | 'duplicate_operation_mismatch' | 'invalid_state',
  ) {
    super(code)
    this.name = 'RuntimeSessionError'
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

function operationHash(method: string, input: unknown): string {
  return createHash('sha256').update(canonicalize({ method, input })).digest('hex')
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .flatMap((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return []
      return []
    })
    .join('')
}

function projectMessage(entry: SessionMessageEntry): SessionMessageProjection | undefined {
  const message = entry.message as AgentMessage
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') {
    return undefined
  }
  const projection: SessionMessageProjection = {
    id: entry.id,
    role: message.role,
    text: messageText(message),
  }
  if (message.role === 'toolResult') {
    projection.toolCallId = message.toolCallId
    projection.toolName = message.toolName
    projection.isError = message.isError
  }
  return projection
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  return [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === 'assistant')
}

export class SessionRegistry {
  private readonly dataRoot: string
  private readonly bindingsRoot: string
  private readonly sessionsRoot: string
  private readonly journalsRoot: string
  private readonly agentDir: string
  private readonly cwd: string
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly createPiSession: (options: CreatePiSessionOptions) => Promise<PiSessionHandle>
  private readonly replayWindowSize: number
  private readonly records = new Map<string, SessionRecord>()
  private readonly operations = new Map<string, OperationEntry>()
  private readonly listeners = new Set<(event: EventEnvelope) => void>()

  constructor(private readonly options: SessionRegistryOptions) {
    this.dataRoot =
      options.dataRoot ?? process.env.GENOFFICE_RESOURCE_HOME ?? join(homedir(), '.open-genoffice')
    this.bindingsRoot = join(this.dataRoot, 'state', 'session-bindings')
    this.sessionsRoot = join(this.dataRoot, 'agent', 'sessions')
    this.journalsRoot = join(this.dataRoot, 'state', 'session-journals')
    this.agentDir = join(this.dataRoot, 'agent')
    this.cwd = join(this.dataRoot, 'projects', 'runtime')
    this.randomUUID = options.randomUUID ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.createPiSession = options.createPiSession ?? createDeterministicPiSession
    this.replayWindowSize = Math.max(1, options.replayWindowSize ?? 512)
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async create(input: CreateInput): Promise<CreateReceipt> {
    return this.idempotent('session.create', input, async () => {
      await this.ensureRoots()
      const sessionId = this.randomUUID()
      const pi = await this.createPiSession({
        cwd: this.cwd,
        agentDir: this.agentDir,
        sessionDir: this.sessionDirectory(input.documentId),
        sessionId,
        documentId: input.documentId,
      })
      const sessionFile = pi.session.sessionFile
      if (!sessionFile) {
        pi.dispose()
        throw new RuntimeSessionError('invalid_state')
      }
      const binding: Binding = { version: 1, sessionId, documentId: input.documentId, sessionFile }
      await this.writeBinding(binding)
      const record = await this.attach(binding, pi)
      await this.appendEvent(record, 'session.opened', { restored: false })
      const snapshot = this.snapshotFor(record)
      return {
        sessionId,
        documentId: input.documentId,
        snapshot,
        cursor: snapshot.cursor,
      }
    })
  }

  async open(input: OpenInput): Promise<OpenReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.open', input, async () => {
      const record = await this.loadRecord(binding)
      const snapshot = this.snapshotFor(record)
      return {
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        snapshot,
        cursor: snapshot.cursor,
      }
    })
  }

  async prompt(input: PromptInput): Promise<PromptReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.prompt', input, async () => {
      const record = await this.loadRecord(binding)
      if (
        record.activeRun &&
        (record.activeRun.state === 'queued' || record.activeRun.state === 'running')
      ) {
        throw new RuntimeSessionError('invalid_state')
      }
      const runId = this.randomUUID()
      record.activeRun = { runId, state: 'queued' }
      await this.appendEvent(record, 'run.queued', {})
      const userMessageId = this.randomUUID()
      await this.appendEvent(
        record,
        'message.started',
        { messageId: userMessageId, role: 'user', text: input.text },
        runId,
      )
      const accepted = await this.appendEvent(
        record,
        'message.completed',
        { messageId: userMessageId, role: 'user' },
        runId,
      )
      const running = record.pi
        .prompt(input.text)
        .then(async (result) => {
          if (result?.branchCreated) {
            await this.appendEvent(record, 'branch.created', result.branchCreated, runId)
          }
          const terminalState = record.pendingTerminalState ?? 'completed'
          record.pendingTerminalState = undefined
          record.activeRun = { runId, state: terminalState }
          await this.appendEvent(record, `run.${terminalState}`, {}, runId)
        })
        .catch(async () => {
          record.pendingTerminalState = undefined
          record.activeRun = { runId, state: 'failed' }
          await this.appendEvent(record, 'run.failed', { reason: 'provider_error' })
        })
        .then(() => record.eventQueue)
      record.activeRun.promise = running
      return { runId, acceptedCursor: accepted.cursor }
    })
  }

  async snapshot(input: BoundInput): Promise<SessionSnapshot> {
    const binding = await this.readBoundBinding(input)
    return this.snapshotFor(await this.loadRecord(binding))
  }

  async subscribe(input: SubscribeInput) {
    const binding = await this.readBoundBinding(input)
    const record = await this.loadRecord(binding)
    const snapshot = this.snapshotFor(record)
    if (!input.afterCursor) return { resetRequired: true, snapshot, events: [] as EventEnvelope[] }
    const afterSequence = this.readCursor(input.afterCursor, binding.sessionId)
    if (afterSequence === undefined)
      return { resetRequired: true, snapshot, events: [] as EventEnvelope[] }
    const earliestReplaySequence = Math.max(0, snapshot.lastSequence - this.replayWindowSize)
    if (afterSequence < earliestReplaySequence || afterSequence > snapshot.lastSequence) {
      return { resetRequired: true, snapshot, events: [] as EventEnvelope[] }
    }
    const events = (await this.readJournal(binding.sessionId)).filter(
      (event) => event.sequence > afterSequence,
    )
    return { resetRequired: false, snapshot, events }
  }

  async waitForIdle(sessionId: string): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record) throw new RuntimeSessionError('session_not_found')
    await record.activeRun?.promise
    await record.eventQueue
  }

  async readJournal(sessionId: string): Promise<EventEnvelope[]> {
    try {
      const content = await readFile(this.journalPath(sessionId), 'utf8')
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventEnvelope)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async listBindings(): Promise<Binding[]> {
    await this.ensureRoots()
    const names = await readdir(this.bindingsRoot)
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => this.readBinding(name.slice(0, -5))),
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => record.activeRun?.promise))
    await Promise.all([...this.records.values()].map((record) => record.eventQueue))
    for (const record of this.records.values()) {
      record.unsubscribe()
      record.pi.dispose()
    }
    this.records.clear()
    this.listeners.clear()
  }

  private async idempotent<T>(
    method: string,
    input: { operationId: string },
    action: () => Promise<T>,
  ): Promise<T> {
    const hash = operationHash(method, input)
    const existing = this.operations.get(input.operationId)
    if (existing) {
      if (existing.hash !== hash) throw new RuntimeSessionError('duplicate_operation_mismatch')
      return existing.result as Promise<T>
    }
    const result = action()
    this.operations.set(input.operationId, { hash, result })
    return result
  }

  private async ensureRoots() {
    await Promise.all([
      mkdir(this.bindingsRoot, { recursive: true }),
      mkdir(this.sessionsRoot, { recursive: true }),
      mkdir(this.journalsRoot, { recursive: true }),
    ])
  }

  private bindingPath(sessionId: string) {
    return join(this.bindingsRoot, `${sessionId}.json`)
  }

  private journalPath(sessionId: string) {
    return join(this.journalsRoot, `${sessionId}.jsonl`)
  }

  private sessionDirectory(documentId: string) {
    return join(this.sessionsRoot, documentId)
  }

  private async writeBinding(binding: Binding) {
    const path = this.bindingPath(binding.sessionId)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(binding)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private async readBinding(sessionId: string): Promise<Binding> {
    try {
      const value: unknown = JSON.parse(await readFile(this.bindingPath(sessionId), 'utf8'))
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as Binding).version === 1 &&
        (value as Binding).sessionId === sessionId &&
        typeof (value as Binding).documentId === 'string' &&
        typeof (value as Binding).sessionFile === 'string'
      ) {
        return value as Binding
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RuntimeSessionError('session_not_found')
      }
    }
    throw new RuntimeSessionError('session_not_found')
  }

  private async readBoundBinding(input: BoundInput): Promise<Binding> {
    const binding = await this.readBinding(input.sessionId)
    if (binding.documentId !== input.documentId) throw new RuntimeSessionError('document_mismatch')
    return binding
  }

  private async loadRecord(binding: Binding): Promise<SessionRecord> {
    const existing = this.records.get(binding.sessionId)
    if (existing) return existing
    const pi = await this.createPiSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      sessionDir: this.sessionDirectory(binding.documentId),
      sessionId: binding.sessionId,
      sessionFile: binding.sessionFile,
      documentId: binding.documentId,
    })
    const record = await this.attach(binding, pi)
    await this.appendEvent(record, 'session.opened', { restored: true })
    return record
  }

  private async attach(binding: Binding, pi: PiSessionHandle): Promise<SessionRecord> {
    const previous = await this.readJournal(binding.sessionId)
    const record = {
      binding,
      pi,
      sequence: previous.at(-1)?.sequence ?? 0,
      eventQueue: Promise.resolve(),
      unsubscribe: () => {},
    } satisfies SessionRecord
    record.unsubscribe = pi.subscribe((event) => this.projectPiEvent(record, event))
    this.records.set(binding.sessionId, record)
    return record
  }

  private projectPiEvent(record: SessionRecord, event: AgentSessionEvent) {
    const runId = record.activeRun?.runId
    if (!runId) return
    if (event.type === 'agent_start') {
      record.activeRun = { ...record.activeRun!, state: 'running' }
      void this.appendEvent(record, 'run.started', {}, runId)
      return
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      record.activeMessageId = this.randomUUID()
      void this.appendEvent(record, 'message.started', { messageId: record.activeMessageId }, runId)
      return
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (update.type === 'thinking_start')
        void this.appendEvent(record, 'thinking.started', {}, runId)
      else if (update.type === 'thinking_delta')
        void this.appendEvent(record, 'thinking.delta', { text: update.delta }, runId)
      else if (update.type === 'thinking_end')
        void this.appendEvent(record, 'thinking.completed', {}, runId)
      else if (update.type === 'text_delta')
        void this.appendEvent(record, 'message.delta', { text: update.delta }, runId)
      else if (update.type === 'toolcall_end') {
        void this.appendEvent(
          record,
          'tool.requested',
          { toolCallId: update.toolCall.id, toolName: update.toolCall.name },
          runId,
        )
      }
      return
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      void this.appendEvent(
        record,
        'message.completed',
        { messageId: record.activeMessageId },
        runId,
      )
      record.activeMessageId = undefined
      return
    }
    if (event.type === 'tool_execution_start') {
      void this.appendEvent(
        record,
        'tool.started',
        { toolCallId: event.toolCallId, toolName: event.toolName },
        runId,
      )
      return
    }
    if (event.type === 'tool_execution_update') {
      void this.appendEvent(record, 'tool.progress', { toolCallId: event.toolCallId }, runId)
      return
    }
    if (event.type === 'tool_execution_end') {
      void this.appendEvent(
        record,
        event.isError ? 'tool.failed' : 'tool.completed',
        { toolCallId: event.toolCallId, toolName: event.toolName, ok: !event.isError },
        runId,
      )
      return
    }
    if (event.type === 'compaction_start') {
      void this.appendEvent(record, 'compaction.started', { reason: event.reason }, runId)
      return
    }
    if (event.type === 'compaction_end') {
      if (event.result) {
        void this.appendEvent(
          record,
          'compaction.completed',
          {
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
            estimatedTokensAfter: event.result.estimatedTokensAfter,
          },
          runId,
        )
      } else {
        void this.appendEvent(
          record,
          'compaction.failed',
          { reason: event.aborted ? 'aborted' : 'compaction_error' },
          runId,
        )
      }
      return
    }
    if (event.type === 'agent_end' && !event.willRetry) {
      const assistant = lastAssistant(event.messages)
      const state =
        assistant?.stopReason === 'error'
          ? 'failed'
          : assistant?.stopReason === 'aborted'
            ? 'aborted'
            : 'completed'
      record.activeRun = { ...record.activeRun!, state }
      record.pendingTerminalState = state
    }
  }

  private appendEvent(
    record: SessionRecord,
    type: EventEnvelope['type'],
    payload: Record<string, unknown>,
    runId?: string,
  ): Promise<EventEnvelope> {
    let resolveEvent!: (event: EventEnvelope) => void
    const result = new Promise<EventEnvelope>((resolve) => {
      resolveEvent = resolve
    })
    record.eventQueue = record.eventQueue.then(async () => {
      record.sequence += 1
      const event: EventEnvelope = {
        protocolVersion: '1',
        kind: 'event',
        eventId: this.randomUUID(),
        instanceId: this.options.instanceId,
        sessionId: record.binding.sessionId,
        documentId: record.binding.documentId,
        ...(runId ? { runId } : {}),
        sequence: record.sequence,
        cursor: this.cursor(record.binding.sessionId, record.sequence),
        occurredAt: this.now().toISOString(),
        type,
        payload,
      }
      await appendFile(this.journalPath(record.binding.sessionId), `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      for (const listener of this.listeners) listener(event)
      resolveEvent(event)
    })
    return result
  }

  private snapshotFor(record: SessionRecord): SessionSnapshot {
    const messages = record.pi.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === 'message' ? [projectMessage(entry)].filter(Boolean) : [],
      ) as SessionMessageProjection[]
    return {
      sessionId: record.binding.sessionId,
      documentId: record.binding.documentId,
      messages,
      ...(record.activeRun
        ? { activeRun: { runId: record.activeRun.runId, state: record.activeRun.state } }
        : {}),
      lastSequence: record.sequence,
      cursor: this.cursor(record.binding.sessionId, record.sequence),
    }
  }

  private cursor(sessionId: string, sequence: number): string {
    const body = Buffer.from(`${this.options.instanceId}\0${sessionId}\0${sequence}`).toString(
      'base64url',
    )
    const signature = createHmac('sha256', this.options.cursorSecret)
      .update(body)
      .digest('base64url')
    return `${body}.${signature}`
  }

  private readCursor(cursor: string, sessionId: string): number | undefined {
    const [body, signature, extra] = cursor.split('.')
    if (!body || !signature || extra) return undefined
    const expected = createHmac('sha256', this.options.cursorSecret).update(body).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    const [instanceId, cursorSessionId, rawSequence, trailing] = Buffer.from(body, 'base64url')
      .toString('utf8')
      .split('\0')
    const sequence = Number(rawSequence)
    if (
      trailing !== undefined ||
      instanceId !== this.options.instanceId ||
      cursorSessionId !== sessionId ||
      !Number.isInteger(sequence) ||
      sequence < 0
    )
      return undefined
    return sequence
  }
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  return new SessionRegistry(options)
}
