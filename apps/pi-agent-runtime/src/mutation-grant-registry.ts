import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson } from '@genoffice/agent-resource'

const EntityIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$',
})
const OfficeToolIdSchema = Type.String({
  maxLength: 256,
  pattern: '^office:[a-z0-9-]+:[a-z][a-z0-9_]*$',
})
const GrantStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('denied'),
  Type.Literal('active'),
  Type.Literal('revoked'),
  Type.Literal('expired'),
])

const MutationGrantRecordSchema = Type.Object(
  {
    requestId: EntityIdSchema,
    parentSessionId: EntityIdSchema,
    parentRunId: EntityIdSchema,
    subagentRunId: EntityIdSchema,
    documentId: EntityIdSchema,
    role: Type.String({ minLength: 1, maxLength: 128 }),
    exactToolIds: Type.Array(OfficeToolIdSchema, {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
    requestedAt: Type.String({ minLength: 20, maxLength: 32 }),
    requestExpiresAt: Type.String({ minLength: 20, maxLength: 32 }),
    status: GrantStatusSchema,
    grantId: Type.Optional(EntityIdSchema),
    issuedByUserActionId: Type.Optional(EntityIdSchema),
    issuedAt: Type.Optional(Type.String({ minLength: 20, maxLength: 32 })),
    expiresAt: Type.Optional(Type.String({ minLength: 20, maxLength: 32 })),
    revokedByUserActionId: Type.Optional(EntityIdSchema),
    terminalReason: Type.Optional(EntityIdSchema),
  },
  { additionalProperties: false },
)

const MutationGrantStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    records: Type.Array(MutationGrantRecordSchema, { maxItems: 4_096 }),
  },
  { additionalProperties: false },
)

type MutationGrantRecord = Static<typeof MutationGrantRecordSchema>

export type MutationGrantRun = {
  runId: string
  parentRunId: string
  parentSessionId: string
  documentId: string
  role: string
  status: string
  grantableToolIds: readonly string[]
}

export type MutationGrantReceipt = {
  grantId: string
  subagentRunId: string
  documentId: string
  exactToolIds: string[]
  issuedByUserActionId: string
  issuedAt: string
  expiresAt: string
  status: 'active'
}

export type MutationGrantProjection = {
  requestId: string
  subagentRunId: string
  role: string
  exactToolIds: string[]
  requestedAt: string
  expiresAt: string
  status: Static<typeof GrantStatusSchema>
  grantId?: string
}

export type MutationGrantRegistryEvent = {
  parentSessionId: string
  documentId: string
  projection: MutationGrantProjection
}

export type MutationGrantRegistryErrorCode =
  | 'mutation_grant_state_invalid'
  | 'mutation_grant_request_invalid'
  | 'mutation_grant_binding_invalid'
  | 'mutation_grant_tool_invalid'
  | 'mutation_grant_run_terminal'
  | 'mutation_grant_receipt_invalid'
  | 'mutation_grant_not_found'
  | 'mutation_grant_denied'

export class MutationGrantRegistryError extends Error {
  constructor(readonly code: MutationGrantRegistryErrorCode) {
    super(code)
    this.name = 'MutationGrantRegistryError'
  }
}

export type MutationGrantRegistryOptions = {
  rootDirectory: string
  inspectRun(runId: string): MutationGrantRun | undefined
  resolveEffect(toolId: string): 'read' | 'mutation' | 'external' | 'orchestration' | undefined
  randomUUID?: () => string
  now?: () => Date
  requestTtlMs?: number
  maxGrantTtlMs?: number
}

