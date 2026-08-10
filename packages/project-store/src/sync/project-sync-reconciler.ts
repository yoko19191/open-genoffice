import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { assertCanonicalPathSet, canonicalJsonBytes, sha256Hex } from './canonical.js'
import {
  CredentialSlotDescriptionSchema,
  ProjectSyncManifestSchema,
  SyncHeadSchema,
  SyncRevisionSchema,
} from './schema.js'
import {
  ProviderUnavailableError,
  type ProjectManifestEntry,
  type ProjectSyncEntry,
  type ProjectSyncKind,
  type ProjectSyncManifest,
  type ReconcileIntent,
  type ReconcileIntentStore,
  type RemoteBase,
  type SyncHead,
  type SyncObjectStore,
  type SyncRevision,
} from './types.js'

const ROOT_MANIFEST_PATH = '.open-genoffice'
const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024 * 1024
const ALLOWED_KINDS = new Set<ProjectSyncKind>([
  'office-document',
  'project-asset',
  'project-metadata',
  'project-resource',
  'pi-session-snapshot',
  'credential-slot',
])

interface PreparedEntry {
  canonicalPath: string
  kind: ProjectSyncKind
  bytes: Uint8Array
  contentHash: string
  executable: boolean
  network: boolean
}

interface ProjectSyncReconcilerOptions {
  store: SyncObjectStore
  scopeId: string
  authorDeviceId: string
  maxObjectBytes?: number
  intentStore?: ReconcileIntentStore
}

export type PublishResult =
  | {
      status: 'published'
      head: SyncHead
      manifest: ProjectSyncManifest
      remoteBase: RemoteBase
    }
  | { status: 'conflict'; remoteBase: RemoteBase | null }

export type RestoreResult =
  | { status: 'restored'; head: SyncHead; manifestHash: string; manifest: ProjectSyncManifest }
  | { status: 'conflict'; canonicalPath: string }
  | { status: 'empty' }

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('sync_remote_object_invalid')
  }
}

function parseHead(bytes: Uint8Array, scopeId: string): SyncHead {
  const value = parseJson(bytes)
  if (!Value.Check(SyncHeadSchema, value) || value.scopeId !== scopeId)
    throw new Error('sync_head_invalid')
  return value
}

function parseRevision(bytes: Uint8Array, expectedId: string, scopeId: string): SyncRevision {
  const value = parseJson(bytes)
  if (
    sha256Hex(bytes) !== expectedId ||
    !Value.Check(SyncRevisionSchema, value) ||
    value.namespace !== 'project' ||
    value.scopeId !== scopeId
  ) {
    throw new Error('sync_revision_invalid')
  }
  return value
}

function parseManifest(
  bytes: Uint8Array,
  expectedHash: string,
  scopeId: string,
): ProjectSyncManifest {
  const value = parseJson(bytes)
  if (
    sha256Hex(bytes) !== expectedHash ||
    !Value.Check(ProjectSyncManifestSchema, value) ||
    value.scopeId !== scopeId
  ) {
    throw new Error('sync_manifest_invalid')
  }
  const paths = assertCanonicalPathSet(value.entries.map((entry) => entry.canonicalPath))
  if (paths.some((path, index) => path !== value.entries[index]?.canonicalPath)) {
    throw new Error('sync_manifest_invalid')
  }
  return value
}

export class ProjectSyncReconciler {
  readonly #store: SyncObjectStore
  readonly #scopeId: string
  readonly #authorDeviceId: string
  readonly #maxObjectBytes: number
  readonly #intentStore?: ReconcileIntentStore

