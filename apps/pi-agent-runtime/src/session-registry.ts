import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, CredentialStore, Message } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type {
  ArtifactRef,
  EventEnvelope,
  MutationGrantProjection,
  MutationGrantReceipt,
  OfficeToolCatalogBinding,
  SessionMessageProjection,
  SessionSnapshot,
  SubagentRunProjection as RendererSubagentRunProjection,
} from '@genoffice/agent-runtime-protocol'
import { resolveOfficeToolDefinitions } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import { parsePlatformToolDetails } from '@genoffice/agent-runtime-protocol/platform-tool-catalog'
import {
  CapabilitySnapshotError,
  SessionLeaseError,
  SessionLeaseStore,
  atomicWriteJson,
  type AtomicWriteOptions,
  type SessionLeaseHandle,
} from '@genoffice/agent-resource'
import {
  createDeterministicPiSession,
  type CreatePiSessionOptions,
  type PiSessionHandle,
} from './pi-session-factory'
import {
  RunAbortTree,
  type AbortDescendantRegistration,
  type RunAbortSummary,
} from './run-abort-tree'
import { planSessionRecovery, type SessionRecoveryPlan } from './session-recovery'
import type { SpawnSubagentRequest, SubagentCoordinatorEvent } from './subagent-coordinator'
import type { SubagentRunProjection } from './subagent-run-registry'

type Binding = {
  version: 1
  sessionId: string
  documentId: string
  sessionFile: string
  parentSessionId?: string
  officeToolCatalog?: OfficeToolCatalogBinding
}

type CreateInput = {
  operationId: string
  documentId: string
  officeToolCatalog?: OfficeToolCatalogBinding
}
type OpenInput = CreateInput & { sessionId: string }
type PromptInput = OpenInput & { text: string; projectRoot?: string; artifacts?: ArtifactRef[] }
type AbortInput = OpenInput & { runId: string }
type ResumeSubagentInput = OpenInput & { runId: string }
type IssueMutationGrantInput = OpenInput & {
  requestId: string
  receipt: MutationGrantReceipt
}
type DenyMutationGrantInput = OpenInput & { requestId: string; userActionId: string }
type RevokeMutationGrantInput = OpenInput & { grantId: string; userActionId: string }
type NavigateInput = OpenInput & { targetEntryId: string }
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
type AbortReceipt = {
  runId: string
  state: 'cancelling' | 'already_terminal'
  acceptedCursor: string
}
type ResumeSubagentReceipt = { runId: string; attempt: number; acceptedCursor: string }
type SessionMutationGrantReceipt = {
  sessionId: string
  documentId: string
  grant: MutationGrantProjection
  acceptedCursor: string
}
type ForkReceipt = CreateReceipt & { parentSessionId: string }
type NavigateReceipt = CreateReceipt & { activeLeafId: string }
type OperationEntry = { hash: string; result: Promise<unknown> }

type SessionRecord = {
  binding: Binding
  pi: PiSessionHandle
  lease: SessionLeaseHandle
  leaseHeartbeatTimer?: NodeJS.Timeout
  leaseHeartbeat?: Promise<void>
  leaseError?: RuntimeSessionError
  writeError?: RuntimeSessionError
  unsubscribe: () => void
  sequence: number
  eventQueue: Promise<void>
  activeRun?: {
    runId: string
    state: NonNullable<SessionSnapshot['activeRun']>['state']
    promise?: Promise<void>
    abortTree: RunAbortTree
    abortRegistration?: Promise<AbortReceipt>
  }
  activeMessageId?: string
  pendingTerminalState?: 'completed' | 'failed' | 'aborted'
}

export type SessionRegistryOptions = {
  dataRoot?: string
  instanceId: string
  cursorSecret: Buffer
  replayWindowSize?: number
  cooperativeAbortMs?: number
  forceAbortMs?: number
  sessionLeaseTtlMs?: number
  sessionLeaseHeartbeatMs?: number
  randomUUID?: () => string
  now?: () => Date
  createPiSession?: (options: CreatePiSessionOptions) => Promise<PiSessionHandle>
  credentials?: CredentialStore
  subagents?: SessionSubagentCoordinator
  mutationGrants?: SessionMutationGrantRegistry
  bindingAtomicWriteOptions?: (binding: Readonly<Binding>) => AtomicWriteOptions
}

export type SessionSubagentCoordinator = {
  onEvent(listener: (event: SubagentCoordinatorEvent) => void): () => void
  listForSession(parentSessionId: string): SubagentRunProjection[]
  spawn(request: SpawnSubagentRequest): Promise<SubagentRunProjection>
  cancelTree(parentRunId: string, reason: string): Promise<void>
  resume(runId: string): Promise<SubagentRunProjection>
  parentSessionIdsWithRuns?(): string[]
  reconcile?(): Promise<void>
}

