import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { ResourceActivationDescriptor } from './project-security'

export type ResourceKind = 'skill' | 'prompt' | 'extension'
export type ResourceNamespace = 'builtin' | 'global' | 'project'
export type ResourceState = 'invalid' | 'restricted' | 'eligible'
export type ResourceReason =
  | 'project_untrusted'
  | 'activation_required'
  | 'resource_collision'
  | 'reserved_resource_id'
  | 'resource_shape_invalid'
  | 'resource_symlink_forbidden'
  | 'resource_integrity_invalid'

export type ResourceCatalogEntry = {
  resourceKey: string
  resourceId: string
  namespace: ResourceNamespace
  kind: ResourceKind
  source: string
  state: ResourceState
  reason?: ResourceReason
  contentSha256?: string
  path?: string
  activatedCapabilities: readonly ('executable' | 'network')[]
}

export type ResourceCatalog = {
  catalogId: string
  resources: readonly ResourceCatalogEntry[]
}

export type BuiltInResource = {
  resourceId: string
  kind: ResourceKind
  path: string
}

export type ScanResourceCatalogOptions = {
  resourceHome: string
  projectRoot?: string
  projectTrusted?: boolean
  builtInResources?: readonly BuiltInResource[]
  isActivated?: (descriptor: ResourceActivationDescriptor) => Promise<boolean>
}

type Candidate = Omit<ResourceCatalogEntry, 'state' | 'activatedCapabilities'> & {
  state?: ResourceState
  reason?: ResourceReason
  trusted: boolean
  activatedCapabilities: ('executable' | 'network')[]
}

const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/
const maximumFiles = 4_096
const maximumBytes = 64 * 1024 * 1024

class ResourceReadError extends Error {
  constructor(
    readonly reason: Extract<
      ResourceReason,
      'resource_symlink_forbidden' | 'resource_integrity_invalid'
    >,
  ) {
    super(reason)
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(',')}}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function decodedResourceId(name: string): string | undefined {
  try {
    const value = decodeURIComponent(name)
    return resourceIdPattern.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

function plural(kind: ResourceKind): string {
  return kind === 'skill' ? 'skills' : kind === 'prompt' ? 'prompts' : 'extensions'
}

async function directoryEntries(path: string): Promise<Dirent[]> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isDirectory()) return []
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function hashResource(path: string): Promise<string> {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0

  const visit = async (current: string, relative: string): Promise<void> => {
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) throw new ResourceReadError('resource_symlink_forbidden')
    if (metadata.isFile()) {
      files += 1
      bytes += metadata.size
      if (files > maximumFiles || bytes > maximumBytes) {
        throw new ResourceReadError('resource_integrity_invalid')
      }
      hash.update(`file\0${relative}\0${metadata.size}\0`)
      hash.update(await readFile(current))
      return
    }
    if (!metadata.isDirectory()) throw new ResourceReadError('resource_integrity_invalid')
    hash.update(`directory\0${relative}\0`)
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(join(current, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
    }
  }

  await visit(path, '')
  return hash.digest('hex')
}

async function discoverNamespace(
  namespace: 'global' | 'project',
  agentRoot: string,
  trusted: boolean,
): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const kind of ['skill', 'prompt', 'extension'] as const) {
    const directory = join(agentRoot, plural(kind))
    for (const entry of await directoryEntries(directory)) {
      const extension = extname(entry.name)
      const rawId = kind === 'skill' ? entry.name : entry.name.slice(0, -extension.length)
      const resourceId = decodedResourceId(rawId)
      const source = `${namespace}:${plural(kind)}/${entry.name}`
      const path = join(directory, entry.name)
      const candidate: Candidate = {
        resourceKey: `${kind}:${namespace}/${resourceId ?? rawId}`,
        resourceId: resourceId ?? rawId,
        namespace,
        kind,
        source,
        path,
        trusted,
        activatedCapabilities: kind === 'extension' ? ['executable'] : [],
      }
      if (entry.isSymbolicLink()) {
        candidates.push({
          ...candidate,
          state: 'invalid',
          reason: 'resource_symlink_forbidden',
        })
        continue
      }
      if (!resourceId) {
        candidates.push({ ...candidate, state: 'invalid', reason: 'resource_shape_invalid' })
        continue
      }
      if (resourceId.startsWith('open-genoffice/')) {
        candidates.push({ ...candidate, state: 'invalid', reason: 'reserved_resource_id' })
        continue
      }
      const shapeValid =
        (kind === 'skill' && entry.isDirectory()) ||
        (kind === 'prompt' && entry.isFile() && extension === '.md') ||
        (kind === 'extension' && entry.isFile() && ['.js', '.cjs', '.mjs'].includes(extension))
      if (!shapeValid) {
        candidates.push({ ...candidate, state: 'invalid', reason: 'resource_shape_invalid' })
        continue
      }
      if (!trusted) {
        candidates.push({ ...candidate, state: 'restricted', reason: 'project_untrusted' })
        continue
      }
      if (kind === 'skill') {
        try {
          const skillManifest = await lstat(join(path, 'SKILL.md'))
          if (skillManifest.isSymbolicLink()) {
            candidates.push({
              ...candidate,
              state: 'invalid',
              reason: 'resource_symlink_forbidden',
            })
            continue
          }
          if (!skillManifest.isFile()) {
            candidates.push({ ...candidate, state: 'invalid', reason: 'resource_shape_invalid' })
            continue
          }
        } catch {
          candidates.push({
            ...candidate,
            state: 'invalid',
            reason: 'resource_shape_invalid',
          })
          continue
        }
      }
      try {
        candidates.push({ ...candidate, contentSha256: await hashResource(path) })
      } catch (error) {
        candidates.push({
          ...candidate,
          state: 'invalid',
          reason: error instanceof ResourceReadError ? error.reason : 'resource_integrity_invalid',
        })
      }
    }
  }
  return candidates
}

