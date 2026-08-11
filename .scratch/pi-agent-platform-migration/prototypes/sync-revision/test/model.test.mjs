import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertEntryKind,
  assertNamespace,
  assertScopeId,
  assertSyncPath,
  canonicalJson,
  createConflict,
  createManifest,
  createRevision,
  createSyncIntent,
  hashJson,
  planPathSync,
  remoteLayout,
  requiresLocalTrust,
  resolveConflict,
  sha256,
  verifyManifest,
  verifyRevision,
} from '../src/model.mjs'

const bytes = (value) => new TextEncoder().encode(value)
const baseRevision = (overrides = {}) =>
  createRevision({
    namespace: 'project',
    scopeId: 'project-1',
    path: 'documents/report.docx',
    kind: 'office-document',
    contentBytes: bytes('base'),
    authorDeviceId: 'device-a',
    ...overrides,
  })
const resignRevision = (revision, changes) => {
  const body = { ...revision, ...changes }
  delete body.revisionId
  return { ...body, revisionId: hashJson(body) }
}
const resignManifest = (manifest, changes) => {
  const body = { ...manifest, ...changes }
  delete body.manifestId
  return { ...body, manifestId: hashJson(body) }
}

test('canonical JSON and hashes are stable across object key order', () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"z":1}')
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }))
  assert.match(sha256(bytes('x')), /^sha256:[a-f0-9]{64}$/u)
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/u)
  assert.throws(() => canonicalJson({ missing: undefined }), /undefined/u)
  assert.throws(() => canonicalJson(Symbol('x')), /symbol/u)
})

test('validates namespace, scope, canonical path and entry kind', () => {
  assert.doesNotThrow(() => assertNamespace('project'))
  assert.doesNotThrow(() => assertNamespace('global'))
  assert.throws(() => assertNamespace('mixed'), /unsupported/u)
  assert.doesNotThrow(() => assertScopeId('device_01.example'))
  assert.throws(() => assertScopeId('bad/scope'), /stable opaque/u)
  assert.doesNotThrow(() => assertSyncPath('assets/image.png'))
  for (const path of ['', '/absolute', 'a\\b', 'a//b', 'a/./b', 'a/../b'])
    assert.throws(() => assertSyncPath(path), /canonical relative/u)
  assert.doesNotThrow(() => assertEntryKind('pi-session'))
  assert.throws(() => assertEntryKind('credential'), /unsupported/u)
})

test('creates content-addressed live and tombstone revisions without wall clock time', () => {
  const live = baseRevision({ executable: true, network: true })
  assert.equal(live.contentHash, sha256(bytes('base')))
  assert.equal(live.size, 4)
  assert.equal(live.tombstone, false)
  assert.equal(live.event, 'edit')
  assert.equal('createdAt' in live, false)
  assert.equal(verifyRevision(live), live)

  const tombstone = baseRevision({
    contentBytes: undefined,
    tombstone: true,
    parents: [live.revisionId, live.revisionId],
  })
  assert.equal(tombstone.contentHash, null)
  assert.equal(tombstone.size, 0)
  assert.equal(tombstone.event, 'delete')
  assert.deepEqual(tombstone.parents, [live.revisionId])
})

test('rejects malformed revision inputs and tampering', () => {
  assert.throws(() => baseRevision({ namespace: 'bad' }), /unsupported/u)
  assert.throws(() => baseRevision({ contentBytes: undefined }), /requires content/u)
  assert.throws(() => baseRevision({ tombstone: true }), /cannot contain/u)
  assert.throws(() => baseRevision({ parents: 'bad' }), /zero, one or two/u)
  assert.throws(() => baseRevision({ parents: ['bad'] }), /SHA-256/u)
  assert.throws(
    () => baseRevision({ parents: ['a'.repeat(71), 'b'.repeat(71), 'c'.repeat(71)] }),
    /zero, one or two/u,
  )
  assert.throws(() => verifyRevision(null), /object/u)
  const live = baseRevision()
  assert.throws(() => verifyRevision({ ...live, size: 99 }), /does not match/u)
  const inconsistent = { ...live, contentHash: null }
  delete inconsistent.revisionId
  assert.throws(
    () => verifyRevision({ ...inconsistent, revisionId: hashJson(inconsistent) }),
    /tombstone and content hash disagree/u,
  )
})

test('validates all untrusted revision fields after content-address verification', () => {
  const live = baseRevision()
  const parent = live.revisionId
  for (const [changes, pattern] of [
    [{ schemaVersion: 2 }, /schema/u],
    [{ event: 'unknown' }, /event/u],
    [{ parents: 'bad' }, /parents/u],
    [{ parents: [parent, parent, parent] }, /parents/u],
    [{ parents: ['bad'] }, /SHA-256/u],
    [{ parents: [parent, parent] }, /unique/u],
    [{ size: -1 }, /size/u],
    [{ contentHash: 'bad' }, /content hash/u],
    [{ executable: 'yes' }, /flags/u],
    [{ network: 1 }, /flags/u],
    [{ authorDeviceId: 'bad/device' }, /stable opaque/u],
  ]) {
    assert.throws(() => verifyRevision(resignRevision(live, changes)), pattern)
  }
  const tombstone = baseRevision({ contentBytes: undefined, tombstone: true })
  assert.throws(() => verifyRevision(resignRevision(tombstone, { size: 1 })), /size must be zero/u)
})

