import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type AtomicWriteOptions } from './atomic-file'
import { lock } from './proper-lockfile'
import { ResourceActivationStore } from './project-security'

const hashPattern = '^[0-9a-f]{64}$'
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const packageIdPattern = '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]{0,127}$'
const exactVersionPattern =
  '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$'
const safeRelativePathPattern = '^(?:\\./)?(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$'

const PackageCapabilitySchema = Type.Union([Type.Literal('executable'), Type.Literal('network')])

const PackageSourceSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('local'),
      sourceRef: Type.String({ pattern: `^local-sha256:${hashPattern.slice(1)}` }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('npm'),
      name: Type.String({ pattern: packageIdPattern }),
      version: Type.String({ pattern: exactVersionPattern }),
      integrity: Type.String({ pattern: '^sha512-[A-Za-z0-9+/]+={0,2}$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('git'),
      url: Type.String({ minLength: 1, maxLength: 2048, pattern: '^(?:https|ssh)://' }),
      commit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    },
    { additionalProperties: false },
  ),
])

const PackageToolSchema = Type.Object(
  {
    extension: Type.String({ minLength: 1, maxLength: 512, pattern: safeRelativePathPattern }),
    name: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
    effect: Type.Literal('read'),
  },
  { additionalProperties: false },
)

const PackageLockEntrySchema = Type.Object(
  {
    packageId: Type.String({ pattern: packageIdPattern }),
    source: PackageSourceSchema,
    contentSha256: Type.String({ pattern: hashPattern }),
    license: Type.String({ minLength: 1, maxLength: 256 }),
    activatedCapabilities: Type.Array(PackageCapabilitySchema, {
      maxItems: 2,
      uniqueItems: true,
    }),
    enabled: Type.Boolean(),
    tools: Type.Array(PackageToolSchema, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false },
)

export const PackageLockSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generation: Type.Integer({ minimum: 1 }),
    packages: Type.Array(PackageLockEntrySchema, { maxItems: 4096 }),
  },
  { additionalProperties: false },
)

