import { lstat, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJsonBytes, sha256Hex } from '../src/sync/canonical.js'
import { FileConflictCopyStore } from '../src/sync/conflict-copy-store.js'
import type { SyncRevision } from '../src/sync/types.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'project-conflict-copy-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function branch(
  content: string,
  authorDeviceId: string,
  parents: string[],
): { revisionId: string; revision: SyncRevision; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(content)
  const revision: SyncRevision = {
    schemaVersion: 1,
    namespace: 'project',
    scopeId: 'project-a',
    canonicalPath: 'documents/季度 报告.docx',
    kind: 'office-document',
    contentHash: sha256Hex(bytes),
    size: bytes.byteLength,
    tombstone: false,
    parents,
    authorDeviceId,
    event: parents.length === 0 ? 'create' : 'update',
    executable: false,
    network: false,
  }
  return { revisionId: sha256Hex(canonicalJsonBytes(revision)), revision, bytes }
}

function tombstoneBranch(parent: string) {
  const revision: SyncRevision = {
    schemaVersion: 1,
    namespace: 'project',
    scopeId: 'project-a',
    canonicalPath: 'documents/季度 报告.docx',
    kind: 'office-document',
    size: 0,
    tombstone: true,
    parents: [parent],
    authorDeviceId: 'device-b',
    event: 'delete',
    executable: false,
    network: false,
  }
  return { revisionId: sha256Hex(canonicalJsonBytes(revision)), revision }
}

async function openFixture(store: FileConflictCopyStore) {
  const base = branch('base', 'device-a', [])
  const local = branch('local', 'device-a', [base.revisionId])
  const remote = branch('remote', 'device-b', [base.revisionId])
  const conflict = await store.open({
    scopeId: 'project-a',
    canonicalPath: local.revision.canonicalPath,
    kind: 'office-document',
    baseRevisionId: base.revisionId,
    local: { revisionId: local.revisionId, revision: local.revision },
    remote: { revisionId: remote.revisionId, revision: remote.revision },
    remoteBytes: remote.bytes,
  })
  return { base, local, remote, conflict }
}

