import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { assertCanonicalPathSet, canonicalJsonBytes, sha256Hex } from './canonical.js'
import type {
  ConflictBranch,
  ConflictChoice,
  ProjectConflictStore,
  ProjectSyncConflict,
} from './conflict-copy-store.js'
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
  type SyncKind,
  type SyncNamespace,
  type SyncObjectStore,
  type SyncRevision,
} from './types.js'

const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024 * 1024
const PROJECT_KINDS = new Set<SyncKind>([
  'office-document',
  'project-asset',
  'project-metadata',
  'project-resource',
  'pi-session-snapshot',
  'credential-slot',
])
const GLOBAL_KINDS = new Set<SyncKind>([
  'global-asset',
  'global-skill',
  'global-extension',
  'global-prompt',
  'global-package-lock',
  'global-mcp-config',
  'credential-slot',
])

interface PreparedEntry {
  canonicalPath: string
  kind: SyncKind
  bytes?: Uint8Array
  contentHash?: string
  tombstone: boolean
  executable: boolean
  network: boolean
}

export interface ProjectSyncReconcilerOptions {
  store: SyncObjectStore
  scopeId: string
  authorDeviceId: string
  namespace?: SyncNamespace
  maxObjectBytes?: number
  intentStore?: ReconcileIntentStore
  conflictFaultInjector?: (stage: ConflictFaultStage) => void | Promise<void>
}

export type ConflictFaultStage =
  | 'after-remote-download'
  | 'after-conflict-copy'
  | 'after-local-copy'
  | 'before-local-replace-validation'
  | 'before-local-replace-rename'
  | 'after-local-replace'
  | 'before-resolution-cas'
  | 'after-resolution-cas'

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
  | { status: 'deletion_confirmation_required'; canonicalPath: string; revisionId: string }
  | { status: 'empty' }

export type DivergenceReconcileResult =
  | {
      status: 'reconciled' | 'conflicts'
      conflicts: ProjectSyncConflict[]
      head: SyncHead
      manifest: ProjectSyncManifest
      remoteBase: RemoteBase
      publishedPaths: string[]
      fastForwardedPaths: string[]
      deletionConfirmations: string[]
    }
  | { status: 'retry'; remoteBase: RemoteBase | null }

export type ConflictResolutionResult =
  | {
      status: 'resolved'
      conflict: ProjectSyncConflict
      head: SyncHead
      manifest: ProjectSyncManifest
      remoteBase: RemoteBase
    }
  | { status: 'retry'; conflict: ProjectSyncConflict; remoteBase: RemoteBase | null }

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

function parseRevision(
  bytes: Uint8Array,
  expectedId: string,
  scopeId: string,
  namespace: SyncNamespace,
): SyncRevision {
  const value = parseJson(bytes)
  if (
    sha256Hex(bytes) !== expectedId ||
    !Value.Check(SyncRevisionSchema, value) ||
    value.namespace !== namespace ||
    value.scopeId !== scopeId ||
    (value.tombstone
      ? value.contentHash !== undefined ||
        value.size !== 0 ||
        !['delete', 'resolve'].includes(value.event) ||
        value.parents.length === 0
      : value.contentHash === undefined || value.event === 'delete')
  ) {
    throw new Error('sync_revision_invalid')
  }
  return value
}

