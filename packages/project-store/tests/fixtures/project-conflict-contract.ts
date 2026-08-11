import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { FileConflictCopyStore } from '../../src/sync/conflict-copy-store.js'
import { ProjectSyncReconciler } from '../../src/sync/project-sync-reconciler.js'
import type { ProjectSyncEntry, SyncObjectStore } from '../../src/sync/types.js'

export const PROVIDER_CONFLICT_SCOPE = 'provider-conflict-contract'

export const EXPECTED_PROVIDER_CONFLICT_RESULT = {
  conflictId: 'b79cefe3bf5894b67049a4a458a57d0a6f9c14b22ad1362ced6c5bb2cad4c4bd',
  localRevisionId: 'ceffe0b088d6ea5e8ba0df4f2ee48cf72e7fbbaf766020cd054107b4b7a5afec',
  remoteRevisionId: 'abf8bcd8bb9e65dd42da2e3ce25a3ba03fda74d6c7a5acefe577633734ca2255',
  resolutionRevisionId: 'e5363ab999e0a38b81cbba4ceac912795b0be2aef271e554dc5d37e54eae19a0',
  resolutionHeadRevisionId: '72358d2bbd73ef3e252c455a53e6f136c4ace286eec60671c466ecd4bf6cdb78',
  resolutionManifestHash: '9cd1403ae2f3b5a9654d79075db815b515a884d37996234e57d825ace1047973',
} as const

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

export async function runProviderConflictContract(makeStore: () => SyncObjectStore): Promise<{
  conflictId: string
  localRevisionId: string
  remoteRevisionId: string
  resolutionRevisionId: string
  resolutionHeadRevisionId: string
  resolutionManifestHash: string
}> {
  const currentRoot = await mkdtemp(join(tmpdir(), 'provider-conflict-current-'))
  const conflictRoot = await mkdtemp(join(tmpdir(), 'provider-conflict-store-'))
  try {
    const local = new ProjectSyncReconciler({
      store: makeStore(),
      scopeId: PROVIDER_CONFLICT_SCOPE,
      authorDeviceId: 'device-a',
    })
    const remote = new ProjectSyncReconciler({
      store: makeStore(),
      scopeId: PROVIDER_CONFLICT_SCOPE,
      authorDeviceId: 'device-b',
    })
    const base = await local.publish(entries('base-document', 'base-metadata'))
    if (base.status !== 'published') throw new Error('base_publish_failed')
    const remotePublished = await remote.publish(
      entries('remote-document', 'base-metadata'),
      base.remoteBase,
    )
    if (remotePublished.status !== 'published') throw new Error('remote_publish_failed')

    await mkdir(join(currentRoot, 'documents'), { recursive: true })
    await mkdir(join(currentRoot, '.open-genoffice'), { recursive: true })
    await writeFile(join(currentRoot, 'documents/report.docx'), 'local-document')
    await writeFile(join(currentRoot, '.open-genoffice/project.json'), 'local-metadata')
    const conflictStore = new FileConflictCopyStore(conflictRoot)
    const reconciled = await local.reconcileDivergence(
      entries('local-document', 'local-metadata'),
      { base: base.remoteBase, targetRoot: currentRoot, conflictStore },
    )
    expect(reconciled.status).toBe('conflicts')
    if (reconciled.status !== 'conflicts') throw new Error('conflict_not_detected')
    expect(reconciled.publishedPaths).toEqual(['.open-genoffice/project.json'])
    expect(await readFile(join(currentRoot, 'documents/report.docx'), 'utf8')).toBe(
      'local-document',
    )
    const conflict = reconciled.conflicts[0]!
    expect(
      Buffer.from(
        await conflictStore.readCopy(
          PROVIDER_CONFLICT_SCOPE,
          conflict.conflictId,
          conflict.remote.revisionId,
        ),
      ).toString('utf8'),
    ).toBe('remote-document')

    const resolved = await local.resolveConflict({
      conflictStore,
      conflictId: conflict.conflictId,
      choice: 'keep-local',
      targetRoot: currentRoot,
    })
    expect(resolved.status).toBe('resolved')
    if (resolved.status !== 'resolved') throw new Error('resolution_failed')
    const resolution = resolved.manifest.entries.find(
      (entry) => entry.canonicalPath === conflict.canonicalPath,
    )!
    expect(await readFile(join(currentRoot, 'documents/report.docx'), 'utf8')).toBe(
      'local-document',
    )
    return {
      conflictId: conflict.conflictId,
      localRevisionId: conflict.local.revisionId,
      remoteRevisionId: conflict.remote.revisionId,
      resolutionRevisionId: resolution.revisionId,
      resolutionHeadRevisionId: resolved.head.revisionId,
      resolutionManifestHash: resolved.head.manifestHash,
    }
  } finally {
    await Promise.all([
      rm(currentRoot, { recursive: true, force: true }),
      rm(conflictRoot, { recursive: true, force: true }),
    ])
  }
}