async function discoverBuiltIns(resources: readonly BuiltInResource[]): Promise<Candidate[]> {
  return Promise.all(
    resources.map(async (resource): Promise<Candidate> => {
      const base: Candidate = {
        resourceKey: `${resource.kind}:builtin/${resource.resourceId}`,
        resourceId: resource.resourceId,
        namespace: 'builtin',
        kind: resource.kind,
        source: `builtin:${plural(resource.kind)}/${resource.resourceId}`,
        path: resource.path,
        trusted: true,
        activatedCapabilities: [],
      }
      if (
        !resourceIdPattern.test(resource.resourceId) ||
        !resource.resourceId.startsWith('open-genoffice/')
      ) {
        return { ...base, state: 'invalid', reason: 'reserved_resource_id' }
      }
      try {
        return { ...base, contentSha256: await hashResource(resource.path) }
      } catch (error) {
        return {
          ...base,
          state: 'invalid',
          reason: error instanceof ResourceReadError ? error.reason : 'resource_integrity_invalid',
        }
      }
    }),
  )
}

function publicEntry(candidate: Candidate): ResourceCatalogEntry {
  const { trusted: _trusted, ...entry } = candidate
  return entry as ResourceCatalogEntry
}

export async function scanResourceCatalog(
  options: ScanResourceCatalogOptions,
): Promise<ResourceCatalog> {
  const candidates = [
    ...(await discoverBuiltIns(options.builtInResources ?? [])),
    ...(await discoverNamespace('global', join(options.resourceHome, 'agent'), true)),
    ...(options.projectRoot
      ? await discoverNamespace(
          'project',
          join(options.projectRoot, '.open-genoffice', 'agent'),
          options.projectTrusted === true,
        )
      : []),
  ]

  const collisionGroups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.resourceId}`
    const group = collisionGroups.get(key) ?? []
    group.push(candidate)
    collisionGroups.set(key, group)
  }
  for (const group of collisionGroups.values()) {
    const userResources = group.filter((candidate) => candidate.namespace !== 'builtin')
    const hasGlobalProjectCollision =
      userResources.some((candidate) => candidate.namespace === 'global') &&
      userResources.some((candidate) => candidate.namespace === 'project')
    if (hasGlobalProjectCollision) {
      for (const candidate of userResources) {
        candidate.state = 'invalid'
        candidate.reason = 'resource_collision'
      }
    } else if (group.some((candidate) => candidate.namespace === 'builtin')) {
      for (const candidate of userResources) {
        candidate.state = 'invalid'
        candidate.reason = 'reserved_resource_id'
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.state) continue
    if (candidate.activatedCapabilities.length > 0) {
      const descriptor: ResourceActivationDescriptor = {
        namespace: candidate.namespace === 'project' ? 'project' : 'global',
        resourceId: `${candidate.kind}/${candidate.resourceId}`,
        source: candidate.source,
        contentSha256: candidate.contentSha256!,
        capabilities: candidate.activatedCapabilities,
      }
      if (!options.isActivated || !(await options.isActivated(descriptor))) {
        candidate.state = 'restricted'
        candidate.reason = 'activation_required'
        continue
      }
    }
    candidate.state = 'eligible'
  }

  const resources = candidates
    .map(publicEntry)
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))
  return Object.freeze({
    catalogId: sha256(canonicalize(resources.map(({ path: _path, ...entry }) => entry))),
    resources: Object.freeze(resources.map((resource) => Object.freeze(resource))),
  })
}

export type CapabilitySnapshot = {
  snapshotId: string
  createdForRunId: string
  model: { providerId: string; modelId: string; capabilities: readonly string[] }
  resourceHashes: Readonly<Record<string, string>>
  toolIds: readonly string[]
  permissionVersion: string
}

export type CreateCapabilitySnapshotInput = Omit<
  CapabilitySnapshot,
  'snapshotId' | 'resourceHashes'
> & {
  resources: readonly { resourceKey: string; contentSha256: string }[]
}

export class CapabilitySnapshotError extends Error {
  constructor(public readonly code: 'capability_snapshot_invalid' | 'capability_revoked') {
    super(code)
    this.name = 'CapabilitySnapshotError'
  }
}

export function createCapabilitySnapshot(input: CreateCapabilitySnapshotInput): CapabilitySnapshot {
  if (
    !input.createdForRunId ||
    !input.model.providerId ||
    !input.model.modelId ||
    !input.permissionVersion ||
    input.resources.some(
      (resource) => !resource.resourceKey || !/^[0-9a-f]{64}$/.test(resource.contentSha256),
    ) ||
    input.toolIds.some((toolId) => !toolId)
  ) {
    throw new CapabilitySnapshotError('capability_snapshot_invalid')
  }
  const resourceHashes = Object.fromEntries(
    [...input.resources]
      .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))
      .map((resource) => [resource.resourceKey, resource.contentSha256]),
  )
  const body = {
    createdForRunId: input.createdForRunId,
    model: {
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      capabilities: [...new Set(input.model.capabilities)].sort(),
    },
    resourceHashes,
    toolIds: [...new Set(input.toolIds)].sort(),
    permissionVersion: input.permissionVersion,
  }
  return Object.freeze({
    snapshotId: sha256(canonicalize(body)),
    ...body,
    model: Object.freeze(body.model),
    resourceHashes: Object.freeze(resourceHashes),
    toolIds: Object.freeze(body.toolIds),
  })
}

export async function verifyCapabilitySnapshot(
  snapshot: CapabilitySnapshot,
  current: {
    permissionVersion: string
    isResourceAuthorized: (resourceKey: string, contentSha256: string) => Promise<boolean>
    isToolEnabled: (toolId: string) => boolean
  },
): Promise<void> {
  if (current.permissionVersion !== snapshot.permissionVersion) {
    throw new CapabilitySnapshotError('capability_revoked')
  }
  for (const [resourceKey, contentSha256] of Object.entries(snapshot.resourceHashes)) {
    if (!(await current.isResourceAuthorized(resourceKey, contentSha256))) {
      throw new CapabilitySnapshotError('capability_revoked')
    }
  }
  if (snapshot.toolIds.some((toolId) => !current.isToolEnabled(toolId))) {
    throw new CapabilitySnapshotError('capability_revoked')
  }
}
