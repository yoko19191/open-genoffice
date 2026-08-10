import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { canonicalJsonBytes, canonicalizeSyncPath, sha256Hex } from './canonical.js'
import { ProjectSyncKindSchema, SyncRevisionSchema, SyncScopeIdSchema } from './schema.js'
import type { ProjectSyncKind, SyncRevision } from './types.js'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,160}$/

export type ConflictChoice = 'keep-local' | 'accept-remote'
export type ConflictSource = 'local' | 'remote'

export interface ConflictBranch {
  revisionId: string
  revision: SyncRevision
}

export interface ConflictCopyDescriptor {
  source: ConflictSource
  revisionId: string
  contentHash: string
  size: number
  fileName: string
}

export interface ProjectSyncConflict {
  schemaVersion: 1
  conflictId: string
  scopeId: string
  canonicalPath: string
  kind: ProjectSyncKind
  baseRevisionId: string | null
  local: ConflictBranch
  remote: ConflictBranch
  copies: ConflictCopyDescriptor[]
  state: 'open' | 'resolved'
  choice: ConflictChoice | null
  resolutionRevisionId: string | null
  conflictCopyRevisionId: string | null
}

export interface OpenConflictInput {
  scopeId: string
  canonicalPath: string
  kind: ProjectSyncKind
  baseRevisionId: string | null
  local: ConflictBranch
  remote: ConflictBranch
  remoteBytes?: Uint8Array
}

export interface ProjectConflictStore {
  open(input: OpenConflictInput): Promise<ProjectSyncConflict>
  load(scopeId: string, conflictId: string): Promise<ProjectSyncConflict>
  saveLocalCopy(
    scopeId: string,
    conflictId: string,
    bytes: Uint8Array,
  ): Promise<ProjectSyncConflict>
  readCopy(scopeId: string, conflictId: string, revisionId: string): Promise<Uint8Array>
  restoreCopy(
    scopeId: string,
    conflictId: string,
    revisionId: string,
    targetRoot: string,
  ): Promise<void>
  markResolved(
    scopeId: string,
    conflictId: string,
    resolution: {
      choice: ConflictChoice
      resolutionRevisionId: string
      conflictCopyRevisionId: string
    },
  ): Promise<ProjectSyncConflict>
  deleteCopy(scopeId: string, conflictId: string, revisionId: string): Promise<void>
}

function assertHash(value: string, code = 'sync_conflict_invalid'): void {
  if (!HASH_PATTERN.test(value)) throw new Error(code)
}

function assertScopeId(scopeId: string): void {
  if (!Value.Check(SyncScopeIdSchema, scopeId)) throw new Error('sync_scope_invalid')
}

function assertBranch(
  branch: ConflictBranch,
  expected: { scopeId: string; canonicalPath: string; kind: ProjectSyncKind },
): void {
  assertHash(branch.revisionId)
  if (
    !Value.Check(SyncRevisionSchema, branch.revision) ||
    sha256Hex(canonicalJsonBytes(branch.revision)) !== branch.revisionId ||
    branch.revision.namespace !== 'project' ||
    branch.revision.scopeId !== expected.scopeId ||
    branch.revision.canonicalPath !== expected.canonicalPath ||
    branch.revision.kind !== expected.kind ||
    (branch.revision.tombstone
      ? branch.revision.contentHash !== undefined || branch.revision.size !== 0
      : branch.revision.contentHash === undefined)
  ) {
    throw new Error('sync_conflict_revision_invalid')
  }
}

function conflictIdentity(input: {
  scopeId: string
  canonicalPath: string
  baseRevisionId: string | null
  localRevisionId: string
  remoteRevisionId: string
}): string {
  return sha256Hex(canonicalJsonBytes({ schemaVersion: 1, ...input }))
}

function copyName(canonicalPath: string, branch: ConflictBranch): string {
  const rawBase = basename(canonicalPath)
  const safeBase = SAFE_FILE_NAME.test(rawBase) ? rawBase.slice(0, 80) : 'conflict'
  const device = branch.revision.authorDeviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)
  return `${safeBase}.${device}.${branch.revisionId.slice(0, 12)}.conflict`
}

function copyDescriptor(source: ConflictSource, branch: ConflictBranch): ConflictCopyDescriptor {
  if (branch.revision.tombstone || !branch.revision.contentHash) {
    throw new Error('sync_conflict_copy_tombstone')
  }
  return {
    source,
    revisionId: branch.revisionId,
    contentHash: branch.revision.contentHash,
    size: branch.revision.size,
    fileName: copyName(branch.revision.canonicalPath, branch),
  }
}

