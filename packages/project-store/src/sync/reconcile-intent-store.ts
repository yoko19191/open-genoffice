import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { assertCanonicalPathSet, canonicalJsonBytes } from './canonical.js'
import { ReconcileIntentSchema, SyncScopeIdSchema } from './schema.js'
import type { ReconcileIntent, ReconcileIntentStore } from './types.js'

export class FileReconcileIntentStore implements ReconcileIntentStore {
  readonly #directory: string
  #pendingWrite = Promise.resolve()

  constructor(directory: string) {
    this.#directory = directory
  }

  async enqueue(intent: ReconcileIntent): Promise<void> {
    await this.#serialize(async () => {
      this.#assertScopeId(intent.scopeId)
      const existing = await this.#load(intent.scopeId)
      const paths = assertCanonicalPathSet([
        ...new Set([...(existing?.paths ?? []), ...intent.paths]),
      ]).sort((a, b) => a.localeCompare(b, 'en-US'))
      const next: ReconcileIntent = {
        schemaVersion: 1,
        operation: 'reconcile',
        scopeId: intent.scopeId,
        paths,
      }
      await mkdir(this.#directory, { recursive: true, mode: 0o700 })
      const target = this.#path(intent.scopeId)
      const temporary = `${target}.tmp`
      await writeFile(temporary, canonicalJsonBytes(next), { mode: 0o600 })
      await rename(temporary, target)
    })
  }

  async load(scopeId: string): Promise<ReconcileIntent | null> {
    await this.#pendingWrite
    return this.#load(scopeId)
  }

  async clear(scopeId: string): Promise<void> {
    await this.#serialize(async () => {
      this.#assertScopeId(scopeId)
      await rm(this.#path(scopeId), { force: true })
    })
  }

  async #load(scopeId: string): Promise<ReconcileIntent | null> {
    this.#assertScopeId(scopeId)
    const bytes = await readFile(this.#path(scopeId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) return null
    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('sync_reconcile_intent_invalid')
    }
    if (!Value.Check(ReconcileIntentSchema, value)) throw new Error('sync_reconcile_intent_invalid')
    const paths = assertCanonicalPathSet(value.paths)
    if (paths.some((path, index) => path !== value.paths[index])) {
      throw new Error('sync_reconcile_intent_invalid')
    }
    return value
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#pendingWrite.then(operation, operation)
    this.#pendingWrite = result.catch(() => undefined)
    await result
  }

  #path(scopeId: string): string {
    return join(this.#directory, `${scopeId}.json`)
  }

  #assertScopeId(scopeId: string): void {
    if (!Value.Check(SyncScopeIdSchema, scopeId)) throw new Error('sync_scope_invalid')
  }
}
