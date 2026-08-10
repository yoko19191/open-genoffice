import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, posix, resolve } from 'node:path'
import {
  parseRuntimeBundleManifest,
  type RuntimeBundleManifest,
} from '@genoffice/agent-runtime-protocol'

export class RuntimeBundleVerificationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'RuntimeBundleVerificationError'
    this.code = code
  }
}

export const WINDOWS_JOB_LAUNCHER_RELATIVE_PATH = 'node/open-genoffice-job-launcher.exe'
export const CAPABILITY_SMOKE_ENTRY_RELATIVE_PATH = 'self-test/native-capability-smoke.mjs'
export const SUBAGENT_SMOKE_ENTRY_RELATIVE_PATH = 'self-test/native-subagent-smoke.mjs'
export const CAPABILITY_EXTENSION_RELATIVE_PATH = 'self-test/native-smoke-extension.mjs'
export const MCP_SMOKE_SERVER_RELATIVE_PATH = 'self-test/mcp-stdio-server.mjs'
export const PI_HEADLESS_FIXTURE_RELATIVE_PATH = 'self-test/pi-headless-fixture.mjs'
export const PI_CLI_ENTRY_RELATIVE_PATH = 'app/pi-cli.mjs'
export const PI_PACKAGE_MANIFEST_RELATIVE_PATH = 'app/package.json'
export const SUBAGENT_WORKER_RELATIVE_PATH = 'workers/durable-worker.mjs'
export const WINDOWS_NATIVE_ADDON_RELATIVE_PATH = 'native/win32-x64/win32-console-mode.node'

export function piCliCommandRelativePath(platform: RuntimeBundleManifest['platform']): string {
  return `node/open-genoffice-pi-cli${platform === 'win32' ? '.exe' : ''}`
}

export function piSmokeCommandRelativePath(platform: RuntimeBundleManifest['platform']): string {
  return `node/open-genoffice-pi-smoke${platform === 'win32' ? '.exe' : ''}`
}

export function piShimRelativePath(platform: RuntimeBundleManifest['platform']): string {
  return `node/pi${platform === 'win32' ? '.exe' : ''}`
}

export type RuntimeBundleTarget = {
  platform: RuntimeBundleManifest['platform']
  arch: RuntimeBundleManifest['arch']
}

export type VerifiedPiRuntimeBundle = Readonly<{
  kind: 'verified-pi-runtime-bundle'
  root: string
  executablePath: string
  entryPath: string
  capabilitySmokeEntryPath: string
  windowsJobLauncherPath?: string
  windowsNativeAddonPath?: string
  manifest: RuntimeBundleManifest
  manifestSha256: string
}>

export type RuntimeBundleVerifierIo = {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

type RuntimeTreeFile = RuntimeBundleManifest['files'][number]

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalRuntimeTreeHash(files: readonly RuntimeTreeFile[]): string {
  const canonical = files
    .map((file) => `${file.path}\0${file.mode ?? ''}\0${file.size}\0${file.sha256}\n`)
    .join('')
  return sha256(canonical)
}

function fail(code: string): never {
  throw new RuntimeBundleVerificationError(code)
}

function validateManifestPaths(manifest: RuntimeBundleManifest) {
  let previous = ''
  const caseFolded = new Set<string>()
  for (const file of manifest.files) {
    const path = file.path
    if (
      path === '' ||
      isAbsolute(path) ||
      path.includes('\\') ||
      path.includes('\0') ||
      path !== posix.normalize(path) ||
      path.startsWith('../')
    ) {
      fail('runtime_bundle_path_invalid')
    }
    if (previous !== '' && previous >= path) fail('runtime_bundle_files_unsorted')
    previous = path
    const folded = path.toLowerCase()
    if (caseFolded.has(folded)) fail('runtime_bundle_path_duplicate')
    caseFolded.add(folded)
  }

  const paths = new Set(manifest.files.map((file) => file.path))
  if (!paths.has(manifest.executable) || !paths.has(manifest.entry)) {
    fail('runtime_bundle_launch_path_missing')
  }
  if (!paths.has('THIRD-PARTY-NOTICES.txt')) fail('runtime_bundle_notices_missing')
  if (manifest.platform === 'win32' && !paths.has(WINDOWS_JOB_LAUNCHER_RELATIVE_PATH)) {
    fail('runtime_bundle_windows_job_launcher_missing')
  }
  if (manifest.platform === 'win32' && !paths.has(WINDOWS_NATIVE_ADDON_RELATIVE_PATH)) {
    fail('runtime_bundle_windows_native_addon_missing')
  }
  if (
    !paths.has(CAPABILITY_SMOKE_ENTRY_RELATIVE_PATH) ||
    !paths.has(SUBAGENT_SMOKE_ENTRY_RELATIVE_PATH) ||
    !paths.has(CAPABILITY_EXTENSION_RELATIVE_PATH) ||
    !paths.has(MCP_SMOKE_SERVER_RELATIVE_PATH) ||
    !paths.has(PI_HEADLESS_FIXTURE_RELATIVE_PATH) ||
    !paths.has(PI_CLI_ENTRY_RELATIVE_PATH) ||
    !paths.has(PI_PACKAGE_MANIFEST_RELATIVE_PATH) ||
    !paths.has(SUBAGENT_WORKER_RELATIVE_PATH) ||
    !paths.has(piCliCommandRelativePath(manifest.platform)) ||
    !paths.has(piSmokeCommandRelativePath(manifest.platform)) ||
    !paths.has(piShimRelativePath(manifest.platform))
  ) {
    fail('runtime_bundle_self_test_missing')
  }
}

async function walkBundle(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string, relativeDirectory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = resolve(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink !== 1)) {
        fail('runtime_bundle_link_forbidden')
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (!metadata.isFile()) fail('runtime_bundle_file_type_invalid')
      if (relativePath !== 'manifest.json') files.push(relativePath)
    }
  }

  await walk(root, '')
  return files.sort()
}