function parseManifest(
  bytes: Uint8Array,
  expectedHash: string,
  scopeId: string,
  namespace: SyncNamespace,
): ProjectSyncManifest {
  const value = parseJson(bytes)
  if (
    sha256Hex(bytes) !== expectedHash ||
    !Value.Check(ProjectSyncManifestSchema, value) ||
    value.scopeId !== scopeId ||
    value.namespace !== namespace ||
    value.entries.some((entry) =>
      entry.tombstone
        ? entry.contentHash !== undefined || entry.size !== 0
        : entry.contentHash === undefined,
    )
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
  readonly #namespace: SyncNamespace
  readonly #authorDeviceId: string
  readonly #maxObjectBytes: number
  readonly #intentStore?: ReconcileIntentStore
  readonly #conflictFaultInjector?: (stage: ConflictFaultStage) => void | Promise<void>

  constructor(options: ProjectSyncReconcilerOptions) {
    this.#store = options.store
    this.#scopeId = options.scopeId
    this.#namespace = options.namespace ?? 'project'
    this.#authorDeviceId = options.authorDeviceId
    this.#maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES
    this.#intentStore = options.intentStore
    this.#conflictFaultInjector = options.conflictFaultInjector
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
    const preparedPaths = new Set(prepared.map((entry) => entry.canonicalPath))
    if (previousManifest?.entries.some((entry) => !preparedPaths.has(entry.canonicalPath))) {
      throw new Error('sync_manifest_path_missing')
    }

    for (const entry of prepared) {
      const previous = previousByPath.get(entry.canonicalPath)
      if (entry.tombstone) {
        if (!previous) throw new Error('sync_tombstone_without_parent')
        if (entry.kind !== previous.kind) throw new Error('sync_tombstone_kind_mismatch')
        if (previous.tombstone) {
          manifestEntries.push(previous)
          continue
        }
        const revision: SyncRevision = {
          schemaVersion: 1,
          namespace: this.#namespace,
          scopeId: this.#scopeId,
          canonicalPath: entry.canonicalPath,
          kind: entry.kind,
          size: 0,
          tombstone: true,
          parents: [previous.revisionId],
          authorDeviceId: this.#authorDeviceId,
          event: 'delete',
          executable: previous.executable,
          network: previous.network,
        }
        const revisionBytes = canonicalJsonBytes(revision)
        const revisionId = sha256Hex(revisionBytes)
        await this.#putContentAddressed(this.#revisionKey(revisionId), revisionBytes, revisionId)
        manifestEntries.push({
          canonicalPath: entry.canonicalPath,
          kind: entry.kind,
          size: 0,
          revisionId,
          tombstone: true,
          executable: previous.executable,
          network: previous.network,
        })
        continue
      }
      if (previous?.tombstone) throw new Error('sync_tombstone_requires_resolution')
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
      const contentHash = entry.contentHash!
      const bytes = entry.bytes!
      await this.#putContentAddressed(this.#blobKey(contentHash), bytes, contentHash)
      const revision: SyncRevision = {
        schemaVersion: 1,
        namespace: this.#namespace,
        scopeId: this.#scopeId,
        canonicalPath: entry.canonicalPath,
        kind: entry.kind,
        contentHash,
        size: bytes.byteLength,
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
        contentHash,
        size: bytes.byteLength,
        revisionId,
        tombstone: false,
        executable: entry.executable,
        network: entry.network,
      })
    }

    manifestEntries.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath, 'en-US'))
    const manifest: ProjectSyncManifest = {
      schemaVersion: 1,
      namespace: this.#namespace,
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
      namespace: this.#namespace,
      scopeId: this.#scopeId,
      canonicalPath: this.#rootManifestPath(),
      kind: this.#rootManifestKind(),
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

  async reconcileDivergence(
    entries: ProjectSyncEntry[],
    options: {
      base: RemoteBase
      targetRoot: string
      conflictStore: ProjectConflictStore
    },
  ): Promise<DivergenceReconcileResult> {
    const prepared = this.#prepareEntries(entries)
    const diagnostics = await this.#store.probe()
    if (!diagnostics.ok || !diagnostics.strongEtag || !diagnostics.conditionalPut) {
      throw new ProviderUnavailableError()
    }
    const remoteBase = await this.#readRemoteBase()
    if (!remoteBase) return { status: 'retry', remoteBase: null }
    if (
      remoteBase.head.revisionId === options.base.head.revisionId &&
      remoteBase.versionToken === options.base.versionToken
    ) {
      const published = await this.publish(entries, options.base)
      if (published.status === 'conflict') {
        return { status: 'retry', remoteBase: published.remoteBase }
      }
      return {
        status: 'reconciled',
        conflicts: [],
        head: published.head,
        manifest: published.manifest,
        remoteBase: published.remoteBase,
        publishedPaths: prepared.map((entry) => entry.canonicalPath),
        fastForwardedPaths: [],
        deletionConfirmations: [],
      }
    }

    const baseManifest = await this.#readManifest(options.base.head.manifestHash)
    const remoteManifest = await this.#readManifest(remoteBase.head.manifestHash)
    const preparedByPath = new Map(prepared.map((entry) => [entry.canonicalPath, entry]))
    const baseByPath = new Map(baseManifest.entries.map((entry) => [entry.canonicalPath, entry]))
    const remoteByPath = new Map(
      remoteManifest.entries.map((entry) => [entry.canonicalPath, entry]),
    )
    if (
      baseManifest.entries.some(
        (entry) =>
          !preparedByPath.has(entry.canonicalPath) || !remoteByPath.has(entry.canonicalPath),
      )
    ) {
      throw new Error('sync_manifest_path_missing')
    }

    const paths = [...new Set([...preparedByPath.keys(), ...remoteByPath.keys()])].sort((a, b) =>
      a.localeCompare(b, 'en-US'),
    )
    const nextEntries: ProjectManifestEntry[] = []
    const conflicts: ProjectSyncConflict[] = []
    const publishedPaths: string[] = []
    const fastForwardedPaths: string[] = []
    const deletionConfirmations: string[] = []

    for (const path of paths) {
      const local = preparedByPath.get(path)
      const baseEntry = baseByPath.get(path)
      const remoteEntry = remoteByPath.get(path)
      const localMatchesBase = Boolean(
        local && baseEntry && this.#preparedMatches(local, baseEntry),
      )
      const localBranch = local
        ? localMatchesBase
          ? null
          : this.#preparedBranch(local, baseEntry?.revisionId)
        : null
      const localRevisionId = localMatchesBase ? baseEntry!.revisionId : localBranch?.revisionId
      const baseRevisionId = baseEntry?.revisionId
      const remoteRevisionId = remoteEntry?.revisionId
      const localChanged = localRevisionId !== baseRevisionId
      const remoteChanged = remoteRevisionId !== baseRevisionId

      if (
        remoteChanged &&
        baseEntry &&
        remoteEntry &&
        !(await this.#isRevisionDescendant(remoteEntry.revisionId, baseEntry.revisionId))
      ) {
        const currentLocalBranch = localBranch ?? (await this.#entryBranch(baseEntry))
        const remoteBranch = await this.#entryBranch(remoteEntry)
        const remoteBytes = remoteEntry.tombstone
          ? undefined
          : await this.#readEntryBytes(remoteEntry)
        await this.#injectConflictFault('after-remote-download')
        const conflict = await options.conflictStore.open({
          scopeId: this.#scopeId,
          canonicalPath: path,
          kind: currentLocalBranch.revision.kind as ProjectSyncKind,
          baseRevisionId: baseEntry.revisionId,
          local: currentLocalBranch,
          remote: remoteBranch,
          ...(remoteBytes ? { remoteBytes } : {}),
        })
        await this.#injectConflictFault('after-conflict-copy')
        conflicts.push(conflict)
        nextEntries.push(remoteEntry)
        continue
      }

      if (localChanged && remoteChanged) {
        if (local && remoteEntry && this.#preparedMatches(local, remoteEntry)) {
          nextEntries.push(remoteEntry)
          continue
        }
        const changedLocalBranch = localBranch!
        const changedRemoteEntry = remoteEntry!
        const remoteBranch = await this.#entryBranch(changedRemoteEntry)
        const remoteBytes = changedRemoteEntry.tombstone
          ? undefined
          : await this.#readEntryBytes(changedRemoteEntry)
        await this.#injectConflictFault('after-remote-download')
        const conflict = await options.conflictStore.open({
          scopeId: this.#scopeId,
          canonicalPath: path,
          kind: changedLocalBranch.revision.kind as ProjectSyncKind,
          baseRevisionId: baseRevisionId ?? null,
          local: changedLocalBranch,
          remote: remoteBranch,
          ...(remoteBytes ? { remoteBytes } : {}),
        })
        await this.#injectConflictFault('after-conflict-copy')
        conflicts.push(conflict)
        nextEntries.push(changedRemoteEntry)
        continue
      }

      if (localChanged) {
        const changedLocalBranch = localBranch!
        await this.#uploadBranch(changedLocalBranch, local!)
        nextEntries.push(this.#manifestEntry(changedLocalBranch))
        publishedPaths.push(path)
        continue
      }

      if (remoteChanged) {
        const changedRemoteEntry = remoteEntry!
        nextEntries.push(changedRemoteEntry)
        if (changedRemoteEntry.tombstone) {
          deletionConfirmations.push(path)
          continue
        }
        const remoteBytes = await this.#readEntryBytes(changedRemoteEntry)
        await this.#replaceUnchangedLocal(options.targetRoot, path, remoteBytes, local?.bytes)
        fastForwardedPaths.push(path)
        continue
      }

      if (remoteEntry) nextEntries.push(remoteEntry)
    }

    const changedRemoteManifest =
      nextEntries.length !== remoteManifest.entries.length ||
      nextEntries.some(
        (entry, index) => entry.revisionId !== remoteManifest.entries[index]?.revisionId,
      )
    const committed = changedRemoteManifest
      ? await this.#commitManifest(nextEntries, remoteBase)
      : {
          status: 'published' as const,
          head: remoteBase.head,
          manifest: remoteManifest,
          remoteBase,
        }
    if (committed.status === 'conflict') {
      return { status: 'retry', remoteBase: committed.remoteBase }
    }
    return {
      status: conflicts.length > 0 ? 'conflicts' : 'reconciled',
      conflicts,
      head: committed.head,
      manifest: committed.manifest,
      remoteBase: committed.remoteBase,
      publishedPaths,
      fastForwardedPaths,
      deletionConfirmations,
    }
  }

  async resolveConflict(options: {
    conflictStore: ProjectConflictStore
    conflictId: string
    choice: ConflictChoice
    targetRoot: string
  }): Promise<ConflictResolutionResult> {
    const conflict = await options.conflictStore.load(this.#scopeId, options.conflictId)
    if (conflict.state !== 'open') throw new Error('sync_conflict_resolved')
    const selected = options.choice === 'keep-local' ? conflict.local : conflict.remote
    const conflictCopyRevisionId =
      options.choice === 'keep-local' ? conflict.remote.revisionId : conflict.local.revisionId
    const parents = [conflict.local.revisionId, conflict.remote.revisionId].sort((a, b) =>
      a.localeCompare(b, 'en-US'),
    )
    const resolution: SyncRevision = {
      ...selected.revision,
      parents,
      authorDeviceId: this.#authorDeviceId,
      event: 'resolve',
    }
    const resolutionBytes = canonicalJsonBytes(resolution)
    const resolutionRevisionId = sha256Hex(resolutionBytes)
    const resolutionBranch: ConflictBranch = {
      revisionId: resolutionRevisionId,
      revision: resolution,
    }
    const remoteBase = await this.#readRemoteBase()
    if (!remoteBase) throw new Error('sync_conflict_stale')
    const remoteManifest = await this.#readManifest(remoteBase.head.manifestHash)
    const remoteEntry = remoteManifest.entries.find(
      (entry) => entry.canonicalPath === conflict.canonicalPath,
    )
    if (
      remoteEntry?.revisionId !== conflict.remote.revisionId &&
      remoteEntry?.revisionId !== resolutionRevisionId
    ) {
      throw new Error('sync_conflict_stale')
    }

    const remoteBytes = conflict.remote.revision.tombstone
      ? undefined
      : await options.conflictStore.readCopy(
          this.#scopeId,
          conflict.conflictId,
          conflict.remote.revisionId,
        )
    let localBytes: Uint8Array | undefined
    if (options.choice === 'keep-local') {
      localBytes = await this.#readLocalBranchBytes(options.targetRoot, conflict.local)
    } else {
      const current = await this.#readCurrentPathBytes(options.targetRoot, conflict.canonicalPath)
      if (this.#branchMatchesBytes(conflict.local, current)) {
        localBytes = current ?? undefined
        if (localBytes) {
          await options.conflictStore.saveLocalCopy(this.#scopeId, conflict.conflictId, localBytes)
        }
        await this.#injectConflictFault('after-local-copy')
        if (remoteBytes) {
          if (localBytes) {
            await this.#assertLocalBytes(options.targetRoot, conflict.canonicalPath, localBytes)
          }
          await options.conflictStore.restoreCopy(
            this.#scopeId,
            conflict.conflictId,
            conflict.remote.revisionId,
            options.targetRoot,
          )
        } else {
          await this.#removeLocalCurrent(options.targetRoot, conflict.canonicalPath, localBytes!)
        }
        await this.#injectConflictFault('after-local-replace')
      } else if (this.#branchMatchesBytes(conflict.remote, current)) {
        localBytes = conflict.local.revision.tombstone
          ? undefined
          : await options.conflictStore.readCopy(
              this.#scopeId,
              conflict.conflictId,
              conflict.local.revisionId,
            )
      } else {
        throw new Error('sync_conflict_local_changed')
      }
    }
    await this.#uploadExistingBranch(conflict.local, localBytes)

    if (remoteEntry.revisionId === resolutionRevisionId) {
      const resolved = await options.conflictStore.markResolved(
        this.#scopeId,
        conflict.conflictId,
        { choice: options.choice, resolutionRevisionId, conflictCopyRevisionId },
      )
      return {
        status: 'resolved',
        conflict: resolved,
        head: remoteBase.head,
        manifest: remoteManifest,
        remoteBase,
      }
    }
    if (
      selected.revision.contentHash &&
      (options.choice === 'keep-local' ? localBytes : remoteBytes)
    ) {
      await this.#putContentAddressed(
        this.#blobKey(selected.revision.contentHash),
        (options.choice === 'keep-local' ? localBytes : remoteBytes)!,
        selected.revision.contentHash,
      )
    }
    await this.#putContentAddressed(
      this.#revisionKey(resolutionRevisionId),
      resolutionBytes,
      resolutionRevisionId,
    )
    await this.#injectConflictFault('before-resolution-cas')
    const nextEntries = remoteManifest.entries.map((entry) =>
      entry.canonicalPath === conflict.canonicalPath
        ? this.#manifestEntry(resolutionBranch)
        : entry,
    )
    const committed = await this.#commitManifest(nextEntries, remoteBase)
    if (committed.status === 'conflict') {
      return { status: 'retry', conflict, remoteBase: committed.remoteBase }
    }
    await this.#injectConflictFault('after-resolution-cas')
    const resolved = await options.conflictStore.markResolved(this.#scopeId, conflict.conflictId, {
      choice: options.choice,
      resolutionRevisionId,
      conflictCopyRevisionId,
    })
    return {
      status: 'resolved',
      conflict: resolved,
      head: committed.head,
      manifest: committed.manifest,
      remoteBase: committed.remoteBase,
    }
  }

  async restore(targetRoot: string): Promise<RestoreResult> {
    const remoteBase = await this.#readRemoteBase()
    if (!remoteBase) return { status: 'empty' }
    const rootRevision = await this.#readRevision(remoteBase.head.revisionId)
    if (
      rootRevision.kind !== this.#rootManifestKind() ||
      rootRevision.contentHash !== remoteBase.head.manifestHash ||
      rootRevision.canonicalPath !== this.#rootManifestPath()
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
        revision.tombstone !== entry.tombstone ||
        revision.executable !== entry.executable ||
        revision.network !== entry.network
      ) {
        throw new Error('sync_manifest_revision_mismatch')
      }
      const target = join(targetRoot, ...entry.canonicalPath.split('/'))
      await this.#assertNoSymlink(targetRoot, entry.canonicalPath)
      if (entry.tombstone) {
        if (entry.contentHash !== undefined || entry.size !== 0) {
          throw new Error('sync_manifest_revision_mismatch')
        }
        const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (current) {
          return {
            status: 'deletion_confirmation_required',
            canonicalPath: entry.canonicalPath,
            revisionId: entry.revisionId,
          }
        }
        continue
      }
      const contentHash = entry.contentHash!
      const object = await this.#store.get(this.#blobKey(contentHash))
      if (
        !object ||
        object.bytes.byteLength !== entry.size ||
        sha256Hex(object.bytes) !== contentHash
      ) {
        throw new Error('sync_blob_invalid')
      }
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
      const temporary = `${item.target}.open-genoffice-sync-${item.entry.contentHash!.slice(0, 12)}.tmp`
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

  #preparedMatches(entry: PreparedEntry, manifest: ProjectManifestEntry): boolean {
    return (
      entry.kind === manifest.kind &&
      entry.contentHash === manifest.contentHash &&
      entry.tombstone === manifest.tombstone &&
      (entry.tombstone || entry.bytes?.byteLength === manifest.size) &&
      entry.executable === manifest.executable &&
      entry.network === manifest.network
    )
  }

  #preparedBranch(entry: PreparedEntry, parentRevisionId?: string): ConflictBranch {
    if (entry.tombstone && !parentRevisionId) throw new Error('sync_tombstone_without_parent')
    const revision: SyncRevision = {
      schemaVersion: 1,
      namespace: this.#namespace,
      scopeId: this.#scopeId,
      canonicalPath: entry.canonicalPath,
      kind: entry.kind,
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      size: entry.bytes?.byteLength ?? 0,
      tombstone: entry.tombstone,
      parents: parentRevisionId ? [parentRevisionId] : [],
      authorDeviceId: this.#authorDeviceId,
      event: entry.tombstone ? 'delete' : parentRevisionId ? 'update' : 'create',
      executable: entry.executable,
      network: entry.network,
    }
    return { revisionId: sha256Hex(canonicalJsonBytes(revision)), revision }
  }

  async #entryBranch(entry: ProjectManifestEntry): Promise<ConflictBranch> {
    const revision = await this.#readRevision(entry.revisionId)
    if (
      revision.canonicalPath !== entry.canonicalPath ||
      revision.kind !== entry.kind ||
      revision.contentHash !== entry.contentHash ||
      revision.size !== entry.size ||
      revision.tombstone !== entry.tombstone ||
      revision.executable !== entry.executable ||
      revision.network !== entry.network
    ) {
      throw new Error('sync_manifest_revision_mismatch')
    }
    return { revisionId: entry.revisionId, revision }
  }

  async #isRevisionDescendant(revisionId: string, ancestorId: string): Promise<boolean> {
    const pending = [revisionId]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()!
      if (current === ancestorId) return true
      if (visited.has(current)) continue
      visited.add(current)
      if (visited.size > 10_000) throw new Error('sync_revision_ancestry_limit')
      const revision = await this.#readRevision(current)
      pending.push(...revision.parents)
    }
    return false
  }

  async #readEntryBytes(entry: ProjectManifestEntry): Promise<Uint8Array> {
    const contentHash = entry.contentHash!
    const object = await this.#store.get(this.#blobKey(contentHash))
    if (
      !object ||
      object.bytes.byteLength !== entry.size ||
      sha256Hex(object.bytes) !== contentHash
    ) {
      throw new Error('sync_blob_invalid')
    }
    return object.bytes
  }

  async #uploadBranch(branch: ConflictBranch, prepared: PreparedEntry): Promise<void> {
    await this.#uploadExistingBranch(branch, prepared.bytes)
  }

  async #uploadExistingBranch(branch: ConflictBranch, bytes?: Uint8Array): Promise<void> {
    if (!branch.revision.tombstone) {
      const contentHash = branch.revision.contentHash!
      await this.#putContentAddressed(this.#blobKey(contentHash), bytes!, contentHash)
    }
    const revisionBytes = canonicalJsonBytes(branch.revision)
    await this.#putContentAddressed(
      this.#revisionKey(branch.revisionId),
      revisionBytes,
      branch.revisionId,
    )
  }

  #manifestEntry(branch: ConflictBranch): ProjectManifestEntry {
    return {
      canonicalPath: branch.revision.canonicalPath,
      kind: branch.revision.kind as ProjectSyncKind,
      ...(branch.revision.contentHash ? { contentHash: branch.revision.contentHash } : {}),
      size: branch.revision.size,
      revisionId: branch.revisionId,
      tombstone: branch.revision.tombstone,
      executable: branch.revision.executable,
      network: branch.revision.network,
    }
  }

  async #commitManifest(
    entries: ProjectManifestEntry[],
    remoteBase: RemoteBase,
  ): Promise<
    | {
        status: 'published'
        head: SyncHead
        manifest: ProjectSyncManifest
        remoteBase: RemoteBase
      }
    | { status: 'conflict'; remoteBase: RemoteBase | null }
  > {
    entries.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath, 'en-US'))
    const manifest: ProjectSyncManifest = {
      schemaVersion: 1,
      namespace: this.#namespace,
      scopeId: this.#scopeId,
      entries,
    }
    const manifestBytes = canonicalJsonBytes(manifest)
    const manifestHash = sha256Hex(manifestBytes)
    await this.#putContentAddressed(this.#blobKey(manifestHash), manifestBytes, manifestHash)
    const rootRevision: SyncRevision = {
      schemaVersion: 1,
      namespace: this.#namespace,
      scopeId: this.#scopeId,
      canonicalPath: this.#rootManifestPath(),
      kind: this.#rootManifestKind(),
      contentHash: manifestHash,
      size: manifestBytes.byteLength,
      tombstone: false,
      parents: [remoteBase.head.revisionId],
      authorDeviceId: this.#authorDeviceId,
      event: 'update',
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
      remoteBase.versionToken,
    )
    if ('conflict' in result) {
      return { status: 'conflict', remoteBase: await this.#readRemoteBase() }
    }
    return {
      status: 'published',
      head,
      manifest,
      remoteBase: { head, versionToken: result.versionToken },
    }
  }

  async #replaceUnchangedLocal(
    targetRoot: string,
    canonicalPath: string,
    nextBytes: Uint8Array,
    expectedBytes?: Uint8Array,
  ): Promise<void> {
    const target = join(targetRoot, ...canonicalPath.split('/'))
    await this.#assertNoSymlink(targetRoot, canonicalPath)
    const current = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      (expectedBytes && (!current || !current.equals(Buffer.from(expectedBytes)))) ||
      (!expectedBytes && current)
    ) {
      throw new Error('sync_local_current_changed')
    }
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.open-genoffice-sync-${sha256Hex(nextBytes).slice(0, 12)}.tmp`
    try {
      await writeFile(temporary, nextBytes, { flag: 'wx' })
      await this.#injectConflictFault('before-local-replace-validation')
      const beforeRename = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (
        (expectedBytes && (!beforeRename || !beforeRename.equals(Buffer.from(expectedBytes)))) ||
        (!expectedBytes && beforeRename)
      ) {
        throw new Error('sync_local_current_changed')
      }
      await this.#injectConflictFault('before-local-replace-rename')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async #readLocalBranchBytes(
    targetRoot: string,
    branch: ConflictBranch,
  ): Promise<Uint8Array | undefined> {
    if (branch.revision.tombstone) return undefined
    const target = join(targetRoot, ...branch.revision.canonicalPath.split('/'))
    await this.#assertNoSymlink(targetRoot, branch.revision.canonicalPath)
    const bytes = new Uint8Array(await readFile(target))
    if (
      !branch.revision.contentHash ||
      bytes.byteLength !== branch.revision.size ||
      sha256Hex(bytes) !== branch.revision.contentHash
    ) {
      throw new Error('sync_conflict_local_changed')
    }
    return bytes
  }

  async #removeLocalCurrent(
    targetRoot: string,
    canonicalPath: string,
    expected: Uint8Array,
  ): Promise<void> {
    await this.#assertLocalBytes(targetRoot, canonicalPath, expected)
    await rm(join(targetRoot, ...canonicalPath.split('/')))
  }

  async #readCurrentPathBytes(
    targetRoot: string,
    canonicalPath: string,
  ): Promise<Uint8Array | null> {
    const target = join(targetRoot, ...canonicalPath.split('/'))
    await this.#assertNoSymlink(targetRoot, canonicalPath)
    const bytes = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return bytes ? new Uint8Array(bytes) : null
  }

  #branchMatchesBytes(branch: ConflictBranch, bytes: Uint8Array | null): boolean {
    return branch.revision.tombstone
      ? bytes === null
      : Boolean(
          bytes &&
          branch.revision.contentHash &&
          bytes.byteLength === branch.revision.size &&
          sha256Hex(bytes) === branch.revision.contentHash,
        )
  }

  async #assertLocalBytes(
    targetRoot: string,
    canonicalPath: string,
    expected: Uint8Array,
  ): Promise<void> {
    const target = join(targetRoot, ...canonicalPath.split('/'))
    await this.#assertNoSymlink(targetRoot, canonicalPath)
    const current = await readFile(target)
    if (!current.equals(Buffer.from(expected))) throw new Error('sync_conflict_local_changed')
  }

  async #injectConflictFault(stage: ConflictFaultStage): Promise<void> {
    await this.#conflictFaultInjector?.(stage)
  }

  #prepareEntries(entries: ProjectSyncEntry[]): PreparedEntry[] {
    const paths = assertCanonicalPathSet(entries.map((entry) => entry.canonicalPath))
    const allowedKinds = this.#namespace === 'project' ? PROJECT_KINDS : GLOBAL_KINDS
    return entries.map((entry, index) => {
      if (!allowedKinds.has(entry.kind)) throw new Error('sync_kind_excluded')
      if (paths[index] === this.#rootManifestPath()) throw new Error('sync_path_reserved')
      if (entry.tombstone) {
        if (entry.bytes || entry.credentialSlot || entry.executable || entry.network) {
          throw new Error('sync_tombstone_invalid')
        }
        return {
          canonicalPath: paths[index]!,
          kind: entry.kind,
          tombstone: true,
          executable: false,
          network: false,
        }
      }
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
        tombstone: false,
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
    return parseManifest(object.bytes, hash, this.#scopeId, this.#namespace)
  }

  async #readRevision(revisionId: string): Promise<SyncRevision> {
    const object = await this.#store.get(this.#revisionKey(revisionId))
    if (!object) throw new Error('sync_revision_missing')
    return parseRevision(object.bytes, revisionId, this.#scopeId, this.#namespace)
  }

  async #putContentAddressed(key: string, bytes: Uint8Array, expectedHash: string): Promise<void> {
    const result = await this.#store.putImmutable(key, bytes)
    if (result === 'created') return
    const existing = await this.#store.get(key)
    if (!existing || sha256Hex(existing.bytes) !== expectedHash)
      throw new Error('sync_immutable_object_mismatch')
  }

  #prefix(): string {
    return `open-genoffice-sync/v1/${this.#namespace}/${this.#scopeId}`
  }

  #rootManifestPath(): string {
    return this.#namespace === 'project' ? '.open-genoffice' : '.open-genoffice-global'
  }

  #rootManifestKind(): string {
    return `${this.#namespace}-manifest`
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

export type GlobalAssetSyncReconcilerOptions = Omit<ProjectSyncReconcilerOptions, 'namespace'>

export class GlobalAssetSyncReconciler extends ProjectSyncReconciler {
  constructor(options: GlobalAssetSyncReconcilerOptions) {
    super({ ...options, namespace: 'global' })
  }
}