const PackageManifestSchema = Type.Object(
  {
    name: Type.String({ pattern: packageIdPattern }),
    version: Type.String({ pattern: exactVersionPattern }),
    license: Type.String({ minLength: 1, maxLength: 256 }),
    scripts: Type.Optional(Type.Record(Type.String(), Type.String())),
    pi: Type.Object(
      {
        extensions: Type.Array(Type.String({ pattern: safeRelativePathPattern }), {
          minItems: 1,
          maxItems: 256,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
    genoffice: Type.Object(
      {
        capabilities: Type.Array(PackageCapabilitySchema, {
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
        }),
        tools: Type.Array(PackageToolSchema, { minItems: 1, maxItems: 256 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
)

const LocalPackageSourcesSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sources: Type.Record(
      Type.String({ pattern: `^local-sha256:${hashPattern.slice(1)}` }),
      Type.String({ minLength: 1, maxLength: 4096 }),
    ),
  },
  { additionalProperties: false },
)

export type PackageLock = Static<typeof PackageLockSchema>
export type PackageLockEntry = Static<typeof PackageLockEntrySchema>
export type PackageToolDescriptor = Static<typeof PackageToolSchema>
export type PackageSource =
  | { type: 'local'; path: string }
  | { type: 'npm'; name: string; version: string; integrity: string }
  | { type: 'git'; url: string; commit: string }
export type PackageInstallInput = {
  operationId: string
  packageId: string
  source: PackageSource
  resolvedDirectory?: string
  expectedPreviousContentSha256?: string
}
export type PackageProjectionStatus =
  'disabled' | 'source_unavailable' | 'integrity_invalid' | 'activation_required' | 'eligible'
export type PackageCatalogProjection = {
  generation: number
  packages: Array<{
    packageId: string
    source: string
    contentSha256: string
    license: string
    capabilities: readonly ('executable' | 'network')[]
    enabled: boolean
    status: PackageProjectionStatus
    resourceCount: number
  }>
}
export type ResolvedPackage = {
  entry: PackageLockEntry
  directory: string
  extensionPaths: readonly string[]
  tools: readonly PackageToolDescriptor[]
}
export type PackageLockErrorCode =
  | 'package_source_invalid'
  | 'package_manifest_invalid'
  | 'package_integrity_invalid'
  | 'package_lock_invalid'
  | 'package_not_found'
  | 'package_generation_conflict'
  | 'package_source_unavailable'

export class PackageLockError extends Error {
  constructor(readonly code: PackageLockErrorCode) {
    super(code)
    this.name = 'PackageLockError'
  }
}

export type PackageLockServiceOptions = {
  resourceHome: string
  deviceId: string
  namespace: 'global' | 'project'
  projectRoot?: string
  platform?: NodeJS.Platform
  atomicWriteOptions?: (
    value: PackageLock | Static<typeof LocalPackageSourcesSchema>,
  ) => AtomicWriteOptions
}

const lifecycleScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
])
const maximumFiles = 4_096
const maximumBytes = 64 * 1024 * 1024

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  const visit = async (path: string, relative: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new PackageLockError('package_integrity_invalid')
    if (metadata.isFile()) {
      files += 1
      bytes += metadata.size
      if (files > maximumFiles || bytes > maximumBytes) {
        throw new PackageLockError('package_integrity_invalid')
      }
      hash.update(`file\0${relative}\0${metadata.size}\0`)
      hash.update(await readFile(path))
      return
    }
    if (!metadata.isDirectory()) throw new PackageLockError('package_integrity_invalid')
    hash.update(`directory\0${relative}\0`)
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      await visit(join(path, entry.name), relative ? `${relative}/${entry.name}` : entry.name)
    }
  }
  await visit(directory, '')
  return hash.digest('hex')
}

function sourceLabel(source: PackageLockEntry['source']): string {
  if (source.type === 'local') return source.sourceRef
  if (source.type === 'npm') return `npm:${source.name}@${source.version}`
  return `git:${source.url}#${source.commit}`
}

function packageDirectoryName(packageId: string): string {
  return encodeURIComponent(packageId)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class PackageLockService {
  private readonly agentRoot: string
  private readonly stateRoot: string
  private readonly lockPath: string
  private readonly localSourcesPath: string
  private readonly activation: ResourceActivationStore
  private readonly platform: NodeJS.Platform

  constructor(private readonly options: PackageLockServiceOptions) {
    this.agentRoot =
      options.namespace === 'project'
        ? join(options.projectRoot ?? '', '.open-genoffice', 'agent')
        : join(options.resourceHome, 'agent')
    if (options.namespace === 'project' && !options.projectRoot) {
      throw new PackageLockError('package_source_invalid')
    }
    this.stateRoot = join(options.resourceHome, 'state')
    this.lockPath = join(this.agentRoot, 'packages.lock.json')
    this.localSourcesPath = join(this.stateRoot, 'package-sources.json')
    this.activation = new ResourceActivationStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
      ...(options.platform ? { platform: options.platform } : {}),
    })
    this.platform = options.platform ?? process.platform
  }

  async install(input: PackageInstallInput): Promise<PackageCatalogProjection> {
    this.assertInstallInput(input)
    const sourceDirectory = await this.resolveSourceDirectory(input)
    const manifest = await this.readManifest(sourceDirectory, input.packageId)
    const contentSha256 = await hashDirectory(sourceDirectory)
    const source = await this.lockSource(input.source, sourceDirectory, contentSha256)
    const entry: PackageLockEntry = {
      packageId: input.packageId,
      source,
      contentSha256,
      license: manifest.license,
      activatedCapabilities: [...manifest.genoffice.capabilities].sort(),
      enabled: true,
      tools: [...manifest.genoffice.tools].sort((left, right) =>
        `${left.extension}:${left.name}`.localeCompare(`${right.extension}:${right.name}`),
      ),
    }
    await this.assertManifestFiles(sourceDirectory, manifest)
    return this.withLock(async () => {
      const current = await this.readLock()
      const previous = current.packages.find((candidate) => candidate.packageId === input.packageId)
      if (
        input.expectedPreviousContentSha256 !== undefined &&
        previous?.contentSha256 !== input.expectedPreviousContentSha256
      ) {
        throw new PackageLockError('package_generation_conflict')
      }
      await this.ensureImmutableContent(input.packageId, sourceDirectory, contentSha256)
      const packages = current.packages.filter(
        (candidate) => candidate.packageId !== input.packageId,
      )
      packages.push(entry)
      await this.writeLock({
        schemaVersion: 1,
        generation: current.generation + 1,
        packages: packages.sort((left, right) => left.packageId.localeCompare(right.packageId)),
      })
      return this.catalogUnlocked()
    })
  }

  async activate(packageId: string): Promise<PackageCatalogProjection> {
    return this.withLock(async () => {
      const entry = this.entry(await this.readLock(), packageId)
      await this.activation.activate(this.activationDescriptor(entry))
      return this.catalogUnlocked()
    })
  }

  async enable(packageId: string): Promise<PackageCatalogProjection> {
    return this.setEnabled(packageId, true)
  }

  async disable(packageId: string): Promise<PackageCatalogProjection> {
    return this.setEnabled(packageId, false)
  }

  async uninstall(packageId: string): Promise<PackageCatalogProjection> {
    return this.withLock(async () => {
      const current = await this.readLock()
      this.entry(current, packageId)
      await this.writeLock({
        schemaVersion: 1,
        generation: current.generation + 1,
        packages: current.packages.filter((entry) => entry.packageId !== packageId),
      })
      return this.catalogUnlocked()
    })
  }

  async catalog(): Promise<PackageCatalogProjection> {
    return this.withLock(() => this.catalogUnlocked())
  }

  async resolve(packageId: string): Promise<ResolvedPackage | undefined> {
    return this.withLock(async () => {
      const lockState = await this.readLock()
      const entry = lockState.packages.find((candidate) => candidate.packageId === packageId)
      if (!entry) return undefined
      return this.resolveEntry(entry)
    })
  }

  async resolveEligible(): Promise<ResolvedPackage[]> {
    return this.withLock(async () => {
      const lockState = await this.readLock()
      const resolved: ResolvedPackage[] = []
      for (const entry of lockState.packages) {
        if (!entry.enabled || !(await this.activation.isActive(this.activationDescriptor(entry)))) {
          continue
        }
        resolved.push(await this.resolveEntry(entry))
      }
      return resolved
    })
  }

  private async setEnabled(packageId: string, enabled: boolean): Promise<PackageCatalogProjection> {
    return this.withLock(async () => {
      const current = await this.readLock()
      const existing = this.entry(current, packageId)
      if (existing.enabled === enabled) return this.catalogUnlocked()
      await this.writeLock({
        schemaVersion: 1,
        generation: current.generation + 1,
        packages: current.packages.map((entry) =>
          entry.packageId === packageId ? { ...entry, enabled } : entry,
        ),
      })
      return this.catalogUnlocked()
    })
  }

  private assertInstallInput(input: PackageInstallInput): void {
    if (
      !new RegExp(uuidPattern).test(input.operationId) ||
      !new RegExp(packageIdPattern).test(input.packageId) ||
      (input.expectedPreviousContentSha256 !== undefined &&
        !new RegExp(hashPattern).test(input.expectedPreviousContentSha256))
    ) {
      throw new PackageLockError('package_source_invalid')
    }
    if (input.source.type === 'local') {
      if (!input.source.path || input.resolvedDirectory !== undefined) {
        throw new PackageLockError('package_source_invalid')
      }
      return
    }
    const candidate =
      input.source.type === 'npm'
        ? { ...input.source }
        : { type: 'git' as const, url: input.source.url, commit: input.source.commit }
    if (!Value.Check(PackageSourceSchema, candidate) || !input.resolvedDirectory) {
      throw new PackageLockError('package_source_invalid')
    }
  }

  private async resolveSourceDirectory(input: PackageInstallInput): Promise<string> {
    try {
      return await realpath(
        input.source.type === 'local' ? input.source.path : input.resolvedDirectory!,
      )
    } catch {
      throw new PackageLockError('package_source_unavailable')
    }
  }

  private async readManifest(
    directory: string,
    packageId: string,
  ): Promise<Static<typeof PackageManifestSchema>> {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (!Value.Check(PackageManifestSchema, value) || value.name !== packageId) throw new Error()
      if (Object.keys(value.scripts ?? {}).some((name) => lifecycleScripts.has(name))) {
        throw new Error()
      }
      const extensions = new Set(value.pi.extensions)
      if (value.genoffice.tools.some((tool) => !extensions.has(tool.extension))) throw new Error()
      return value as Static<typeof PackageManifestSchema>
    } catch {
      throw new PackageLockError('package_manifest_invalid')
    }
  }

  private async assertManifestFiles(
    directory: string,
    manifest: Static<typeof PackageManifestSchema>,
  ): Promise<void> {
    try {
      for (const relative of manifest.pi.extensions) {
        const resolved = await realpath(join(directory, relative))
        if (!resolved.startsWith(`${directory}${sep}`) || !(await lstat(resolved)).isFile()) {
          throw new Error()
        }
      }
    } catch {
      throw new PackageLockError('package_manifest_invalid')
    }
  }

  private async lockSource(
    source: PackageSource,
    sourceDirectory: string,
    contentSha256: string,
  ): Promise<PackageLockEntry['source']> {
    if (source.type !== 'local') return source
    const sourceRef = `local-sha256:${contentSha256}` as const
    const sources = await this.readLocalSources()
    sources.sources[sourceRef] = sourceDirectory
    await atomicWriteJson(this.localSourcesPath, sources, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(sources),
    })
    return { type: 'local', sourceRef }
  }

  private async ensureImmutableContent(
    packageId: string,
    sourceDirectory: string,
    contentSha256: string,
  ): Promise<void> {
    const target = this.contentDirectory(packageId, contentSha256)
    try {
      if ((await hashDirectory(target)) !== contentSha256) {
        throw new PackageLockError('package_integrity_invalid')
      }
      return
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await cp(sourceDirectory, target, { recursive: true, errorOnExist: true, force: false })
    if (this.platform !== 'win32') await chmod(target, 0o700)
    if ((await hashDirectory(target)) !== contentSha256) {
      throw new PackageLockError('package_integrity_invalid')
    }
  }

  private async catalogUnlocked(): Promise<PackageCatalogProjection> {
    const state = await this.readLock()
    const packages = await Promise.all(
      state.packages.map(async (entry) => ({
        packageId: entry.packageId,
        source: sourceLabel(entry.source),
        contentSha256: entry.contentSha256,
        license: entry.license,
        capabilities: entry.activatedCapabilities,
        enabled: entry.enabled,
        status: await this.status(entry),
        resourceCount: entry.tools.length,
      })),
    )
    return { generation: state.generation, packages }
  }

  private async status(entry: PackageLockEntry): Promise<PackageProjectionStatus> {
    if (!entry.enabled) return 'disabled'
    try {
      if (
        (await hashDirectory(this.contentDirectory(entry.packageId, entry.contentSha256))) !==
        entry.contentSha256
      ) {
        return 'integrity_invalid'
      }
    } catch (error) {
      return isMissing(error) ? 'source_unavailable' : 'integrity_invalid'
    }
    return (await this.activation.isActive(this.activationDescriptor(entry)))
      ? 'eligible'
      : 'activation_required'
  }

  private async resolveEntry(entry: PackageLockEntry): Promise<ResolvedPackage> {
    const directory = this.contentDirectory(entry.packageId, entry.contentSha256)
    try {
      if ((await hashDirectory(directory)) !== entry.contentSha256) {
        throw new PackageLockError('package_integrity_invalid')
      }
    } catch (error) {
      if (error instanceof PackageLockError) throw error
      throw new PackageLockError(
        isMissing(error) ? 'package_source_unavailable' : 'package_integrity_invalid',
      )
    }
    return {
      entry,
      directory,
      extensionPaths: [...new Set(entry.tools.map((tool) => join(directory, tool.extension)))],
      tools: entry.tools,
    }
  }

  private activationDescriptor(entry: PackageLockEntry) {
    return {
      namespace: this.options.namespace,
      resourceId: `package/${entry.packageId}`,
      source: `package:${this.options.namespace}/${entry.packageId}`,
      contentSha256: entry.contentSha256,
      capabilities: entry.activatedCapabilities,
    } as const
  }

  private contentDirectory(packageId: string, contentSha256: string): string {
    return join(this.agentRoot, 'packages', packageDirectoryName(packageId), contentSha256)
  }

  private entry(state: PackageLock, packageId: string): PackageLockEntry {
    const entry = state.packages.find((candidate) => candidate.packageId === packageId)
    if (!entry) throw new PackageLockError('package_not_found')
    return entry
  }

  private async readLock(): Promise<PackageLock> {
    try {
      const value: unknown = JSON.parse(await readFile(this.lockPath, 'utf8'))
      if (!Value.Check(PackageLockSchema, value)) throw new Error()
      return value as PackageLock
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, generation: 1, packages: [] }
      throw new PackageLockError('package_lock_invalid')
    }
  }

  private async writeLock(value: PackageLock): Promise<void> {
    await atomicWriteJson(this.lockPath, value, {
      platform: this.platform,
      ...this.options.atomicWriteOptions?.(value),
    })
  }

  private async readLocalSources(): Promise<Static<typeof LocalPackageSourcesSchema>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.localSourcesPath, 'utf8'))
      if (!Value.Check(LocalPackageSourcesSchema, value)) throw new Error()
      return value as Static<typeof LocalPackageSourcesSchema>
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, sources: {} }
      throw new PackageLockError('package_lock_invalid')
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const leases = join(this.stateRoot, 'leases')
    await mkdir(leases, { recursive: true, mode: 0o700 })
    const lockPath = join(
      leases,
      `package-${createHash('sha256').update(this.lockPath).digest('hex')}`,
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