export type SessionMutationGrantRegistry = {
  onEvent(
    listener: (event: {
      parentSessionId: string
      documentId: string
      projection: MutationGrantProjection
    }) => void,
  ): () => void
  listForSession(parentSessionId: string): MutationGrantProjection[]
  issue(requestId: string, receipt: MutationGrantReceipt): Promise<MutationGrantProjection>
  deny(requestId: string, userActionId: string): Promise<MutationGrantProjection>
  revoke(grantId: string, userActionId: string): Promise<MutationGrantProjection>
  revokeForRun(runId: string, reason: string): Promise<void>
  revokeForParentRun(parentRunId: string, reason: string): Promise<void>
  revokeForDocument(documentId: string, reason: string): Promise<void>
}

export class RuntimeSessionError extends Error {
  constructor(
    public readonly code:
      | 'session_not_found'
      | 'session_in_use'
      | 'session_lease_invalid'
      | 'session_lease_lost'
      | 'document_mismatch'
      | 'duplicate_operation_mismatch'
      | 'invalid_state'
      | 'branch_not_found'
      | 'office_tool_catalog_mismatch',
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
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .flatMap((block) => {
            if (block.type === 'text') return block.text
            if (block.type === 'thinking') return []
            return []
          })
          .join('')
  if (message.role !== 'user' || !text.startsWith('<genoffice-artifacts>')) return text
  const marker = '</genoffice-artifacts>\n'
  const end = text.indexOf(marker)
  return end === -1 ? text : text.slice(end + marker.length)
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
  private readonly leasesRoot: string
  private readonly agentDir: string
  private readonly cwd: string
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly createPiSession: (options: CreatePiSessionOptions) => Promise<PiSessionHandle>
  private readonly replayWindowSize: number
  private readonly cooperativeAbortMs: number
  private readonly forceAbortMs: number
  private readonly sessionLeaseStore: SessionLeaseStore
  private readonly sessionLeaseHeartbeatMs: number
  private readonly records = new Map<string, SessionRecord>()
  private readonly loadingRecords = new Map<string, Promise<SessionRecord>>()
  private readonly operations = new Map<string, OperationEntry>()
  private readonly listeners = new Set<(event: EventEnvelope) => void>()
  private readonly unsubscribeSubagents: () => void
  private readonly unsubscribeMutationGrants: () => void

  constructor(private readonly options: SessionRegistryOptions) {
    this.dataRoot =
      options.dataRoot ?? process.env.GENOFFICE_RESOURCE_HOME ?? join(homedir(), '.open-genoffice')
    this.bindingsRoot = join(this.dataRoot, 'state', 'session-bindings')
    this.sessionsRoot = join(this.dataRoot, 'agent', 'sessions')
    this.journalsRoot = join(this.dataRoot, 'state', 'session-journals')
    this.leasesRoot = join(this.dataRoot, 'state', 'leases')
    this.agentDir = join(this.dataRoot, 'agent')
    this.cwd = join(this.dataRoot, 'projects', 'runtime')
    this.randomUUID = options.randomUUID ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.createPiSession =
      options.createPiSession ??
      (options.credentials
        ? (piOptions) =>
            createDeterministicPiSession({ ...piOptions, credentials: options.credentials })
        : createDeterministicPiSession)
    this.replayWindowSize = Math.max(1, options.replayWindowSize ?? 512)
    this.cooperativeAbortMs = Math.max(1, options.cooperativeAbortMs ?? 2_000)
    this.forceAbortMs = Math.max(this.cooperativeAbortMs, options.forceAbortMs ?? 5_000)
    const sessionLeaseTtlMs = Math.max(1_000, options.sessionLeaseTtlMs ?? 15_000)
    this.sessionLeaseHeartbeatMs = Math.max(
      250,
      options.sessionLeaseHeartbeatMs ?? Math.floor(sessionLeaseTtlMs / 3),
    )
    this.sessionLeaseStore = new SessionLeaseStore({
      leasesDirectory: this.leasesRoot,
      instanceId: options.instanceId,
      pid: process.pid,
      ttlMs: sessionLeaseTtlMs,
      now: this.now,
      isProcessAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH'
        }
      },
    })
    this.unsubscribeSubagents =
      options.subagents?.onEvent((event) => this.projectSubagentEvent(event)) ?? (() => {})
    this.unsubscribeMutationGrants =
      options.mutationGrants?.onEvent((event) => this.projectMutationGrantEvent(event)) ??
      (() => {})
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async create(input: CreateInput): Promise<CreateReceipt> {
    return this.idempotent('session.create', input, async () => {
      this.assertOfficeToolCatalog(input.officeToolCatalog)
      await this.ensureRoots()
      const sessionId = this.randomUUID()
      const lease = await this.acquireLease(sessionId)
      let pi: PiSessionHandle
      try {
        pi = await this.createPiSession({
          cwd: this.cwd,
          agentDir: this.agentDir,
          sessionDir: this.sessionDirectory(input.documentId),
          sessionId,
          documentId: input.documentId,
          ...(input.officeToolCatalog ? { officeToolCatalog: input.officeToolCatalog } : {}),
        })
      } catch (error) {
        await lease.release()
        throw error
      }
      const sessionFile = pi.session.sessionFile
      if (!sessionFile) {
        pi.dispose()
        await lease.release()
        throw new RuntimeSessionError('invalid_state')
      }
      const binding: Binding = {
        version: 1,
        sessionId,
        documentId: input.documentId,
        sessionFile,
        ...(input.officeToolCatalog ? { officeToolCatalog: input.officeToolCatalog } : {}),
      }
      let record: SessionRecord
      try {
        record = await this.attach(binding, pi, lease)
      } catch (error) {
        pi.dispose()
        await lease.release()
        throw error
      }
      try {
        await this.appendEvent(record, 'session.opened', { restored: false })
        await this.writeBinding(binding)
        const snapshot = this.snapshotFor(record)
        return {
          sessionId,
          documentId: input.documentId,
          snapshot,
          cursor: snapshot.cursor,
        }
      } catch (error) {
        await this.disposeRecord(record)
        throw error
      }
    })
  }