test('creates a sorted, content-addressed manifest for one namespace and scope', () => {
  const report = baseRevision()
  const asset = baseRevision({
    path: 'assets/image.png',
    kind: 'project-asset',
    contentBytes: bytes('image'),
  })
  const manifest = createManifest({
    namespace: 'project',
    scopeId: 'project-1',
    generation: 0,
    revisions: [report, asset],
    writerDeviceId: 'device-a',
  })
  assert.deepEqual(Object.keys(manifest.entries), ['assets/image.png', 'documents/report.docx'])
  assert.equal(verifyManifest(manifest), manifest)
  assert.throws(() => verifyManifest({ ...manifest, generation: 2 }), /does not match/u)
  assert.throws(() => verifyManifest(null), /object/u)
  assert.throws(
    () => createManifest({ ...manifest, revisions: [report], generation: -1 }),
    /non-negative/u,
  )
  assert.throws(() => createManifest({ ...manifest, revisions: [report, report] }), /duplicate/u)
  assert.throws(
    () =>
      createManifest({
        ...manifest,
        revisions: [baseRevision({ namespace: 'global', scopeId: 'global-1' })],
      }),
    /another namespace/u,
  )
  assert.throws(
    () => createManifest({ ...manifest, parentManifestId: 'bad', revisions: [report] }),
    /SHA-256/u,
  )
})

test('validates every field of an untrusted remote manifest', () => {
  const revision = baseRevision()
  const manifest = createManifest({
    namespace: 'project',
    scopeId: 'project-1',
    generation: 0,
    revisions: [revision],
    writerDeviceId: 'device-a',
  })
  const path = revision.path
  const entry = manifest.entries[path]
  for (const [changes, pattern] of [
    [{ schemaVersion: 2 }, /schema/u],
    [{ generation: -1 }, /generation/u],
    [{ parentManifestId: 'bad' }, /SHA-256/u],
    [{ entries: null }, /entries/u],
    [{ entries: [] }, /entries/u],
    [{ writerDeviceId: 'bad/device' }, /stable opaque/u],
    [{ entries: { [path]: { ...entry, size: -1 } } }, /entry size/u],
    [{ entries: { [path]: { ...entry, contentHash: null } } }, /tombstone and content/u],
    [
      { entries: { [path]: { ...entry, tombstone: true, contentHash: null, size: 1 } } },
      /tombstone size/u,
    ],
    [{ entries: { [path]: { ...entry, contentHash: 'bad' } } }, /content hash/u],
    [{ entries: { [path]: { ...entry, executable: 'yes' } } }, /flags/u],
    [{ entries: { [path]: { ...entry, network: 1 } } }, /flags/u],
  ]) {
    assert.throws(() => verifyManifest(resignManifest(manifest, changes)), pattern)
  }
})

test('plans initial, fast-forward, upload, deletion and divergent cases', () => {
  const base = baseRevision()
  const local = baseRevision({ contentBytes: bytes('local'), parents: [base.revisionId] })
  const remote = baseRevision({ contentBytes: bytes('remote'), parents: [base.revisionId] })
  const deleted = baseRevision({
    contentBytes: undefined,
    tombstone: true,
    parents: [base.revisionId],
    authorDeviceId: 'device-b',
  })
  const path = base.path

  assert.deepEqual(planPathSync({ path }), { action: 'up-to-date', nextBaseRevisionId: null })
  assert.equal(planPathSync({ path, localRevision: local }).action, 'upload-local')
  assert.equal(planPathSync({ path, remoteRevision: remote }).action, 'fast-forward-remote')
  assert.equal(planPathSync({ path, remoteRevision: deleted }).action, 'up-to-date')
  assert.equal(
    planPathSync({
      path,
      baseRevisionId: base.revisionId,
      localRevision: base,
      remoteRevision: base,
    }).action,
    'up-to-date',
  )
  assert.equal(
    planPathSync({
      path,
      baseRevisionId: base.revisionId,
      localRevision: local,
      remoteRevision: base,
    }).action,
    'upload-local',
  )
  assert.equal(
    planPathSync({
      path,
      baseRevisionId: base.revisionId,
      localRevision: base,
      remoteRevision: remote,
    }).action,
    'fast-forward-remote',
  )
  assert.equal(
    planPathSync({
      path,
      baseRevisionId: base.revisionId,
      localRevision: base,
      remoteRevision: deleted,
    }).action,
    'confirm-remote-delete',
  )
  assert.deepEqual(planPathSync({ path, baseRevisionId: base.revisionId, localRevision: local }), {
    action: 'conflict',
    reason: 'remote-entry-missing',
  })
  assert.deepEqual(
    planPathSync({
      path,
      baseRevisionId: base.revisionId,
      localRevision: local,
      remoteRevision: remote,
    }),
    { action: 'conflict', reason: 'diverged' },
  )
  assert.throws(
    () => planPathSync({ path, baseRevisionId: base.revisionId, remoteRevision: remote }),
    /tombstone/u,
  )
  assert.throws(() => planPathSync({ path, baseRevisionId: 'bad' }), /SHA-256/u)
  assert.throws(() => planPathSync({ path: 'other.docx', localRevision: local }), /requested path/u)
  assert.throws(
    () =>
      planPathSync({
        path,
        localRevision: local,
        remoteRevision: baseRevision({ namespace: 'global', scopeId: 'global-1' }),
      }),
    /different repositories/u,
  )
})

