import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type CapabilitySnapshot } from '@genoffice/agent-resource'

const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$',
})
const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })

export const SubagentRootBudgetSchema = Type.Object(
  {
    maxDepth: Type.Integer({ minimum: 1, maximum: 16 }),
    maxChildren: Type.Integer({ minimum: 1, maximum: 256 }),
    maxConcurrency: Type.Integer({ minimum: 1, maximum: 64 }),
    maxWallTimeMs: Type.Integer({ minimum: 1_000, maximum: 24 * 60 * 60 * 1_000 }),
    maxTokens: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    maxCostUsd: Type.Number({ minimum: 0, maximum: 100_000 }),
    maxToolCalls: Type.Integer({ minimum: 0, maximum: 100_000 }),
  },
  { additionalProperties: false },
)

export type SubagentRootBudget = Static<typeof SubagentRootBudgetSchema>

export const DEFAULT_SUBAGENT_ROOT_BUDGET: Readonly<SubagentRootBudget> = Object.freeze({
  maxDepth: 2,
  maxChildren: 8,
  maxConcurrency: 4,
  maxWallTimeMs: 30 * 60 * 1_000,
  maxTokens: 200_000,
  maxCostUsd: 10,
  maxToolCalls: 128,
})

const SubagentUsageSchema = Type.Object(
  {
    inputTokens: Type.Number({ minimum: 0 }),
    outputTokens: Type.Number({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    toolCalls: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
)

export type SubagentUsage = Static<typeof SubagentUsageSchema>

const CapabilitySnapshotSchema = Type.Object(
  {
    snapshotId: Sha256Schema,
    createdForRunId: EntityIdSchema,
    model: Type.Object(
      {
        providerId: EntityIdSchema,
        modelId: EntityIdSchema,
        capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 64,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    resourceHashes: Type.Record(EntityIdSchema, Sha256Schema),
    toolIds: Type.Array(EntityIdSchema, { maxItems: 2_048, uniqueItems: true }),
    permissionVersion: EntityIdSchema,
  },
  { additionalProperties: false },
)

export const SubagentRunStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('waiting'),
  Type.Literal('cancelling'),
  Type.Literal('reconciling'),
  Type.Literal('resumable'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
])

export type SubagentRunStatus = Static<typeof SubagentRunStatusSchema>

const SubagentResultSchema = Type.Object(
  {
    kind: Type.Literal('text'),
    text: Type.String({ maxLength: 64 * 1024 }),
  },
  { additionalProperties: false },
)

export type SubagentResult = Static<typeof SubagentResultSchema>

const SubagentRunRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: EntityIdSchema,
    rootRunId: EntityIdSchema,
    parentRunId: EntityIdSchema,
    parentSessionId: EntityIdSchema,
    sessionId: EntityIdSchema,
    documentId: EntityIdSchema,
    projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
    role: Type.String({ minLength: 1, maxLength: 128 }),
    depth: Type.Integer({ minimum: 1, maximum: 16 }),
    model: Type.Object(
      { providerId: EntityIdSchema, modelId: EntityIdSchema },
      { additionalProperties: false },
    ),
    status: SubagentRunStatusSchema,
    attempt: Type.Integer({ minimum: 1 }),
    attemptId: EntityIdSchema,
    correlationId: EntityIdSchema,
    providerRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    providerAttemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    budget: SubagentRootBudgetSchema,
    usage: SubagentUsageSchema,
    attemptUsage: SubagentUsageSchema,
    capabilitySnapshot: CapabilitySnapshotSchema,
    createdAt: Type.String({ minLength: 1, maxLength: 64 }),
    updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
    startedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    completedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    result: Type.Optional(SubagentResultSchema),
    errorCode: Type.Optional(EntityIdSchema),
  },
  { additionalProperties: false },
)

export type SubagentRunRecord = Static<typeof SubagentRunRecordSchema>

export type SubagentRunProjection = {
  runId: string
  rootRunId: string
  parentRunId: string
  parentSessionId: string
  documentId: string
  role: string
  depth: number
  model: { providerId: string; modelId: string }
  status: SubagentRunStatus
  attempt: number
  usage: SubagentUsage
  capabilitySnapshotId: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  result?: SubagentResult
  errorCode?: string
}

export type SubagentRegistryEvent = {
  type:
    | 'queued'
    | 'started'
    | 'waiting'
    | 'usage.updated'
    | 'child.linked'
    | 'cancelling'
    | 'reconciling'
    | 'resumable'
    | 'completed'
    | 'failed'
    | 'cancelled'
  projection: SubagentRunProjection
}

export type CreateSubagentRunInput = {
  runId?: string
  rootRunId: string
  parentRunId: string
  parentSessionId: string
  documentId: string
  role: string
  model: { providerId: string; modelId: string }
  budget?: SubagentRootBudget
  capabilitySnapshot: CapabilitySnapshot
  sessionId?: string
  projectRoot?: string
}

export type SubagentRunRegistryErrorCode =
  | 'subagent_registry_invalid'
  | 'subagent_run_not_found'
  | 'subagent_state_invalid'
  | 'subagent_budget_invalid'
  | 'subagent_budget_depth'
  | 'subagent_budget_children'
  | 'subagent_budget_concurrency'
  | 'subagent_budget_wall_time'
  | 'subagent_budget_tokens'
  | 'subagent_budget_cost'
  | 'subagent_budget_tools'

export class SubagentRunRegistryError extends Error {
  constructor(readonly code: SubagentRunRegistryErrorCode) {
    super(code)
    this.name = 'SubagentRunRegistryError'
  }
}

export type SubagentRunRegistryOptions = {
  rootDirectory: string
  randomUUID?: () => string
  now?: () => Date
}

const ACTIVE_STATES = new Set<SubagentRunStatus>([
  'queued',
  'running',
  'waiting',
  'cancelling',
  'reconciling',
])

const EMPTY_USAGE: Readonly<SubagentUsage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  toolCalls: 0,
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isTerminal(status: SubagentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function assertBudget(value: SubagentRootBudget): void {
  if (!Value.Check(SubagentRootBudgetSchema, value)) {
    throw new SubagentRunRegistryError('subagent_budget_invalid')
  }
}

function sameBudget(left: SubagentRootBudget, right: SubagentRootBudget): boolean {
  return (
    left.maxDepth === right.maxDepth &&
    left.maxChildren === right.maxChildren &&
    left.maxConcurrency === right.maxConcurrency &&
    left.maxWallTimeMs === right.maxWallTimeMs &&
    left.maxTokens === right.maxTokens &&
    left.maxCostUsd === right.maxCostUsd &&
    left.maxToolCalls === right.maxToolCalls
  )
}

function parseRecord(value: unknown): SubagentRunRecord {
  if (!Value.Check(SubagentRunRecordSchema, value)) {
    throw new SubagentRunRegistryError('subagent_registry_invalid')
  }
  return value
}

export class SubagentRunRegistry {
  private readonly directory: string
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly records = new Map<string, SubagentRunRecord>()
  private readonly listeners = new Set<(event: SubagentRegistryEvent) => void>()
  private writes = Promise.resolve()
  private initialized = false

  constructor(options: SubagentRunRegistryOptions) {
    this.directory = join(options.rootDirectory, 'state', 'subagent-runs')
    this.randomUUID = options.randomUUID ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.directory, { withFileTypes: true })
    const loaded = new Map<string, SubagentRunRecord>()
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.json')) continue
      const path = join(this.directory, entry.name)
      const metadata = await lstat(path)
      if (!entry.isFile() || metadata.isSymbolicLink()) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      let value: unknown
      try {
        value = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      const record = parseRecord(value)
      if (`${record.runId}.json` !== entry.name || loaded.has(record.runId)) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      loaded.set(record.runId, record)
    }
    this.assertLoadedLineage(loaded)
    this.records.clear()
    for (const [runId, record] of loaded) this.records.set(runId, record)
    this.initialized = true
  }

  onEvent(listener: (event: SubagentRegistryEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    return this.enqueue(async () => {
      this.assertInitialized()
      const budget = clone(input.budget ?? DEFAULT_SUBAGENT_ROOT_BUDGET)
      assertBudget(budget)
      if (!Value.Check(CapabilitySnapshotSchema, input.capabilitySnapshot)) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      const rootRecords = this.rootRecords(input.rootRunId)
      const rootBudget = rootRecords[0]?.budget ?? budget
      if (rootRecords.length > 0 && !sameBudget(rootBudget, budget)) {
        throw new SubagentRunRegistryError('subagent_budget_invalid')
      }
      const parent = this.records.get(input.parentRunId)
      if (parent && parent.rootRunId !== input.rootRunId) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      const depth = parent ? parent.depth + 1 : 1
      if (depth > rootBudget.maxDepth) {
        throw new SubagentRunRegistryError('subagent_budget_depth')
      }
      if (rootRecords.length >= rootBudget.maxChildren) {
        throw new SubagentRunRegistryError('subagent_budget_children')
      }
      if (
        rootRecords.filter((record) => ACTIVE_STATES.has(record.status)).length >=
        rootBudget.maxConcurrency
      ) {
        throw new SubagentRunRegistryError('subagent_budget_concurrency')
      }
      const runId = input.runId ?? this.randomUUID()
      if (this.records.has(runId)) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
      const createdAt = this.now().toISOString()
      const record: SubagentRunRecord = {
        schemaVersion: 1,
        runId,
        rootRunId: input.rootRunId,
        parentRunId: input.parentRunId,
        parentSessionId: input.parentSessionId,
        sessionId: input.sessionId ?? this.randomUUID(),
        documentId: input.documentId,
        ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
        role: input.role,
        depth,
        model: {
          providerId: input.model.providerId,
          modelId: input.model.modelId,
        },
        status: 'queued',
        attempt: 1,
        attemptId: this.randomUUID(),
        correlationId: this.randomUUID(),
        budget: clone(rootBudget),
        usage: clone(EMPTY_USAGE),
        attemptUsage: clone(EMPTY_USAGE),
        capabilitySnapshot: clone(input.capabilitySnapshot),
        createdAt,
        updatedAt: createdAt,
      }
      parseRecord(record)
      this.records.set(runId, record)
      await this.persist(record)
      this.emit('queued', record)
      if (parent) this.emit('child.linked', record)
      return clone(record)
    })
  }

  markStarted(
    runId: string,
    provider: { providerRunId: string; providerAttemptId: string },
  ): Promise<void> {
    return this.update(runId, ['queued'], 'started', (record) => {
      record.status = 'running'
      record.providerRunId = provider.providerRunId
      record.providerAttemptId = provider.providerAttemptId
      record.startedAt ??= this.now().toISOString()
      delete record.errorCode
    })
  }

  markWaiting(runId: string, waiting: boolean): Promise<void> {
    return this.update(runId, waiting ? ['running'] : ['waiting'], 'waiting', (record) => {
      record.status = waiting ? 'waiting' : 'running'
    })
  }

  updateUsage(
    runId: string,
    usage: Partial<SubagentUsage>,
    mode: 'delta' | 'attempt-total' = 'delta',
  ): Promise<void> {
    return this.enqueue(async () => {
      const record = this.require(runId)
      if (isTerminal(record.status) || record.status === 'resumable') {
        throw new SubagentRunRegistryError('subagent_state_invalid')
      }
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new SubagentRunRegistryError('subagent_budget_invalid')
        }
        const usageKey = key as keyof SubagentUsage
        const delta =
          mode === 'attempt-total' ? Math.max(0, value - record.attemptUsage[usageKey]) : value
        record.attemptUsage[usageKey] += delta
        record.usage[usageKey] += delta
      }
      record.updatedAt = this.now().toISOString()
      const code = this.budgetError(record.rootRunId)
      if (code) {
        record.status = 'cancelling'
        record.errorCode = code
      }
      await this.persist(record)
      this.emit(code ? 'cancelling' : 'usage.updated', record)
      if (code) throw new SubagentRunRegistryError(code)
    })
  }

  assertWallTime(runId: string): Promise<void> {
    return this.enqueue(async () => {
      const record = this.require(runId)
      const rootStarted = this.rootRecords(record.rootRunId)
        .map((candidate) => candidate.startedAt ?? candidate.createdAt)
        .sort()[0]
      if (
        !rootStarted ||
        this.now().getTime() - new Date(rootStarted).getTime() <= record.budget.maxWallTimeMs
      )
        return
      record.status = 'cancelling'
      record.errorCode = 'subagent_budget_wall_time'
      record.updatedAt = this.now().toISOString()
      await this.persist(record)
      this.emit('cancelling', record)
      throw new SubagentRunRegistryError('subagent_budget_wall_time')
    })
  }

  complete(runId: string, input: { result: SubagentResult }): Promise<void> {
    return this.update(
      runId,
      ['running', 'waiting', 'queued', 'reconciling'],
      'completed',
      (record) => {
        if (!Value.Check(SubagentResultSchema, input.result)) {
          throw new SubagentRunRegistryError('subagent_registry_invalid')
        }
        record.status = 'completed'
        record.result = clone(input.result)
        record.completedAt = this.now().toISOString()
        delete record.errorCode
      },
    )
  }

  fail(runId: string, errorCode: string): Promise<void> {
    return this.update(
      runId,
      ['queued', 'running', 'waiting', 'cancelling', 'reconciling'],
      'failed',
      (record) => {
        record.status = 'failed'
        record.errorCode = errorCode
        record.completedAt = this.now().toISOString()
      },
    )
  }

  cancel(runId: string): Promise<void> {
    return this.update(
      runId,
      ['queued', 'running', 'waiting', 'cancelling', 'reconciling'],
      'cancelled',
      (record) => {
        record.status = 'cancelled'
        record.completedAt = this.now().toISOString()
      },
    )
  }

  beginCancelling(runId: string, errorCode?: string): Promise<void> {
    return this.update(runId, ['queued', 'running', 'waiting'], 'cancelling', (record) => {
      record.status = 'cancelling'
      if (errorCode) record.errorCode = errorCode
    })
  }

  markReconciled(runId: string, input: { resumable: boolean; errorCode: string }): Promise<void> {
    return this.update(
      runId,
      ['queued', 'running', 'waiting', 'cancelling', 'reconciling'],
      input.resumable ? 'resumable' : 'failed',
      (record) => {
        record.status = input.resumable ? 'resumable' : 'failed'
        record.errorCode = input.errorCode
        if (!input.resumable) record.completedAt = this.now().toISOString()
      },
    )
  }

  beginReconcile(runId: string): Promise<void> {
    return this.update(
      runId,
      ['queued', 'running', 'waiting', 'cancelling'],
      'reconciling',
      (record) => {
        record.status = 'reconciling'
      },
    )
  }

  beginResume(runId: string): Promise<void> {
    return this.update(runId, ['resumable'], 'queued', (record) => {
      record.status = 'queued'
      record.attempt += 1
      record.attemptId = this.randomUUID()
      record.updatedAt = this.now().toISOString()
      delete record.providerRunId
      delete record.providerAttemptId
      delete record.completedAt
      delete record.errorCode
      delete record.result
      record.attemptUsage = clone(EMPTY_USAGE)
    })
  }

  get(runId: string): SubagentRunProjection | undefined {
    const record = this.records.get(runId)
    return record ? this.project(record) : undefined
  }

  getInternal(runId: string): SubagentRunRecord | undefined {
    const record = this.records.get(runId)
    return record ? clone(record) : undefined
  }

  listForSession(parentSessionId: string): SubagentRunProjection[] {
    return [...this.records.values()]
      .filter((record) => record.parentSessionId === parentSessionId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
      )
      .map((record) => this.project(record))
  }

  listChildren(parentRunId: string): SubagentRunProjection[] {
    return [...this.records.values()]
      .filter((record) => record.parentRunId === parentRunId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId),
      )
      .map((record) => this.project(record))
  }

  activeRuns(): SubagentRunRecord[] {
    return [...this.records.values()]
      .filter((record) => ACTIVE_STATES.has(record.status))
      .map(clone)
  }

  private update(
    runId: string,
    allowed: readonly SubagentRunStatus[],
    event: SubagentRegistryEvent['type'],
    mutate: (record: SubagentRunRecord) => void,
  ): Promise<void> {
    return this.enqueue(async () => {
      const record = this.require(runId)
      if (!allowed.includes(record.status)) {
        throw new SubagentRunRegistryError('subagent_state_invalid')
      }
      mutate(record)
      record.updatedAt = this.now().toISOString()
      parseRecord(record)
      await this.persist(record)
      this.emit(event, record)
    })
  }

  private project(record: SubagentRunRecord): SubagentRunProjection {
    const durationEnd =
      record.completedAt ??
      (ACTIVE_STATES.has(record.status) ? this.now().toISOString() : undefined)
    const durationMs = durationEnd
      ? Math.max(
          0,
          new Date(durationEnd).getTime() -
            new Date(record.startedAt ?? record.createdAt).getTime(),
        )
      : undefined
    return clone({
      runId: record.runId,
      rootRunId: record.rootRunId,
      parentRunId: record.parentRunId,
      parentSessionId: record.parentSessionId,
      documentId: record.documentId,
      role: record.role,
      depth: record.depth,
      model: record.model,
      status: record.status,
      attempt: record.attempt,
      usage: record.usage,
      capabilitySnapshotId: record.capabilitySnapshot.snapshotId,
      createdAt: record.createdAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(record.result ? { result: record.result } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    })
  }

  private budgetError(rootRunId: string): SubagentRunRegistryErrorCode | undefined {
    const records = this.rootRecords(rootRunId)
    const budget = records[0]?.budget
    if (!budget) return undefined
    const usage = records.reduce(
      (total, record) => ({
        inputTokens: total.inputTokens + record.usage.inputTokens,
        outputTokens: total.outputTokens + record.usage.outputTokens,
        costUsd: total.costUsd + record.usage.costUsd,
        toolCalls: total.toolCalls + record.usage.toolCalls,
      }),
      clone(EMPTY_USAGE),
    )
    if (usage.inputTokens + usage.outputTokens > budget.maxTokens) return 'subagent_budget_tokens'
    if (usage.costUsd > budget.maxCostUsd) return 'subagent_budget_cost'
    if (usage.toolCalls > budget.maxToolCalls) return 'subagent_budget_tools'
    return undefined
  }

  private rootRecords(rootRunId: string): SubagentRunRecord[] {
    return [...this.records.values()].filter((record) => record.rootRunId === rootRunId)
  }

  private require(runId: string): SubagentRunRecord {
    this.assertInitialized()
    const record = this.records.get(runId)
    if (!record) throw new SubagentRunRegistryError('subagent_run_not_found')
    return record
  }

  private async persist(record: SubagentRunRecord): Promise<void> {
    await atomicWriteJson(join(this.directory, `${record.runId}.json`), record)
  }

  private emit(type: SubagentRegistryEvent['type'], record: SubagentRunRecord): void {
    const event: SubagentRegistryEvent = { type, projection: this.project(record) }
    for (const listener of this.listeners) listener(event)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new SubagentRunRegistryError('subagent_registry_invalid')
  }

  private assertLoadedLineage(records: ReadonlyMap<string, SubagentRunRecord>): void {
    for (const record of records.values()) {
      const parent = records.get(record.parentRunId)
      if (!parent) {
        if (record.depth !== 1) throw new SubagentRunRegistryError('subagent_registry_invalid')
        continue
      }
      if (
        parent.rootRunId !== record.rootRunId ||
        parent.parentSessionId !== record.parentSessionId ||
        parent.documentId !== record.documentId ||
        parent.depth + 1 !== record.depth ||
        JSON.stringify(parent.budget) !== JSON.stringify(record.budget)
      ) {
        throw new SubagentRunRegistryError('subagent_registry_invalid')
      }
    }
  }
}
