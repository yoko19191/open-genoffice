import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { x, type ReadEntry } from 'tar'
import {
  PackageLockService,
  type PackageCatalogProjection,
  type PackageInstallInput,
  type PackageSource,
} from '@genoffice/agent-resource'

const exactVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,127}$/
const commitPattern = /^[0-9a-f]{40}$/
const integrityPattern = /^sha512-([A-Za-z0-9+/]+={0,2})$/
const maximumArchiveBytes = 64 * 1024 * 1024
const execFileAsync = promisify(execFile)

export type PackageSourceRequest =
  | { type: 'local'; path: string }
  | { type: 'npm'; name: string; version: string; integrity?: string }
  | { type: 'git'; url: string; commit: string }

export type ResolvedPackageSource = {
  source: PackageSource
  directory: string
  cleanup: () => Promise<void>
}

export type PackageSourceResolverErrorCode =
  'package_source_invalid' | 'package_source_unavailable' | 'package_integrity_invalid'

export class PackageSourceResolverError extends Error {
  constructor(readonly code: PackageSourceResolverErrorCode) {
    super(code)
    this.name = 'PackageSourceResolverError'
  }
}

export type GitCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>

export type PackageSourceResolverOptions = {
  resourceHome: string
  fetch?: typeof globalThis.fetch
  git?: GitCommandRunner
}

type NpmMetadata = {
  name: string
  version: string
  dist: { tarball: string; integrity: string }
}

async function defaultGit(command: string, args: string[]): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  })
  return { stdout: result.stdout }
}

function validHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function validGitUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'ssh:'
  } catch {
    return false
  }
}

function isNpmMetadata(value: unknown, name: string, version: string): value is NpmMetadata {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NpmMetadata>
  return (
    candidate.name === name &&
    candidate.version === version &&
    typeof candidate.dist?.tarball === 'string' &&
    validHttps(candidate.dist.tarball) &&
    typeof candidate.dist.integrity === 'string' &&
    integrityPattern.test(candidate.dist.integrity)
  )
}

function isSafeArchiveEntry(path: string, type: string, root?: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return !(
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => segment === '..') ||
    (root !== undefined && normalized !== root && !normalized.startsWith(`${root}/`)) ||
    !['File', 'OldFile', 'Directory'].includes(type)
  )
}

async function extractArchive(
  archive: string,
  directory: string,
  options: { gzip: boolean; strip: number; root?: string },
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let unsafeEntry = false
  try {
    await x({
      cwd: directory,
      file: archive,
      gzip: options.gzip,
      strip: options.strip,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const safe = isSafeArchiveEntry(path, (entry as ReadEntry).type, options.root)
        if (!safe) unsafeEntry = true
        return safe
      },
    })
    if (unsafeEntry) throw new PackageSourceResolverError('package_integrity_invalid')
  } catch (error) {
    if (error instanceof PackageSourceResolverError) throw error
    throw new PackageSourceResolverError('package_integrity_invalid')
  }
}

export class PackageSourceResolver {
  private readonly fetch: typeof globalThis.fetch
  private readonly git: GitCommandRunner

  constructor(private readonly options: PackageSourceResolverOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.git = options.git ?? defaultGit
  }

  async resolve(source: PackageSourceRequest): Promise<ResolvedPackageSource> {
    if (source.type === 'local') return this.resolveLocal(source)
    if (source.type === 'npm') return this.resolveNpm(source)
    return this.resolveGit(source)
  }

  private async resolveLocal(source: Extract<PackageSourceRequest, { type: 'local' }>) {
    if (!source.path) throw new PackageSourceResolverError('package_source_invalid')
    try {
      const directory = await realpath(source.path)
      return {
        source: { type: 'local' as const, path: directory },
        directory,
        cleanup: async () => {},
      }
    } catch {
      throw new PackageSourceResolverError('package_source_unavailable')
    }
  }