test('keeps local current open during conflict and creates a merge revision after user choice', () => {
  const base = baseRevision()
  const local = baseRevision({ contentBytes: bytes('local'), parents: [base.revisionId] })
  const remote = baseRevision({
    contentBytes: bytes('remote'),
    parents: [base.revisionId],
    authorDeviceId: 'device-b',
  })
  const conflict = createConflict({
    path: base.path,
    baseRevisionId: base.revisionId,
    localRevision: local,
    remoteRevision: remote,
  })
  assert.equal(conflict.state, 'open')
  assert.equal(conflict.remoteRevisionId, remote.revisionId)

  const acceptRemote = resolveConflict({
    conflict,
    choice: 'accept-remote',
    localRevision: local,
    remoteRevision: remote,
    authorDeviceId: 'device-a',
  })
  assert.equal(acceptRemote.currentRevision.contentHash, remote.contentHash)
  assert.equal(acceptRemote.currentRevision.event, 'accept-remote')
  assert.equal(acceptRemote.conflictCopyRevisionId, local.revisionId)
  assert.equal(acceptRemote.resolvedConflict.state, 'resolved')

  const keepLocal = resolveConflict({
    conflict,
    choice: 'keep-local',
    localRevision: local,
    remoteRevision: remote,
    authorDeviceId: 'device-a',
  })
  assert.equal(keepLocal.currentRevision.contentHash, local.contentHash)
  assert.equal(keepLocal.conflictCopyRevisionId, remote.revisionId)
  assert.deepEqual(keepLocal.currentRevision.parents, [local.revisionId, remote.revisionId].sort())

  assert.throws(
    () => createConflict({ path: 'other.docx', localRevision: local, remoteRevision: remote }),
    /same path/u,
  )
  assert.throws(
    () =>
      createConflict({
        path: base.path,
        baseRevisionId: 'bad',
        localRevision: local,
        remoteRevision: remote,
      }),
    /SHA-256/u,
  )
  assert.throws(
    () =>
      createConflict({
        path: base.path,
        localRevision: local,
        remoteRevision: baseRevision({ namespace: 'global', scopeId: 'global-1' }),
      }),
    /repository and kind/u,
  )
  assert.throws(
    () =>
      createConflict({
        path: base.path,
        localRevision: local,
        remoteRevision: baseRevision({ kind: 'project-asset' }),
      }),
    /repository and kind/u,
  )
  assert.throws(
    () => resolveConflict({ conflict: { state: 'resolved' }, choice: 'keep-local' }),
    /open conflict/u,
  )
  assert.throws(
    () =>
      resolveConflict({
        conflict,
        choice: 'both',
        localRevision: local,
        remoteRevision: remote,
      }),
    /choice/u,
  )
  assert.throws(
    () =>
      resolveConflict({
        conflict,
        choice: 'keep-local',
        localRevision: base,
        remoteRevision: remote,
        authorDeviceId: 'device-a',
      }),
    /changed/u,
  )
})

test('keeps trust local, queues only reconcile intent and separates remote namespaces', () => {
  assert.equal(requiresLocalTrust({ kind: 'extension' }), true)
  assert.equal(requiresLocalTrust({ kind: 'mcp-config-redacted' }), true)
  assert.equal(requiresLocalTrust({ kind: 'skill', executable: true }), true)
  assert.equal(requiresLocalTrust({ kind: 'prompt', network: true }), true)
  assert.equal(requiresLocalTrust({ kind: 'prompt' }), false)
  assert.equal(requiresLocalTrust(null), false)

  assert.deepEqual(createSyncIntent({ namespace: 'project', scopeId: 'project-1' }), {
    schemaVersion: 1,
    operation: 'reconcile',
    namespace: 'project',
    scopeId: 'project-1',
  })
  const project = remoteLayout('project', 'project-1')
  const global = remoteLayout('global', 'global-1')
  assert.notEqual(project.root, global.root)
  assert.equal(project.head, 'open-genoffice-sync/v1/project/project-1/head.json')
  const id = `sha256:${'a'.repeat(64)}`
  assert.match(project.blob(id), /blobs\/sha256\/a{64}$/u)
  assert.match(project.revision(id), /revisions\/a{64}\.json$/u)
  assert.throws(() => project.blob('bad'), /SHA-256/u)
})
