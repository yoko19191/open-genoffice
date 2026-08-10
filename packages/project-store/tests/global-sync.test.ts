import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileConflictCopyStore,
  GlobalAssetSyncReconciler,
  InMemorySyncObjectStore,
  ProjectSyncReconciler,
  type ProjectSyncEntry,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GlobalAssetSyncReconciler', () => {
  it('isolates the global namespace and reuses unchanged content-addressed objects', async () => {
    const store = new InMemorySyncObjectStore()
    const global = new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-a',
    })
    const entries: ProjectSyncEntry[] = [
      {
        canonicalPath: 'assets/template.bin',
        kind: 'global-asset',
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        canonicalPath: 'agent/extensions/demo.mjs',
        kind: 'global-extension',
        bytes: new TextEncoder().encode('export default {}'),
        executable: true,
      },
      {
        canonicalPath: '.open-genoffice/credential-slots/mcp.json',
        kind: 'credential-slot',
        credentialSlot: { slotId: 'model/mcp/default', providerId: 'mcp-oauth' },
      },
    ]
    const first = await global.publish(entries)
    expect(first.status).toBe('published')
    if (first.status !== 'published') throw new Error('publish_failed')
    expect(first.manifest).toMatchObject({ namespace: 'global', scopeId: 'global-assets' })
    await expect(
      store.get('open-genoffice-sync/v1/global/global-assets/head.json'),
    ).resolves.not.toBeNull()
    await expect(
      store.get('open-genoffice-sync/v1/project/global-assets/head.json'),
    ).resolves.toBeNull()

    const writes = store.immutableWriteCount
    const unchanged = await global.publish(entries, first.remoteBase)
    expect(unchanged).toMatchObject({ status: 'published', head: first.head })
    expect(store.immutableWriteCount).toBe(writes)

    const target = await mkdtemp(join(tmpdir(), 'global-sync-target-'))
    roots.push(target)
    const targetClient = new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-b',
    })
    await expect(targetClient.restore(target)).resolves.toMatchObject({
      status: 'restored',
      manifest: { namespace: 'global' },
    })
    expect(await readFile(join(target, 'assets/template.bin'))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readFile(join(target, 'agent/extensions/demo.mjs'), 'utf8')).toBe(
      'export default {}',
    )

    const updatedEntries = entries.map((entry) =>
      entry.canonicalPath === 'agent/extensions/demo.mjs'
        ? { ...entry, bytes: new TextEncoder().encode('export default { version: 2 }') }
        : entry,
    )
    await expect(global.publish(updatedEntries, first.remoteBase)).resolves.toMatchObject({
      status: 'published',
    })
    const conflictRoot = await mkdtemp(join(tmpdir(), 'global-sync-conflicts-'))
    roots.push(conflictRoot)
    await expect(
      targetClient.reconcileDivergence(entries, {
        base: first.remoteBase,
        targetRoot: target,
        conflictStore: new FileConflictCopyStore(conflictRoot),
      }),
    ).resolves.toMatchObject({
      status: 'reconciled',
      fastForwardedPaths: ['agent/extensions/demo.mjs'],
      conflicts: [],
    })
    expect(await readFile(join(target, 'agent/extensions/demo.mjs'), 'utf8')).toBe(
      'export default { version: 2 }',
    )

    await expect(
      new ProjectSyncReconciler({
        store: new InMemorySyncObjectStore(),
        scopeId: 'project-a',
        authorDeviceId: 'device-a',
      }).publish([entries[0]!]),
    ).rejects.toThrow(/sync_kind_excluded/)
    await expect(
      new GlobalAssetSyncReconciler({
        store: new InMemorySyncObjectStore(),
        scopeId: 'global-assets',
        authorDeviceId: 'device-a',
      }).publish([
        {
          canonicalPath: 'documents/report.docx',
          kind: 'office-document',
          bytes: new Uint8Array([1]),
        },
      ]),
    ).rejects.toThrow(/sync_kind_excluded/)
  })

  it('handles the 10,000-path ceiling and deduplicates repeated asset blobs', async () => {
    const store = new InMemorySyncObjectStore()
    const global = new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-stress',
      authorDeviceId: 'device-a',
    })
    const shared = new Uint8Array(1024 * 1024).fill(7)
    const entries: ProjectSyncEntry[] = Array.from({ length: 10_000 }, (_, index) => ({
      canonicalPath: `assets/bulk/${String(index).padStart(5, '0')}.bin`,
      kind: 'global-asset',
      bytes: shared,
    }))
    const first = await global.publish(entries)
    expect(first.status).toBe('published')
    if (first.status !== 'published') throw new Error('publish_failed')
    expect(first.manifest.entries).toHaveLength(10_000)
    expect(new Set(first.manifest.entries.map((entry) => entry.contentHash))).toHaveLength(1)
    expect(store.immutableWriteCount).toBe(10_003)

    const writes = store.immutableWriteCount
    await expect(global.publish(entries, first.remoteBase)).resolves.toMatchObject({
      status: 'published',
      head: first.head,
    })
    expect(store.immutableWriteCount).toBe(writes)
    await expect(
      global.publish([
        ...entries,
        { canonicalPath: 'assets/overflow.bin', kind: 'global-asset', bytes: shared },
      ]),
    ).rejects.toThrow(/sync_limit_exceeded/)
  }, 30_000)
})
