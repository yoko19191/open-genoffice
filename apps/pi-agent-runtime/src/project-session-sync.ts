import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  DocumentBindingError,
  DocumentBindingStore,
  DocumentSessionIndexStore,
  atomicWriteFile,
  atomicWriteJson,
  type DocumentBinding,
  type DocumentFormat,
} from '@genoffice/agent-resource'
import {
  OfficeToolCatalogBindingSchema,
  type OfficeToolCatalogBinding,
} from '@genoffice/agent-runtime-protocol'
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const HASH_PATTERN = '^[a-f0-9]{64}$'
const MAX_SESSION_BYTES = 64 * 1024 * 1024

const CredentialRequirementSchema = Type.Object(
  {
    slotId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
    providerId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
  },
  { additionalProperties: false },
)

const ResourceRequirementSchema = Type.Object(
  {
    resourceId: Type.String({ minLength: 1, maxLength: 512 }),
    contentHash: Type.String({ pattern: HASH_PATTERN }),
    executable: Type.Boolean(),
    network: Type.Boolean(),
  },
  { additionalProperties: false },
)

const SessionDescriptorSchema = Type.Object(
  {
    sessionId: Type.String({ pattern: UUID_PATTERN }),
    parentSessionId: Type.Union([Type.String({ pattern: UUID_PATTERN }), Type.Null()]),
    transcriptHash: Type.String({ pattern: HASH_PATTERN }),
    byteLength: Type.Integer({ minimum: 1, maximum: MAX_SESSION_BYTES }),
    messageCount: Type.Integer({ minimum: 0 }),
    lastEntryId: Type.String({ minLength: 1, maxLength: 512 }),
    committedCursor: Type.String({ pattern: HASH_PATTERN }),
    officeToolCatalog: Type.Optional(OfficeToolCatalogBindingSchema),
  },
  { additionalProperties: false },
)

const ForkCandidateRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    candidateId: Type.String({ pattern: HASH_PATTERN }),
    documentId: Type.String({ pattern: UUID_PATTERN }),
    sourceSessionId: Type.String({ pattern: UUID_PATTERN }),
    transcriptHash: Type.String({ pattern: HASH_PATTERN }),
    messageCount: Type.Integer({ minimum: 0 }),
    committedCursor: Type.String({ pattern: HASH_PATTERN }),
    officeToolCatalog: Type.Optional(OfficeToolCatalogBindingSchema),
  },
  { additionalProperties: false },
)

export const ProjectSessionSyncBundleSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    documentId: Type.String({ pattern: UUID_PATTERN }),
    projectId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
    format: Type.Union([
      Type.Literal('pdf'),
      Type.Literal('docx'),
      Type.Literal('xlsx'),
      Type.Literal('pptx'),
    ]),
    lastKnownContentHash: Type.Optional(Type.String({ pattern: HASH_PATTERN })),
    currentSessionId: Type.String({ pattern: UUID_PATTERN }),
    indexGeneration: Type.Integer({ minimum: 1 }),
    sessions: Type.Array(SessionDescriptorSchema, { minItems: 1, maxItems: 1024 }),
    requiredCredentialSlots: Type.Array(CredentialRequirementSchema, { maxItems: 256 }),
    requiredResources: Type.Array(ResourceRequirementSchema, { maxItems: 4096 }),
    committedCursor: Type.String({ pattern: HASH_PATTERN }),
  },
  { additionalProperties: false },
)

export type ProjectSessionSyncBundle = Static<typeof ProjectSessionSyncBundleSchema>
export type SessionSyncCredentialRequirement = Static<typeof CredentialRequirementSchema>
export type SessionSyncResourceRequirement = Static<typeof ResourceRequirementSchema>
export type SessionSyncDescriptor = Static<typeof SessionDescriptorSchema>

export type ProjectSessionSyncEntry = {
  canonicalPath: string
  kind: 'project-metadata' | 'pi-session-snapshot'
  bytes?: Uint8Array
  tombstone?: boolean
}

type JsonObject = Record<string, unknown>
type CapturedFile = { path: string; bytes: Uint8Array; size: number; modifiedMs: number }

export type SessionForkCandidate = {
  candidateId: string
  sourceSessionId: string
  transcriptHash: string
  messageCount: number
  committedCursor: string
}

export type SessionRestoreResult = {
  status: 'restored' | 'fork_candidates' | 'needs_rebind' | 'binding_conflict'
  restoredSessionIds: string[]
  forkCandidates: SessionForkCandidate[]
  missingCredentialSlots: string[]
  inactiveResourceHashes: string[]
  committedCursor: string
}

