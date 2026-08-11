import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createManifest, createRevision, remoteLayout } from '../src/model.mjs'
import { CasMismatchError, MemoryObjectStore, createSyncRepository } from '../src/repository.mjs'

const bytes = (value) => new TextEncoder().encode(value)

function fixture() {
  const revision = createRevision({
    namespace: 'project',
    scopeId: 'project-1',
    path: 'documents/report.docx',
    kind: 'office-document',
    contentBytes: bytes('report'),
    authorDeviceId: 'device-a',
  })
  const manifest = createManifest({
    namespace: 'project',
    scopeId: 'project-1',
    generation: 0,
    revisions: [revision],
    writerDeviceId: 'device-a',
  })
  return { revision, manifest }
}

test('publishes immutable content and commits a manifest with CAS', async () => {
  const store = new MemoryObjectStore()
  const repository = createSyncRepository(store, { namespace: 'project', scopeId: 'project-1' })
  const { revision, manifest } = fixture()
  assert.deepEqual(await repository.loadHead(), { manifest: null, versionToken: null })
  await repository.publishRevision(revision, bytes('report'))
  await repository.publishRevision(revision, bytes('report'))
  const commit = await repository.commitHead(manifest, null)
  assert.match(commit.versionToken, /^"memory-/u)
  const loaded = await repository.loadHead()
  assert.deepEqual(loaded.manifest, manifest)
  assert.equal(loaded.versionToken, commit.versionToken)
  await assert.rejects(() => repository.commitHead(manifest, null), CasMismatchError)
})

test('publishes tombstones without content and rejects mismatched ownership or bytes', async () => {
  const store = new MemoryObjectStore()
  const repository = createSyncRepository(store, { namespace: 'project', scopeId: 'project-1' })
  const { revision, manifest } = fixture()
  await assert.rejects(() => repository.publishRevision(revision, bytes('wrong')), /do not match/u)
  const foreign = createRevision({
    namespace: 'global',
    scopeId: 'global-1',
    path: 'prompts/default.md',
    kind: 'prompt',
    contentBytes: bytes('prompt'),
    authorDeviceId: 'device-a',
  })
  await assert.rejects(
    () => repository.publishRevision(foreign, bytes('prompt')),
    /another repository/u,
  )
  await assert.rejects(() => repository.commitHead({ ...manifest, scopeId: 'other' }, null))

  const tombstone = createRevision({
    namespace: 'project',
    scopeId: 'project-1',
    path: revision.path,
    kind: revision.kind,
    tombstone: true,
    parents: [revision.revisionId],
    authorDeviceId: 'device-a',
  })
  await repository.publishRevision(tombstone)
  await assert.rejects(() => repository.publishRevision(tombstone, bytes('bad')), /cannot include/u)
})

test('detects immutable collisions and malformed or foreign remote heads', async () => {
  const layout = remoteLayout('project', 'project-1')
  const { revision, manifest } = fixture()
  const collidingStore = {
    async putIfAbsent() {
      return { created: false }
    },
    async get() {
      return { bytes: bytes('different'), versionToken: '"1"' }
    },
  }
  const collisionRepository = createSyncRepository(collidingStore, {
    namespace: 'project',
    scopeId: 'project-1',
  })
  await assert.rejects(
    () => collisionRepository.publishRevision(revision, bytes('report')),
    /collision/u,
  )

  const invalidStore = new MemoryObjectStore()
  await invalidStore.compareAndSwap(layout.head, bytes('{bad'), null)
  await assert.rejects(
    () =>
      createSyncRepository(invalidStore, { namespace: 'project', scopeId: 'project-1' }).loadHead(),
    /valid JSON/u,
  )

  const foreignStore = new MemoryObjectStore()
  const foreignManifest = { ...manifest, namespace: 'global', scopeId: 'global-1' }
  const globalFixture = createManifest({
    namespace: 'global',
    scopeId: 'global-1',
    generation: 0,
    revisions: [],
    writerDeviceId: 'device-a',
  })
  await foreignStore.compareAndSwap(layout.head, bytes(JSON.stringify(globalFixture)), null)
  await assert.rejects(
    () =>
      createSyncRepository(foreignStore, { namespace: 'project', scopeId: 'project-1' }).loadHead(),
    /another repository/u,
  )
  assert.equal(foreignManifest.namespace, 'global')
})
