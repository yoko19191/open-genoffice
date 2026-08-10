import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { NODE_VERSION, type RuntimeBundleManifest } from '@genoffice/agent-runtime-protocol'

const execFileAsync = promisify(execFile)
const NODE_DIST_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}`

type SupportedTarget = 'darwin-arm64' | 'win32-x64' | 'linux-x64'

export type NodeDistributionDescriptor = Readonly<{
  archive: string
  sha256: string
  directory: string
  executable: string
  license: string
}>

export const OFFICIAL_NODE_DISTRIBUTIONS: Readonly<
  Record<SupportedTarget, NodeDistributionDescriptor>
> = Object.freeze({
  'darwin-arm64': Object.freeze({
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: 'c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d',
    directory: `node-v${NODE_VERSION}-darwin-arm64`,
    executable: 'bin/node',
    license: 'LICENSE',
  }),
  'win32-x64': Object.freeze({
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    sha256: 'ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86',
    directory: `node-v${NODE_VERSION}-win-x64`,
    executable: 'node.exe',
    license: 'LICENSE',
  }),
  'linux-x64': Object.freeze({
    archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2',
    directory: `node-v${NODE_VERSION}-linux-x64`,
    executable: 'bin/node',
    license: 'LICENSE',
  }),
})

export class OfficialNodeDistributionError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'OfficialNodeDistributionError'
    this.code = code
  }
}

type FetchResponse = Readonly<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>

export type AcquireOfficialNodeDistributionOptions = Readonly<{
  outputDirectory: string
  platform: RuntimeBundleManifest['platform']
  arch: RuntimeBundleManifest['arch']
}>

export type AcquireOfficialNodeDistributionDependencies = Readonly<{
  fetchImpl: (url: string) => Promise<FetchResponse>
  extractArchive: (archivePath: string, destination: string) => Promise<void>
  hashArchive: (archive: Buffer) => string
  executeNode: (executable: string) => Promise<string>
}>

export type AcquiredOfficialNodeDistribution = Readonly<{
  root: string
  executable: string
  license: string
  archive: string
  archiveSha256: string
}>

function fail(code: string): never {
  throw new OfficialNodeDistributionError(code)
}

function descriptor(
  platform: RuntimeBundleManifest['platform'],
  arch: RuntimeBundleManifest['arch'],
): NodeDistributionDescriptor {
  const found = OFFICIAL_NODE_DISTRIBUTIONS[`${platform}-${arch}` as SupportedTarget]
  return found ?? fail('node_distribution_target_unsupported')
}

async function regularFile(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail('node_distribution_layout_invalid')
}

export async function extractOfficialNodeArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', destination])
  } catch {
    fail('node_distribution_extract_failed')
  }
}

export function officialNodeArchiveSha256(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex')
}

export async function officialNodeVersion(executable: string): Promise<string> {
  return (await execFileAsync(executable, ['--version'])).stdout
}

const PRODUCTION_DEPENDENCIES: AcquireOfficialNodeDistributionDependencies = Object.freeze({
  fetchImpl: (url) => fetch(url),
  extractArchive: extractOfficialNodeArchive,
  hashArchive: officialNodeArchiveSha256,
  executeNode: officialNodeVersion,
})

export async function acquireOfficialNodeDistributionWithDependencies(
  options: AcquireOfficialNodeDistributionOptions,
  dependencies: AcquireOfficialNodeDistributionDependencies,
): Promise<AcquiredOfficialNodeDistribution> {
  const selected = descriptor(options.platform, options.arch)
  const output = resolve(options.outputDirectory)
  if (await lstat(output).catch(() => undefined)) fail('node_distribution_output_exists')
  let response: FetchResponse
  try {
    response = await dependencies.fetchImpl(`${NODE_DIST_BASE_URL}/${selected.archive}`)
  } catch {
    fail('node_distribution_download_failed')
  }
  if (!response.ok) fail('node_distribution_download_failed')
  const archive = Buffer.from(await response.arrayBuffer())
  const actualSha256 = dependencies.hashArchive(archive)
  if (actualSha256 !== selected.sha256) fail('node_distribution_hash_mismatch')

  await mkdir(dirname(output), { recursive: true })
  const staging = await mkdtemp(`${output}.acquiring-`)
  try {
    const archivePath = join(staging, selected.archive)
    await writeFile(archivePath, archive)
    await dependencies.extractArchive(archivePath, staging)
    const extracted = join(staging, selected.directory)
    const executable = join(extracted, ...selected.executable.split('/'))
    const license = join(extracted, selected.license)
    await Promise.all([regularFile(executable), regularFile(license)])
    const stdout = await dependencies.executeNode(executable)
    if (stdout.trim() !== `v${NODE_VERSION}`) fail('node_distribution_version_mismatch')
    await rename(extracted, output)
    return Object.freeze({
      root: output,
      executable: join(output, ...selected.executable.split('/')),
      license: join(output, selected.license),
      archive: selected.archive,
      archiveSha256: actualSha256,
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export function acquireOfficialNodeDistribution(
  options: AcquireOfficialNodeDistributionOptions,
): Promise<AcquiredOfficialNodeDistribution> {
  return acquireOfficialNodeDistributionWithDependencies(options, PRODUCTION_DEPENDENCIES)
}

export async function runOfficialNodeDistributionCli(
  args: readonly string[],
  io: Readonly<{ stdout(line: string): void; stderr(line: string): void }>,
): Promise<number> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      io.stderr('node_distribution_arguments_invalid')
      return 1
    }
    values.set(name, value)
  }
  if (!values.has('--output') || !values.has('--platform') || !values.has('--arch')) {
    io.stderr('node_distribution_arguments_invalid')
    return 1
  }
  try {
    const acquired = await acquireOfficialNodeDistribution({
      outputDirectory: values.get('--output')!,
      platform: values.get('--platform') as RuntimeBundleManifest['platform'],
      arch: values.get('--arch') as RuntimeBundleManifest['arch'],
    })
    io.stdout(JSON.stringify({ status: 'passed', ...acquired }))
    return 0
  } catch (error) {
    io.stderr(
      error instanceof OfficialNodeDistributionError
        ? error.code
        : 'node_distribution_acquire_failed',
    )
    return 1
  }
}