function assertRecord(record: unknown): asserts record is ProjectSyncConflict {
  if (!record || typeof record !== 'object') throw new Error('sync_conflict_invalid')
  const value = record as ProjectSyncConflict
  if (
    value.schemaVersion !== 1 ||
    !HASH_PATTERN.test(value.conflictId) ||
    !Value.Check(SyncScopeIdSchema, value.scopeId) ||
    canonicalizeSyncPath(value.canonicalPath) !== value.canonicalPath ||
    !Value.Check(ProjectSyncKindSchema, value.kind) ||
    (value.baseRevisionId !== null && !HASH_PATTERN.test(value.baseRevisionId)) ||
    !Array.isArray(value.copies) ||
    !['open', 'resolved'].includes(value.state) ||
    ![null, 'keep-local', 'accept-remote'].includes(value.choice) ||
    (value.resolutionRevisionId !== null && !HASH_PATTERN.test(value.resolutionRevisionId)) ||
    (value.conflictCopyRevisionId !== null && !HASH_PATTERN.test(value.conflictCopyRevisionId))
  ) {
    throw new Error('sync_conflict_invalid')
  }
  const expected = {
    scopeId: value.scopeId,
    canonicalPath: value.canonicalPath,
    kind: value.kind,
  }
  assertBranch(value.local, expected)
  assertBranch(value.remote, expected)
  if (
    value.local.revisionId === value.remote.revisionId ||
    conflictIdentity({
      scopeId: value.scopeId,
      canonicalPath: value.canonicalPath,
      baseRevisionId: value.baseRevisionId,
      localRevisionId: value.local.revisionId,
      remoteRevisionId: value.remote.revisionId,
    }) !== value.conflictId ||
    (value.state === 'open' &&
      (value.choice !== null ||
        value.resolutionRevisionId !== null ||
        value.conflictCopyRevisionId !== null)) ||
    (value.state === 'resolved' &&
      (value.choice === null ||
        value.resolutionRevisionId === null ||
        value.conflictCopyRevisionId === null))
  ) {
    throw new Error('sync_conflict_invalid')
  }
  const copyIds = new Set<string>()
  for (const copy of value.copies) {
    if (
      !copy ||
      !['local', 'remote'].includes(copy.source) ||
      !HASH_PATTERN.test(copy.revisionId) ||
      !HASH_PATTERN.test(copy.contentHash) ||
      !Number.isSafeInteger(copy.size) ||
      copy.size < 0 ||
      !SAFE_FILE_NAME.test(copy.fileName) ||
      copyIds.has(copy.revisionId)
    ) {
      throw new Error('sync_conflict_invalid')
    }
    const branch = copy.source === 'local' ? value.local : value.remote
    if (
      copy.revisionId !== branch.revisionId ||
      copy.contentHash !== branch.revision.contentHash ||
      copy.size !== branch.revision.size ||
      copy.fileName !== copyName(value.canonicalPath, branch)
    ) {
      throw new Error('sync_conflict_invalid')
    }
    copyIds.add(copy.revisionId)
  }
}

export class FileConflictCopyStore implements ProjectConflictStore {
  readonly #root: string
  readonly #platform: NodeJS.Platform
  readonly #faultInjector: () => void | Promise<void>

  constructor(
    root: string,
    options: { platform?: NodeJS.Platform; faultInjector?: () => void | Promise<void> } = {},
  ) {
    this.#root = resolve(root)
    this.#platform = options.platform ?? process.platform
    this.#faultInjector = options.faultInjector ?? (() => undefined)
  }