const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'waiting'])
const DEFAULT_REQUEST_TTL_MS = 5 * 60 * 1_000
const DEFAULT_MAX_GRANT_TTL_MS = 10 * 60 * 1_000

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validDate(value: string): number | undefined {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function safeReason(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : 'revoked'
}

export class MutationGrantRegistry {
  private readonly path: string
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly requestTtlMs: number
  private readonly maxGrantTtlMs: number
  private readonly records = new Map<string, MutationGrantRecord>()
  private readonly listeners = new Set<(event: MutationGrantRegistryEvent) => void>()
  private writes = Promise.resolve()
  private initialized = false

  constructor(private readonly options: MutationGrantRegistryOptions) {
    this.path = join(options.rootDirectory, 'state', 'mutation-grants.json')
    this.randomUUID = options.randomUUID ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.requestTtlMs = Math.max(1_000, options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS)
    this.maxGrantTtlMs = Math.max(1_000, options.maxGrantTtlMs ?? DEFAULT_MAX_GRANT_TTL_MS)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(join(this.options.rootDirectory, 'state'), { recursive: true, mode: 0o700 })
    let value: unknown = { schemaVersion: 1, records: [] }
    try {
      const metadata = await lstat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new MutationGrantRegistryError('mutation_grant_state_invalid')
      }
      value = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof MutationGrantRegistryError) throw error
        throw new MutationGrantRegistryError('mutation_grant_state_invalid')
      }
    }
    if (!Value.Check(MutationGrantStateSchema, value)) {
      throw new MutationGrantRegistryError('mutation_grant_state_invalid')
    }
    this.records.clear()
    for (const record of value.records) {
      if (this.records.has(record.requestId)) {
        throw new MutationGrantRegistryError('mutation_grant_state_invalid')
      }
      this.records.set(record.requestId, clone(record))
    }
    this.initialized = true
    await this.expireCurrent()
  }

  onEvent(listener: (event: MutationGrantRegistryEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request(input: {
    parentSessionId: string
    subagentRunId: string
    documentId: string
    exactToolIds: readonly string[]
  }): Promise<MutationGrantProjection> {
    return this.enqueue(async () => {
      this.assertInitialized()
      const run = this.requireActiveRun(input.subagentRunId)
      if (run.parentSessionId !== input.parentSessionId || run.documentId !== input.documentId) {
        throw new MutationGrantRegistryError('mutation_grant_binding_invalid')
      }
      const exactToolIds = [...new Set(input.exactToolIds)].sort()
      if (exactToolIds.length !== input.exactToolIds.length || exactToolIds.length === 0) {
        throw new MutationGrantRegistryError('mutation_grant_tool_invalid')
      }
      for (const toolId of exactToolIds) {
        if (
          !Value.Check(OfficeToolIdSchema, toolId) ||
          this.options.resolveEffect(toolId) !== 'mutation' ||
          !run.grantableToolIds.includes(toolId)
        ) {
          throw new MutationGrantRegistryError('mutation_grant_tool_invalid')
        }
      }
      const now = this.now()
      const record: MutationGrantRecord = {
        requestId: this.randomUUID(),
        parentSessionId: run.parentSessionId,
        parentRunId: run.parentRunId,
        subagentRunId: run.runId,
        documentId: run.documentId,
        role: run.role,
        exactToolIds,
        requestedAt: now.toISOString(),
        requestExpiresAt: new Date(now.getTime() + this.requestTtlMs).toISOString(),
        status: 'pending',
      }
      if (!Value.Check(MutationGrantRecordSchema, record) || this.records.has(record.requestId)) {
        throw new MutationGrantRegistryError('mutation_grant_request_invalid')
      }
      this.records.set(record.requestId, record)
      await this.persist()
      this.emit(record)
      return this.project(record)
    })
  }

  issue(requestId: string, receipt: MutationGrantReceipt): Promise<MutationGrantProjection> {
    return this.enqueue(async () => {
      this.assertInitialized()
      const record = this.records.get(requestId)
      if (!record) throw new MutationGrantRegistryError('mutation_grant_not_found')
      if (record.status === 'active' && this.sameReceipt(record, receipt))
        return this.project(record)
      if (record.status !== 'pending') {
        throw new MutationGrantRegistryError('mutation_grant_receipt_invalid')
      }
      this.requireActiveRun(record.subagentRunId)
      const now = this.now().getTime()
      const issuedAt = validDate(receipt.issuedAt)
      const expiresAt = validDate(receipt.expiresAt)
      const requestExpiresAt = validDate(record.requestExpiresAt)!
      if (
        !Value.Check(EntityIdSchema, receipt.grantId) ||
        !Value.Check(EntityIdSchema, receipt.issuedByUserActionId) ||
        receipt.status !== 'active' ||
        receipt.subagentRunId !== record.subagentRunId ||
        receipt.documentId !== record.documentId ||
        !sameStrings([...receipt.exactToolIds].sort(), record.exactToolIds) ||
        issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt < validDate(record.requestedAt)! ||
        issuedAt > now + 5_000 ||
        expiresAt <= now ||
        expiresAt > issuedAt + this.maxGrantTtlMs ||
        now >= requestExpiresAt ||
        this.findByGrantId(receipt.grantId)
      ) {
        throw new MutationGrantRegistryError('mutation_grant_receipt_invalid')
      }
      Object.assign(record, {
        grantId: receipt.grantId,
        issuedByUserActionId: receipt.issuedByUserActionId,
        issuedAt: receipt.issuedAt,
        expiresAt: receipt.expiresAt,
        status: 'active' as const,
      })
      await this.persist()
      this.emit(record)
      return this.project(record)
    })
  }

  deny(requestId: string, userActionId: string): Promise<MutationGrantProjection> {
    return this.enqueue(async () => {
      const record = this.records.get(requestId)
      if (!record || record.status !== 'pending' || !Value.Check(EntityIdSchema, userActionId)) {
        throw new MutationGrantRegistryError('mutation_grant_denied')
      }
      record.status = 'denied'
      record.revokedByUserActionId = userActionId
      await this.persist()
      this.emit(record)
      return this.project(record)
    })
  }

  revoke(grantId: string, userActionId: string): Promise<MutationGrantProjection> {
    return this.enqueue(async () => {
      const record = this.findByGrantId(grantId)
      if (!record || record.status !== 'active' || !Value.Check(EntityIdSchema, userActionId)) {
        throw new MutationGrantRegistryError('mutation_grant_denied')
      }
      record.status = 'revoked'
      record.revokedByUserActionId = userActionId
      await this.persist()
      this.emit(record)
      return this.project(record)
    })
  }

  authorize(input: {
    grantId: string
    subagentRunId: string
    documentId: string
    toolId: string
  }): Promise<MutationGrantReceipt> {
    return this.enqueue(async () => {
      await this.expireCurrent(false)
      const record = this.findByGrantId(input.grantId)
      const run = this.options.inspectRun(input.subagentRunId)
      if (
        !record ||
        record.status !== 'active' ||
        !run ||
        !ACTIVE_RUN_STATES.has(run.status) ||
        record.subagentRunId !== input.subagentRunId ||
        record.documentId !== input.documentId ||
        !record.exactToolIds.includes(input.toolId) ||
        this.options.resolveEffect(input.toolId) !== 'mutation'
      ) {
        if (
          record?.status === 'active' &&
          record.subagentRunId === input.subagentRunId &&
          (!run || !ACTIVE_RUN_STATES.has(run.status))
        ) {
          record.status = 'revoked'
          record.terminalReason = 'subagent_terminal'
          await this.persist()
          this.emit(record)
        }
        throw new MutationGrantRegistryError('mutation_grant_denied')
      }
      return this.receipt(record)
    })
  }

  listForSession(parentSessionId: string): MutationGrantProjection[] {
    if (this.expireInMemory()) void this.enqueue(() => this.persist())
    return [...this.records.values()]
      .filter((record) => record.parentSessionId === parentSessionId)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((record) => this.project(record))
  }

  revokeForRun(runId: string, reason: string): Promise<void> {
    return this.revokeWhere((record) => record.subagentRunId === runId, reason)
  }

  revokeForParentRun(parentRunId: string, reason: string): Promise<void> {
    return this.revokeWhere((record) => record.parentRunId === parentRunId, reason)
  }

  revokeForDocument(documentId: string, reason: string): Promise<void> {
    return this.revokeWhere((record) => record.documentId === documentId, reason)
  }

  private requireActiveRun(runId: string): MutationGrantRun {
    const run = this.options.inspectRun(runId)
    if (!run) throw new MutationGrantRegistryError('mutation_grant_binding_invalid')
    if (!ACTIVE_RUN_STATES.has(run.status)) {
      throw new MutationGrantRegistryError('mutation_grant_run_terminal')
    }
    return run
  }

  private revokeWhere(
    predicate: (record: MutationGrantRecord) => boolean,
    reason: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      let changed = false
      for (const record of this.records.values()) {
        if (!predicate(record) || (record.status !== 'pending' && record.status !== 'active'))
          continue
        record.status = 'revoked'
        record.terminalReason = safeReason(reason)
        changed = true
        this.emit(record)
      }
      if (changed) await this.persist()
    })
  }

  private async expireCurrent(enqueue = true): Promise<void> {
    if (enqueue) {
      await this.enqueue(async () => {
        if (this.expireInMemory()) await this.persist()
      })
      return
    }
    if (this.expireInMemory()) await this.persist()
  }

  private expireInMemory(): boolean {
    const now = this.now().getTime()
    let changed = false
    for (const record of this.records.values()) {
      const expiry = validDate(record.expiresAt ?? record.requestExpiresAt)
      if (
        (record.status === 'pending' || record.status === 'active') &&
        expiry !== undefined &&
        now >= expiry
      ) {
        record.status = 'expired'
        changed = true
        this.emit(record)
      }
    }
    return changed
  }

  private sameReceipt(record: MutationGrantRecord, receipt: MutationGrantReceipt): boolean {
    return (
      record.grantId === receipt.grantId &&
      record.subagentRunId === receipt.subagentRunId &&
      record.documentId === receipt.documentId &&
      sameStrings(record.exactToolIds, [...receipt.exactToolIds].sort()) &&
      record.issuedByUserActionId === receipt.issuedByUserActionId &&
      record.issuedAt === receipt.issuedAt &&
      record.expiresAt === receipt.expiresAt &&
      receipt.status === 'active'
    )
  }

  private findByGrantId(grantId: string): MutationGrantRecord | undefined {
    return [...this.records.values()].find((record) => record.grantId === grantId)
  }

  private receipt(record: MutationGrantRecord): MutationGrantReceipt {
    if (!record.grantId || !record.issuedByUserActionId || !record.issuedAt || !record.expiresAt) {
      throw new MutationGrantRegistryError('mutation_grant_state_invalid')
    }
    return {
      grantId: record.grantId,
      subagentRunId: record.subagentRunId,
      documentId: record.documentId,
      exactToolIds: clone(record.exactToolIds),
      issuedByUserActionId: record.issuedByUserActionId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      status: 'active',
    }
  }

  private project(record: MutationGrantRecord): MutationGrantProjection {
    return clone({
      requestId: record.requestId,
      subagentRunId: record.subagentRunId,
      role: record.role,
      exactToolIds: record.exactToolIds,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt ?? record.requestExpiresAt,
      status: record.status,
      ...(record.grantId ? { grantId: record.grantId } : {}),
    })
  }

  private emit(record: MutationGrantRecord): void {
    const event = {
      parentSessionId: record.parentSessionId,
      documentId: record.documentId,
      projection: this.project(record),
    }
    for (const listener of this.listeners) listener(clone(event))
  }

  private persist(): Promise<void> {
    return atomicWriteJson(this.path, {
      schemaVersion: 1,
      records: [...this.records.values()].sort((left, right) =>
        left.requestId.localeCompare(right.requestId),
      ),
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation, operation)
    this.writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new MutationGrantRegistryError('mutation_grant_state_invalid')
  }
}