export class ProjectSessionSyncError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ProjectSessionSyncError'
  }
}

export type ProjectSessionSyncServiceOptions = {
  rootDirectory: string
  platform?: NodeJS.Platform
  randomUUID?: () => string
  now?: () => Date
  canonicalizePath?: (path: string) => Promise<string>
  withCommittedReadBarrier: <T>(
    sessionId: string,
    read: (sessionFile: string) => Promise<T>,
  ) => Promise<T>
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8')
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'))
}

function sameCapturedFile(left: CapturedFile, stat: { size: number; mtimeMs: number }): boolean {
  return left.size === stat.size && left.modifiedMs === stat.mtimeMs
}

function bundlePath(documentId: string): string {
  return `.open-genoffice/session-sync/${documentId}/bundle.json`
}

function sessionEntryPath(documentId: string, sessionId: string): string {
  return `.open-genoffice/session-sync/${documentId}/sessions/${sessionId}.jsonl`
}

function parseJsonLines(bytes: Uint8Array): JsonObject[] {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SESSION_BYTES) {
    throw new ProjectSessionSyncError('session_snapshot_invalid')
  }
  const text = Buffer.from(bytes).toString('utf8')
  if (!text.endsWith('\n')) throw new ProjectSessionSyncError('session_snapshot_incomplete')
  try {
    const lines = text.slice(0, -1).split('\n')
    if (lines.some((line) => line.length === 0)) {
      throw new ProjectSessionSyncError('session_snapshot_invalid')
    }
    return lines.map((line) => {
      const value: unknown = JSON.parse(line)
      if (!isObject(value)) throw new ProjectSessionSyncError('session_snapshot_invalid')
      return value
    })
  } catch (error) {
    if (error instanceof ProjectSessionSyncError) throw error
    throw new ProjectSessionSyncError('session_snapshot_invalid')
  }
}

function documentBindingEntry(entries: JsonObject[], documentId: string): JsonObject {
  const entry = entries.find(
    (value) =>
      value.type === 'custom' &&
      value.customType === 'genoffice.document-binding' &&
      isObject(value.data),
  )
  if (!entry || (entry.data as JsonObject).documentId !== documentId) {
    throw new ProjectSessionSyncError('session_snapshot_binding_mismatch')
  }
  return entry
}

function sessionDescriptor(
  bytes: Uint8Array,
  documentId: string,
  expectedSessionId: string,
): SessionSyncDescriptor {
  const entries = parseJsonLines(bytes)
  const header = entries[0]
  if (header?.type !== 'session' || header.id !== expectedSessionId) {
    throw new ProjectSessionSyncError('session_snapshot_id_mismatch')
  }
  const ids = entries.flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []))
  if (new Set(ids).size !== ids.length) {
    throw new ProjectSessionSyncError('session_snapshot_invalid')
  }
  const binding = documentBindingEntry(entries, documentId)
  const fork = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === 'genoffice.session-fork' &&
        isObject(entry.data),
    )
  const parentSessionId = fork ? (fork.data as JsonObject).parentSessionId : null
  if (parentSessionId !== null && !new RegExp(UUID_PATTERN).test(String(parentSessionId))) {
    throw new ProjectSessionSyncError('session_snapshot_invalid')
  }
  const catalog = (binding.data as JsonObject).officeToolCatalog
  if (catalog !== undefined && !Value.Check(OfficeToolCatalogBindingSchema, catalog)) {
    throw new ProjectSessionSyncError('session_snapshot_invalid')
  }
  const transcriptHash = sha256Hex(bytes)
  const lastEntryId = ids.at(-1)!
  const committedCursor = sha256Hex(
    canonicalJsonBytes({ documentId, sessionId: expectedSessionId, transcriptHash, lastEntryId }),
  )
  return {
    sessionId: expectedSessionId,
    parentSessionId: parentSessionId as string | null,
    transcriptHash,
    byteLength: bytes.byteLength,
    messageCount: entries.filter((entry) => entry.type === 'message').length,
    lastEntryId,
    committedCursor,
    ...(catalog ? { officeToolCatalog: catalog as OfficeToolCatalogBinding } : {}),
  }
}