  recordPath(scopeId: string, conflictId: string): string {
    return join(this.#directory(scopeId, conflictId), 'conflict.json')
  }

  copyPath(scopeId: string, conflictId: string, fileName: string): string {
    if (!SAFE_FILE_NAME.test(fileName)) throw new Error('sync_conflict_copy_invalid')
    return join(this.#directory(scopeId, conflictId), 'copies', fileName)
  }

  async open(input: OpenConflictInput): Promise<ProjectSyncConflict> {
    this.#assertOpenInput(input)
    const conflictId = conflictIdentity({
      scopeId: input.scopeId,
      canonicalPath: input.canonicalPath,
      baseRevisionId: input.baseRevisionId,
      localRevisionId: input.local.revisionId,
      remoteRevisionId: input.remote.revisionId,
    })
    const existing = await this.#loadOptional(input.scopeId, conflictId)
    if (existing) return existing
    const copies: ConflictCopyDescriptor[] = []
    if (!input.remote.revision.tombstone) {
      if (!input.remoteBytes) throw new Error('sync_conflict_copy_missing')
      const descriptor = copyDescriptor('remote', input.remote)
      await this.#writeCopy(input.scopeId, conflictId, descriptor, input.remoteBytes)
      copies.push(descriptor)
    } else if (input.remoteBytes) {
      throw new Error('sync_conflict_copy_tombstone')
    }
    const conflict: ProjectSyncConflict = {
      schemaVersion: 1,
      conflictId,
      scopeId: input.scopeId,
      canonicalPath: input.canonicalPath,
      kind: input.kind,
      baseRevisionId: input.baseRevisionId,
      local: input.local,
      remote: input.remote,
      copies,
      state: 'open',
      choice: null,
      resolutionRevisionId: null,
      conflictCopyRevisionId: null,
    }
    assertRecord(conflict)
    await this.#atomicWrite(
      this.recordPath(input.scopeId, conflictId),
      canonicalJsonBytes(conflict),
    )
    return conflict
  }

  async load(scopeId: string, conflictId: string): Promise<ProjectSyncConflict> {
    const record = await this.#loadOptional(scopeId, conflictId)
    if (!record) throw new Error('sync_conflict_missing')
    return record
  }

  async saveLocalCopy(
    scopeId: string,
    conflictId: string,
    bytes: Uint8Array,
  ): Promise<ProjectSyncConflict> {
    const conflict = await this.load(scopeId, conflictId)
    if (conflict.state !== 'open') throw new Error('sync_conflict_resolved')
    if (conflict.copies.some((copy) => copy.revisionId === conflict.local.revisionId)) {
      await this.readCopy(scopeId, conflictId, conflict.local.revisionId)
      return conflict
    }
    const descriptor = copyDescriptor('local', conflict.local)
    await this.#writeCopy(scopeId, conflictId, descriptor, bytes)
    const next = { ...conflict, copies: [...conflict.copies, descriptor] }
    assertRecord(next)
    await this.#atomicWrite(this.recordPath(scopeId, conflictId), canonicalJsonBytes(next))
    return next
  }

  async readCopy(scopeId: string, conflictId: string, revisionId: string): Promise<Uint8Array> {
    const conflict = await this.load(scopeId, conflictId)
    const descriptor = conflict.copies.find((copy) => copy.revisionId === revisionId)
    if (!descriptor) throw new Error('sync_conflict_copy_missing')
    const path = this.copyPath(scopeId, conflictId, descriptor.fileName)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('sync_conflict_copy_missing')
    }
    const bytes = new Uint8Array(await readFile(path))
    if (bytes.byteLength !== descriptor.size || sha256Hex(bytes) !== descriptor.contentHash) {
      throw new Error('sync_conflict_copy_invalid')
    }
    return bytes
  }

  async restoreCopy(
    scopeId: string,
    conflictId: string,
    revisionId: string,
    targetRoot: string,
  ): Promise<void> {
    const conflict = await this.load(scopeId, conflictId)
    const bytes = await this.readCopy(scopeId, conflictId, revisionId)
    const target = join(resolve(targetRoot), ...conflict.canonicalPath.split('/'))
    await this.#assertSafeTarget(resolve(targetRoot), conflict.canonicalPath)
    await this.#atomicWrite(target, bytes, resolve(targetRoot))
  }

  async markResolved(
    scopeId: string,
    conflictId: string,
    resolution: {
      choice: ConflictChoice
      resolutionRevisionId: string
      conflictCopyRevisionId: string
    },
  ): Promise<ProjectSyncConflict> {
    const conflict = await this.load(scopeId, conflictId)
    if (conflict.state !== 'open') throw new Error('sync_conflict_resolved')
    assertHash(resolution.resolutionRevisionId)
    const expectedCopy =
      resolution.choice === 'keep-local' ? conflict.remote.revisionId : conflict.local.revisionId
    const expectedBranch = resolution.choice === 'keep-local' ? conflict.remote : conflict.local
    if (
      resolution.conflictCopyRevisionId !== expectedCopy ||
      (!expectedBranch.revision.tombstone &&
        !conflict.copies.some((copy) => copy.revisionId === expectedCopy))
    ) {
      throw new Error('sync_conflict_copy_missing')
    }
    const next: ProjectSyncConflict = {
      ...conflict,
      state: 'resolved',
      choice: resolution.choice,
      resolutionRevisionId: resolution.resolutionRevisionId,
      conflictCopyRevisionId: resolution.conflictCopyRevisionId,
    }
    assertRecord(next)
    await this.#atomicWrite(this.recordPath(scopeId, conflictId), canonicalJsonBytes(next))
    return next
  }

