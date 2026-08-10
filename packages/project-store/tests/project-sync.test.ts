import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  FileReconcileIntentStore,
  InMemorySyncObjectStore,
  ProjectSyncReconciler,
  type ProjectSyncEntry,
  type ProviderDiagnostics,
  type SyncObjectStore,
} from '../src/sync/index.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project-sync-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function completeProject(): ProjectSyncEntry[] {
  return [
    {
      canonicalPath: 'documents/report.docx',
      kind: 'office-document',
      bytes: new TextEncoder().encode('office-content'),
    },
    {
      canonicalPath: 'assets/chart.png',
      kind: 'project-asset',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
    {
      canonicalPath: '.open-genoffice/project.json',
      kind: 'project-metadata',
      bytes: new TextEncoder().encode('{"projectId":"project-a"}'),
    },
    {
      canonicalPath: '.open-genoffice/resources/skill.md',
      kind: 'project-resource',
      bytes: new TextEncoder().encode('# Skill'),
      executable: true,
    },
    {
      canonicalPath: '.open-genoffice/sessions/document-a/session-a.jsonl',
      kind: 'pi-session-snapshot',
      bytes: new TextEncoder().encode('{"type":"session"}\n'),
    },
    {
      canonicalPath: '.open-genoffice/credentials/model-a.json',
      kind: 'credential-slot',
      credentialSlot: { slotId: 'model-a', providerId: 'openai-compatible' },
    },
  ]
}

class DelegatingStore implements SyncObjectStore {
  constructor(
    readonly inner: SyncObjectStore,
    readonly hooks: {
      probe?: () => Promise<ProviderDiagnostics>
      get?: (
        key: string,
        next: () => Promise<{ bytes: Uint8Array; versionToken: string } | null>,
      ) => Promise<{ bytes: Uint8Array; versionToken: string } | null>
      putImmutable?: (
        key: string,
        bytes: Uint8Array,
        next: () => Promise<'created' | 'already-exists'>,
      ) => Promise<'created' | 'already-exists'>
      compareAndSwap?: () => Promise<{ versionToken: string } | { conflict: true }>
    } = {},
  ) {}

  probe(): Promise<ProviderDiagnostics> {
    return this.hooks.probe?.() ?? this.inner.probe()
  }

  get(key: string): Promise<{ bytes: Uint8Array; versionToken: string } | null> {
    return this.hooks.get?.(key, () => this.inner.get(key)) ?? this.inner.get(key)
  }

  putImmutable(key: string, bytes: Uint8Array): Promise<'created' | 'already-exists'> {
    return (
      this.hooks.putImmutable?.(key, bytes, () => this.inner.putImmutable(key, bytes)) ??
      this.inner.putImmutable(key, bytes)
    )
  }

  compareAndSwap(
    key: string,
    bytes: Uint8Array,
    expectedVersion: string | 'absent',
  ): Promise<{ versionToken: string } | { conflict: true }> {
    return this.hooks.compareAndSwap?.() ?? this.inner.compareAndSwap(key, bytes, expectedVersion)
  }
}

