import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileConflictCopyStore } from '../src/sync/conflict-copy-store.js'
import { canonicalJsonBytes } from '../src/sync/canonical.js'
import { InMemorySyncObjectStore } from '../src/sync/memory-object-store.js'
import { ProjectSyncReconciler } from '../src/sync/project-sync-reconciler.js'
import type { ProjectSyncEntry, SyncRevision } from '../src/sync/types.js'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function entries(document: string, metadata: string): ProjectSyncEntry[] {
  return [
    {
      canonicalPath: 'documents/report.docx',
      kind: 'office-document',
      bytes: new TextEncoder().encode(document),
    },
    {
      canonicalPath: '.open-genoffice/project.json',
      kind: 'project-metadata',
      bytes: new TextEncoder().encode(metadata),
    },
  ]
}

async function writeLocalCurrent(targetRoot: string, document: string, metadata: string) {
  await mkdir(join(targetRoot, 'documents'), { recursive: true })
  await mkdir(join(targetRoot, '.open-genoffice'), { recursive: true })
  await writeFile(join(targetRoot, 'documents/report.docx'), document)
  await writeFile(join(targetRoot, '.open-genoffice/project.json'), metadata)
}

async function readRevision(
  store: InMemorySyncObjectStore,
  scopeId: string,
  revisionId: string,
): Promise<SyncRevision> {
  const object = await store.get(
    `open-genoffice-sync/v1/project/${scopeId}/revisions/sha256/${revisionId.slice(0, 2)}/${revisionId}.json`,
  )
  if (!object) throw new Error('revision_missing')
  return JSON.parse(Buffer.from(object.bytes).toString('utf8')) as SyncRevision
}

class ControllableCasStore extends InMemorySyncObjectStore {
  failNextCas = false

  override async compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ) {
    if (this.failNextCas) {
      this.failNextCas = false
      return { conflict: true } as const
    }
    return super.compareAndSwap(key, bytes, expectedVersion)
  }
}

class InvalidProbeStore extends InMemorySyncObjectStore {
  override async probe() {
    return { ok: false, strongEtag: false, conditionalPut: false }
  }
}

class MissingObjectStore extends InMemorySyncObjectStore {
  missingKeyFragment: string | null = null

  override async get(key: string) {
    if (this.missingKeyFragment && key.includes(this.missingKeyFragment)) return null
    return super.get(key)
  }
}

async function divergentFixture(
  conflictFaultInjector?: (stage: string) => void | Promise<void>,
  store: InMemorySyncObjectStore = new InMemorySyncObjectStore(),
) {
  const scopeId = 'project-conflict'
  const local = new ProjectSyncReconciler({
    store,
    scopeId,
    authorDeviceId: 'device-a',
    ...(conflictFaultInjector ? { conflictFaultInjector } : {}),
  })
  const remote = new ProjectSyncReconciler({
    store,
    scopeId,
    authorDeviceId: 'device-b',
  })
  const base = await local.publish(entries('base-document', 'base-metadata'))
  if (base.status !== 'published') throw new Error('base_publish_failed')
  const remotePublished = await remote.publish(
    entries('remote-document', 'base-metadata'),
    base.remoteBase,
  )
  if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
  const targetRoot = await tempRoot('project-conflict-current-')
  await writeLocalCurrent(targetRoot, 'local-document', 'local-metadata')
  const conflictStore = new FileConflictCopyStore(await tempRoot('project-conflict-store-'))
  return {
    scopeId,
    store,
    local,
    base,
    remotePublished,
    targetRoot,
    conflictStore,
    localEntries: entries('local-document', 'local-metadata'),
  }
}