  private async resolveNpm(
    source: Extract<PackageSourceRequest, { type: 'npm' }>,
  ): Promise<ResolvedPackageSource> {
    if (
      !packageNamePattern.test(source.name) ||
      !exactVersionPattern.test(source.version) ||
      (source.integrity !== undefined && !integrityPattern.test(source.integrity))
    ) {
      throw new PackageSourceResolverError('package_source_invalid')
    }
    const stage = await this.stage()
    try {
      const metadataResponse = await this.fetch(
        `https://registry.npmjs.org/${encodeURIComponent(source.name)}/${encodeURIComponent(source.version)}`,
        { redirect: 'error', signal: AbortSignal.timeout(30_000) },
      )
      if (!metadataResponse.ok) {
        throw new PackageSourceResolverError('package_source_unavailable')
      }
      const metadata: unknown = await metadataResponse.json()
      if (!isNpmMetadata(metadata, source.name, source.version)) {
        throw new PackageSourceResolverError('package_source_invalid')
      }
      if (source.integrity !== undefined && source.integrity !== metadata.dist.integrity) {
        throw new PackageSourceResolverError('package_integrity_invalid')
      }
      const archiveResponse = await this.fetch(metadata.dist.tarball, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      if (!archiveResponse.ok) {
        throw new PackageSourceResolverError('package_source_unavailable')
      }
      if (!validHttps(archiveResponse.url)) {
        throw new PackageSourceResolverError('package_source_invalid')
      }
      const declaredLength = Number(archiveResponse.headers.get('content-length') ?? '0')
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumArchiveBytes) {
        throw new PackageSourceResolverError('package_source_invalid')
      }
      const bytes = Buffer.from(await archiveResponse.arrayBuffer())
      if (bytes.byteLength > maximumArchiveBytes) {
        throw new PackageSourceResolverError('package_source_invalid')
      }
      const expectedDigest = integrityPattern.exec(metadata.dist.integrity)![1]
      const actualDigest = createHash('sha512').update(bytes).digest('base64')
      if (actualDigest !== expectedDigest) {
        throw new PackageSourceResolverError('package_integrity_invalid')
      }
      const archive = join(stage, 'package.tgz')
      const directory = join(stage, 'content')
      await writeFile(archive, bytes, { mode: 0o600 })
      await extractArchive(archive, directory, { gzip: true, strip: 1, root: 'package' })
      return {
        source: {
          type: 'npm',
          name: source.name,
          version: source.version,
          integrity: metadata.dist.integrity,
        },
        directory,
        cleanup: () => rm(stage, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      if (error instanceof PackageSourceResolverError) throw error
      throw new PackageSourceResolverError('package_source_unavailable')
    }
  }

  private async resolveGit(
    source: Extract<PackageSourceRequest, { type: 'git' }>,
  ): Promise<ResolvedPackageSource> {
    if (!validGitUrl(source.url) || !commitPattern.test(source.commit)) {
      throw new PackageSourceResolverError('package_source_invalid')
    }
    const stage = await this.stage()
    const repository = join(stage, 'repository')
    const archive = join(stage, 'package.tar')
    const directory = join(stage, 'content')
    try {
      await this.git('git', ['init', '--quiet', repository])
      await this.git('git', [
        '-C',
        repository,
        'fetch',
        '--depth=1',
        '--no-tags',
        source.url,
        source.commit,
      ])
      const resolved = await this.git('git', ['-C', repository, 'rev-parse', 'FETCH_HEAD^{commit}'])
      if (resolved.stdout.trim() !== source.commit) {
        throw new PackageSourceResolverError('package_integrity_invalid')
      }
      await this.git('git', [
        '-C',
        repository,
        'archive',
        '--format=tar',
        `--output=${archive}`,
        source.commit,
      ])
      await extractArchive(archive, directory, { gzip: false, strip: 0 })
      return {
        source,
        directory,
        cleanup: () => rm(stage, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      if (error instanceof PackageSourceResolverError) throw error
      throw new PackageSourceResolverError('package_source_unavailable')
    }
  }

  private async stage(): Promise<string> {
    const root = join(this.options.resourceHome, 'state', 'package-staging')
    await mkdir(root, { recursive: true, mode: 0o700 })
    return mkdtemp(join(root, 'resolve-'))
  }
}

export type PackageInstallCoordinatorOptions = {
  resolver: Pick<PackageSourceResolver, 'resolve'>
  packages: Pick<PackageLockService, 'install'>
}

export type CoordinatedPackageInstallInput = Omit<
  PackageInstallInput,
  'source' | 'resolvedDirectory'
> & { source: PackageSourceRequest }

export class PackageInstallCoordinator {
  constructor(private readonly options: PackageInstallCoordinatorOptions) {}

  async install(input: CoordinatedPackageInstallInput): Promise<PackageCatalogProjection> {
    const resolved = await this.options.resolver.resolve(input.source)
    try {
      return await this.options.packages.install({
        operationId: input.operationId,
        packageId: input.packageId,
        source: resolved.source,
        ...(resolved.source.type === 'local' ? {} : { resolvedDirectory: resolved.directory }),
        ...(input.expectedPreviousContentSha256
          ? { expectedPreviousContentSha256: input.expectedPreviousContentSha256 }
          : {}),
      })
    } finally {
      await resolved.cleanup()
    }
  }
}
