import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type AtomicWriteOptions } from './atomic-file'
import { lock } from './proper-lockfile'

const UuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const HashPattern = '^[0-9a-f]{64}$'
const ResourceIdPattern = '^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$'
const SourcePattern = '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$'

export const ProjectManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    projectId: Type.String({ pattern: UuidPattern }),
  },
  { additionalProperties: false },
)

export const ProjectIdentitySchema = Type.Object(
  {
    deviceId: Type.String({ pattern: UuidPattern }),
    projectId: Type.String({ pattern: UuidPattern }),
    canonicalRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    rootIdentity: Type.Object(
      {
        volumeId: Type.String({ minLength: 1, maxLength: 128 }),
        fileId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const TrustRecordSchema = Type.Object(
  {
    deviceId: Type.String({ pattern: UuidPattern }),
    projectId: Type.String({ pattern: UuidPattern }),
    canonicalRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    rootIdentity: Type.Object(
      {
        volumeId: Type.String({ minLength: 1, maxLength: 128 }),
        fileId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    grantedAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

export const ProjectTrustStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generation: Type.Integer({ minimum: 1 }),
    records: Type.Array(TrustRecordSchema, { maxItems: 4096 }),
  },
  { additionalProperties: false },
)

export const ResourceActivationDescriptorSchema = Type.Object(
  {
    namespace: Type.Union([Type.Literal('project'), Type.Literal('global')]),
    resourceId: Type.String({ pattern: ResourceIdPattern }),
    source: Type.String({ pattern: SourcePattern }),
    contentSha256: Type.String({ pattern: HashPattern }),
    capabilities: Type.Array(Type.Union([Type.Literal('executable'), Type.Literal('network')]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
)

const ActivationRecordSchema = Type.Object(
  {
    namespace: Type.Union([Type.Literal('project'), Type.Literal('global')]),
    resourceId: Type.String({ pattern: ResourceIdPattern }),
    source: Type.String({ pattern: SourcePattern }),
    contentSha256: Type.String({ pattern: HashPattern }),
    capabilities: Type.Array(Type.Union([Type.Literal('executable'), Type.Literal('network')]), {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    deviceId: Type.String({ pattern: UuidPattern }),
    activatedAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

export const ResourceActivationStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generation: Type.Integer({ minimum: 1 }),
    records: Type.Array(ActivationRecordSchema, { maxItems: 16_384 }),
  },
  { additionalProperties: false },
)

export type ProjectIdentity = Static<typeof ProjectIdentitySchema>
export type ProjectTrustState = Static<typeof ProjectTrustStateSchema>
export type ResourceActivationDescriptor = Omit<
  Static<typeof ResourceActivationDescriptorSchema>,
  'capabilities'
> & { capabilities: readonly ('executable' | 'network')[] }
export type ResourceActivationState = Static<typeof ResourceActivationStateSchema>
export type ProjectSecurityErrorCode =
  | 'project_root_invalid'
  | 'project_metadata_symlink_forbidden'
  | 'project_manifest_invalid'
  | 'project_identity_invalid'
  | 'project_trust_state_invalid'
  | 'resource_activation_invalid'
  | 'resource_activation_state_invalid'

export class ProjectSecurityError extends Error {
  constructor(public readonly code: ProjectSecurityErrorCode) {
    super(code)
    this.name = 'ProjectSecurityError'
  }
}

export async function findCanonicalProjectRoot(filePath: string): Promise<string | undefined> {
  let current: string
  try {
    const canonicalFile = await realpath(filePath)
    if (!(await lstat(canonicalFile)).isFile()) return undefined
    current = dirname(canonicalFile)
  } catch {
    return undefined
  }

  for (;;) {
    const metadataDirectory = join(current, '.open-genoffice')
    try {
      const metadata = await lstat(metadataDirectory)
      if (!metadata.isDirectory()) return undefined
      const manifest = await lstat(join(metadataDirectory, 'project.json'))
      if (!manifest.isFile()) return undefined
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

type StoreOptions = {
  rootDirectory: string
  deviceId: string
  platform?: NodeJS.Platform
  now?: () => Date
  atomicWriteOptions?: (value: ProjectTrustState | ResourceActivationState) => AtomicWriteOptions
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function identityKey(identity: ProjectIdentity): string {
  return JSON.stringify({
    deviceId: identity.deviceId,
    projectId: identity.projectId,
    canonicalRoot: identity.canonicalRoot,
    rootIdentity: identity.rootIdentity,
  })
}

function sameIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return identityKey(left) === identityKey(right)
}

function normalizedDescriptor(
  descriptor: ResourceActivationDescriptor,
): Static<typeof ResourceActivationDescriptorSchema> {
  const normalized = {
    ...descriptor,
    capabilities: [...descriptor.capabilities].sort(),
  }
  if (!Value.Check(ResourceActivationDescriptorSchema, normalized)) {
    throw new ProjectSecurityError('resource_activation_invalid')
  }
  return normalized
}

function activationKey(
  deviceId: string,
  descriptor: Static<typeof ResourceActivationDescriptorSchema>,
): string {
  return JSON.stringify({
    deviceId,
    namespace: descriptor.namespace,
    resourceId: descriptor.resourceId,
    source: descriptor.source,
    contentSha256: descriptor.contentSha256,
    capabilities: [...descriptor.capabilities].sort(),
  })
}

async function assertRegularFile(path: string, code: ProjectSecurityErrorCode): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ProjectSecurityError(code)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    if (error instanceof ProjectSecurityError) throw error
    throw new ProjectSecurityError(code)
  }
}

export async function resolveProjectIdentity(
  rootDirectory: string,
  deviceId: string,
): Promise<ProjectIdentity> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(rootDirectory)
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error('not_directory')
  } catch {
    throw new ProjectSecurityError('project_root_invalid')
  }
  const metadataDirectory = join(canonicalRoot, '.open-genoffice')
  try {
    const metadata = await lstat(metadataDirectory)
    if (metadata.isSymbolicLink()) {
      throw new ProjectSecurityError('project_metadata_symlink_forbidden')
    }
    if (!metadata.isDirectory()) throw new ProjectSecurityError('project_manifest_invalid')
  } catch (error) {
    if (error instanceof ProjectSecurityError) throw error
    throw new ProjectSecurityError('project_manifest_invalid')
  }
  const manifestPath = join(metadataDirectory, 'project.json')
  if (!(await assertRegularFile(manifestPath, 'project_manifest_invalid'))) {
    throw new ProjectSecurityError('project_manifest_invalid')
  }
  let manifest: Static<typeof ProjectManifestSchema>
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!Value.Check(ProjectManifestSchema, value)) throw new Error('invalid')
    manifest = value as Static<typeof ProjectManifestSchema>
  } catch {
    throw new ProjectSecurityError('project_manifest_invalid')
  }
  const rootMetadata = await stat(canonicalRoot)
  const identity = {
    deviceId,
    projectId: manifest.projectId,
    canonicalRoot,
    rootIdentity: {
      volumeId: String(rootMetadata.dev),
      fileId: String(rootMetadata.ino),
    },
  }
  if (!Value.Check(ProjectIdentitySchema, identity)) {
    throw new ProjectSecurityError('project_identity_invalid')
  }
  return Object.freeze({ ...identity, rootIdentity: Object.freeze(identity.rootIdentity) })
}

abstract class LockedStateStore {
  protected readonly platform: NodeJS.Platform
  protected readonly now: () => Date
  protected readonly stateDirectory: string
  protected readonly leasesDirectory: string

  constructor(protected readonly options: StoreOptions) {
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date())
    this.stateDirectory = join(options.rootDirectory, 'state')
    this.leasesDirectory = join(this.stateDirectory, 'leases')
    if (!new RegExp(UuidPattern).test(options.deviceId)) {
      throw new ProjectSecurityError('project_identity_invalid')
    }
  }

  protected async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.leasesDirectory, { recursive: true, mode: 0o700 })
    if (this.platform !== 'win32') await chmod(this.leasesDirectory, 0o700)
    const lockPath = join(
      this.leasesDirectory,
      `security-${createHash('sha256').update(name).digest('hex')}`,
    )
    const release = await lock(lockPath, {
      realpath: false,
      stale: 15_000,
      retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 50 },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }
}

export class ProjectTrustStore extends LockedStateStore {
  private readonly path = join(this.stateDirectory, 'trust.json')

  async isTrusted(identity: ProjectIdentity): Promise<boolean> {
    if (!Value.Check(ProjectIdentitySchema, identity)) return false
    return this.withLock('trust', async () =>
      (await this.read()).records.some(
        (record) => record.deviceId === this.options.deviceId && sameIdentity(record, identity),
      ),
    )
  }

  async grant(identity: ProjectIdentity): Promise<ProjectTrustState> {
    if (
      !Value.Check(ProjectIdentitySchema, identity) ||
      identity.deviceId !== this.options.deviceId
    ) {
      throw new ProjectSecurityError('project_identity_invalid')
    }
    return this.withLock('trust', async () => {
      const state = await this.read()
      const records = state.records.filter((record) => !sameIdentity(record, identity))
      records.push({ ...identity, grantedAt: this.now().toISOString() })
      return this.write({ schemaVersion: 1, generation: state.generation + 1, records })
    })
  }

  async revoke(identity: ProjectIdentity): Promise<ProjectTrustState> {
    if (!Value.Check(ProjectIdentitySchema, identity)) {
      throw new ProjectSecurityError('project_identity_invalid')
    }
    return this.withLock('trust', async () => {
      const state = await this.read()
      const records = state.records.filter((record) => !sameIdentity(record, identity))
      if (records.length === state.records.length) return state
      return this.write({ schemaVersion: 1, generation: state.generation + 1, records })
    })
  }

  private async read(): Promise<ProjectTrustState> {
    if (!(await assertRegularFile(this.path, 'project_trust_state_invalid'))) {
      return { schemaVersion: 1, generation: 1, records: [] }
    }
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (
        !Value.Check(ProjectTrustStateSchema, value) ||
        value.records.some((record) => !Number.isFinite(Date.parse(record.grantedAt)))
      ) {
        throw new Error('invalid')
      }
      return value as ProjectTrustState
    } catch {
      throw new ProjectSecurityError('project_trust_state_invalid')
    }
  }

  private async write(state: ProjectTrustState): Promise<ProjectTrustState> {
    await atomicWriteJson(this.path, state, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(state),
    })
    return Object.freeze(state)
  }
}

export class ResourceActivationStore extends LockedStateStore {
  private readonly path = join(this.stateDirectory, 'activations.json')

  async isActive(descriptor: ResourceActivationDescriptor): Promise<boolean> {
    const normalized = normalizedDescriptor(descriptor)
    const key = activationKey(this.options.deviceId, normalized)
    return this.withLock('activations', async () =>
      (await this.read()).records.some((record) => activationKey(record.deviceId, record) === key),
    )
  }

  async activate(descriptor: ResourceActivationDescriptor): Promise<ResourceActivationState> {
    const normalized = normalizedDescriptor(descriptor)
    return this.withLock('activations', async () => {
      const state = await this.read()
      const key = activationKey(this.options.deviceId, normalized)
      const records = state.records.filter(
        (record) => activationKey(record.deviceId, record) !== key,
      )
      records.push({
        ...normalized,
        deviceId: this.options.deviceId,
        activatedAt: this.now().toISOString(),
      })
      return this.write({ schemaVersion: 1, generation: state.generation + 1, records })
    })
  }

  async revoke(descriptor: ResourceActivationDescriptor): Promise<ResourceActivationState> {
    const normalized = normalizedDescriptor(descriptor)
    return this.withLock('activations', async () => {
      const state = await this.read()
      const key = activationKey(this.options.deviceId, normalized)
      const records = state.records.filter(
        (record) => activationKey(record.deviceId, record) !== key,
      )
      if (records.length === state.records.length) return state
      return this.write({ schemaVersion: 1, generation: state.generation + 1, records })
    })
  }

  private async read(): Promise<ResourceActivationState> {
    if (!(await assertRegularFile(this.path, 'resource_activation_state_invalid'))) {
      return { schemaVersion: 1, generation: 1, records: [] }
    }
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (
        !Value.Check(ResourceActivationStateSchema, value) ||
        value.records.some((record) => !Number.isFinite(Date.parse(record.activatedAt)))
      ) {
        throw new Error('invalid')
      }
      return value as ResourceActivationState
    } catch {
      throw new ProjectSecurityError('resource_activation_state_invalid')
    }
  }

  private async write(state: ResourceActivationState): Promise<ResourceActivationState> {
    await atomicWriteJson(this.path, state, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(state),
    })
    return Object.freeze(state)
  }
}
