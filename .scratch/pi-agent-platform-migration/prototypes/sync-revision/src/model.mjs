import { createHash } from 'node:crypto'

export const SYNC_SCHEMA_VERSION = 1

const NAMESPACES = new Set(['project', 'global'])
const ENTRY_KINDS = new Set([
  'office-document',
  'project-asset',
  'project-metadata',
  'pi-session',
  'global-asset',
  'skill',
  'extension',
  'prompt',
  'package-lock',
  'mcp-config-redacted',
])
const REVISION_EVENTS = new Set(['edit', 'delete', 'keep-local', 'accept-remote'])

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const output = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError('canonical JSON rejects undefined values')
      output[key] = canonicalize(value[key])
    }
    return output
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`)
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function hashJson(value) {
  return sha256(canonicalJson(value))
}

export function assertNamespace(namespace) {
  if (!NAMESPACES.has(namespace)) throw new TypeError(`unsupported sync namespace: ${namespace}`)
}

export function assertScopeId(scopeId) {
  if (typeof scopeId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(scopeId))
    throw new TypeError('scopeId must be a stable opaque identifier')
}

export function assertSyncPath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new TypeError('sync path must be a canonical relative POSIX path')
}

export function assertEntryKind(kind) {
  if (!ENTRY_KINDS.has(kind)) throw new TypeError(`unsupported sync entry kind: ${kind}`)
}

function assertRevisionId(value, label = 'revisionId') {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new TypeError(`${label} must be a SHA-256 identifier`)
}

function makeRevision(body) {
  const revisionId = hashJson(body)
  return { ...body, revisionId }
}

export function createRevision({
  namespace,
  scopeId,
  path,
  kind,
  contentBytes,
  tombstone = false,
  parents = [],
  authorDeviceId,
  event = tombstone ? 'delete' : 'edit',
  executable = false,
  network = false,
}) {
  assertNamespace(namespace)
  assertScopeId(scopeId)
  assertSyncPath(path)
  assertEntryKind(kind)
  assertScopeId(authorDeviceId)
  if (!Array.isArray(parents) || parents.length > 2)
    throw new TypeError('a revision must have zero, one or two parents')
  for (const parent of parents) assertRevisionId(parent, 'parent revision')
  if (tombstone && contentBytes !== undefined)
    throw new TypeError('a tombstone cannot contain bytes')
  if (!tombstone && !(contentBytes instanceof Uint8Array))
    throw new TypeError('a live revision requires content bytes')
  const body = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    namespace,
    scopeId,
    path,
    kind,
    contentHash: tombstone ? null : sha256(contentBytes),
    size: tombstone ? 0 : contentBytes.byteLength,
    tombstone,
    parents: [...new Set(parents)].sort(),
    authorDeviceId,
    event,
    executable: Boolean(executable),
    network: Boolean(network),
  }
  return makeRevision(body)
}

export function verifyRevision(revision) {
  if (!revision || typeof revision !== 'object') throw new TypeError('revision must be an object')
  const { revisionId, ...body } = revision
  assertRevisionId(revisionId)
  if (hashJson(body) !== revisionId)
    throw new TypeError('revision content hash does not match its ID')
  assertNamespace(body.namespace)
  assertScopeId(body.scopeId)
  assertSyncPath(body.path)
  assertEntryKind(body.kind)
  assertScopeId(body.authorDeviceId)
  if (body.schemaVersion !== SYNC_SCHEMA_VERSION) throw new TypeError('unsupported revision schema')
  if (!REVISION_EVENTS.has(body.event)) throw new TypeError('unsupported revision event')
  if (!Array.isArray(body.parents) || body.parents.length > 2)
    throw new TypeError('revision parents are malformed')
  for (const parent of body.parents) assertRevisionId(parent, 'parent revision')
  if (new Set(body.parents).size !== body.parents.length)
    throw new TypeError('revision parents must be unique')
  if (!Number.isSafeInteger(body.size) || body.size < 0)
    throw new TypeError('revision size must be a non-negative safe integer')
  if (body.tombstone !== (body.contentHash === null))
    throw new TypeError('revision tombstone and content hash disagree')
  if (body.tombstone && body.size !== 0) throw new TypeError('tombstone size must be zero')
  if (!body.tombstone) assertRevisionId(body.contentHash, 'content hash')
  if (typeof body.executable !== 'boolean' || typeof body.network !== 'boolean')
    throw new TypeError('revision capability flags must be boolean')
  return revision
}

export function createManifest({
  namespace,
  scopeId,
  generation,
  parentManifestId = null,
  revisions,
  writerDeviceId,
}) {
  assertNamespace(namespace)
  assertScopeId(scopeId)
  assertScopeId(writerDeviceId)
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new TypeError('manifest generation must be a non-negative safe integer')
  if (parentManifestId !== null) assertRevisionId(parentManifestId, 'parent manifest ID')
  const entries = {}
  for (const revision of [...revisions].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    verifyRevision(revision)
    if (revision.namespace !== namespace || revision.scopeId !== scopeId)
      throw new TypeError('manifest revision belongs to another namespace or scope')
    if (entries[revision.path]) throw new TypeError(`duplicate manifest path: ${revision.path}`)
    entries[revision.path] = {
      revisionId: revision.revisionId,
      kind: revision.kind,
      contentHash: revision.contentHash,
      size: revision.size,
      tombstone: revision.tombstone,
      executable: revision.executable,
      network: revision.network,
    }
  }
  const body = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    namespace,
    scopeId,
    generation,
    parentManifestId,
    writerDeviceId,
    entries,
  }
  return { ...body, manifestId: hashJson(body) }
}

export function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('manifest must be an object')
  const { manifestId, ...body } = manifest
  assertRevisionId(manifestId, 'manifest ID')
  if (hashJson(body) !== manifestId)
    throw new TypeError('manifest content hash does not match its ID')
  assertNamespace(body.namespace)
  assertScopeId(body.scopeId)
  assertScopeId(body.writerDeviceId)
  if (body.schemaVersion !== SYNC_SCHEMA_VERSION) throw new TypeError('unsupported manifest schema')
  if (!Number.isSafeInteger(body.generation) || body.generation < 0)
    throw new TypeError('manifest generation must be a non-negative safe integer')
  if (body.parentManifestId !== null) assertRevisionId(body.parentManifestId, 'parent manifest ID')
  if (!body.entries || typeof body.entries !== 'object' || Array.isArray(body.entries))
    throw new TypeError('manifest entries must be an object')
  for (const [path, entry] of Object.entries(body.entries ?? {})) {
    assertSyncPath(path)
    assertRevisionId(entry.revisionId)
    assertEntryKind(entry.kind)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new TypeError('manifest entry size must be a non-negative safe integer')
    if (entry.tombstone !== (entry.contentHash === null))
      throw new TypeError('manifest entry tombstone and content hash disagree')
    if (entry.tombstone && entry.size !== 0)
      throw new TypeError('manifest tombstone size must be zero')
    if (!entry.tombstone) assertRevisionId(entry.contentHash, 'content hash')
    if (typeof entry.executable !== 'boolean' || typeof entry.network !== 'boolean')
      throw new TypeError('manifest capability flags must be boolean')
  }
  return manifest
}

const idOf = (revision) => revision?.revisionId ?? null

export function planPathSync({
  path,
  baseRevisionId = null,
  localRevision = null,
  remoteRevision = null,
}) {
  assertSyncPath(path)
  if (baseRevisionId !== null) assertRevisionId(baseRevisionId, 'base revision')
  if (localRevision) verifyRevision(localRevision)
  if (remoteRevision) verifyRevision(remoteRevision)
  for (const revision of [localRevision, remoteRevision]) {
    if (revision && revision.path !== path)
      throw new TypeError('planned revision does not target the requested path')
  }
  if (
    localRevision &&
    remoteRevision &&
    (localRevision.namespace !== remoteRevision.namespace ||
      localRevision.scopeId !== remoteRevision.scopeId)
  )
    throw new TypeError('planned revisions belong to different repositories')
  const localId = idOf(localRevision)
  const remoteId = idOf(remoteRevision)

  if (localId === remoteId) return { action: 'up-to-date', nextBaseRevisionId: localId }
  if (baseRevisionId === null && localId === null)
    return remoteRevision?.tombstone
      ? { action: 'up-to-date', nextBaseRevisionId: remoteId }
      : { action: 'fast-forward-remote', nextBaseRevisionId: remoteId }
  if (baseRevisionId === null && remoteId === null)
    return { action: 'upload-local', nextBaseRevisionId: localId }
  if (baseRevisionId !== null && localId === null)
    throw new TypeError('local deletion must be represented by a tombstone revision')
  if (baseRevisionId !== null && remoteId === null)
    return { action: 'conflict', reason: 'remote-entry-missing' }
  if (remoteId === baseRevisionId) return { action: 'upload-local', nextBaseRevisionId: localId }
  if (localId === baseRevisionId) {
    if (remoteRevision.tombstone) return { action: 'confirm-remote-delete' }
    return { action: 'fast-forward-remote', nextBaseRevisionId: remoteId }
  }
  return { action: 'conflict', reason: 'diverged' }
}

export function createConflict({ path, baseRevisionId = null, localRevision, remoteRevision }) {
  assertSyncPath(path)
  if (baseRevisionId !== null) assertRevisionId(baseRevisionId, 'base revision')
  verifyRevision(localRevision)
  verifyRevision(remoteRevision)
  if (localRevision.path !== path || remoteRevision.path !== path)
    throw new TypeError('conflict revisions must target the same path')
  if (
    localRevision.namespace !== remoteRevision.namespace ||
    localRevision.scopeId !== remoteRevision.scopeId ||
    localRevision.kind !== remoteRevision.kind
  )
    throw new TypeError('conflict revisions must share repository and kind')
  const body = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    path,
    baseRevisionId,
    localRevisionId: localRevision.revisionId,
    remoteRevisionId: remoteRevision.revisionId,
    state: 'open',
  }
  return { ...body, conflictId: hashJson(body) }
}

export function resolveConflict({
  conflict,
  choice,
  localRevision,
  remoteRevision,
  authorDeviceId,
}) {
  if (!conflict || conflict.state !== 'open')
    throw new TypeError('only an open conflict can resolve')
  if (choice !== 'keep-local' && choice !== 'accept-remote')
    throw new TypeError('conflict choice must be keep-local or accept-remote')
  verifyRevision(localRevision)
  verifyRevision(remoteRevision)
  if (
    conflict.localRevisionId !== localRevision.revisionId ||
    conflict.remoteRevisionId !== remoteRevision.revisionId
  )
    throw new TypeError('conflict revisions changed before resolution')
  const selected = choice === 'keep-local' ? localRevision : remoteRevision
  const conflictCopy = choice === 'keep-local' ? remoteRevision : localRevision
  const body = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    namespace: selected.namespace,
    scopeId: selected.scopeId,
    path: selected.path,
    kind: selected.kind,
    contentHash: selected.contentHash,
    size: selected.size,
    tombstone: selected.tombstone,
    parents: [localRevision.revisionId, remoteRevision.revisionId].sort(),
    authorDeviceId,
    event: choice,
    executable: selected.executable,
    network: selected.network,
  }
  assertScopeId(authorDeviceId)
  const currentRevision = makeRevision(body)
  return {
    currentRevision,
    conflictCopyRevisionId: conflictCopy.revisionId,
    resolvedConflict: {
      ...conflict,
      state: 'resolved',
      choice,
      resolutionRevisionId: currentRevision.revisionId,
    },
  }
}

export function requiresLocalTrust(entry) {
  return Boolean(
    entry?.executable ||
    entry?.network ||
    entry?.kind === 'extension' ||
    entry?.kind === 'mcp-config-redacted',
  )
}

export function createSyncIntent({ namespace, scopeId }) {
  assertNamespace(namespace)
  assertScopeId(scopeId)
  return { schemaVersion: SYNC_SCHEMA_VERSION, operation: 'reconcile', namespace, scopeId }
}

export function remoteLayout(namespace, scopeId) {
  assertNamespace(namespace)
  assertScopeId(scopeId)
  const root = `open-genoffice-sync/v1/${namespace}/${scopeId}`
  return {
    root,
    head: `${root}/head.json`,
    blob(contentHash) {
      assertRevisionId(contentHash, 'content hash')
      return `${root}/blobs/sha256/${contentHash.slice(7)}`
    },
    revision(revisionId) {
      assertRevisionId(revisionId)
      return `${root}/revisions/${revisionId.slice(7)}.json`
    },
  }
}