describe('FileConflictCopyStore', () => {
  it('persists a verified remote branch under hash-only directories and a safe basename', async () => {
    const root = await tempRoot()
    const store = new FileConflictCopyStore(root)
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = branch('remote', 'device-b', [base.revisionId])

    const conflict = await store.open({
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document',
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
      remoteBytes: remote.bytes,
    })

    expect(conflict).toMatchObject({ state: 'open', choice: null })
    expect(conflict.copies).toHaveLength(1)
    expect(conflict.copies[0]).toMatchObject({
      source: 'remote',
      revisionId: remote.revisionId,
      contentHash: remote.revision.contentHash,
    })
    expect(conflict.copies[0]!.fileName).toMatch(/^conflict\.device-b\.[a-f0-9]{12}\.conflict$/)
    expect(JSON.stringify(conflict)).not.toContain('/documents/')
    expect(await store.readCopy('project-a', conflict.conflictId, remote.revisionId)).toEqual(
      remote.bytes,
    )

    const recordPath = store.recordPath('project-a', conflict.conflictId)
    expect(recordPath).not.toContain('季度')
    if (process.platform !== 'win32') {
      expect((await lstat(recordPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('saves Local Current before explicit restore and keeps the selected old branch recoverable', async () => {
    const root = await tempRoot()
    const targetRoot = await tempRoot()
    const store = new FileConflictCopyStore(root)
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = branch('remote', 'device-b', [base.revisionId])
    const conflict = await store.open({
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document',
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
      remoteBytes: remote.bytes,
    })
    await mkdir(join(targetRoot, 'documents'), { recursive: true })
    await writeFile(join(targetRoot, 'documents/季度 报告.docx'), local.bytes)

    const withLocal = await store.saveLocalCopy('project-a', conflict.conflictId, local.bytes)
    expect(withLocal.copies.map((copy) => copy.source).sort()).toEqual(['local', 'remote'])
    await store.restoreCopy('project-a', conflict.conflictId, remote.revisionId, targetRoot)
    expect(await readFile(join(targetRoot, 'documents/季度 报告.docx'), 'utf8')).toBe('remote')
    expect(await store.readCopy('project-a', conflict.conflictId, local.revisionId)).toEqual(
      local.bytes,
    )

    const resolved = await store.markResolved('project-a', conflict.conflictId, {
      choice: 'accept-remote',
      resolutionRevisionId: 'f'.repeat(64),
      conflictCopyRevisionId: local.revisionId,
    })
    expect(resolved).toMatchObject({
      state: 'resolved',
      choice: 'accept-remote',
      conflictCopyRevisionId: local.revisionId,
    })
    await store.deleteCopy('project-a', conflict.conflictId, local.revisionId)
    await expect(
      store.readCopy('project-a', conflict.conflictId, local.revisionId),
    ).rejects.toThrow(/sync_conflict_copy_missing/)
  })

  it('fails closed on tampering, symlink paths and deletion of an unresolved branch', async () => {
    const root = await tempRoot()
    const store = new FileConflictCopyStore(root)
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = branch('remote', 'device-b', [base.revisionId])
    const conflict = await store.open({
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document',
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
      remoteBytes: remote.bytes,
    })
    await expect(
      store.deleteCopy('project-a', conflict.conflictId, remote.revisionId),
    ).rejects.toThrow(/sync_conflict_open_delete_forbidden/)

    const copyPath = store.copyPath('project-a', conflict.conflictId, conflict.copies[0]!.fileName)
    await writeFile(copyPath, 'tampered')
    await expect(
      store.readCopy('project-a', conflict.conflictId, remote.revisionId),
    ).rejects.toThrow(/sync_conflict_copy_invalid/)

    const unsafeRoot = await tempRoot()
    const outside = await tempRoot()
    await symlink(outside, join(unsafeRoot, 'project'))
    await expect(
      new FileConflictCopyStore(unsafeRoot).open({
        scopeId: 'project-a',
        canonicalPath: local.revision.canonicalPath,
        kind: 'office-document',
        baseRevisionId: base.revisionId,
        local: { revisionId: local.revisionId, revision: local.revision },
        remote: { revisionId: remote.revisionId, revision: remote.revision },
        remoteBytes: remote.bytes,
      }),
    ).rejects.toThrow(/sync_symlink_escape/)
  })

  it('supports a remote tombstone without inventing copy bytes and keeps open idempotent', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = tombstoneBranch(base.revisionId)
    const input = {
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document' as const,
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
    }

    const opened = await store.open(input)
    expect(opened.copies).toEqual([])
    await expect(store.open(input)).resolves.toEqual(opened)
    await expect(
      new FileConflictCopyStore(await tempRoot()).open({ ...input, remoteBytes: local.bytes }),
    ).rejects.toThrow(/sync_conflict_copy_tombstone/)
    await expect(
      store.saveLocalCopy('project-a', opened.conflictId, local.bytes),
    ).resolves.toMatchObject({ copies: [{ source: 'local' }] })
  })

  it('rejects missing or mismatched copy bytes and invalid public identifiers', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = branch('remote', 'device-b', [base.revisionId])
    const input = {
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document' as const,
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
    }

    await expect(store.open(input)).rejects.toThrow(/sync_conflict_copy_missing/)
    await expect(store.open({ ...input, remoteBytes: local.bytes })).rejects.toThrow(
      /sync_conflict_copy_invalid/,
    )
    await expect(store.load('bad scope', '0'.repeat(64))).rejects.toThrow(/sync_scope_invalid/)
    await expect(store.load('project-a', 'bad-hash')).rejects.toThrow(/sync_conflict_invalid/)
    await expect(store.load('project-a', '0'.repeat(64))).rejects.toThrow(/sync_conflict_missing/)
    expect(() => store.copyPath('project-a', '0'.repeat(64), '../escape')).toThrow(
      /sync_conflict_copy_invalid/,
    )
  })

  it('rejects malformed open branches before writing a record', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const base = branch('base', 'device-a', [])
    const local = branch('local', 'device-a', [base.revisionId])
    const remote = branch('remote', 'device-b', [base.revisionId])
    const valid = {
      scopeId: 'project-a',
      canonicalPath: local.revision.canonicalPath,
      kind: 'office-document' as const,
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
      remoteBytes: remote.bytes,
    }
    const invalidInputs = [
      { ...valid, canonicalPath: 'documents/../escape' },
      { ...valid, kind: 'not-a-kind' },
      { ...valid, baseRevisionId: 'bad-hash' },
      { ...valid, local: { ...valid.local, revisionId: 'bad-hash' } },
      {
        ...valid,
        local: {
          revisionId: local.revisionId,
          revision: { ...local.revision, namespace: 'global' },
        },
      },
      { ...valid, local: valid.remote },
    ]

    for (const input of invalidInputs) {
      await expect(store.open(input as never)).rejects.toThrow(/sync_(conflict|path)/)
    }
  })

  it('fails closed when a persisted record is malformed or does not match its path identity', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const { conflict } = await openFixture(store)
    const recordPath = store.recordPath('project-a', conflict.conflictId)
    const valid = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    const invalidRecords: unknown[] = [
      null,
      { ...valid, schemaVersion: 2 },
      { ...valid, conflictId: 'bad-hash' },
      { ...valid, scopeId: 'bad scope' },
      { ...valid, canonicalPath: '../escape' },
      { ...valid, kind: 'unknown' },
      { ...valid, baseRevisionId: 'bad-hash' },
      { ...valid, copies: 'not-an-array' },
      { ...valid, state: 'unknown' },
      { ...valid, choice: 'unknown' },
      { ...valid, resolutionRevisionId: 'bad-hash' },
      { ...valid, conflictCopyRevisionId: 'bad-hash' },
      { ...valid, baseRevisionId: null },
      { ...valid, state: 'open', choice: 'keep-local' },
      { ...valid, state: 'resolved', choice: null },
      { ...valid, copies: [null] },
      {
        ...valid,
        copies: [{ ...(valid.copies as Array<Record<string, unknown>>)[0], source: 'local' }],
      },
      {
        ...valid,
        copies: [{ ...(valid.copies as Array<Record<string, unknown>>)[0], fileName: '../bad' }],
      },
      {
        ...valid,
        copies: [(valid.copies as unknown[])[0], (valid.copies as unknown[])[0]],
      },
    ]

    await writeFile(recordPath, '{')
    await expect(store.load('project-a', conflict.conflictId)).rejects.toThrow(
      /sync_conflict_invalid/,
    )
    for (const record of invalidRecords) {
      await writeFile(recordPath, JSON.stringify(record))
      await expect(store.load('project-a', conflict.conflictId)).rejects.toThrow(
        /sync_(conflict|path)/,
      )
    }
  })

  it('covers repeated copy saves, missing files and explicit resolution guards', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const { local, remote, conflict } = await openFixture(store)
    const withLocal = await store.saveLocalCopy('project-a', conflict.conflictId, local.bytes)
    await expect(
      store.saveLocalCopy('project-a', conflict.conflictId, local.bytes),
    ).resolves.toEqual(withLocal)
    await expect(
      store.markResolved('project-a', conflict.conflictId, {
        choice: 'keep-local',
        resolutionRevisionId: 'f'.repeat(64),
        conflictCopyRevisionId: local.revisionId,
      }),
    ).rejects.toThrow(/sync_conflict_copy_missing/)
    await expect(
      store.markResolved('project-a', conflict.conflictId, {
        choice: 'keep-local',
        resolutionRevisionId: 'bad-hash',
        conflictCopyRevisionId: remote.revisionId,
      }),
    ).rejects.toThrow(/sync_conflict_invalid/)

    await store.markResolved('project-a', conflict.conflictId, {
      choice: 'keep-local',
      resolutionRevisionId: 'f'.repeat(64),
      conflictCopyRevisionId: remote.revisionId,
    })
    await expect(
      store.saveLocalCopy('project-a', conflict.conflictId, local.bytes),
    ).rejects.toThrow(/sync_conflict_resolved/)
    await expect(
      store.markResolved('project-a', conflict.conflictId, {
        choice: 'keep-local',
        resolutionRevisionId: 'f'.repeat(64),
        conflictCopyRevisionId: remote.revisionId,
      }),
    ).rejects.toThrow(/sync_conflict_resolved/)
    await expect(
      store.deleteCopy('project-a', conflict.conflictId, '0'.repeat(64)),
    ).rejects.toThrow(/sync_conflict_copy_missing/)

    const remoteCopy = store.copyPath(
      'project-a',
      conflict.conflictId,
      conflict.copies[0]!.fileName,
    )
    await unlink(remoteCopy)
    await expect(
      store.readCopy('project-a', conflict.conflictId, remote.revisionId),
    ).rejects.toThrow(/sync_conflict_copy_missing/)
    await expect(
      store.deleteCopy('project-a', conflict.conflictId, remote.revisionId),
    ).resolves.toBe(undefined)
  })

  it('rejects symlinked and non-file Conflict Copies and unsafe restore parents', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const { remote, conflict } = await openFixture(store)
    const copyPath = store.copyPath('project-a', conflict.conflictId, conflict.copies[0]!.fileName)
    await unlink(copyPath)
    await symlink(await tempRoot(), copyPath)
    await expect(
      store.readCopy('project-a', conflict.conflictId, remote.revisionId),
    ).rejects.toThrow(/sync_conflict_copy_missing/)

    await unlink(copyPath)
    await mkdir(copyPath)
    await expect(
      store.readCopy('project-a', conflict.conflictId, remote.revisionId),
    ).rejects.toThrow(/sync_conflict_copy_missing/)

    const targetStore = new FileConflictCopyStore(await tempRoot())
    const targetFixture = await openFixture(targetStore)
    const targetRoot = await tempRoot()
    await writeFile(join(targetRoot, 'documents'), 'not-a-directory')
    await expect(
      targetStore.restoreCopy(
        'project-a',
        targetFixture.conflict.conflictId,
        targetFixture.remote.revisionId,
        targetRoot,
      ),
    ).rejects.toThrow(/sync_target_invalid/)
  })

  it('restores into a missing path and rejects a symlinked target path', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const { remote, conflict } = await openFixture(store)
    const targetRoot = await tempRoot()
    await store.restoreCopy('project-a', conflict.conflictId, remote.revisionId, targetRoot)
    expect(await readFile(join(targetRoot, 'documents/季度 报告.docx'), 'utf8')).toBe('remote')

    const symlinkRoot = await tempRoot()
    await symlink(await tempRoot(), join(symlinkRoot, 'documents'))
    await expect(
      store.restoreCopy('project-a', conflict.conflictId, remote.revisionId, symlinkRoot),
    ).rejects.toThrow(/sync_symlink_escape/)
  })

  it('rejects Local tombstone copy saves and records stored under another conflict identity', async () => {
    const store = new FileConflictCopyStore(await tempRoot())
    const base = branch('base', 'device-a', [])
    const local = tombstoneBranch(base.revisionId)
    const remote = branch('remote', 'device-b', [base.revisionId])
    const tombstoneConflict = await store.open({
      scopeId: 'project-a',
      canonicalPath: remote.revision.canonicalPath,
      kind: 'office-document',
      baseRevisionId: base.revisionId,
      local: { revisionId: local.revisionId, revision: local.revision },
      remote: { revisionId: remote.revisionId, revision: remote.revision },
      remoteBytes: remote.bytes,
    })
    await expect(
      store.saveLocalCopy('project-a', tombstoneConflict.conflictId, remote.bytes),
    ).rejects.toThrow(/sync_conflict_copy_tombstone/)

    const first = await openFixture(store)
    const secondRemote = branch('remote-two', 'device-c', [first.base.revisionId])
    const second = await store.open({
      scopeId: 'project-a',
      canonicalPath: first.local.revision.canonicalPath,
      kind: 'office-document',
      baseRevisionId: first.base.revisionId,
      local: { revisionId: first.local.revisionId, revision: first.local.revision },
      remote: { revisionId: secondRemote.revisionId, revision: secondRemote.revision },
      remoteBytes: secondRemote.bytes,
    })
    await writeFile(
      store.recordPath('project-a', second.conflictId),
      await readFile(store.recordPath('project-a', first.conflict.conflictId)),
    )
    await expect(store.load('project-a', second.conflictId)).rejects.toThrow(
      /sync_conflict_invalid/,
    )
  })

  it('reuses an immutable copy left before record publication and rejects a changed copy', async () => {
    const seedStore = new FileConflictCopyStore(await tempRoot())
    const fixture = await openFixture(seedStore)
    const input = {
      scopeId: 'project-a',
      canonicalPath: fixture.local.revision.canonicalPath,
      kind: 'office-document' as const,
      baseRevisionId: fixture.base.revisionId,
      local: { revisionId: fixture.local.revisionId, revision: fixture.local.revision },
      remote: { revisionId: fixture.remote.revisionId, revision: fixture.remote.revision },
      remoteBytes: fixture.remote.bytes,
    }

    const recoveryStore = new FileConflictCopyStore(await tempRoot())
    const copy = fixture.conflict.copies[0]!
    const recoveryCopy = recoveryStore.copyPath(
      'project-a',
      fixture.conflict.conflictId,
      copy.fileName,
    )
    await mkdir(join(recoveryCopy, '..'), { recursive: true })
    await writeFile(recoveryCopy, fixture.remote.bytes)
    await expect(recoveryStore.open(input)).resolves.toMatchObject({
      conflictId: fixture.conflict.conflictId,
    })

    const corruptStore = new FileConflictCopyStore(await tempRoot())
    const corruptCopy = corruptStore.copyPath(
      'project-a',
      fixture.conflict.conflictId,
      copy.fileName,
    )
    await mkdir(join(corruptCopy, '..'), { recursive: true })
    await writeFile(corruptCopy, 'bad')
    await expect(corruptStore.open(input)).rejects.toThrow(/sync_conflict_copy_invalid/)
  })

  it('fails closed when the store root or an intermediate directory is unsafe', async () => {
    const seedStore = new FileConflictCopyStore(await tempRoot())
    const fixture = await openFixture(seedStore)
    const input = {
      scopeId: 'project-a',
      canonicalPath: fixture.local.revision.canonicalPath,
      kind: 'office-document' as const,
      baseRevisionId: fixture.base.revisionId,
      local: { revisionId: fixture.local.revisionId, revision: fixture.local.revision },
      remote: { revisionId: fixture.remote.revisionId, revision: fixture.remote.revision },
      remoteBytes: fixture.remote.bytes,
    }

    const outside = await tempRoot()
    const linkedRootParent = await tempRoot()
    const linkedRoot = join(linkedRootParent, 'linked')
    await symlink(outside, linkedRoot)
    await expect(new FileConflictCopyStore(linkedRoot).open(input)).rejects.toThrow(
      /sync_symlink_escape/,
    )

    const fileRoot = await tempRoot()
    await writeFile(join(fileRoot, 'project'), 'not-a-directory')
    await expect(new FileConflictCopyStore(fileRoot).open(input)).rejects.toThrow(/ENOTDIR/)
  })

  it('can exercise the Windows durability policy without chmod or directory fsync', async () => {
    const store = new FileConflictCopyStore(await tempRoot(), { platform: 'win32' })
    await expect(openFixture(store)).resolves.toMatchObject({
      conflict: { state: 'open' },
    })
  })

  it('removes a temporary file when publication crashes before rename', async () => {
    const seedStore = new FileConflictCopyStore(await tempRoot())
    const fixture = await openFixture(seedStore)
    const store = new FileConflictCopyStore(await tempRoot(), {
      faultInjector: () => {
        throw new Error('injected_store_crash')
      },
    })
    await expect(
      store.open({
        scopeId: 'project-a',
        canonicalPath: fixture.local.revision.canonicalPath,
        kind: 'office-document',
        baseRevisionId: fixture.base.revisionId,
        local: { revisionId: fixture.local.revisionId, revision: fixture.local.revision },
        remote: { revisionId: fixture.remote.revisionId, revision: fixture.remote.revision },
        remoteBytes: fixture.remote.bytes,
      }),
    ).rejects.toThrow(/injected_store_crash/)
  })
})
