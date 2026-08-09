import { chmod, lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson } from './atomic-file'

const UuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const require = createRequire(import.meta.url)
const { lock } = require('proper-lockfile') as {
  lock(
    path: string,
    options: {
      realpath: false
      stale: number
      retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number }
    },
  ): Promise<() => Promise<void>>
}

export const SessionLeaseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessionId: Type.String({ pattern: UuidPattern }),
    instanceId: Type.String({ minLength: 1, maxLength: 256 }),
    pid: Type.Integer({ minimum: 1 }),
    ownerToken: Type.String({ pattern: UuidPattern }),
    generation: Type.Integer({ minimum: 1 }),
    heartbeatAt: Type.String({ minLength: 20, maxLength: 32 }),
    expiresAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

export type SessionLeaseRecord = Static<typeof SessionLeaseSchema>
export type SessionLeaseErrorCode =
  'session_in_use' | 'session_lease_invalid' | 'session_lease_lost'

export class SessionLeaseError extends Error {
  constructor(public readonly code: SessionLeaseErrorCode) {
    super(code)
    this.name = 'SessionLeaseError'
  }
}

export type SessionLeaseStoreOptions = {
  leasesDirectory: string
  instanceId: string
  pid: number
  ttlMs?: number
  platform?: NodeJS.Platform
  now?: () => Date
  randomUUID?: () => string
}

export type SessionLeaseHandle = {
  readonly sessionId: string
  readonly ownerToken: string
  heartbeat(): Promise<SessionLeaseRecord>
  release(): Promise<void>
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class SessionLeaseStore {
  private readonly ttlMs: number
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly randomUUID: () => string

  constructor(private readonly options: SessionLeaseStoreOptions) {
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 15_000)
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? randomUUID
  }

  async acquire(sessionId: string): Promise<SessionLeaseHandle> {
    if (!new RegExp(UuidPattern).test(sessionId)) {
      throw new SessionLeaseError('session_lease_invalid')
    }
    await this.ensureDirectory()
    const path = this.path(sessionId)
    return this.withEntityLock(path, async () => {
      let generation = 1
      try {
        const existing = await this.read(path)
        if (Date.parse(existing.expiresAt) > this.now().getTime()) {
          throw new SessionLeaseError('session_in_use')
        }
        generation = existing.generation + 1
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      const record = this.record(sessionId, this.randomUUID(), generation)
      await atomicWriteJson(path, record, { platform: this.platform })
      return this.handle(path, record)
    })
  }

  private handle(path: string, initial: SessionLeaseRecord): SessionLeaseHandle {
    let owned = initial
    return Object.freeze({
      sessionId: initial.sessionId,
      ownerToken: initial.ownerToken,
      heartbeat: () =>
        this.withEntityLock(path, async () => {
          const current = await this.readOwned(path, owned.ownerToken)
          if (Date.parse(current.expiresAt) <= this.now().getTime()) {
            throw new SessionLeaseError('session_lease_lost')
          }
          owned = this.record(current.sessionId, current.ownerToken, current.generation + 1)
          await atomicWriteJson(path, owned, { platform: this.platform })
          return owned
        }),
      release: () =>
        this.withEntityLock(path, async () => {
          let current: SessionLeaseRecord
          try {
            current = await this.read(path)
          } catch (error) {
            if (isMissing(error)) return
            throw error
          }
          if (current.ownerToken !== owned.ownerToken) return
          try {
            await unlink(path)
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }),
    })
  }

  private record(sessionId: string, ownerToken: string, generation: number): SessionLeaseRecord {
    const now = this.now()
    return {
      schemaVersion: 1,
      sessionId,
      instanceId: this.options.instanceId,
      pid: this.options.pid,
      ownerToken,
      generation,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const metadata = await lstat(this.options.leasesDirectory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SessionLeaseError('session_lease_invalid')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(this.options.leasesDirectory, { recursive: true, mode: 0o700 })
    }
    if (this.platform !== 'win32') await chmod(this.options.leasesDirectory, 0o700)
  }

  private async readOwned(path: string, ownerToken: string): Promise<SessionLeaseRecord> {
    let current: SessionLeaseRecord
    try {
      current = await this.read(path)
    } catch (error) {
      if (isMissing(error)) throw new SessionLeaseError('session_lease_lost')
      throw error
    }
    if (current.ownerToken !== ownerToken) throw new SessionLeaseError('session_lease_lost')
    return current
  }

  private async read(path: string): Promise<SessionLeaseRecord> {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SessionLeaseError('session_lease_invalid')
    }
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!Value.Check(SessionLeaseSchema, value)) throw new Error('invalid')
      if (
        !Number.isFinite(Date.parse(value.heartbeatAt)) ||
        !Number.isFinite(Date.parse(value.expiresAt))
      ) {
        throw new Error('invalid')
      }
      return value as SessionLeaseRecord
    } catch (error) {
      throw new SessionLeaseError('session_lease_invalid')
    }
  }

  private path(sessionId: string): string {
    return join(this.options.leasesDirectory, `session-${sessionId}.json`)
  }

  private async withEntityLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const release = await lock(path, {
      realpath: false,
      stale: Math.max(2_000, this.ttlMs),
      retries: { retries: 5, factor: 1, minTimeout: 10, maxTimeout: 50 },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }
}