function validateRequirements(
  credentials: SessionSyncCredentialRequirement[],
  resources: SessionSyncResourceRequirement[],
): void {
  if (
    credentials.some((item) => !Value.Check(CredentialRequirementSchema, item)) ||
    resources.some((item) => !Value.Check(ResourceRequirementSchema, item))
  ) {
    throw new ProjectSessionSyncError('session_snapshot_requirement_invalid')
  }
  if (
    new Set(credentials.map((item) => item.slotId)).size !== credentials.length ||
    new Set(resources.map((item) => `${item.resourceId}\0${item.contentHash}`)).size !==
      resources.length
  ) {
    throw new ProjectSessionSyncError('session_snapshot_requirement_invalid')
  }
}

export class ProjectSessionSyncService {
  readonly #root: string
  readonly #platform: NodeJS.Platform
  readonly #randomUUID: () => string
  readonly #now: () => Date
  readonly #canonicalizePath: (path: string) => Promise<string>
  readonly #bindings: DocumentBindingStore
  readonly #indexes: DocumentSessionIndexStore

  constructor(private readonly options: ProjectSessionSyncServiceOptions) {
    this.#root = options.rootDirectory
    this.#platform = options.platform ?? process.platform
    this.#randomUUID = options.randomUUID ?? randomUUID
    this.#now = options.now ?? (() => new Date())
    this.#canonicalizePath = options.canonicalizePath ?? (async (path) => realpath(path))
    this.#bindings = new DocumentBindingStore({
      rootDirectory: this.#root,
      platform: this.#platform,
      canonicalizePath: this.#canonicalizePath,
    })
    this.#indexes = new DocumentSessionIndexStore({
      rootDirectory: this.#root,
      platform: this.#platform,
    })
  }

  async capture(input: {
    documentId: string
    requiredCredentialSlots?: SessionSyncCredentialRequirement[]
    requiredResources?: SessionSyncResourceRequirement[]
  }): Promise<{
    bundle: ProjectSessionSyncBundle
    entries: ProjectSessionSyncEntry[]
  }> {
    const binding = await this.#binding(input.documentId)
    const index = await this.#indexes.current(input.documentId)
    if (!index) throw new ProjectSessionSyncError('session_snapshot_index_missing')
    const credentials = [...(input.requiredCredentialSlots ?? [])].sort((left, right) =>
      left.slotId.localeCompare(right.slotId, 'en-US'),
    )
    const resources = [...(input.requiredResources ?? [])].sort((left, right) =>
      `${left.resourceId}\0${left.contentHash}`.localeCompare(
        `${right.resourceId}\0${right.contentHash}`,
        'en-US',
      ),
    )
    validateRequirements(credentials, resources)

    const directory = join(this.#root, 'agent', 'sessions', input.documentId)
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const sessionIds = names
      .filter((name) => new RegExp(`^${UUID_PATTERN.slice(1, -1)}\\.jsonl$`).test(name))
      .map((name) => basename(name, '.jsonl'))
      .sort((left, right) => left.localeCompare(right, 'en-US'))
    if (!sessionIds.includes(index.currentSessionId)) {
      throw new ProjectSessionSyncError('session_snapshot_current_missing')
    }

    const captured = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const file = await this.options.withCommittedReadBarrier(sessionId, async (sessionFile) => {
          const before = await lstat(sessionFile)
          if (!before.isFile() || before.isSymbolicLink()) {
            throw new ProjectSessionSyncError('session_snapshot_invalid')
          }
          const bytes = new Uint8Array(await readFile(sessionFile))
          const after = await lstat(sessionFile)
          const result: CapturedFile = {
            path: sessionFile,
            bytes,
            size: after.size,
            modifiedMs: after.mtimeMs,
          }
          if (!sameCapturedFile(result, before)) {
            throw new ProjectSessionSyncError('session_snapshot_changed')
          }
          return result
        })
        const released = await lstat(file.path)
        if (!sameCapturedFile(file, released)) {
          throw new ProjectSessionSyncError('session_snapshot_changed')
        }
        return { descriptor: sessionDescriptor(file.bytes, input.documentId, sessionId), file }
      }),
    )
    const descriptors = captured.map(({ descriptor }) => descriptor)
    const committedCursor = sha256Hex(
      canonicalJsonBytes({
        documentId: input.documentId,
        currentSessionId: index.currentSessionId,
        sessions: descriptors.map(({ sessionId, transcriptHash, committedCursor }) => ({
          sessionId,
          transcriptHash,
          committedCursor,
        })),
      }),
    )
    const bundle: ProjectSessionSyncBundle = {
      schemaVersion: 1,
      documentId: input.documentId,
      projectId: binding.projectId,
      format: binding.format,
      ...(binding.lastKnownContentHash
        ? { lastKnownContentHash: binding.lastKnownContentHash }
        : {}),
      currentSessionId: index.currentSessionId,
      indexGeneration: index.generation,
      sessions: descriptors,
      requiredCredentialSlots: credentials,
      requiredResources: resources,
      committedCursor,
    }
    return {
      bundle,
      entries: [
        {
          canonicalPath: bundlePath(input.documentId),
          kind: 'project-metadata',
          bytes: canonicalJsonBytes(bundle),
        },
        ...captured.map(({ descriptor, file }) => ({
          canonicalPath: sessionEntryPath(input.documentId, descriptor.sessionId),
          kind: 'pi-session-snapshot' as const,
          bytes: file.bytes,
        })),
      ],
    }
  }

  async restore(
    entries: ProjectSessionSyncEntry[],
    options: {
      documentId: string
      targetDocumentPath?: string
      confirmRebind?: boolean
      availableCredentialSlots: string[]
      activeResourceHashes: string[]
    },
  ): Promise<SessionRestoreResult> {
    const { bundle, sessions } = this.#decode(entries, options.documentId)
    const setup = this.#setupState(
      bundle,
      options.availableCredentialSlots,
      options.activeResourceHashes,
    )
    const binding = await this.#restoreBinding(bundle, options)
    if ('status' in binding) {
      return {
        status: binding.status,
        restoredSessionIds: [],
        forkCandidates: [],
        ...setup,
        committedCursor: bundle.committedCursor,
      }
    }

    const restoredSessionIds: string[] = []
    const forkCandidates: SessionForkCandidate[] = []
    for (const descriptor of bundle.sessions) {
      const bytes = sessions.get(descriptor.sessionId)!
      const path = this.#sessionFile(bundle.documentId, descriptor.sessionId)
      const local = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (local && sha256Hex(local) !== descriptor.transcriptHash) {
        forkCandidates.push(
          await this.#saveForkCandidate(bundle, descriptor, bytes, sha256Hex(local)),
        )
        continue
      }
      if (!local) await atomicWriteFile(path, bytes, { platform: this.#platform })
      await this.#writeRuntimeBinding(bundle.documentId, descriptor, path)
      restoredSessionIds.push(descriptor.sessionId)
    }
    if (forkCandidates.length === 0) {
      await this.#indexes.setCurrent(bundle.documentId, bundle.currentSessionId)
    }
    return {
      status: forkCandidates.length > 0 ? 'fork_candidates' : 'restored',
      restoredSessionIds,
      forkCandidates,
      ...setup,
      committedCursor: bundle.committedCursor,
    }
  }

  async importFork(input: { documentId: string; candidateId: string }): Promise<{
    sessionId: string
    parentSessionId: string
    sourceSessionId: string
    committedCursor: string
  }> {
    if (
      !new RegExp(UUID_PATTERN).test(input.documentId) ||
      !new RegExp(HASH_PATTERN).test(input.candidateId)
    ) {
      throw new ProjectSessionSyncError('session_fork_candidate_invalid')
    }
    await this.#binding(input.documentId)
    const directory = this.#candidateDirectory(input.documentId, input.candidateId)
    const record = await this.#readCandidate(join(directory, 'candidate.json'), input)
    const bytes = new Uint8Array(await readFile(join(directory, 'session.jsonl')))
    if (sha256Hex(bytes) !== record.transcriptHash) {
      throw new ProjectSessionSyncError('session_fork_candidate_invalid')
    }
    const lines = parseJsonLines(bytes)
    const newSessionId = this.#randomUUID()
    if (!new RegExp(UUID_PATTERN).test(newSessionId)) {
      throw new ProjectSessionSyncError('session_fork_candidate_invalid')
    }
    lines[0] = { ...lines[0], id: newSessionId }
    const lastEntryId = lines
      .flatMap((entry) => (typeof entry.id === 'string' ? [entry.id] : []))
      .at(-1)!
    lines.push({
      type: 'custom',
      id: `genoffice-sync-fork-${newSessionId}`,
      parentId: lastEntryId,
      timestamp: this.#now().toISOString(),
      customType: 'genoffice.session-fork',
      data: { documentId: input.documentId, parentSessionId: record.sourceSessionId },
    })
    const importedBytes = new TextEncoder().encode(
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    const descriptor = sessionDescriptor(importedBytes, input.documentId, newSessionId)
    const sessionFile = this.#sessionFile(input.documentId, newSessionId)
    await atomicWriteFile(sessionFile, importedBytes, { platform: this.#platform })
    await this.#writeRuntimeBinding(input.documentId, descriptor, sessionFile)
    await this.#indexes.setCurrent(input.documentId, newSessionId)
    return {
      sessionId: newSessionId,
      parentSessionId: record.sourceSessionId,
      sourceSessionId: record.sourceSessionId,
      committedCursor: descriptor.committedCursor,
    }
  }

  #decode(
    entries: ProjectSessionSyncEntry[],
    documentId: string,
  ): { bundle: ProjectSessionSyncBundle; sessions: Map<string, Uint8Array> } {
    const metadata = entries.filter((entry) => entry.canonicalPath === bundlePath(documentId))
    if (metadata.length !== 1 || metadata[0]!.tombstone || !metadata[0]!.bytes) {
      throw new ProjectSessionSyncError('session_snapshot_bundle_missing')
    }
    let value: unknown
    try {
      value = JSON.parse(Buffer.from(metadata[0]!.bytes).toString('utf8'))
    } catch {
      throw new ProjectSessionSyncError('session_snapshot_invalid')
    }
    if (!Value.Check(ProjectSessionSyncBundleSchema, value) || value.documentId !== documentId) {
      throw new ProjectSessionSyncError('session_snapshot_invalid')
    }
    const bundle = value as ProjectSessionSyncBundle
    const sessions = new Map<string, Uint8Array>()
    for (const descriptor of bundle.sessions) {
      const matches = entries.filter(
        (entry) => entry.canonicalPath === sessionEntryPath(documentId, descriptor.sessionId),
      )
      if (matches.length !== 1 || matches[0]!.tombstone || !matches[0]!.bytes) {
        throw new ProjectSessionSyncError('session_snapshot_session_missing')
      }
      const bytes = matches[0]!.bytes
      const parsed = sessionDescriptor(bytes, documentId, descriptor.sessionId)
      if (canonicalJsonBytes(parsed).compare(canonicalJsonBytes(descriptor)) !== 0) {
        throw new ProjectSessionSyncError('session_snapshot_invalid')
      }
      sessions.set(descriptor.sessionId, bytes)
    }
    if (!sessions.has(bundle.currentSessionId)) {
      throw new ProjectSessionSyncError('session_snapshot_current_missing')
    }
    return { bundle, sessions }
  }

  async #restoreBinding(
    bundle: ProjectSessionSyncBundle,
    options: { targetDocumentPath?: string; confirmRebind?: boolean },
  ): Promise<{ binding: DocumentBinding } | { status: 'needs_rebind' | 'binding_conflict' }> {
    let existing: DocumentBinding | undefined
    try {
      existing = await this.#bindings.get(bundle.documentId)
    } catch (error) {
      if (!(error instanceof DocumentBindingError) || error.code !== 'document_binding_not_found') {
        throw error
      }
    }
    if (
      existing &&
      (existing.projectId !== bundle.projectId || existing.format !== bundle.format)
    ) {
      return { status: 'binding_conflict' }
    }
    if (!options.targetDocumentPath) {
      return existing ? { binding: existing } : { status: 'needs_rebind' }
    }
    if (existing?.canonicalPath) {
      const target = await this.#canonicalizePath(options.targetDocumentPath)
      if (existing.canonicalPath === target) return { binding: existing }
      if (!options.confirmRebind) return { status: 'needs_rebind' }
      return {
        binding: await this.#bindings.bindPath(
          bundle.documentId,
          options.targetDocumentPath,
          'rebind',
        ),
      }
    }
    if (existing) {
      if (!options.confirmRebind && existing.state !== 'unsaved') {
        return { status: 'needs_rebind' }
      }
      return {
        binding: await this.#bindings.bindPath(
          bundle.documentId,
          options.targetDocumentPath,
          'rebind',
        ),
      }
    }
    const importer = new DocumentBindingStore({
      rootDirectory: this.#root,
      platform: this.#platform,
      randomUUID: () => bundle.documentId,
      canonicalizePath: this.#canonicalizePath,
    })
    try {
      const imported = await importer.openOrCreate({
        projectId: bundle.projectId,
        format: bundle.format as DocumentFormat,
        canonicalPath: options.targetDocumentPath,
        ...(bundle.lastKnownContentHash
          ? { lastKnownContentHash: bundle.lastKnownContentHash }
          : {}),
      })
      return imported.documentId === bundle.documentId
        ? { binding: imported }
        : { status: 'binding_conflict' }
    } catch (error) {
      if (
        error instanceof DocumentBindingError &&
        (error.code === 'document_path_already_bound' || error.code === 'document_format_mismatch')
      ) {
        return { status: 'binding_conflict' }
      }
      throw error
    }
  }

  #setupState(
    bundle: ProjectSessionSyncBundle,
    availableCredentialSlots: string[],
    activeResourceHashes: string[],
  ): Pick<SessionRestoreResult, 'missingCredentialSlots' | 'inactiveResourceHashes'> {
    const credentials = new Set(availableCredentialSlots)
    const activations = new Set(activeResourceHashes)
    return {
      missingCredentialSlots: uniqueSorted(
        bundle.requiredCredentialSlots
          .filter((requirement) => !credentials.has(requirement.slotId))
          .map((requirement) => requirement.slotId),
      ),
      inactiveResourceHashes: uniqueSorted(
        bundle.requiredResources
          .filter(
            (requirement) =>
              (requirement.executable || requirement.network) &&
              !activations.has(requirement.contentHash),
          )
          .map((requirement) => requirement.contentHash),
      ),
    }
  }

  async #saveForkCandidate(
    bundle: ProjectSessionSyncBundle,
    descriptor: SessionSyncDescriptor,
    bytes: Uint8Array,
    localTranscriptHash: string,
  ): Promise<SessionForkCandidate> {
    const candidateId = sha256Hex(
      canonicalJsonBytes({
        documentId: bundle.documentId,
        sessionId: descriptor.sessionId,
        localTranscriptHash,
        remoteTranscriptHash: descriptor.transcriptHash,
      }),
    )
    const directory = this.#candidateDirectory(bundle.documentId, candidateId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await atomicWriteFile(join(directory, 'session.jsonl'), bytes, { platform: this.#platform })
    await atomicWriteJson(
      join(directory, 'candidate.json'),
      {
        schemaVersion: 1,
        candidateId,
        documentId: bundle.documentId,
        sourceSessionId: descriptor.sessionId,
        transcriptHash: descriptor.transcriptHash,
        messageCount: descriptor.messageCount,
        committedCursor: descriptor.committedCursor,
        ...(descriptor.officeToolCatalog
          ? { officeToolCatalog: descriptor.officeToolCatalog }
          : {}),
      },
      { platform: this.#platform },
    )
    return {
      candidateId,
      sourceSessionId: descriptor.sessionId,
      transcriptHash: descriptor.transcriptHash,
      messageCount: descriptor.messageCount,
      committedCursor: descriptor.committedCursor,
    }
  }

  async #readCandidate(
    path: string,
    input: { documentId: string; candidateId: string },
  ): Promise<{
    sourceSessionId: string
    transcriptHash: string
    officeToolCatalog?: OfficeToolCatalogBinding
  }> {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (
        !Value.Check(ForkCandidateRecordSchema, value) ||
        value.candidateId !== input.candidateId ||
        value.documentId !== input.documentId
      ) {
        throw new Error('invalid')
      }
      return value
    } catch {
      throw new ProjectSessionSyncError('session_fork_candidate_invalid')
    }
  }

  async #writeRuntimeBinding(
    documentId: string,
    descriptor: SessionSyncDescriptor,
    sessionFile: string,
  ): Promise<void> {
    await atomicWriteJson(
      join(this.#root, 'state', 'session-bindings', `${descriptor.sessionId}.json`),
      {
        version: 1,
        sessionId: descriptor.sessionId,
        documentId,
        sessionFile,
        ...(descriptor.parentSessionId ? { parentSessionId: descriptor.parentSessionId } : {}),
        ...(descriptor.officeToolCatalog
          ? { officeToolCatalog: descriptor.officeToolCatalog }
          : {}),
      },
      { platform: this.#platform },
    )
  }

  async #binding(documentId: string): Promise<DocumentBinding> {
    try {
      return await this.#bindings.get(documentId)
    } catch {
      throw new ProjectSessionSyncError('session_snapshot_binding_missing')
    }
  }

  #sessionFile(documentId: string, sessionId: string): string {
    return join(this.#root, 'agent', 'sessions', documentId, `${sessionId}.jsonl`)
  }

  #candidateDirectory(documentId: string, candidateId: string): string {
    return join(
      this.#root,
      'sync',
      'conflicts',
      'project',
      createHash('sha256').update(documentId).digest('hex'),
      candidateId,
    )
  }
}
