import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type AtomicWriteOptions } from './atomic-file'
import { lock } from './proper-lockfile'

const UuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const ProjectIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

export const DocumentBindingSchema = Type.Object(
  {
    documentId: Type.String({ pattern: UuidPattern }),
    projectId: Type.String({ pattern: ProjectIdPattern }),
    format: Type.Union([
      Type.Literal('pdf'),
      Type.Literal('docx'),
      Type.Literal('xlsx'),
      Type.Literal('pptx'),
    ]),
    canonicalPath: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768 })),
    state: Type.Union([
      Type.Literal('unsaved'),
      Type.Literal('bound'),
      Type.Literal('missing'),
      Type.Literal('needs_rebind'),
    ]),
    lastKnownContentHash: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  },
  { additionalProperties: false },
)

export type DocumentBinding = Static<typeof DocumentBindingSchema>
export type DocumentFormat = DocumentBinding['format']
export type DocumentBindingState = DocumentBinding['state']
export type DocumentPathTransition = 'in_app' | 'rebind'
export type DocumentBindingErrorCode =
  | 'document_binding_invalid'
  | 'document_binding_not_found'
  | 'document_path_already_bound'
  | 'document_format_mismatch'
  | 'document_rebind_required'

export class DocumentBindingError extends Error {
  constructor(public readonly code: DocumentBindingErrorCode) {
    super(code)
    this.name = 'DocumentBindingError'
  }
}

export type DocumentBindingStoreOptions = {
  rootDirectory: string
  platform?: NodeJS.Platform
  randomUUID?: () => string
  canonicalizePath?: (path: string) => Promise<string>
  atomicWriteOptions?: (binding: DocumentBinding) => AtomicWriteOptions
}

type CreateBindingInput = {
  projectId: string
  format: DocumentFormat
  lastKnownContentHash?: string
}

type OpenBindingInput = CreateBindingInput & { canonicalPath: string }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function immutable(binding: DocumentBinding): DocumentBinding {
  return Object.freeze({ ...binding })
}

function hashField(lastKnownContentHash?: string): Pick<DocumentBinding, 'lastKnownContentHash'> {
  return lastKnownContentHash ? { lastKnownContentHash } : {}
}

export class DocumentBindingStore {
  private readonly projectsDirectory: string
  private readonly leasesDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly randomUUID: () => string
  private readonly canonicalizePath: (path: string) => Promise<string>

  constructor(private readonly options: DocumentBindingStoreOptions) {
    this.projectsDirectory = join(options.rootDirectory, 'projects')
    this.leasesDirectory = join(options.rootDirectory, 'state', 'leases')
    this.platform = options.platform ?? process.platform
    this.randomUUID = options.randomUUID ?? randomUUID
    this.canonicalizePath =
      options.canonicalizePath ?? (async (path) => (await realpath(path)).normalize('NFC'))
  }

  async createUnsaved(input: CreateBindingInput): Promise<DocumentBinding> {
    this.assertCreateInput(input)
    const documentId = this.randomUUID()
    return this.withLocks([`document:${documentId}`], async () => {
      if (await this.findByDocumentId(documentId)) {
        throw new DocumentBindingError('document_binding_invalid')
      }
      const binding: DocumentBinding = {
        documentId,
        projectId: input.projectId,
        format: input.format,
        state: 'unsaved',
        ...hashField(input.lastKnownContentHash),
      }
      await this.write(binding)
      return immutable(binding)
    })
  }

  async openOrCreate(input: OpenBindingInput): Promise<DocumentBinding> {
    this.assertCreateInput(input)
    const canonicalPath = await this.canonical(input.canonicalPath)
    return this.withLocks([`path:${canonicalPath}`], async () => {
      const existing = await this.findBoundPath(canonicalPath)
      if (existing) {
        if (existing.format !== input.format) {
          throw new DocumentBindingError('document_format_mismatch')
        }
        return immutable(existing)
      }
      const documentId = this.randomUUID()
      if (await this.findByDocumentId(documentId)) {
        throw new DocumentBindingError('document_binding_invalid')
      }
      const binding: DocumentBinding = {
        documentId,
        projectId: input.projectId,
        format: input.format,
        canonicalPath,
        state: 'bound',
        ...hashField(input.lastKnownContentHash),
      }
      await this.write(binding)
      return immutable(binding)
    })
  }