  constructor(options: ProjectSyncReconcilerOptions) {
    this.#store = options.store
    this.#scopeId = options.scopeId
    this.#authorDeviceId = options.authorDeviceId
    this.#maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
    this.#intentStore = options.intentStore
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#scopeId))
      throw new Error('sync_scope_invalid')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#authorDeviceId)) {
      throw new Error('sync_device_invalid')
    }
  }

  async publish(entries: ProjectSyncEntry[], base?: RemoteBase): Promise<PublishResult> {
    const prepared = this.#prepareEntries(entries)
    const diagnostics = await this.#store.probe()
    if (!diagnostics.ok || !diagnostics.strongEtag || !diagnostics.conditionalPut) {
      throw new ProviderUnavailableError()
    }
    const remoteBase = await this.#readRemoteBase()
    if (
      (remoteBase && !base) ||
      (!remoteBase && base) ||
      (remoteBase &&
        base &&
        (remoteBase.head.revisionId !== base.head.revisionId ||
          remoteBase.versionToken !== base.versionToken))
    ) {
      return { status: 'conflict', remoteBase }
    }

    const previousManifest = remoteBase
      ? await this.#readManifest(remoteBase.head.manifestHash)
      : null
    const previousByPath = new Map(
      previousManifest?.entries.map((entry) => [entry.canonicalPath, entry]),
    )
    const manifestEntries: ProjectManifestEntry[] = []

    for (const entry of prepared) {
      const previous = previousByPath.get(entry.canonicalPath)
      if (
        previous &&
        previous.contentHash === entry.contentHash &&
        previous.kind === entry.kind &&
        previous.executable === entry.executable &&
        previous.network === entry.network
      ) {
        manifestEntries.push(previous)
        continue
      }
      await this.#putContentAddressed(
        this.#blobKey(entry.contentHash),
        entry.bytes,
        entry.contentHash,
      )
      const revision: SyncRevision = {
        schemaVersion: 1,
        namespace: 'project',
        scopeId: this.#scopeId,
        canonicalPath: entry.canonicalPath,
        kind: entry.kind,
        contentHash: entry.contentHash,
        size: entry.bytes.byteLength,
        tombstone: false,
        parents: previous ? [previous.revisionId] : [],
        authorDeviceId: this.#authorDeviceId,
        event: previous ? 'update' : 'create',
        executable: entry.executable,
        network: entry.network,
      }
      const revisionBytes = canonicalJsonBytes(revision)
      const revisionId = sha256Hex(revisionBytes)
      await this.#putContentAddressed(this.#revisionKey(revisionId), revisionBytes, revisionId)
      manifestEntries.push({
        canonicalPath: entry.canonicalPath,
        kind: entry.kind,
        contentHash: entry.contentHash,
        size: entry.bytes.byteLength,
        revisionId,
        executable: entry.executable,
        network: entry.network,
      })
    }

    manifestEntries.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath, 'en-US'))
    const manifest: ProjectSyncManifest = {
      schemaVersion: 1,
      namespace: 'project',
      scopeId: this.#scopeId,
      entries: manifestEntries,
    }
    const manifestBytes = canonicalJsonBytes(manifest)
    const manifestHash = sha256Hex(manifestBytes)
    if (remoteBase?.head.manifestHash === manifestHash) {
      return { status: 'published', head: remoteBase.head, manifest, remoteBase }
    }
    await this.#putContentAddressed(this.#blobKey(manifestHash), manifestBytes, manifestHash)

    const rootRevision: SyncRevision = {
      schemaVersion: 1,
      namespace: 'project',
      scopeId: this.#scopeId,
      canonicalPath: ROOT_MANIFEST_PATH,
      kind: 'project-manifest',
      contentHash: manifestHash,
      size: manifestBytes.byteLength,
      tombstone: false,
      parents: remoteBase ? [remoteBase.head.revisionId] : [],
      authorDeviceId: this.#authorDeviceId,
      event: remoteBase ? 'update' : 'create',
      executable: false,
      network: false,
    }
    const rootBytes = canonicalJsonBytes(rootRevision)
    const revisionId = sha256Hex(rootBytes)
    await this.#putContentAddressed(this.#revisionKey(revisionId), rootBytes, revisionId)
    const head: SyncHead = { schemaVersion: 1, scopeId: this.#scopeId, revisionId, manifestHash }
    const result = await this.#store.compareAndSwap(
      this.#headKey(),
      canonicalJsonBytes(head),
      remoteBase?.versionToken ?? 'absent',
    )
    if ('conflict' in result)
      return { status: 'conflict', remoteBase: await this.#readRemoteBase() }
    return {
      status: 'published',
      head,
      manifest,
      remoteBase: { head, versionToken: result.versionToken },
    }
  }

  async reconcile(
    entries: ProjectSyncEntry[],
    options: { enabled: boolean; base?: RemoteBase },
  ): Promise<
    | PublishResult
    | { status: 'pending'; reason: 'disabled' | 'provider_unavailable'; intent: ReconcileIntent }
  > {
    const paths = assertCanonicalPathSet(entries.map((entry) => entry.canonicalPath))
    const intent: ReconcileIntent = {
      schemaVersion: 1,
      operation: 'reconcile',
      scopeId: this.#scopeId,
      paths,
    }
    if (!options.enabled) {
      await this.#intentStore?.enqueue(intent)
      return { status: 'pending', reason: 'disabled', intent }
    }
    try {
      const result = await this.publish(entries, options.base)
      if (result.status === 'published') await this.#intentStore?.clear(this.#scopeId)
      return result
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        await this.#intentStore?.enqueue(intent)
        return { status: 'pending', reason: 'provider_unavailable', intent }
      }
      throw error
    }
  }

  async restore(targetRoot: string): Promise<RestoreResult> {
    const remoteBase = await this.#readRemoteBase()
    if (!remoteBase) return { status: 'empty' }
    const rootRevision = await this.#readRevision(remoteBase.head.revisionId)
    if (
      rootRevision.kind !== 'project-manifest' ||
      rootRevision.contentHash !== remoteBase.head.manifestHash ||
      rootRevision.canonicalPath !== ROOT_MANIFEST_PATH
    ) {
      throw new Error('sync_head_invalid')
    }
    const manifest = await this.#readManifest(remoteBase.head.manifestHash)
    const restored: Array<{ entry: ProjectManifestEntry; bytes: Uint8Array; target: string }> = []
    for (const entry of manifest.entries) {
      if (entry.size > this.#maxObjectBytes) throw new Error('sync_limit_exceeded')
      const revision = await this.#readRevision(entry.revisionId)
      if (
        revision.canonicalPath !== entry.canonicalPath ||
        revision.kind !== entry.kind ||
        revision.contentHash !== entry.contentHash ||
        revision.size !== entry.size ||
        revision.tombstone ||
        revision.executable !== entry.executable ||
        revision.network !== entry.network
      ) {
        throw new Error('sync_manifest_revision_mismatch')
      }
      const object = await this.#store.get(this.#blobKey(entry.contentHash))
      if (
        !object ||
        object.bytes.byteLength !== entry.size ||
        sha256Hex(object.bytes) !== entry.contentHash
      ) {
        throw new Error('sync_blob_invalid')
      }
      const target = join(targetRoot, ...entry.canonicalPath.split('/'))
      await this.#assertNoSymlink(targetRoot, entry.canonicalPath)
      const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (current && !current.equals(Buffer.from(object.bytes))) {
        return { status: 'conflict', canonicalPath: entry.canonicalPath }
      }
      restored.push({ entry, bytes: object.bytes, target })
    }

    for (const item of restored) {
      const current = await readFile(item.target).catch(() => null)
      if (current) continue
      await mkdir(dirname(item.target), { recursive: true })
      const temporary = `${item.target}.open-genoffice-sync-${item.entry.contentHash.slice(0, 12)}.tmp`
      try {
        await writeFile(temporary, item.bytes, { flag: 'wx' })
        await rename(temporary, item.target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    }
    return {
      status: 'restored',
      head: remoteBase.head,
      manifestHash: remoteBase.head.manifestHash,
      manifest,
    }
  }

  #prepareEntries(entries: ProjectSyncEntry[]): PreparedEntry[] {
    const paths = assertCanonicalPathSet(entries.map((entry) => entry.canonicalPath))
    return entries.map((entry, index) => {
      if (!ALLOWED_KINDS.has(entry.kind)) throw new Error('sync_kind_excluded')
      if (paths[index] === ROOT_MANIFEST_PATH) throw new Error('sync_path_reserved')
      let bytes: Uint8Array
      if (entry.kind === 'credential-slot') {
        if (entry.bytes) throw new Error('sync_credential_secret_forbidden')
        if (!Value.Check(CredentialSlotDescriptionSchema, entry.credentialSlot)) {
          throw new Error('sync_credential_slot_invalid')
        }
        bytes = canonicalJsonBytes(entry.credentialSlot)
      } else {
        if (!entry.bytes || entry.credentialSlot) throw new Error('sync_entry_invalid')
        bytes = entry.bytes
      }
      if (bytes.byteLength > this.#maxObjectBytes) throw new Error('sync_limit_exceeded')
      return {
        canonicalPath: paths[index]!,
        kind: entry.kind,
        bytes: bytes.slice(),
        contentHash: sha256Hex(bytes),
        executable: entry.executable ?? false,
        network: entry.network ?? false,
      }
    })
  }

  async #assertNoSymlink(targetRoot: string, canonicalPath: string): Promise<void> {
    const segments = canonicalPath.split('/')
    let current = targetRoot
    for (const segment of segments) {
      current = join(current, segment)
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (stat?.isSymbolicLink()) throw new Error('sync_symlink_escape')
      if (stat && segment !== segments.at(-1) && !stat.isDirectory())
        throw new Error('sync_target_invalid')
    }
  }

  async #readRemoteBase(): Promise<RemoteBase | null> {
    const object = await this.#store.get(this.#headKey())
    return object
      ? { head: parseHead(object.bytes, this.#scopeId), versionToken: object.versionToken }
      : null
  }

  async #readManifest(hash: string): Promise<ProjectSyncManifest> {
    const object = await this.#store.get(this.#blobKey(hash))
    if (!object) throw new Error('sync_manifest_missing')
    return parseManifest(object.bytes, hash, this.#scopeId)
  }

  async #readRevision(revisionId: string): Promise<SyncRevision> {
    const object = await this.#store.get(this.#revisionKey(revisionId))
    if (!object) throw new Error('sync_revision_missing')
    return parseRevision(object.bytes, revisionId, this.#scopeId)
  }

  async #putContentAddressed(key: string, bytes: Uint8Array, expectedHash: string): Promise<void> {
    const result = await this.#store.putImmutable(key, bytes)
    if (result === 'created') return
    const existing = await this.#store.get(key)
    if (!existing || sha256Hex(existing.bytes) !== expectedHash)
      throw new Error('sync_immutable_object_mismatch')
  }

  #prefix(): string {
    return `open-genoffice-sync/v1/project/${this.#scopeId}`
  }

  #blobKey(hash: string): string {
    return `${this.#prefix()}/blobs/sha256/${hash.slice(0, 2)}/${hash}`
  }

  #revisionKey(revisionId: string): string {
    return `${this.#prefix()}/revisions/sha256/${revisionId.slice(0, 2)}/${revisionId}.json`
  }

  #headKey(): string {
    return `${this.#prefix()}/head.json`
  }
}
