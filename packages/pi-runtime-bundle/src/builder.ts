import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import {
  NODE_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  type RuntimeBundleManifest,
} from '@genoffice/agent-runtime-protocol'
import {
  canonicalRuntimeTreeHash,
  WINDOWS_JOB_LAUNCHER_RELATIVE_PATH,
  verifyPiRuntimeBundle,
  type RuntimeBundleVerifierIo,
  type VerifiedPiRuntimeBundle,
} from './index.ts'

const execFileAsync = promisify(execFile)

export class PiRuntimeBundleBuildError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PiRuntimeBundleBuildError'
    this.code = code
  }
}

export type PiRuntimeBundleBuildOptions = {
  outputDirectory: string
  nodeExecutable: string
  nodeLicense: string
  entryPoint: string
  lockfile: string
  notices: string
  platform: RuntimeBundleManifest['platform']
  arch: RuntimeBundleManifest['arch']
  windowsJobLauncher?: string
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fail(code: string): never {
  throw new PiRuntimeBundleBuildError(code)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function verifyNodeExecutable(path: string) {
  try {
    const { stdout } = await execFileAsync(path, ['--version'])
    if (stdout.trim() !== `v${NODE_VERSION}`) fail('runtime_bundle_node_invalid')
  } catch (error) {
    if (error instanceof PiRuntimeBundleBuildError) throw error
    fail('runtime_bundle_node_invalid')
  }
}

async function fileRecord(
  root: string,
  path: string,
): Promise<RuntimeBundleManifest['files'][number]> {
  const absolutePath = join(root, ...path.split('/'))
  const [metadata, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)])
  return {
    path,
    sha256: sha256(bytes),
    size: metadata.size,
    ...(process.platform === 'win32' ? {} : { mode: `0${(metadata.mode & 0o777).toString(8)}` }),
  }
}

export async function buildPiRuntimeBundle(
  options: PiRuntimeBundleBuildOptions,
): Promise<VerifiedPiRuntimeBundle> {
  if (options.platform !== process.platform || options.arch !== process.arch) {
    fail('runtime_bundle_host_target_mismatch')
  }
  if (options.platform === 'win32' && !options.windowsJobLauncher) {
    fail('runtime_bundle_windows_job_launcher_missing')
  }

  const outputDirectory = resolve(options.outputDirectory)
  if (await pathExists(outputDirectory)) fail('runtime_bundle_output_exists')
  await verifyNodeExecutable(options.nodeExecutable)
  await mkdir(dirname(outputDirectory), { recursive: true })
  const stagingDirectory = await mkdtemp(`${outputDirectory}.building-`)

  try {
    const executableName =
      process.platform === 'win32'
        ? 'open-genoffice-pi-agent-runtime.exe'
        : 'open-genoffice-pi-agent-runtime'
    const executablePath = `node/${executableName}`
    await mkdir(join(stagingDirectory, 'node'), { recursive: true })
    await mkdir(join(stagingDirectory, 'app'), { recursive: true })
    await mkdir(join(stagingDirectory, 'built-in/skills'), { recursive: true })
    await mkdir(join(stagingDirectory, 'built-in/extensions'), { recursive: true })
    await mkdir(join(stagingDirectory, 'built-in/prompts'), { recursive: true })
    await copyFile(
      options.nodeExecutable,
      join(stagingDirectory, executablePath),
      process.platform === 'win32' ? 0 : constants.COPYFILE_FICLONE,
    )
    if (options.platform === 'win32') {
      await copyFile(
        options.windowsJobLauncher!,
        join(stagingDirectory, WINDOWS_JOB_LAUNCHER_RELATIVE_PATH),
        0,
      )
    }
    if (process.platform !== 'win32') {
      const executable = join(stagingDirectory, executablePath)
      const metadata = await stat(executable)
      await chmod(executable, metadata.mode | 0o755)
    }
    await build({
      entryPoints: [options.entryPoint],
      outfile: join(stagingDirectory, 'app/main.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'bundle',
      legalComments: 'none',
      sourcemap: false,
      minify: false,
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as __genofficeCreateRequire } from 'node:module'; const require = __genofficeCreateRequire(import.meta.url);",
      },
    })
    await Promise.all([
      copyFile(options.nodeLicense, join(stagingDirectory, 'LICENSE.node.txt')),
      copyFile(options.notices, join(stagingDirectory, 'THIRD-PARTY-NOTICES.txt')),
    ])

    const paths = [
      'LICENSE.node.txt',
      'THIRD-PARTY-NOTICES.txt',
      'app/main.mjs',
      executablePath,
      ...(options.platform === 'win32' ? [WINDOWS_JOB_LAUNCHER_RELATIVE_PATH] : []),
    ].sort()
    const files = await Promise.all(paths.map((path) => fileRecord(stagingDirectory, path)))
    const [notices, lockfile] = await Promise.all([
      readFile(join(stagingDirectory, 'THIRD-PARTY-NOTICES.txt')),
      readFile(options.lockfile),
    ])
    const manifest: RuntimeBundleManifest = {
      manifestVersion: 1,
      runtimeName: RUNTIME_NAME,
      runtimeVersion: RUNTIME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      nodeVersion: NODE_VERSION,
      piVersion: PI_VERSION,
      platform: options.platform,
      arch: options.arch,
      ...(options.platform === 'linux' ? { libc: 'glibc' as const } : {}),
      executable: executablePath,
      entry: 'app/main.mjs',
      treeSha256: canonicalRuntimeTreeHash(files),
      files,
      noticesSha256: sha256(notices),
      generatedFromLockSha256: sha256(lockfile),
    }
    await writeFile(
      join(stagingDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    await verifyPiRuntimeBundle(stagingDirectory, {
      platform: options.platform,
      arch: options.arch,
    })
    await rename(stagingDirectory, outputDirectory)
    return verifyPiRuntimeBundle(outputDirectory, {
      platform: options.platform,
      arch: options.arch,
    })
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw new PiRuntimeBundleBuildError('runtime_bundle_build_failed')
  }
}

export async function runPiRuntimeBundleBuilderCli(
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

  const required = [
    '--output',
    '--node-executable',
    '--node-license',
    '--entry',
    '--lockfile',
    '--notices',
    '--platform',
    '--arch',
  ]
  if (values.get('--platform') === 'win32') required.push('--windows-job-launcher')
  if (required.some((name) => !values.has(name))) {
    io.stderr('runtime_bundle_arguments_invalid')
    return 1
  }

  try {
    const verified = await buildPiRuntimeBundle({
      outputDirectory: values.get('--output')!,
      nodeExecutable: values.get('--node-executable')!,
      nodeLicense: values.get('--node-license')!,
      entryPoint: values.get('--entry')!,
      lockfile: values.get('--lockfile')!,
      notices: values.get('--notices')!,
      platform: values.get('--platform') as RuntimeBundleManifest['platform'],
      arch: values.get('--arch') as RuntimeBundleManifest['arch'],
      windowsJobLauncher: values.get('--windows-job-launcher'),
    })
    io.stdout(
      JSON.stringify({
        status: 'passed',
        runtimeVersion: verified.manifest.runtimeVersion,
        platform: verified.manifest.platform,
        arch: verified.manifest.arch,
        manifestSha256: verified.manifestSha256,
      }),
    )
    return 0
  } catch (error) {
    io.stderr(
      error instanceof PiRuntimeBundleBuildError ? error.code : 'runtime_bundle_build_failed',
    )
    return 1
  }
}