  async bindPath(
    documentId: string,
    path: string,
    transition: DocumentPathTransition,
    lastKnownContentHash?: string,
  ): Promise<DocumentBinding> {
    this.assertDocumentId(documentId)
    const canonicalPath = await this.canonical(path)
    const initial = await this.required(documentId)
    const keys = [
      `document:${documentId}`,
      `path:${canonicalPath}`,
      ...(initial.canonicalPath ? [`path:${initial.canonicalPath}`] : []),
    ]
    return this.withLocks(keys, async () => {
      const current = await this.required(documentId)
      if (
        transition === 'in_app' &&
        (current.state === 'missing' || current.state === 'needs_rebind')
      ) {
        throw new DocumentBindingError('document_rebind_required')
      }
      const collision = await this.findBoundPath(canonicalPath)
      if (collision && collision.documentId !== documentId) {
        throw new DocumentBindingError('document_path_already_bound')
      }
      const binding: DocumentBinding = {
        ...current,
        canonicalPath,
        state: 'bound',
        ...hashField(lastKnownContentHash),
      }
      await this.write(binding)
      return immutable(binding)
    })
  }

  markMissing(documentId: string): Promise<DocumentBinding> {
    return this.markState(documentId, 'missing')
  }

  markNeedsRebind(documentId: string): Promise<DocumentBinding> {
    return this.markState(documentId, 'needs_rebind')
  }

  async fork(documentId: string, canonicalPath?: string): Promise<DocumentBinding> {
    const source = await this.required(documentId)
    if (!canonicalPath) {
      return this.createUnsaved({
        projectId: source.projectId,
        format: source.format,
        ...hashField(source.lastKnownContentHash),
      })
    }
    const path = await this.canonical(canonicalPath)
    return this.withLocks([`path:${path}`], async () => {
      if (await this.findBoundPath(path)) {
        throw new DocumentBindingError('document_path_already_bound')
      }
      const forkId = this.randomUUID()
      if (await this.findByDocumentId(forkId)) {
        throw new DocumentBindingError('document_binding_invalid')
      }
      const binding: DocumentBinding = {
        documentId: forkId,
        projectId: source.projectId,
        format: source.format,
        canonicalPath: path,
        state: 'bound',
        ...hashField(source.lastKnownContentHash),
      }
      await this.write(binding)
      return immutable(binding)
    })
  }

  async get(documentId: string): Promise<DocumentBinding> {
    this.assertDocumentId(documentId)
    return immutable(await this.required(documentId))
  }

  async list(): Promise<DocumentBinding[]> {
    return (await this.readAll())
      .map(immutable)
      .sort((left, right) => left.documentId.localeCompare(right.documentId))
  }

  private async markState(
    documentId: string,
    state: Extract<DocumentBindingState, 'missing' | 'needs_rebind'>,
  ): Promise<DocumentBinding> {
    this.assertDocumentId(documentId)
    const initial = await this.required(documentId)
    const keys = [
      `document:${documentId}`,
      ...(initial.canonicalPath ? [`path:${initial.canonicalPath}`] : []),
    ]
    return this.withLocks(keys, async () => {
      const binding = { ...(await this.required(documentId)), state }
      await this.write(binding)
      return immutable(binding)
    })
  }

  private async required(documentId: string): Promise<DocumentBinding> {
    const binding = await this.findByDocumentId(documentId)
    if (!binding) throw new DocumentBindingError('document_binding_not_found')
    return binding
  }

  private async findByDocumentId(documentId: string): Promise<DocumentBinding | undefined> {
    const matches = (await this.readAll()).filter((binding) => binding.documentId === documentId)
    if (matches.length > 1) throw new DocumentBindingError('document_binding_invalid')
    return matches[0]
  }