  async deleteCopy(scopeId: string, conflictId: string, revisionId: string): Promise<void> {
    const conflict = await this.load(scopeId, conflictId)
    if (conflict.state !== 'resolved') throw new Error('sync_conflict_open_delete_forbidden')
    const descriptor = conflict.copies.find((copy) => copy.revisionId === revisionId)
    if (!descriptor) throw new Error('sync_conflict_copy_missing')
    await unlink(this.copyPath(scopeId, conflictId, descriptor.fileName)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    const next = {
      ...conflict,
      copies: conflict.copies.filter((copy) => copy.revisionId !== revisionId),
    }
    assertRecord(next)
    await this.#atomicWrite(this.recordPath(scopeId, conflictId), canonicalJsonBytes(next))
  }

  #assertOpenInput(input: OpenConflictInput): void {
    assertScopeId(input.scopeId)
    if (
      canonicalizeSyncPath(input.canonicalPath) !== input.canonicalPath ||
      !Value.Check(ProjectSyncKindSchema, input.kind) ||
      (input.baseRevisionId !== null && !HASH_PATTERN.test(input.baseRevisionId))
    ) {
      throw new Error('sync_conflict_invalid')
    }
    const expected = {
      scopeId: input.scopeId,
      canonicalPath: input.canonicalPath,
      kind: input.kind,
    }
    assertBranch(input.local, expected)
    assertBranch(input.remote, expected)
    if (input.local.revisionId === input.remote.revisionId) {
      throw new Error('sync_conflict_invalid')
    }
  }

  async #loadOptional(scopeId: string, conflictId: string): Promise<ProjectSyncConflict | null> {
    assertScopeId(scopeId)
    assertHash(conflictId)
    const path = this.recordPath(scopeId, conflictId)
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) return null
    let record: unknown
    try {
      record = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('sync_conflict_invalid')
    }
    assertRecord(record)
    if (record.scopeId !== scopeId || record.conflictId !== conflictId) {
      throw new Error('sync_conflict_invalid')
    }
    return record
  }

  async #writeCopy(
    scopeId: string,
    conflictId: string,
    descriptor: ConflictCopyDescriptor,
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.byteLength !== descriptor.size || sha256Hex(bytes) !== descriptor.contentHash) {
      throw new Error('sync_conflict_copy_invalid')
    }
    const target = this.copyPath(scopeId, conflictId, descriptor.fileName)
    const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      if (
        existing.byteLength !== descriptor.size ||
        sha256Hex(existing) !== descriptor.contentHash
      ) {
        throw new Error('sync_conflict_copy_invalid')
      }
      return
    }
    await this.#atomicWrite(target, bytes)
  }

  #directory(scopeId: string, conflictId: string): string {
    assertScopeId(scopeId)
    assertHash(conflictId)
    return join(this.#root, 'project', scopeId, sha256Hex(Buffer.from(scopeId)), conflictId)
  }

  async #assertSafeTarget(root: string, canonicalPath: string): Promise<void> {
    const target = join(root, ...canonicalPath.split('/'))
    let current = root
    for (const segment of canonicalPath.split('/')) {
      current = join(current, segment)
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (stat?.isSymbolicLink()) throw new Error('sync_symlink_escape')
      if (stat && current !== target && !stat.isDirectory()) throw new Error('sync_target_invalid')
    }
  }

  async #ensureDirectory(directory: string, root = this.#root): Promise<void> {
    const rel = relative(root, directory)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('sync_path_invalid')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('sync_symlink_escape')
    let current = root
    for (const segment of rel.split(sep).filter(Boolean)) {
      current = join(current, segment)
      const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing?.isSymbolicLink()) throw new Error('sync_symlink_escape')
      if (existing && !existing.isDirectory()) throw new Error('sync_target_invalid')
      if (!existing) await mkdir(current, { mode: 0o700 })
    }
  }

  async #atomicWrite(target: string, bytes: Uint8Array, root = this.#root): Promise<void> {
    const parent = dirname(target)
    await this.#ensureDirectory(parent, root)
    const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let renamed = false
    try {
      await this.#faultInjector()
      await rename(temporary, target)
      renamed = true
      if (this.#platform !== 'win32') await chmod(target, 0o600)
      if (this.#platform !== 'win32') {
        const parentHandle = await open(parent, 'r')
        try {
          await parentHandle.sync()
        } finally {
          await parentHandle.close()
        }
      }
    } catch (error) {
      if (!renamed) await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}