  async open(input: OpenInput): Promise<OpenReceipt> {
    const binding = await this.readBoundBinding(input)
    this.assertOfficeToolCatalogMatch(binding.officeToolCatalog, input.officeToolCatalog)
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

  async fork(input: OpenInput): Promise<ForkReceipt> {
    const parentBinding = await this.readBoundBinding(input)
    return this.idempotent('session.fork', input, async () => {
      const parent = await this.loadRecord(parentBinding)
      await this.renewLease(parent)
      await this.assertIdle(parent)
      const sessionId = this.randomUUID()
      const lease = await this.acquireLease(sessionId)
      let forked: Awaited<ReturnType<PiSessionHandle['fork']>>
      try {
        forked = await parent.pi.fork(sessionId, parentBinding.sessionId)
      } catch (error) {
        await lease.release()
        throw error
      }
      let pi: PiSessionHandle
      try {
        pi = await this.createPiSession({
          cwd: this.cwd,
          agentDir: this.agentDir,
          sessionDir: this.sessionDirectory(input.documentId),
          sessionId,
          sessionFile: forked.sessionFile,
          documentId: input.documentId,
          ...(parentBinding.officeToolCatalog
            ? { officeToolCatalog: parentBinding.officeToolCatalog }
            : {}),
        })
      } catch (error) {
        await lease.release()
        throw error
      }
      const binding: Binding = {
        version: 1,
        sessionId,
        documentId: input.documentId,
        sessionFile: forked.sessionFile,
        parentSessionId: parentBinding.sessionId,
        ...(parentBinding.officeToolCatalog
          ? { officeToolCatalog: parentBinding.officeToolCatalog }
          : {}),
      }
      let record: SessionRecord
      try {
        record = await this.attach(binding, pi, lease)
      } catch (error) {
        pi.dispose()
        await lease.release()
        throw error
      }
      try {
        await this.appendEvent(record, 'branch.created', {
          parentSessionId: parentBinding.sessionId,
          activeLeafId: forked.activeLeafId,
        })
        await this.writeBinding(binding)
        const snapshot = this.snapshotFor(record)
        return {
          sessionId,
          parentSessionId: parentBinding.sessionId,
          documentId: input.documentId,
          snapshot,
          cursor: snapshot.cursor,
        }
      } catch (error) {
        await this.disposeRecord(record)
        throw error
      }
    })
  }

  async navigate(input: NavigateInput): Promise<NavigateReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.navigate', input, async () => {
      const record = await this.loadRecord(binding)
      await this.renewLease(record)
      await this.assertIdle(record)
      let activeLeafId: string
      try {
        activeLeafId = (await record.pi.navigate(input.targetEntryId)).activeLeafId
      } catch (error) {
        if (error instanceof Error && error.message === 'branch_not_found') {
          throw new RuntimeSessionError('branch_not_found')
        }
        throw error
      }
      await this.appendEvent(record, 'branch.navigated', {
        targetEntryId: input.targetEntryId,
        activeLeafId,
      })
      const snapshot = this.snapshotFor(record)
      return {
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        activeLeafId,
        snapshot,
        cursor: snapshot.cursor,
      }
    })
  }

  async prompt(input: PromptInput): Promise<PromptReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.prompt', input, async () => {
      const record = await this.loadRecord(binding)
      await this.renewLease(record)
      if (
        record.activeRun &&
        (record.activeRun.state === 'queued' ||
          record.activeRun.state === 'running' ||
          record.activeRun.state === 'cancelling')
      ) {
        throw new RuntimeSessionError('invalid_state')
      }
      await record.activeRun?.promise
      const runId = this.randomUUID()
      const abortTree = new RunAbortTree({
        cooperativeAbortMs: this.cooperativeAbortMs,
        forceAbortMs: this.forceAbortMs,
      })
      const activeRun: NonNullable<SessionRecord['activeRun']> = {
        runId,
        state: 'queued',
        abortTree,
      }
      record.activeRun = activeRun
      let resolveModelSettled!: () => void
      const modelSettled = new Promise<void>((resolve) => {
        resolveModelSettled = resolve
      })
      const completeModel = abortTree.register({
        id: 'pi-model',
        kind: 'model',
        abort: async () => {
          await record.pi.abort()
          await modelSettled
        },
      })
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
        .prompt(input.text, abortTree.signal, {
          runId,
          ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
          ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        })
        .then(async (result) => {
          completeModel()
          if (record.activeRun !== activeRun || activeRun.abortRegistration) return
          if (result?.branchCreated) {
            await this.appendEvent(record, 'branch.created', result.branchCreated, runId)
          }
          const terminalState = record.pendingTerminalState ?? 'completed'
          record.pendingTerminalState = undefined
          activeRun.state = terminalState
          await this.options.mutationGrants?.revokeForParentRun(activeRun.runId, 'parent_terminal')
          await this.appendEvent(record, `run.${terminalState}`, {}, runId)
        })
        .catch(async (error) => {
          completeModel()
          if (record.activeRun !== activeRun || activeRun.abortRegistration) return
          record.pendingTerminalState = undefined
          activeRun.state = 'failed'
          await this.options.mutationGrants?.revokeForParentRun(activeRun.runId, 'parent_terminal')
          await this.appendEvent(
            record,
            'run.failed',
            error instanceof CapabilitySnapshotError
              ? { code: error.code }
              : { reason: 'provider_error' },
            runId,
          )
        })
        .finally(resolveModelSettled)
        .then(() => record.eventQueue)
      activeRun.promise = running
      return { runId, acceptedCursor: accepted.cursor }
    })
  }

  async abort(input: AbortInput): Promise<AbortReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.abort', input, async () => {
      const record = await this.loadRecord(binding)
      const activeRun = record.activeRun
      if (!activeRun || activeRun.runId !== input.runId) {
        throw new RuntimeSessionError('invalid_state')
      }
      if (
        activeRun.state === 'completed' ||
        activeRun.state === 'failed' ||
        activeRun.state === 'aborted' ||
        activeRun.state === 'interrupted'
      ) {
        const snapshot = this.snapshotFor(record)
        return {
          runId: activeRun.runId,
          state: 'already_terminal',
          acceptedCursor: snapshot.cursor,
        }
      }
      return this.beginAbort(record, activeRun)
    })
  }

  async spawnSubagent(request: SpawnSubagentRequest): Promise<SubagentRunProjection> {
    const binding = await this.readBoundBinding({
      sessionId: request.parentSessionId,
      documentId: request.documentId,
    })
    const record = await this.loadRecord(binding)
    const activeRun = record.activeRun
    if (
      !this.options.subagents ||
      !activeRun ||
      activeRun.runId !== request.parentRunId ||
      (activeRun.state !== 'queued' && activeRun.state !== 'running')
    ) {
      throw new RuntimeSessionError('invalid_state')
    }
    const child = await this.options.subagents.spawn(request)
    activeRun.abortTree.register({
      id: `subagent:${child.runId}`,
      kind: 'subagent',
      abort: async () => {
        await this.options.subagents!.cancelTree(child.runId, 'parent_run_aborted')
      },
    })
    await record.eventQueue
    return child
  }

  async resumeSubagent(input: ResumeSubagentInput): Promise<ResumeSubagentReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.subagent.resume', input, async () => {
      const record = await this.loadRecord(binding)
      const child = this.options.subagents
        ?.listForSession(binding.sessionId)
        .find((candidate) => candidate.runId === input.runId)
      if (!child || child.documentId !== binding.documentId || child.status !== 'resumable') {
        throw new RuntimeSessionError('invalid_state')
      }
      const resumed = await this.options.subagents!.resume(input.runId)
      await record.eventQueue
      return {
        runId: resumed.runId,
        attempt: resumed.attempt,
        acceptedCursor: this.snapshotFor(record).cursor,
      }
    })
  }

  async issueMutationGrant(input: IssueMutationGrantInput): Promise<SessionMutationGrantReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.mutation-grant.issue', input, async () => {
      const record = await this.loadRecord(binding)
      const pending = this.options.mutationGrants
        ?.listForSession(binding.sessionId)
        .find((candidate) => candidate.requestId === input.requestId)
      if (
        !pending ||
        pending.status !== 'pending' ||
        pending.subagentRunId !== input.receipt.subagentRunId ||
        input.receipt.documentId !== binding.documentId
      ) {
        throw new RuntimeSessionError('invalid_state')
      }
      const grant = await this.options.mutationGrants!.issue(input.requestId, input.receipt)
      await record.eventQueue
      return {
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        grant,
        acceptedCursor: this.snapshotFor(record).cursor,
      }
    })
  }

  async denyMutationGrant(input: DenyMutationGrantInput): Promise<SessionMutationGrantReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.mutation-grant.deny', input, async () => {
      const record = await this.loadRecord(binding)
      const grant = await this.options.mutationGrants!.deny(input.requestId, input.userActionId)
      await record.eventQueue
      return {
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        grant,
        acceptedCursor: this.snapshotFor(record).cursor,
      }
    })
  }

  async revokeMutationGrant(input: RevokeMutationGrantInput): Promise<SessionMutationGrantReceipt> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.mutation-grant.revoke', input, async () => {
      const record = await this.loadRecord(binding)
      const grant = await this.options.mutationGrants!.revoke(input.grantId, input.userActionId)
      await record.eventQueue
      return {
        sessionId: binding.sessionId,
        documentId: binding.documentId,
        grant,
        acceptedCursor: this.snapshotFor(record).cursor,
      }
    })
  }

  async revokeDocumentMutationGrants(input: OpenInput): Promise<{ revoked: true }> {
    const binding = await this.readBoundBinding(input)
    return this.idempotent('session.mutation-grant.revoke-document', input, async () => {
      await this.options.mutationGrants?.revokeForDocument(binding.documentId, 'document_closed')
      const record = await this.loadRecord(binding)
      await record.eventQueue
      return { revoked: true as const }
    })
  }

  registerRunDescendant(
    sessionId: string,
    runId: string,
    descendant: AbortDescendantRegistration,
  ): () => void {
    const record = this.records.get(sessionId)
    if (!record) throw new RuntimeSessionError('session_not_found')
    if (
      !record.activeRun ||
      record.activeRun.runId !== runId ||
      (record.activeRun.state !== 'queued' && record.activeRun.state !== 'running')
    ) {
      throw new RuntimeSessionError('invalid_state')
    }
    return record.activeRun.abortTree.register(descendant)
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

  async reconcileSubagents(): Promise<void> {
    const coordinator = this.options.subagents
    if (!coordinator?.reconcile) return
    for (const sessionId of coordinator.parentSessionIdsWithRuns?.() ?? []) {
      const binding = await this.readBinding(sessionId)
      await this.loadRecord(binding)
    }
    await coordinator.reconcile()
    await Promise.all([...this.records.values()].map((record) => record.eventQueue))
  }

  async readJournal(sessionId: string): Promise<EventEnvelope[]> {
    try {
      const content = await readFile(this.journalPath(sessionId), 'utf8')
      const lines = content.split('\n')
      if (lines.at(-1) === '') lines.pop()
      const events: EventEnvelope[] = []
      for (const [index, line] of lines.entries()) {
        try {
          events.push(JSON.parse(line) as EventEnvelope)
        } catch (error) {
          if (index !== lines.length - 1 || content.endsWith('\n')) throw error
          const validPrefix = lines.slice(0, index).join('\n')
          const handle = await open(this.journalPath(sessionId), 'r+')
          try {
            await handle.truncate(
              Buffer.byteLength(validPrefix.length > 0 ? `${validPrefix}\n` : ''),
            )
            await handle.sync()
          } finally {
            await handle.close()
          }
        }
      }
      return events
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
    const records = [...this.records.values()]
    for (const record of records) clearInterval(record.leaseHeartbeatTimer)
    try {
      await Promise.all(
        records.map((record) => {
          const activeRun = record.activeRun
          if (
            activeRun &&
            (activeRun.state === 'queued' ||
              activeRun.state === 'running' ||
              activeRun.state === 'cancelling')
          ) {
            return this.beginAbort(record, activeRun).then(() => activeRun.promise)
          }
          return activeRun?.promise
        }),
      )
      await Promise.all(records.map((record) => record.eventQueue))
    } finally {
      await Promise.all(records.map((record) => this.disposeRecord(record)))
      this.records.clear()
      this.loadingRecords.clear()
      this.listeners.clear()
      this.unsubscribeSubagents()
      this.unsubscribeMutationGrants()
    }
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
      mkdir(this.leasesRoot, { recursive: true }),
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
    await atomicWriteJson(
      this.bindingPath(binding.sessionId),
      binding,
      this.options.bindingAtomicWriteOptions?.(binding),
    )
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
        typeof (value as Binding).sessionFile === 'string' &&
        ((value as Binding).parentSessionId === undefined ||
          (typeof (value as Binding).parentSessionId === 'string' &&
            (value as Binding).parentSessionId !== sessionId)) &&
        this.isOfficeToolCatalogValid((value as Binding).officeToolCatalog)
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
    const pending = this.loadingRecords.get(binding.sessionId)
    if (pending) return pending
    const loading = this.loadNewRecord(binding)
    this.loadingRecords.set(binding.sessionId, loading)
    try {
      return await loading
    } finally {
      this.loadingRecords.delete(binding.sessionId)
    }
  }

  private async loadNewRecord(binding: Binding): Promise<SessionRecord> {
    const lease = await this.acquireLease(binding.sessionId)
    let pi: PiSessionHandle
    try {
      pi = await this.createPiSession({
        cwd: this.cwd,
        agentDir: this.agentDir,
        sessionDir: this.sessionDirectory(binding.documentId),
        sessionId: binding.sessionId,
        sessionFile: binding.sessionFile,
        documentId: binding.documentId,
        ...(binding.officeToolCatalog ? { officeToolCatalog: binding.officeToolCatalog } : {}),
      })
    } catch (error) {
      await lease.release()
      throw error
    }
    let record: SessionRecord
    try {
      record = await this.attach(binding, pi, lease)
    } catch (error) {
      pi.dispose()
      await lease.release()
      throw error
    }
    try {
      await this.appendEvent(record, 'session.opened', { restored: true })
      return record
    } catch (error) {
      await this.disposeRecord(record)
      throw error
    }
  }

  private isOfficeToolCatalogValid(binding: OfficeToolCatalogBinding | undefined): boolean {
    if (!binding) return true
    try {
      resolveOfficeToolDefinitions(binding)
      return true
    } catch {
      return false
    }
  }

  private assertOfficeToolCatalog(binding: OfficeToolCatalogBinding | undefined): void {
    if (!this.isOfficeToolCatalogValid(binding)) {
      throw new RuntimeSessionError('office_tool_catalog_mismatch')
    }
  }

  private assertOfficeToolCatalogMatch(
    persisted: OfficeToolCatalogBinding | undefined,
    requested: OfficeToolCatalogBinding | undefined,
  ): void {
    this.assertOfficeToolCatalog(requested)
    if (JSON.stringify(persisted) !== JSON.stringify(requested)) {
      throw new RuntimeSessionError('office_tool_catalog_mismatch')
    }
  }

  private async attach(
    binding: Binding,
    pi: PiSessionHandle,
    lease: SessionLeaseHandle,
  ): Promise<SessionRecord> {
    const previous = await this.readJournal(binding.sessionId)
    const record: SessionRecord = {
      binding,
      pi,
      lease,
      sequence: previous.at(-1)?.sequence ?? 0,
      eventQueue: Promise.resolve(),
      unsubscribe: () => {},
    }
    record.unsubscribe = pi.subscribe((event) => this.projectPiEvent(record, event))
    record.leaseHeartbeatTimer = setInterval(() => {
      void this.renewLease(record).catch(() => {})
    }, this.sessionLeaseHeartbeatMs)
    record.leaseHeartbeatTimer.unref()
    this.records.set(binding.sessionId, record)
    try {
      await this.recoverInterruptedRun(record, planSessionRecovery(previous))
      return record
    } catch (error) {
      clearInterval(record.leaseHeartbeatTimer)
      record.unsubscribe()
      this.records.delete(binding.sessionId)
      throw error
    }
  }

  private async recoverInterruptedRun(
    record: SessionRecord,
    recovery: SessionRecoveryPlan | undefined,
  ): Promise<void> {
    if (!recovery) return
    record.activeRun = {
      runId: recovery.runId,
      state: 'interrupted',
      abortTree: new RunAbortTree({
        cooperativeAbortMs: this.cooperativeAbortMs,
        forceAbortMs: this.forceAbortMs,
      }),
    }
    for (const tool of recovery.tools) {
      await this.appendEvent(
        record,
        tool.terminalType,
        {
          toolCallId: tool.toolCallId,
          ...(tool.toolName ? { toolName: tool.toolName } : {}),
          mutationOutcome: tool.mutationOutcome,
          recovered: true,
          ...(tool.mutationOutcome === 'unknown'
            ? { code: 'mutation_outcome_unknown', documentNeedsReview: true }
            : {}),
        },
        recovery.runId,
      )
    }
    await this.appendEvent(
      record,
      'run.interrupted',
      {
        reason: recovery.reason,
        documentNeedsReview: recovery.documentNeedsReview,
        tools: recovery.tools.map(({ toolCallId, mutationOutcome }) => ({
          toolCallId,
          mutationOutcome,
        })),
      },
      recovery.runId,
    )
  }

  private async assertIdle(record: SessionRecord): Promise<void> {
    if (
      record.activeRun &&
      (record.activeRun.state === 'queued' ||
        record.activeRun.state === 'running' ||
        record.activeRun.state === 'cancelling')
    ) {
      throw new RuntimeSessionError('invalid_state')
    }
    await record.activeRun?.promise
  }

  private projectPiEvent(record: SessionRecord, event: AgentSessionEvent) {
    const activeRun = record.activeRun
    const runId = activeRun?.runId
    if (!activeRun || !runId || activeRun.state === 'cancelling' || activeRun.state === 'aborted')
      return
    if (event.type === 'agent_start') {
      activeRun.state = 'running'
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
      const resultDetails = (event.result as { details?: unknown } | undefined)?.details
      const officeTool =
        resultDetails && typeof resultDetails === 'object'
          ? (resultDetails as { officeTool?: unknown }).officeTool
          : undefined
      const mutationOutcome =
        officeTool && typeof officeTool === 'object'
          ? (officeTool as { mutationOutcome?: unknown }).mutationOutcome
          : undefined
      const platformTool =
        resultDetails && typeof resultDetails === 'object'
          ? (resultDetails as { platformTool?: unknown }).platformTool
          : undefined
      let safePlatformTool: ReturnType<typeof parsePlatformToolDetails> | undefined
      try {
        if (platformTool !== undefined) safePlatformTool = parsePlatformToolDetails(platformTool)
      } catch {
        safePlatformTool = undefined
      }
      void this.appendEvent(
        record,
        event.isError ? 'tool.failed' : 'tool.completed',
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: !event.isError,
          ...(mutationOutcome === 'not_started' ||
          mutationOutcome === 'committed' ||
          mutationOutcome === 'rolled_back' ||
          mutationOutcome === 'unknown'
            ? { mutationOutcome }
            : {}),
          ...(safePlatformTool ? { platformTool: safePlatformTool } : {}),
        },
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
      activeRun.state = state
      record.pendingTerminalState = state
    }
  }

  private beginAbort(
    record: SessionRecord,
    activeRun: NonNullable<SessionRecord['activeRun']>,
  ): Promise<AbortReceipt> {
    activeRun.abortRegistration ??= this.registerAbort(record, activeRun)
    return activeRun.abortRegistration
  }

  private async registerAbort(
    record: SessionRecord,
    activeRun: NonNullable<SessionRecord['activeRun']>,
  ): Promise<AbortReceipt> {
    activeRun.state = 'cancelling'
    record.pendingTerminalState = undefined
    const acceptedEvent = this.appendEvent(record, 'run.cancelling', {}, activeRun.runId)
    activeRun.promise = activeRun.abortTree
      .abort()
      .then((summary) => this.finishAbort(record, activeRun, summary))
      .then(() => record.eventQueue)
    const accepted = await acceptedEvent
    const receipt: AbortReceipt = {
      runId: activeRun.runId,
      state: 'cancelling',
      acceptedCursor: accepted.cursor,
    }
    return receipt
  }

  private async finishAbort(
    record: SessionRecord,
    activeRun: NonNullable<SessionRecord['activeRun']>,
    summary: RunAbortSummary,
  ): Promise<void> {
    if (record.activeRun !== activeRun || activeRun.state !== 'cancelling') return
    if (!summary.complete) {
      activeRun.state = 'failed'
      await this.options.mutationGrants?.revokeForParentRun(activeRun.runId, 'parent_terminal')
      await this.appendEvent(
        record,
        'run.failed',
        {
          code: 'abort_incomplete',
          mutationOutcome: summary.descendants.some(
            (descendant) => descendant.mutationOutcome === 'unknown',
          )
            ? 'unknown'
            : 'not_started',
          documentNeedsReview: summary.descendants.some(
            (descendant) => descendant.mutationOutcome === 'unknown',
          ),
          descendants: summary.descendants,
        },
        activeRun.runId,
      )
      return
    }
    activeRun.state = 'aborted'
    await this.options.mutationGrants?.revokeForParentRun(activeRun.runId, 'parent_terminal')
    await this.appendEvent(
      record,
      'run.aborted',
      { descendants: summary.descendants },
      activeRun.runId,
    )
  }

  private appendEvent(
    record: SessionRecord,
    type: EventEnvelope['type'],
    payload: Record<string, unknown>,
    runId?: string,
  ): Promise<EventEnvelope> {
    let resolveEvent!: (event: EventEnvelope) => void
    let rejectEvent!: (error: unknown) => void
    const result = new Promise<EventEnvelope>((resolve, reject) => {
      resolveEvent = resolve
      rejectEvent = reject
    })
    const write = record.eventQueue.then(async () => {
      this.assertWritable(record)
      const sequence = record.sequence + 1
      const event: EventEnvelope = {
        protocolVersion: '1',
        kind: 'event',
        eventId: this.randomUUID(),
        instanceId: this.options.instanceId,
        sessionId: record.binding.sessionId,
        documentId: record.binding.documentId,
        ...(runId ? { runId } : {}),
        sequence,
        cursor: this.cursor(record.binding.sessionId, sequence),
        occurredAt: this.now().toISOString(),
        type,
        payload,
      }
      await appendFile(this.journalPath(record.binding.sessionId), `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      record.sequence = sequence
      for (const listener of this.listeners) listener(event)
      return event
    })
    record.eventQueue = write.then(
      () => undefined,
      () => {
        record.writeError = new RuntimeSessionError('invalid_state')
      },
    )
    write.then(resolveEvent, rejectEvent)
    return result
  }

  private async acquireLease(sessionId: string): Promise<SessionLeaseHandle> {
    try {
      return await this.sessionLeaseStore.acquire(sessionId)
    } catch (error) {
      if (error instanceof SessionLeaseError) throw new RuntimeSessionError(error.code)
      throw error
    }
  }

  private async renewLease(record: SessionRecord): Promise<void> {
    if (record.leaseError) throw record.leaseError
    record.leaseHeartbeat ??= record.lease
      .heartbeat()
      .then(() => undefined)
      .catch((error: unknown) => {
        record.leaseError =
          error instanceof SessionLeaseError
            ? new RuntimeSessionError(error.code)
            : new RuntimeSessionError('session_lease_lost')
        void record.pi.abort().catch(() => {})
      })
      .finally(() => {
        record.leaseHeartbeat = undefined
      })
    await record.leaseHeartbeat
    if (record.leaseError) throw record.leaseError
  }

  private assertWritable(record: SessionRecord): void {
    if (record.leaseError) throw record.leaseError
    if (record.writeError) throw record.writeError
  }

  private async disposeRecord(record: SessionRecord): Promise<void> {
    clearInterval(record.leaseHeartbeatTimer)
    await record.leaseHeartbeat
    this.records.delete(record.binding.sessionId)
    try {
      record.unsubscribe()
      record.pi.dispose()
    } finally {
      await record.lease.release()
    }
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
      ...(this.options.subagents
        ? {
            subagents: this.options.subagents
              .listForSession(record.binding.sessionId)
              .map(rendererSubagentProjection),
          }
        : {}),
      ...(this.options.mutationGrants
        ? { mutationGrants: this.options.mutationGrants.listForSession(record.binding.sessionId) }
        : {}),
      branch: {
        ...(record.binding.parentSessionId
          ? { parentSessionId: record.binding.parentSessionId }
          : {}),
        ...(record.pi.sessionManager.getLeafId()
          ? { activeLeafId: record.pi.sessionManager.getLeafId()! }
          : {}),
        nodes: record.pi.sessionManager
          .getEntries()
          .filter(
            (
              entry,
            ): entry is typeof entry & { id: string; parentId: string | null; type: string } =>
              typeof entry.id === 'string' &&
              (typeof entry.parentId === 'string' || entry.parentId === null) &&
              typeof entry.type === 'string',
          )
          .slice(-4096)
          .map((entry) => ({
            entryId: entry.id,
            parentEntryId: entry.parentId,
            kind: entry.type,
          })),
      },
      ...(record.activeRun
        ? { activeRun: { runId: record.activeRun.runId, state: record.activeRun.state } }
        : {}),
      lastSequence: record.sequence,
      cursor: this.cursor(record.binding.sessionId, record.sequence),
    }
  }

  private projectSubagentEvent(event: SubagentCoordinatorEvent): void {
    const parentSessionId = 'run' in event ? event.run.parentSessionId : event.parentSessionId
    const record = this.records.get(parentSessionId)
    if (!record) return
    const runId = 'run' in event ? event.run.runId : event.runId
    if (
      'run' in event &&
      (event.run.status === 'completed' ||
        event.run.status === 'failed' ||
        event.run.status === 'cancelled')
    ) {
      void this.options.mutationGrants?.revokeForRun(runId, 'subagent_terminal')
    }
    if ('run' in event) {
      void this.appendEvent(
        record,
        `subagent.${event.type}` as EventEnvelope['type'],
        rendererSubagentProjection(event.run),
        runId,
      )
      return
    }
    void this.appendEvent(
      record,
      `subagent.${event.type}` as EventEnvelope['type'],
      {
        runId,
        rootRunId: event.rootRunId,
        parentRunId: event.parentRunId,
        ...(event.text ? { text: event.text } : {}),
        ...(event.toolId ? { toolId: event.toolId } : {}),
      },
      runId,
    )
  }

  private projectMutationGrantEvent(event: {
    parentSessionId: string
    documentId: string
    projection: MutationGrantProjection
  }): void {
    const record = this.records.get(event.parentSessionId)
    if (!record || record.binding.documentId !== event.documentId) return
    void this.appendEvent(
      record,
      'mutation-grant.updated',
      event.projection,
      event.projection.subagentRunId,
    )
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

function rendererSubagentProjection(
  projection: SubagentRunProjection,
): RendererSubagentRunProjection {
  const { parentSessionId: _parentSessionId, documentId: _documentId, ...renderer } = projection
  return renderer
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  return new SessionRegistry(options)
}