function freezeManifest(manifest: RuntimeBundleManifest): RuntimeBundleManifest {
  for (const file of manifest.files) Object.freeze(file)
  Object.freeze(manifest.files)
  return Object.freeze(manifest)
}

export async function verifyPiRuntimeBundle(
  bundleRoot: string,
  target: RuntimeBundleTarget,
): Promise<VerifiedPiRuntimeBundle> {
  const root = resolve(bundleRoot)
  let rootMetadata
  try {
    rootMetadata = await lstat(root)
  } catch {
    fail('runtime_bundle_root_invalid')
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('runtime_bundle_root_invalid')
  }

  const manifestPath = resolve(root, 'manifest.json')
  let manifestBytes: Buffer
  let manifest: RuntimeBundleManifest
  try {
    manifestBytes = await readFile(manifestPath)
    manifest = parseRuntimeBundleManifest(JSON.parse(manifestBytes.toString('utf8')))
  } catch {
    fail('runtime_bundle_manifest_invalid')
  }

  if (
    manifest.platform !== target.platform ||
    manifest.arch !== target.arch ||
    (target.platform === 'linux' && manifest.libc !== 'glibc')
  ) {
    fail('runtime_bundle_target_mismatch')
  }
  validateManifestPaths(manifest)
  if (canonicalRuntimeTreeHash(manifest.files) !== manifest.treeSha256) {
    fail('runtime_bundle_tree_hash_mismatch')
  }

  const actualPaths = await walkBundle(root)
  const expectedPaths = manifest.files.map((file) => file.path)
  if (actualPaths.some((path) => !expectedPaths.includes(path))) {
    fail('runtime_bundle_unregistered_file')
  }
  if (expectedPaths.some((path) => !actualPaths.includes(path))) {
    fail('runtime_bundle_registered_file_missing')
  }

  for (const file of manifest.files) {
    const absolutePath = resolve(root, ...file.path.split('/'))
    const metadata = await lstat(absolutePath)
    const bytes = await readFile(absolutePath)
    const mode = `0${(metadata.mode & 0o777).toString(8)}`
    if (
      metadata.size !== file.size ||
      sha256(bytes) !== file.sha256 ||
      (file.mode !== undefined && file.mode !== mode)
    ) {
      fail('runtime_bundle_file_mismatch')
    }
  }

  if (target.platform !== 'win32') {
    const executable = await lstat(resolve(root, ...manifest.executable.split('/')))
    if ((executable.mode & 0o111) === 0) fail('runtime_bundle_executable_mode_invalid')
  }

  const notices = await readFile(resolve(root, 'THIRD-PARTY-NOTICES.txt'))
  if (sha256(notices) !== manifest.noticesSha256) fail('runtime_bundle_notices_mismatch')

  return Object.freeze({
    kind: 'verified-pi-runtime-bundle' as const,
    root,
    executablePath: resolve(root, ...manifest.executable.split('/')),
    entryPath: resolve(root, ...manifest.entry.split('/')),
    capabilitySmokeEntryPath: resolve(root, ...CAPABILITY_SMOKE_ENTRY_RELATIVE_PATH.split('/')),
    ...(target.platform === 'win32'
      ? {
          windowsJobLauncherPath: resolve(root, ...WINDOWS_JOB_LAUNCHER_RELATIVE_PATH.split('/')),
          windowsNativeAddonPath: resolve(root, ...WINDOWS_NATIVE_ADDON_RELATIVE_PATH.split('/')),
        }
      : {}),
    manifest: freezeManifest(manifest),
    manifestSha256: sha256(manifestBytes),
  })
}

export async function runPiRuntimeBundleVerifierCli(
  args: readonly string[],
  io: RuntimeBundleVerifierIo,
): Promise<number> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      io.stderr('runtime_bundle_arguments_invalid')
      return 1
    }
    values.set(name, value)
  }

  const bundle = values.get('--bundle')
  const platform = values.get('--platform')
  const arch = values.get('--arch')
  if (
    bundle === undefined ||
    !['darwin', 'win32', 'linux'].includes(platform ?? '') ||
    !['arm64', 'x64'].includes(arch ?? '')
  ) {
    io.stderr('runtime_bundle_arguments_invalid')
    return 1
  }

  try {
    const verified = await verifyPiRuntimeBundle(bundle, {
      platform: platform as RuntimeBundleManifest['platform'],
      arch: arch as RuntimeBundleManifest['arch'],
    })
    io.stdout(
      JSON.stringify({
        status: 'passed',
        runtimeVersion: verified.manifest.runtimeVersion,
        protocolVersion: verified.manifest.protocolVersion,
        platform: verified.manifest.platform,
        arch: verified.manifest.arch,
        manifestSha256: verified.manifestSha256,
      }),
    )
    return 0
  } catch (error) {
    io.stderr(
      error instanceof RuntimeBundleVerificationError
        ? error.code
        : 'runtime_bundle_verification_failed',
    )
    return 1
  }
}