  private async findBoundPath(canonicalPath: string): Promise<DocumentBinding | undefined> {
    const matches = (await this.readAll()).filter(
      (binding) => binding.state === 'bound' && binding.canonicalPath === canonicalPath,
    )
    if (matches.length > 1) throw new DocumentBindingError('document_binding_invalid')
    return matches[0]
  }

  private async readAll(): Promise<DocumentBinding[]> {
    await this.ensureRoots()
    const bindings: DocumentBinding[] = []
    for (const project of await readdir(this.projectsDirectory, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) {
        throw new DocumentBindingError('document_binding_invalid')
      }
      const documentsDirectory = join(this.projectsDirectory, project.name, 'documents')
      let documents
      try {
        documents = await readdir(documentsDirectory, { withFileTypes: true })
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      for (const document of documents) {
        if (!document.isDirectory() || document.isSymbolicLink()) {
          throw new DocumentBindingError('document_binding_invalid')
        }
        const path = join(documentsDirectory, document.name, 'binding.json')
        let metadata
        try {
          metadata = await lstat(path)
        } catch (error) {
          if (isMissing(error)) continue
          throw error
        }
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new DocumentBindingError('document_binding_invalid')
        }
        try {
          const value: unknown = JSON.parse(await readFile(path, 'utf8'))
          if (
            !Value.Check(DocumentBindingSchema, value) ||
            value.projectId !== project.name ||
            value.documentId !== document.name
          ) {
            throw new Error('invalid')
          }
          bindings.push(value as DocumentBinding)
        } catch {
          throw new DocumentBindingError('document_binding_invalid')
        }
      }
    }
    return bindings
  }

  private async write(binding: DocumentBinding): Promise<void> {
    if (!Value.Check(DocumentBindingSchema, binding)) {
      throw new DocumentBindingError('document_binding_invalid')
    }
    const directory = join(
      this.projectsDirectory,
      binding.projectId,
      'documents',
      binding.documentId,
    )
    await this.ensurePrivateDirectory(directory)
    await atomicWriteJson(join(directory, 'binding.json'), binding, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(binding),
    })
  }

  private async withLocks<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    await this.ensureRoots()
    const lockPaths = [...new Set(keys)]
      .sort()
      .map((key) =>
        join(
          this.leasesDirectory,
          `document-binding-${createHash('sha256').update(key).digest('hex')}`,
        ),
      )
    const releases: Array<() => Promise<void>> = []
    try {
      for (const path of lockPaths) {
        releases.push(
          await lock(path, {
            realpath: false,
            stale: 10_000,
            retries: { retries: 10, factor: 1, minTimeout: 10, maxTimeout: 50 },
          }),
        )
      }
      return await operation()
    } finally {
      for (const release of releases.reverse()) await release()
    }
  }

  private async ensureRoots(): Promise<void> {
    await Promise.all([
      this.ensurePrivateDirectory(this.projectsDirectory),
      this.ensurePrivateDirectory(this.leasesDirectory),
    ])
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (this.platform !== 'win32') await chmod(path, 0o700)
  }

  private async canonical(path: string): Promise<string> {
    if (!path || path.includes('\0')) throw new DocumentBindingError('document_binding_invalid')
    try {
      const canonicalPath = await this.canonicalizePath(path)
      if (!canonicalPath || canonicalPath.includes('\0')) throw new Error('invalid')
      return canonicalPath.normalize('NFC')
    } catch {
      throw new DocumentBindingError('document_binding_invalid')
    }
  }

  private assertDocumentId(documentId: string): void {
    if (!new RegExp(UuidPattern).test(documentId)) {
      throw new DocumentBindingError('document_binding_invalid')
    }
  }

  private assertCreateInput(input: CreateBindingInput): void {
    if (!new RegExp(ProjectIdPattern).test(input.projectId)) {
      throw new DocumentBindingError('document_binding_invalid')
    }
    if (input.lastKnownContentHash && !/^[0-9a-f]{64}$/.test(input.lastKnownContentHash)) {
      throw new DocumentBindingError('document_binding_invalid')
    }
  }
}
