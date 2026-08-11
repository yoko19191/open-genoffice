import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type AtomicWriteOptions } from './atomic-file'
import { DocumentBindingError, DocumentBindingStore } from './document-binding'
import { lock } from './proper-lockfile'

const UuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

export const DocumentSessionIndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    documentId: Type.String({ pattern: UuidPattern }),
    currentSessionId: Type.String({ pattern: UuidPattern }),
    generation: Type.Integer({ minimum: 1 }),
    updatedAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

export type DocumentSessionIndex = Static<typeof DocumentSessionIndexSchema>
export type DocumentSessionIndexErrorCode =
  | 'document_session_index_invalid'
  | 'document_session_binding_not_found'
  | 'document_session_not_found'
  | 'document_session_not_current'
  | 'document_session_conflict'

export class DocumentSessionIndexError extends Error {
  constructor(public readonly code: DocumentSessionIndexErrorCode) {
    super(code)
    this.name = 'DocumentSessionIndexError'
  }
}

export type DocumentSessionIndexStoreOptions = {
  rootDirectory: string
  platform?: NodeJS.Platform
  now?: () => Date
  atomicWriteOptions?: (index: DocumentSessionIndex) => AtomicWriteOptions
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function immutable(index: DocumentSessionIndex): DocumentSessionIndex {
  return Object.freeze({ ...index })
}

export class DocumentSessionIndexStore {
  private readonly leasesDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly now: () => Date
  private readonly bindings: DocumentBindingStore

  constructor(private readonly options: DocumentSessionIndexStoreOptions) {
    this.leasesDirectory = join(options.rootDirectory, 'state', 'leases')
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.bindings = new DocumentBindingStore({
      rootDirectory: options.rootDirectory,
      platform: this.platform,
    })
  }

  async resolveCurrent(
    documentId: string,
    create: () => Promise<string>,
  ): Promise<DocumentSessionIndex> {
    const path = await this.indexPath(documentId)
    return this.withLock(documentId, async () => {
      const existing = await this.read(path, documentId)
      if (existing) return immutable(existing)
      const currentSessionId = await create()
      this.assertUuid(currentSessionId)
      const index = this.record(documentId, currentSessionId, 1)
      await this.write(path, index)
      return immutable(index)
    })
  }

  async current(documentId: string): Promise<DocumentSessionIndex | undefined> {
    const path = await this.indexPath(documentId)
    return this.withLock(documentId, async () => {
      const index = await this.read(path, documentId)
      return index ? immutable(index) : undefined
    })
  }

  async assertCurrent(documentId: string, sessionId: string): Promise<DocumentSessionIndex> {
    this.assertUuid(sessionId)
    const path = await this.indexPath(documentId)
    return this.withLock(documentId, async () => {
      const index = await this.read(path, documentId)
      if (!index) throw new DocumentSessionIndexError('document_session_not_found')
      if (index.currentSessionId !== sessionId) {
        throw new DocumentSessionIndexError('document_session_not_current')
      }
      return immutable(index)
    })
  }

  async setCurrent(
    documentId: string,
    sessionId: string,
    expectedGeneration?: number,
  ): Promise<DocumentSessionIndex> {
    this.assertUuid(sessionId)
    const path = await this.indexPath(documentId)
    return this.withLock(documentId, async () => {
      const existing = await this.read(path, documentId)
      if (expectedGeneration !== undefined && existing?.generation !== expectedGeneration) {
        throw new DocumentSessionIndexError('document_session_conflict')
      }
      const index = this.record(documentId, sessionId, (existing?.generation ?? 0) + 1)
      await this.write(path, index)
      return immutable(index)
    })
  }

  async advanceCurrent(
    documentId: string,
    expectedSessionId: string,
    sessionId: string,
  ): Promise<DocumentSessionIndex> {
    this.assertUuid(expectedSessionId)
    this.assertUuid(sessionId)
    const path = await this.indexPath(documentId)
    return this.withLock(documentId, async () => {
      const existing = await this.read(path, documentId)
      if (!existing) throw new DocumentSessionIndexError('document_session_not_found')
      if (existing.currentSessionId !== expectedSessionId) {
        throw new DocumentSessionIndexError('document_session_not_current')
      }
      const index = this.record(documentId, sessionId, existing.generation + 1)
      await this.write(path, index)
      return immutable(index)
    })
  }

  private async indexPath(documentId: string): Promise<string> {
    this.assertUuid(documentId)
    try {
      const binding = await this.bindings.get(documentId)
      return join(
        this.options.rootDirectory,
        'projects',
        binding.projectId,
        'documents',
        documentId,
        'session-index.json',
      )
    } catch (error) {
      if (error instanceof DocumentBindingError && error.code === 'document_binding_not_found') {
        throw new DocumentSessionIndexError('document_session_binding_not_found')
      }
      throw new DocumentSessionIndexError('document_session_index_invalid')
    }
  }

  private async read(path: string, documentId: string): Promise<DocumentSessionIndex | undefined> {
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DocumentSessionIndexError('document_session_index_invalid')
    }
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        !Value.Check(DocumentSessionIndexSchema, value) ||
        value.documentId !== documentId ||
        !Number.isFinite(Date.parse(value.updatedAt))
      ) {
        throw new Error('invalid')
      }
      return value as DocumentSessionIndex
    } catch {
      throw new DocumentSessionIndexError('document_session_index_invalid')
    }
  }

  private async write(path: string, index: DocumentSessionIndex): Promise<void> {
    await atomicWriteJson(path, index, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(index),
    })
  }

  private record(
    documentId: string,
    currentSessionId: string,
    generation: number,
  ): DocumentSessionIndex {
    return {
      schemaVersion: 1,
      documentId,
      currentSessionId,
      generation,
      updatedAt: this.now().toISOString(),
    }
  }

  private assertUuid(value: string): void {
    if (!new RegExp(UuidPattern).test(value)) {
      throw new DocumentSessionIndexError('document_session_index_invalid')
    }
  }

  private async withLock<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.leasesDirectory, { recursive: true, mode: 0o700 })
    if (this.platform !== 'win32') await chmod(this.leasesDirectory, 0o700)
    const path = join(
      this.leasesDirectory,
      `document-session-${createHash('sha256').update(documentId).digest('hex')}`,
    )
    const release = await lock(path, {
      realpath: false,
      stale: 15_000,
      retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 50 },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }
}