describe('ProjectSyncReconciler', () => {
  it('publishes immutable blobs/revisions and restores a complete project on a clean client', async () => {
    const store = new InMemorySyncObjectStore()
    const publisher = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    const published = await publisher.publish(completeProject())
    expect(published.status).toBe('published')
    if (published.status !== 'published') throw new Error('publish_failed')

    const targetRoot = await tempRoot()
    const cleanClient = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-b',
    })
    const restored = await cleanClient.restore(targetRoot)
    expect(restored).toMatchObject({
      status: 'restored',
      manifestHash: published.head.manifestHash,
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe('office-content')
    expect(await readFile(join(targetRoot, '.open-genoffice/resources/skill.md'), 'utf8')).toBe(
      '# Skill',
    )
    expect(
      JSON.parse(
        await readFile(join(targetRoot, '.open-genoffice/credentials/model-a.json'), 'utf8'),
      ),
    ).toEqual({ providerId: 'openai-compatible', slotId: 'model-a' })
    expect(published.manifest.entries.map((entry) => entry.contentHash)).toEqual(
      restored.status === 'restored'
        ? restored.manifest.entries.map((entry) => entry.contentHash)
        : [],
    )
    await expect(cleanClient.restore(targetRoot)).resolves.toMatchObject({ status: 'restored' })
  })

  it('reuses unchanged objects during an incremental fast-forward', async () => {
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    const first = await reconciler.publish(completeProject())
    if (first.status !== 'published') throw new Error('publish_failed')
    const writesAfterFirst = store.immutableWriteCount
    const second = await reconciler.publish(completeProject(), first.remoteBase)
    expect(second.status).toBe('published')
    expect(store.immutableWriteCount - writesAfterFirst).toBeLessThanOrEqual(2)
  })

  it('never silently overwrites a diverged remote head or local target', async () => {
    const store = new InMemorySyncObjectStore()
    const local = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    const first = await local.publish(completeProject())
    if (first.status !== 'published') throw new Error('publish_failed')

    const remote = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-b',
    })
    const remoteEntries = completeProject()
    remoteEntries[0] = { ...remoteEntries[0]!, bytes: new TextEncoder().encode('remote-change') }
    const remoteUpdate = await remote.publish(remoteEntries, first.remoteBase)
    expect(remoteUpdate.status).toBe('published')
    await expect(local.publish(completeProject(), first.remoteBase)).resolves.toMatchObject({
      status: 'conflict',
    })

    const targetRoot = await tempRoot()
    await mkdir(join(targetRoot, 'documents'), { recursive: true })
    await writeFile(join(targetRoot, 'documents/report.docx'), 'local-current')
    await expect(local.restore(targetRoot)).resolves.toMatchObject({
      status: 'conflict',
      canonicalPath: 'documents/report.docx',
    })
    expect(await readFile(join(targetRoot, 'documents/report.docx'), 'utf8')).toBe('local-current')

    await expect(
      local.publish(completeProject(), { ...first.remoteBase, versionToken: '"stale"' }),
    ).resolves.toMatchObject({ status: 'conflict' })
    const emptyRemote = new ProjectSyncReconciler({
      store: new InMemorySyncObjectStore(),
      scopeId: 'project-a',
      authorDeviceId: 'device-c',
    })
    await expect(emptyRemote.publish(completeProject(), first.remoteBase)).resolves.toMatchObject({
      status: 'conflict',
    })
  })

  it('rejects excluded state, arbitrary credential bytes and oversized objects', async () => {
    const reconciler = new ProjectSyncReconciler({
      store: new InMemorySyncObjectStore(),
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
      maxObjectBytes: 8,
    })
    await expect(
      reconciler.publish([
        {
          canonicalPath: 'logs/runtime.log',
          kind: 'log' as 'project-asset',
          bytes: new Uint8Array(),
        },
      ]),
    ).rejects.toThrow(/sync_kind_excluded/)
    await expect(
      reconciler.publish([
        {
          canonicalPath: '.open-genoffice/credentials/model-a.json',
          kind: 'credential-slot',
          bytes: new TextEncoder().encode('secret'),
          credentialSlot: { slotId: 'model-a', providerId: 'provider' },
        },
      ]),
    ).rejects.toThrow(/sync_credential_secret_forbidden/)
    await expect(
      reconciler.publish([
        {
          canonicalPath: 'documents/large.docx',
          kind: 'office-document',
          bytes: new Uint8Array(9),
        },
      ]),
    ).rejects.toThrow(/sync_limit_exceeded/)
    await expect(
      reconciler.publish([
        { canonicalPath: '.open-genoffice', kind: 'project-metadata', bytes: new Uint8Array() },
      ]),
    ).rejects.toThrow(/sync_path_reserved/)
    await expect(
      reconciler.publish([{ canonicalPath: 'missing.bin', kind: 'project-asset' }]),
    ).rejects.toThrow(/sync_entry_invalid/)
    await expect(
      reconciler.publish([
        {
          canonicalPath: 'bad-slot.json',
          kind: 'credential-slot',
          credentialSlot: { slotId: '../bad', providerId: 'provider' },
        },
      ]),
    ).rejects.toThrow(/sync_credential_slot_invalid/)
    expect(
      () =>
        new ProjectSyncReconciler({
          store: new InMemorySyncObjectStore(),
          scopeId: '../bad',
          authorDeviceId: 'device',
        }),
    ).toThrow(/sync_scope_invalid/)
    expect(
      () =>
        new ProjectSyncReconciler({
          store: new InMemorySyncObjectStore(),
          scopeId: 'scope',
          authorDeviceId: '../bad',
        }),
    ).toThrow(/sync_device_invalid/)
  })

  it('rejects symlink escape before writing any restored file', async () => {
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    const published = await reconciler.publish(completeProject())
    expect(published.status).toBe('published')
    const targetRoot = await tempRoot()
    const outside = await tempRoot()
    await symlink(outside, join(targetRoot, 'documents'))
    await expect(reconciler.restore(targetRoot)).rejects.toThrow(/sync_symlink_escape/)
    expect((await lstat(join(targetRoot, 'documents'))).isSymbolicLink()).toBe(true)
  })

  it('rejects a non-directory target parent before writing', async () => {
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    await reconciler.publish(completeProject())
    const targetRoot = await tempRoot()
    await writeFile(join(targetRoot, 'documents'), 'not-a-directory')
    await expect(reconciler.restore(targetRoot)).rejects.toThrow(/sync_target_invalid/)
  })

  it('keeps reconcile intent when sync is disabled or the provider is unavailable', async () => {
    const store = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({
      store,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    await expect(reconciler.reconcile(completeProject(), { enabled: false })).resolves.toEqual({
      status: 'pending',
      reason: 'disabled',
      intent: {
        schemaVersion: 1,
        operation: 'reconcile',
        scopeId: 'project-a',
        paths: completeProject().map((entry) => entry.canonicalPath),
      },
    })
    store.available = false
    await expect(reconciler.reconcile(completeProject(), { enabled: true })).resolves.toMatchObject(
      {
        status: 'pending',
        reason: 'provider_unavailable',
      },
    )
    store.available = true
    await expect(reconciler.reconcile(completeProject(), { enabled: true })).resolves.toMatchObject(
      {
        status: 'published',
      },
    )

    const invalidDiagnostics = new ProjectSyncReconciler({
      store: new DelegatingStore(store, {
        probe: async () => ({ ok: false, strongEtag: false, conditionalPut: false }),
      }),
      scopeId: 'project-b',
      authorDeviceId: 'device-a',
    })
    await expect(
      invalidDiagnostics.reconcile(completeProject(), { enabled: true }),
    ).resolves.toMatchObject({
      status: 'pending',
      reason: 'provider_unavailable',
    })

    const unexpectedFailure = new ProjectSyncReconciler({
      store: new DelegatingStore(store, {
        probe: async () => Promise.reject(new Error('unexpected')),
      }),
      scopeId: 'project-c',
      authorDeviceId: 'device-a',
    })
    await expect(unexpectedFailure.reconcile(completeProject(), { enabled: true })).rejects.toThrow(
      /unexpected/,
    )
  })

  it('persists only reconcile paths while offline and clears them after recovery', async () => {
    const root = await tempRoot()
    const intentStore = new FileReconcileIntentStore(join(root, 'sync', 'intents'))
    const objectStore = new InMemorySyncObjectStore()
    const reconciler = new ProjectSyncReconciler({
      store: objectStore,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
      intentStore,
    })
    await reconciler.reconcile(completeProject(), { enabled: false })
    const queued = await intentStore.load('project-a')
    expect(queued?.paths).toEqual([...completeProject().map((entry) => entry.canonicalPath)].sort())
    const serialized = await readFile(join(root, 'sync', 'intents', 'project-a.json'), 'utf8')
    expect(serialized).not.toMatch(/etag|versionToken|manifestHash|revisionId|bytes|secret/i)

    objectStore.available = false
    await reconciler.reconcile(completeProject(), { enabled: true })
    expect(await intentStore.load('project-a')).not.toBeNull()
    objectStore.available = true
    await expect(reconciler.reconcile(completeProject(), { enabled: true })).resolves.toMatchObject(
      {
        status: 'published',
      },
    )
    expect(await intentStore.load('project-a')).toBeNull()
  })

  it('returns empty for a clean remote and surfaces a head CAS race', async () => {
    const emptyStore = new InMemorySyncObjectStore()
    const empty = new ProjectSyncReconciler({
      store: emptyStore,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    await expect(empty.restore(await tempRoot())).resolves.toEqual({ status: 'empty' })

    const racing = new ProjectSyncReconciler({
      store: new DelegatingStore(emptyStore, { compareAndSwap: async () => ({ conflict: true }) }),
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    await expect(racing.publish(completeProject())).resolves.toEqual({
      status: 'conflict',
      remoteBase: null,
    })
  })

  it('fails closed on malformed or missing remote objects', async () => {
    const inner = new InMemorySyncObjectStore()
    const publisher = new ProjectSyncReconciler({
      store: inner,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    const published = await publisher.publish(completeProject())
    if (published.status !== 'published') throw new Error('publish_failed')
    const target = await tempRoot()

    const cases: Array<{ name: string; hook: DelegatingStore['hooks']['get']; error: RegExp }> = [
      {
        name: 'invalid head JSON',
        hook: async (key, next) =>
          key.endsWith('/head.json')
            ? { bytes: new TextEncoder().encode('{'), versionToken: '"g1"' }
            : next(),
        error: /sync_remote_object_invalid/,
      },
      {
        name: 'invalid head schema',
        hook: async (key, next) =>
          key.endsWith('/head.json')
            ? { bytes: canonicalJsonBytes({}), versionToken: '"g1"' }
            : next(),
        error: /sync_head_invalid/,
      },
      {
        name: 'missing root revision',
        hook: async (key, next) => (key.includes('/revisions/') ? null : next()),
        error: /sync_revision_missing/,
      },
      {
        name: 'invalid root revision',
        hook: async (key, next) =>
          key.includes('/revisions/')
            ? { bytes: canonicalJsonBytes({}), versionToken: '"g1"' }
            : next(),
        error: /sync_revision_invalid/,
      },
      {
        name: 'missing manifest',
        hook: async (key, next) => (key.includes(published.head.manifestHash) ? null : next()),
        error: /sync_manifest_missing/,
      },
      {
        name: 'invalid manifest',
        hook: async (key, next) =>
          key.includes(published.head.manifestHash)
            ? { bytes: canonicalJsonBytes({}), versionToken: '"g1"' }
            : next(),
        error: /sync_manifest_invalid/,
      },
      {
        name: 'missing content blob',
        hook: async (key, next) =>
          key.includes(published.manifest.entries[0]!.contentHash) ? null : next(),
        error: /sync_blob_invalid/,
      },
    ]

    for (const testCase of cases) {
      const reconciler = new ProjectSyncReconciler({
        store: new DelegatingStore(inner, { get: testCase.hook }),
        scopeId: 'project-a',
        authorDeviceId: 'device-b',
      })
      await expect(reconciler.restore(target), testCase.name).rejects.toThrow(testCase.error)
    }

    const limited = new ProjectSyncReconciler({
      store: inner,
      scopeId: 'project-a',
      authorDeviceId: 'device-b',
      maxObjectBytes: 1,
    })
    await expect(limited.restore(target)).rejects.toThrow(/sync_limit_exceeded/)
  })

  it('verifies pre-existing content-addressed objects before publishing', async () => {
    const inner = new InMemorySyncObjectStore()
    const exactObjects = new Map<string, Uint8Array>()
    const exactStore = new DelegatingStore(inner, {
      putImmutable: async (key, bytes) => {
        exactObjects.set(key, bytes.slice())
        return 'already-exists'
      },
      get: async (key, next) => {
        const bytes = exactObjects.get(key)
        return bytes ? { bytes, versionToken: '"existing"' } : next()
      },
    })
    const exact = new ProjectSyncReconciler({
      store: exactStore,
      scopeId: 'project-a',
      authorDeviceId: 'device-a',
    })
    await expect(exact.publish(completeProject())).resolves.toMatchObject({ status: 'published' })

    const corrupt = new ProjectSyncReconciler({
      store: new DelegatingStore(new InMemorySyncObjectStore(), {
        putImmutable: async () => 'already-exists',
        get: async () => null,
      }),
      scopeId: 'project-b',
      authorDeviceId: 'device-a',
    })
    await expect(corrupt.publish(completeProject())).rejects.toThrow(
      /sync_immutable_object_mismatch/,
    )
  })

  it('covers the in-memory store conditional conflict contract directly', async () => {
    const store = new InMemorySyncObjectStore()
    await expect(store.putImmutable('object', new Uint8Array([1]))).resolves.toBe('created')
    await expect(store.putImmutable('object', new Uint8Array([2]))).resolves.toBe('already-exists')
    await expect(store.compareAndSwap('missing', new Uint8Array([1]), '"g1"')).resolves.toEqual({
      conflict: true,
    })
    await expect(store.compareAndSwap('object', new Uint8Array([2]), 'absent')).resolves.toEqual({
      conflict: true,
    })
  })
})