describe('ProjectSyncReconciler conflicts', () => {
  it('keeps Local Current, stores the remote branch and publishes non-conflicting paths', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    expect(reconciled.status).toBe('conflicts')
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    expect(reconciled.conflicts).toHaveLength(1)
    const conflict = reconciled.conflicts[0]!
    const baseDocument = fixture.base.manifest.entries.find(
      (entry) => entry.canonicalPath === 'documents/report.docx',
    )!
    expect(conflict).toMatchObject({
      canonicalPath: 'documents/report.docx',
      baseRevisionId: baseDocument.revisionId,
      state: 'open',
    })
    expect(conflict.local.revision.parents).toEqual([baseDocument.revisionId])
    expect(conflict.remote.revision.parents).toEqual([baseDocument.revisionId])
    expect(await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'local-document',
    )
    expect(
      Buffer.from(
        await fixture.conflictStore.readCopy(
          fixture.scopeId,
          conflict.conflictId,
          conflict.remote.revisionId,
        ),
      ).toString('utf8'),
    ).toBe('remote-document')

    const cleanRoot = await tempRoot('project-conflict-clean-')
    const clean = new ProjectSyncReconciler({
      store: fixture.store,
      scopeId: fixture.scopeId,
      authorDeviceId: 'device-clean',
    })
    await expect(clean.restore(cleanRoot)).resolves.toMatchObject({ status: 'restored' })
    expect(await readFile(join(cleanRoot, 'documents/report.docx'), 'utf8')).toBe('remote-document')
    expect(await readFile(join(cleanRoot, '.open-genoffice/project.json'), 'utf8')).toBe(
      'local-metadata',
    )
  })

  it('keep-local creates a two-parent resolution while retaining the remote Conflict Copy', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const open = reconciled.conflicts[0]!
    const resolved = await fixture.local.resolveConflict({
      conflictStore: fixture.conflictStore,
      conflictId: open.conflictId,
      choice: 'keep-local',
      targetRoot: fixture.targetRoot,
    })
    expect(resolved.status).toBe('resolved')
    if (resolved.status !== 'resolved') throw new Error('resolution_failed')
    expect(resolved.conflict).toMatchObject({
      state: 'resolved',
      choice: 'keep-local',
      conflictCopyRevisionId: open.remote.revisionId,
    })
    const resolutionEntry = resolved.manifest.entries.find(
      (entry) => entry.canonicalPath === open.canonicalPath,
    )!
    const revision = await readRevision(fixture.store, fixture.scopeId, resolutionEntry.revisionId)
    expect(revision).toMatchObject({
      event: 'resolve',
      contentHash: open.local.revision.contentHash,
    })
    expect(revision.parents).toEqual(
      [open.local.revisionId, open.remote.revisionId].sort((a, b) => a.localeCompare(b, 'en-US')),
    )
    expect(await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'local-document',
    )
    expect(
      Buffer.from(
        await fixture.conflictStore.readCopy(
          fixture.scopeId,
          open.conflictId,
          open.remote.revisionId,
        ),
      ).toString('utf8'),
    ).toBe('remote-document')
  })

  it('accept-remote saves Local Current before replacement and publishes a two-parent resolution', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const open = reconciled.conflicts[0]!
    const resolved = await fixture.local.resolveConflict({
      conflictStore: fixture.conflictStore,
      conflictId: open.conflictId,
      choice: 'accept-remote',
      targetRoot: fixture.targetRoot,
    })
    expect(resolved.status).toBe('resolved')
    if (resolved.status !== 'resolved') throw new Error('resolution_failed')
    expect(resolved.conflict).toMatchObject({
      state: 'resolved',
      choice: 'accept-remote',
      conflictCopyRevisionId: open.local.revisionId,
    })
    expect(await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'remote-document',
    )
    expect(
      Buffer.from(
        await fixture.conflictStore.readCopy(
          fixture.scopeId,
          open.conflictId,
          open.local.revisionId,
        ),
      ).toString('utf8'),
    ).toBe('local-document')
    const resolutionEntry = resolved.manifest.entries.find(
      (entry) => entry.canonicalPath === open.canonicalPath,
    )!
    const revision = await readRevision(fixture.store, fixture.scopeId, resolutionEntry.revisionId)
    expect(revision).toMatchObject({
      event: 'resolve',
      contentHash: open.remote.revision.contentHash,
    })
    expect(revision.parents).toHaveLength(2)
  })

  it('treats a remote rollback as a fork instead of calling it newer or overwriting Local Current', async () => {
    const scopeId = 'project-rollback'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({
      store,
      scopeId,
      authorDeviceId: 'device-a',
    })
    const first = await local.publish(entries('generation-one', 'metadata'))
    if (first.status !== 'published') throw new Error('first_publish_failed')
    const second = await local.publish(entries('generation-two', 'metadata'), first.remoteBase)
    if (second.status !== 'published') throw new Error('second_publish_failed')
    const headKey = `open-genoffice-sync/v1/project/${scopeId}/head.json`
    await expect(
      store.compareAndSwap(headKey, canonicalJsonBytes(first.head), second.remoteBase.versionToken),
    ).resolves.toMatchObject({ versionToken: expect.any(String) })

    const targetRoot = await tempRoot('project-rollback-current-')
    await writeLocalCurrent(targetRoot, 'generation-two', 'metadata')
    const conflictStore = new FileConflictCopyStore(await tempRoot('project-rollback-store-'))
    const reconciled = await local.reconcileDivergence(entries('generation-two', 'metadata'), {
      base: second.remoteBase,
      targetRoot,
      conflictStore,
    })
    expect(reconciled.status).toBe('conflicts')
    if (reconciled.status !== 'conflicts') throw new Error('rollback_not_detected')
    expect(reconciled.conflicts).toHaveLength(1)
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe('generation-two')
    expect(
      Buffer.from(
        await conflictStore.readCopy(
          scopeId,
          reconciled.conflicts[0]!.conflictId,
          reconciled.conflicts[0]!.remote.revisionId,
        ),
      ).toString('utf8'),
    ).toBe('generation-one')
  })

  it.each(['after-remote-download', 'after-conflict-copy'])(
    'keeps Local Current and a recoverable remote branch after a crash at %s',
    async (failureStage) => {
      let armed = true
      const fixture = await divergentFixture(async (stage) => {
        if (armed && stage === failureStage) {
          armed = false
          throw new Error('injected_conflict_crash')
        }
      })
      await expect(
        fixture.local.reconcileDivergence(fixture.localEntries, {
          base: fixture.base.remoteBase,
          targetRoot: fixture.targetRoot,
          conflictStore: fixture.conflictStore,
        }),
      ).rejects.toThrow(/injected_conflict_crash/)
      expect(await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')).toBe(
        'local-document',
      )

      const recovered = await fixture.local.reconcileDivergence(fixture.localEntries, {
        base: fixture.base.remoteBase,
        targetRoot: fixture.targetRoot,
        conflictStore: fixture.conflictStore,
      })
      expect(recovered.status).toBe('conflicts')
      if (recovered.status !== 'conflicts') throw new Error('conflict_recovery_failed')
      expect(
        Buffer.from(
          await fixture.conflictStore.readCopy(
            fixture.scopeId,
            recovered.conflicts[0]!.conflictId,
            recovered.conflicts[0]!.remote.revisionId,
          ),
        ).toString('utf8'),
      ).toBe('remote-document')
    },
  )

  it.each([
    'after-local-copy',
    'after-local-replace',
    'before-resolution-cas',
    'after-resolution-cas',
  ])(
    'recovers accept-remote after a crash at %s without losing either old branch',
    async (failureStage) => {
      const fixture = await divergentFixture()
      const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
        base: fixture.base.remoteBase,
        targetRoot: fixture.targetRoot,
        conflictStore: fixture.conflictStore,
      })
      if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
      const open = reconciled.conflicts[0]!
      let armed = true
      const resolver = new ProjectSyncReconciler({
        store: fixture.store,
        scopeId: fixture.scopeId,
        authorDeviceId: 'device-a',
        conflictFaultInjector: async (stage) => {
          if (armed && stage === failureStage) {
            armed = false
            throw new Error('injected_conflict_crash')
          }
        },
      })
      await expect(
        resolver.resolveConflict({
          conflictStore: fixture.conflictStore,
          conflictId: open.conflictId,
          choice: 'accept-remote',
          targetRoot: fixture.targetRoot,
        }),
      ).rejects.toThrow(/injected_conflict_crash/)

      const current = await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')
      expect(['local-document', 'remote-document']).toContain(current)
      expect(
        Buffer.from(
          await fixture.conflictStore.readCopy(
            fixture.scopeId,
            open.conflictId,
            open.remote.revisionId,
          ),
        ).toString('utf8'),
      ).toBe('remote-document')

      const recovered = await resolver.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'accept-remote',
        targetRoot: fixture.targetRoot,
      })
      expect(recovered.status).toBe('resolved')
      expect(await readFile(join(fixture.targetRoot, 'documents/report.docx'), 'utf8')).toBe(
        'remote-document',
      )
      expect(
        Buffer.from(
          await fixture.conflictStore.readCopy(
            fixture.scopeId,
            open.conflictId,
            open.local.revisionId,
          ),
        ).toString('utf8'),
      ).toBe('local-document')
    },
  )

  it('handles an unchanged base, a missing remote and an unavailable provider explicitly', async () => {
    const scopeId = 'project-reconcile-state'
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const base = await reconciler.publish(entries('base-document', 'base-metadata'))
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const targetRoot = await tempRoot('project-state-current-')
    await writeLocalCurrent(targetRoot, 'base-document', 'base-metadata')
    const conflictStore = new FileConflictCopyStore(await tempRoot('project-state-conflicts-'))

    await expect(
      reconciler.reconcileDivergence(entries('base-document', 'base-metadata'), {
        base: base.remoteBase,
        targetRoot,
        conflictStore,
      }),
    ).resolves.toMatchObject({
      status: 'reconciled',
      conflicts: [],
      fastForwardedPaths: [],
    })

    const empty = new ProjectSyncReconciler({
      store: new InMemorySyncObjectStore(),
      scopeId,
      authorDeviceId: 'device-empty',
    })
    await expect(
      empty.reconcileDivergence(entries('base-document', 'base-metadata'), {
        base: base.remoteBase,
        targetRoot,
        conflictStore,
      }),
    ).resolves.toEqual({ status: 'retry', remoteBase: null })

    store.available = false
    await expect(
      reconciler.reconcileDivergence(entries('base-document', 'base-metadata'), {
        base: base.remoteBase,
        targetRoot,
        conflictStore,
      }),
    ).rejects.toThrow(/sync_provider_unavailable/)

    const invalidProbe = new ProjectSyncReconciler({
      store: new InvalidProbeStore(),
      scopeId,
      authorDeviceId: 'device-invalid-probe',
    })
    await expect(
      invalidProbe.reconcileDivergence(entries('base-document', 'base-metadata'), {
        base: base.remoteBase,
        targetRoot,
        conflictStore,
      }),
    ).rejects.toThrow(/sync_provider_unavailable/)
  })

  it('returns retry when the unchanged-base publish loses its head CAS', async () => {
    const store = new ControllableCasStore()
    const scopeId = 'project-same-base-race'
    const reconciler = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const base = await reconciler.publish(entries('base-document', 'base-metadata'))
    if (base.status !== 'published') throw new Error('base_publish_failed')
    store.failNextCas = true
    await expect(
      reconciler.reconcileDivergence(entries('changed-document', 'base-metadata'), {
        base: base.remoteBase,
        targetRoot: await tempRoot('project-same-base-race-current-'),
        conflictStore: new FileConflictCopyStore(
          await tempRoot('project-same-base-race-conflicts-'),
        ),
      }),
    ).resolves.toMatchObject({ status: 'retry' })
  })

  it('fails closed when a known base path disappears from the local manifest', async () => {
    const scopeId = 'project-missing-path'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const moved = await remote.publish(entries('remote-document', 'base-metadata'), base.remoteBase)
    if (moved.status !== 'published') throw new Error('remote_publish_failed')
    await expect(
      local.reconcileDivergence([baseEntries[0]!], {
        base: base.remoteBase,
        targetRoot: await tempRoot('project-missing-path-current-'),
        conflictStore: new FileConflictCopyStore(await tempRoot('project-missing-path-conflicts-')),
      }),
    ).rejects.toThrow(/sync_manifest_path_missing/)
  })

  it('fast-forwards changed and newly added remote paths without touching unrelated Local Current', async () => {
    const scopeId = 'project-fast-forward'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remoteEntries: ProjectSyncEntry[] = [
      ...entries('remote-document', 'base-metadata'),
      {
        canonicalPath: 'assets/new.bin',
        kind: 'project-asset',
        bytes: new TextEncoder().encode('remote-asset'),
      },
    ]
    const published = await remote.publish(remoteEntries, base.remoteBase)
    if (published.status !== 'published') throw new Error('remote_publish_failed')
    const targetRoot = await tempRoot('project-fast-forward-current-')
    await writeLocalCurrent(targetRoot, 'base-document', 'base-metadata')
    const reconciled = await local.reconcileDivergence(baseEntries, {
      base: base.remoteBase,
      targetRoot,
      conflictStore: new FileConflictCopyStore(await tempRoot('project-fast-forward-conflicts-')),
    })
    expect(reconciled).toMatchObject({
      status: 'reconciled',
      fastForwardedPaths: ['assets/new.bin', 'documents/report.docx'],
      deletionConfirmations: [],
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'remote-document',
    )
    expect(await readFile(join(targetRoot, 'assets/new.bin'), 'utf8')).toBe('remote-asset')
    expect(await readFile(join(targetRoot, '.open-genoffice/project.json'), 'utf8')).toBe(
      'base-metadata',
    )
  })

  it('surfaces a remote tombstone as a deletion confirmation without deleting Local Current', async () => {
    const scopeId = 'project-delete-confirmation'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const published = await remote.publish(
      [
        { canonicalPath: 'documents/report.docx', kind: 'office-document', tombstone: true },
        baseEntries[1]!,
      ],
      base.remoteBase,
    )
    if (published.status !== 'published') throw new Error('remote_publish_failed')
    const targetRoot = await tempRoot('project-delete-current-')
    await writeLocalCurrent(targetRoot, 'base-document', 'base-metadata')
    const reconciled = await local.reconcileDivergence(baseEntries, {
      base: base.remoteBase,
      targetRoot,
      conflictStore: new FileConflictCopyStore(await tempRoot('project-delete-conflicts-')),
    })
    expect(reconciled).toMatchObject({
      status: 'reconciled',
      deletionConfirmations: ['documents/report.docx'],
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe('base-document')
  })

  it('collapses semantically identical branches and publishes a new local path', async () => {
    const scopeId = 'project-semantic-merge'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remotePublished = await remote.publish(
      entries('same-document', 'base-metadata'),
      base.remoteBase,
    )
    if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
    const targetRoot = await tempRoot('project-semantic-current-')
    await writeLocalCurrent(targetRoot, 'same-document', 'base-metadata')
    const localEntries: ProjectSyncEntry[] = [
      ...entries('same-document', 'base-metadata'),
      {
        canonicalPath: 'assets/local.bin',
        kind: 'project-asset',
        bytes: new TextEncoder().encode('local-asset'),
      },
    ]
    const reconciled = await local.reconcileDivergence(localEntries, {
      base: base.remoteBase,
      targetRoot,
      conflictStore: new FileConflictCopyStore(await tempRoot('project-semantic-conflicts-')),
    })
    expect(reconciled).toMatchObject({
      status: 'reconciled',
      conflicts: [],
      publishedPaths: ['assets/local.bin'],
    })
  })

  it('publishes a local tombstone when another remote path moved forward', async () => {
    const scopeId = 'project-local-tombstone'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remotePublished = await remote.publish(
      entries('base-document', 'remote-metadata'),
      base.remoteBase,
    )
    if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
    const targetRoot = await tempRoot('project-local-tombstone-current-')
    await mkdir(join(targetRoot, '.open-genoffice'), { recursive: true })
    await writeFile(join(targetRoot, '.open-genoffice/project.json'), 'base-metadata')
    const reconciled = await local.reconcileDivergence(
      [
        { canonicalPath: 'documents/report.docx', kind: 'office-document', tombstone: true },
        baseEntries[1]!,
      ],
      {
        base: base.remoteBase,
        targetRoot,
        conflictStore: new FileConflictCopyStore(
          await tempRoot('project-local-tombstone-conflicts-'),
        ),
      },
    )
    expect(reconciled).toMatchObject({
      status: 'reconciled',
      publishedPaths: ['documents/report.docx'],
      fastForwardedPaths: ['.open-genoffice/project.json'],
    })
  })

  it('returns retry on a resolution CAS race and succeeds on the next attempt', async () => {
    const store = new ControllableCasStore()
    const fixture = await divergentFixture(undefined, store)
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const open = reconciled.conflicts[0]!
    store.failNextCas = true
    await expect(
      fixture.local.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'keep-local',
        targetRoot: fixture.targetRoot,
      }),
    ).resolves.toMatchObject({ status: 'retry' })
    await expect(
      fixture.local.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'keep-local',
        targetRoot: fixture.targetRoot,
      }),
    ).resolves.toMatchObject({ status: 'resolved' })
  })

  it('returns retry when publishing non-conflicting paths loses the remote head CAS', async () => {
    const store = new ControllableCasStore()
    const fixture = await divergentFixture(undefined, store)
    store.failNextCas = true
    await expect(
      fixture.local.reconcileDivergence(fixture.localEntries, {
        base: fixture.base.remoteBase,
        targetRoot: fixture.targetRoot,
        conflictStore: fixture.conflictStore,
      }),
    ).resolves.toMatchObject({ status: 'retry' })
  })

  it('rejects stale, already-resolved and locally changed conflict decisions', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const open = reconciled.conflicts[0]!

    const emptyResolver = new ProjectSyncReconciler({
      store: new InMemorySyncObjectStore(),
      scopeId: fixture.scopeId,
      authorDeviceId: 'device-empty',
    })
    await expect(
      emptyResolver.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'keep-local',
        targetRoot: fixture.targetRoot,
      }),
    ).rejects.toThrow(/sync_conflict_stale/)

    await writeFile(join(fixture.targetRoot, 'documents/report.docx'), 'edited-again')
    await expect(
      fixture.local.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'accept-remote',
        targetRoot: fixture.targetRoot,
      }),
    ).rejects.toThrow(/sync_conflict_local_changed/)
    await writeFile(join(fixture.targetRoot, 'documents/report.docx'), 'local-document')
    await fixture.local.resolveConflict({
      conflictStore: fixture.conflictStore,
      conflictId: open.conflictId,
      choice: 'keep-local',
      targetRoot: fixture.targetRoot,
    })
    await expect(
      fixture.local.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: open.conflictId,
        choice: 'keep-local',
        targetRoot: fixture.targetRoot,
      }),
    ).rejects.toThrow(/sync_conflict_resolved/)
  })

  it('rejects a decision after the remote conflict branch advances again', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const remote = new ProjectSyncReconciler({
      store: fixture.store,
      scopeId: fixture.scopeId,
      authorDeviceId: 'device-b',
    })
    const advanced = await remote.publish(
      entries('remote-again', 'local-metadata'),
      reconciled.remoteBase,
    )
    if (advanced.status !== 'published') throw new Error('remote_advance_failed')
    await expect(
      fixture.local.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: reconciled.conflicts[0]!.conflictId,
        choice: 'keep-local',
        targetRoot: fixture.targetRoot,
      }),
    ).rejects.toThrow(/sync_conflict_stale/)
  })

  it('accepts a remote tombstone only after preserving Local Current as a Conflict Copy', async () => {
    const scopeId = 'project-tombstone-resolution'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remotePublished = await remote.publish(
      [
        { canonicalPath: 'documents/report.docx', kind: 'office-document', tombstone: true },
        baseEntries[1]!,
      ],
      base.remoteBase,
    )
    if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
    const targetRoot = await tempRoot('project-tombstone-resolution-current-')
    await writeLocalCurrent(targetRoot, 'local-document', 'base-metadata')
    const conflictStore = new FileConflictCopyStore(
      await tempRoot('project-tombstone-resolution-conflicts-'),
    )
    const reconciled = await local.reconcileDivergence(entries('local-document', 'base-metadata'), {
      base: base.remoteBase,
      targetRoot,
      conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const open = reconciled.conflicts[0]!
    const resolved = await local.resolveConflict({
      conflictStore,
      conflictId: open.conflictId,
      choice: 'accept-remote',
      targetRoot,
    })
    expect(resolved.status).toBe('resolved')
    await expect(readFile(join(targetRoot, 'documents/report.docx'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(
      Buffer.from(
        await conflictStore.readCopy(scopeId, open.conflictId, open.local.revisionId),
      ).toString('utf8'),
    ).toBe('local-document')
    if (resolved.status !== 'resolved') throw new Error('resolution_failed')
    const entry = resolved.manifest.entries.find(
      (item) => item.canonicalPath === 'documents/report.docx',
    )!
    const revision = await readRevision(store, scopeId, entry.revisionId)
    expect(revision).toMatchObject({ tombstone: true, event: 'resolve' })
    expect(revision.parents).toHaveLength(2)
  })

  it.each([
    { choice: 'keep-local' as const, failureStage: null },
    { choice: 'accept-remote' as const, failureStage: null },
    { choice: 'accept-remote' as const, failureStage: 'after-local-replace' as const },
  ])(
    '$choice resolves a local tombstone against remote content after $failureStage',
    async ({ choice, failureStage }) => {
      const scopeId = `project-local-tombstone-${choice}`
      const store = new InMemorySyncObjectStore()
      const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
      const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
      const baseEntries = entries('base-document', 'base-metadata')
      const base = await local.publish(baseEntries)
      if (base.status !== 'published') throw new Error('base_publish_failed')
      const remotePublished = await remote.publish(
        entries('remote-document', 'base-metadata'),
        base.remoteBase,
      )
      if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
      const targetRoot = await tempRoot('project-local-delete-resolution-current-')
      await mkdir(join(targetRoot, '.open-genoffice'), { recursive: true })
      await writeFile(join(targetRoot, '.open-genoffice/project.json'), 'base-metadata')
      const conflictStore = new FileConflictCopyStore(
        await tempRoot('project-local-delete-resolution-conflicts-'),
      )
      const reconciled = await local.reconcileDivergence(
        [
          { canonicalPath: 'documents/report.docx', kind: 'office-document', tombstone: true },
          baseEntries[1]!,
        ],
        { base: base.remoteBase, targetRoot, conflictStore },
      )
      if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
      let armed = Boolean(failureStage)
      const resolver = new ProjectSyncReconciler({
        store,
        scopeId,
        authorDeviceId: 'device-a',
        conflictFaultInjector: (stage) => {
          if (armed && stage === failureStage) {
            armed = false
            throw new Error('injected_tombstone_resolution_crash')
          }
        },
      })
      const resolutionInput = {
        conflictStore,
        conflictId: reconciled.conflicts[0]!.conflictId,
        choice,
        targetRoot,
      }
      if (failureStage) {
        await expect(resolver.resolveConflict(resolutionInput)).rejects.toThrow(
          /injected_tombstone_resolution_crash/,
        )
      }
      const resolved = await resolver.resolveConflict(resolutionInput)
      expect(resolved.status).toBe('resolved')
      if (choice === 'accept-remote') {
        expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe(
          'remote-document',
        )
      } else {
        await expect(readFile(join(targetRoot, 'documents/report.docx'))).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    },
  )

  it('rejects a tombstone without a parent during divergence reconciliation', async () => {
    const scopeId = 'project-orphan-tombstone'
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const moved = await remote.publish(entries('remote-document', 'base-metadata'), base.remoteBase)
    if (moved.status !== 'published') throw new Error('remote_publish_failed')
    await expect(
      local.reconcileDivergence(
        [
          ...baseEntries,
          { canonicalPath: 'assets/missing.bin', kind: 'project-asset', tombstone: true },
        ],
        {
          base: base.remoteBase,
          targetRoot: await tempRoot('project-orphan-tombstone-current-'),
          conflictStore: new FileConflictCopyStore(
            await tempRoot('project-orphan-tombstone-conflicts-'),
          ),
        },
      ),
    ).rejects.toThrow(/sync_tombstone_without_parent/)
  })

  it('detects Local Current changes both before and during a remote fast-forward', async () => {
    const scopeId = 'project-fast-forward-local-change'
    const store = new InMemorySyncObjectStore()
    const publisher = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await publisher.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const moved = await remote.publish(entries('remote-document', 'base-metadata'), base.remoteBase)
    if (moved.status !== 'published') throw new Error('remote_publish_failed')
    const conflictStore = new FileConflictCopyStore(await tempRoot('project-local-change-store-'))

    const alreadyChangedRoot = await tempRoot('project-local-change-before-')
    await writeLocalCurrent(alreadyChangedRoot, 'edited-outside-sync', 'base-metadata')
    await expect(
      publisher.reconcileDivergence(baseEntries, {
        base: base.remoteBase,
        targetRoot: alreadyChangedRoot,
        conflictStore,
      }),
    ).rejects.toThrow(/sync_local_current_changed/)

    const changedDuringRoot = await tempRoot('project-local-change-during-')
    await writeLocalCurrent(changedDuringRoot, 'base-document', 'base-metadata')
    const guarded = new ProjectSyncReconciler({
      store,
      scopeId,
      authorDeviceId: 'device-a',
      conflictFaultInjector: async (stage) => {
        if (stage === 'before-local-replace-validation') {
          await writeFile(join(changedDuringRoot, 'documents/report.docx'), 'edited-during-sync')
        }
      },
    })
    await expect(
      guarded.reconcileDivergence(baseEntries, {
        base: base.remoteBase,
        targetRoot: changedDuringRoot,
        conflictStore,
      }),
    ).rejects.toThrow(/sync_local_current_changed/)
    expect(await readFile(join(changedDuringRoot, 'documents/report.docx'), 'utf8')).toBe(
      'edited-during-sync',
    )
  })

  it('fails closed on a missing remote blob during fast-forward', async () => {
    const scopeId = 'project-missing-remote-blob'
    const store = new MissingObjectStore()
    const local = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await local.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const moved = await remote.publish(entries('remote-document', 'base-metadata'), base.remoteBase)
    if (moved.status !== 'published') throw new Error('remote_publish_failed')
    const document = moved.manifest.entries.find(
      (entry) => entry.canonicalPath === 'documents/report.docx',
    )!
    store.missingKeyFragment = document.contentHash!
    await expect(
      local.reconcileDivergence(baseEntries, {
        base: base.remoteBase,
        targetRoot: await tempRoot('project-missing-blob-current-'),
        conflictStore: new FileConflictCopyStore(await tempRoot('project-missing-blob-conflicts-')),
      }),
    ).rejects.toThrow(/sync_blob_invalid/)
  })

  it('fails closed when the head revision is not a project manifest revision', async () => {
    const scopeId = 'project-invalid-root-revision'
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const published = await reconciler.publish(entries('document', 'metadata'))
    if (published.status !== 'published') throw new Error('publish_failed')
    const document = published.manifest.entries.find(
      (entry) => entry.canonicalPath === 'documents/report.docx',
    )!
    const headKey = `open-genoffice-sync/v1/project/${scopeId}/head.json`
    await expect(
      store.compareAndSwap(
        headKey,
        canonicalJsonBytes({ ...published.head, revisionId: document.revisionId }),
        published.remoteBase.versionToken,
      ),
    ).resolves.toMatchObject({ versionToken: expect.any(String) })
    await expect(
      reconciler.restore(await tempRoot('project-invalid-root-current-')),
    ).rejects.toThrow(/sync_head_invalid/)
  })

  it('detects a Local Current mutation after saving its Conflict Copy', async () => {
    const fixture = await divergentFixture()
    const reconciled = await fixture.local.reconcileDivergence(fixture.localEntries, {
      base: fixture.base.remoteBase,
      targetRoot: fixture.targetRoot,
      conflictStore: fixture.conflictStore,
    })
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    const resolver = new ProjectSyncReconciler({
      store: fixture.store,
      scopeId: fixture.scopeId,
      authorDeviceId: 'device-a',
      conflictFaultInjector: async (stage) => {
        if (stage === 'after-local-copy') {
          await writeFile(join(fixture.targetRoot, 'documents/report.docx'), 'edited-after-copy')
        }
      },
    })
    await expect(
      resolver.resolveConflict({
        conflictStore: fixture.conflictStore,
        conflictId: reconciled.conflicts[0]!.conflictId,
        choice: 'accept-remote',
        targetRoot: fixture.targetRoot,
      }),
    ).rejects.toThrow(/sync_conflict_local_changed/)
  })

  it('cleans an interrupted fast-forward workfile replacement before retrying', async () => {
    const scopeId = 'project-fast-forward-crash'
    const store = new InMemorySyncObjectStore()
    const publisher = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-a' })
    const remote = new ProjectSyncReconciler({ store, scopeId, authorDeviceId: 'device-b' })
    const baseEntries = entries('base-document', 'base-metadata')
    const base = await publisher.publish(baseEntries)
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remotePublished = await remote.publish(
      entries('remote-document', 'base-metadata'),
      base.remoteBase,
    )
    if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')
    let armed = true
    const local = new ProjectSyncReconciler({
      store,
      scopeId,
      authorDeviceId: 'device-a',
      conflictFaultInjector: (stage) => {
        if (armed && stage === 'before-local-replace-rename') {
          armed = false
          throw new Error('injected_replace_crash')
        }
      },
    })
    const targetRoot = await tempRoot('project-fast-forward-crash-current-')
    await writeLocalCurrent(targetRoot, 'base-document', 'base-metadata')
    const options = {
      base: base.remoteBase,
      targetRoot,
      conflictStore: new FileConflictCopyStore(await tempRoot('project-fast-forward-crash-store-')),
    }
    await expect(local.reconcileDivergence(baseEntries, options)).rejects.toThrow(
      /injected_replace_crash/,
    )
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe('base-document')
    await expect(local.reconcileDivergence(baseEntries, options)).resolves.toMatchObject({
      status: 'reconciled',
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe(
      'remote-document',
    )
  })
})
