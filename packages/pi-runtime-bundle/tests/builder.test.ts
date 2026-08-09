import { execFile } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { NODE_VERSION } from '@genoffice/agent-runtime-protocol'
import {
  PiRuntimeBundleBuildError,
  buildPiRuntimeBundle,
  runPiRuntimeBundleBuilderCli,
} from '../src/builder'

const execFileAsync = promisify(execFile)

function hostTarget() {
  return {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    arch: process.arch as 'arm64' | 'x64',
  }
}

async function inputs() {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-builder-test-'))
  const noticesPath = join(root, 'THIRD-PARTY-NOTICES.txt')
  await writeFile(noticesPath, 'builder fixture notices\n')
  return {
    outputDirectory: join(root, 'bundle'),
    nodeExecutable: process.execPath,
    nodeLicense: resolve(dirname(process.execPath), '../LICENSE'),
    entryPoint: resolve(import.meta.dirname, '../../../apps/pi-agent-runtime/src/main.ts'),
    capabilitySmokeEntryPoint: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-capability-smoke.ts',
    ),
    capabilityExtension: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-smoke-extension.mjs',
    ),
    mcpSmokeServer: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/mcp-stdio-server.mjs',
    ),
    lockfile: resolve(import.meta.dirname, '../../../package-lock.json'),
    notices: noticesPath,
    windowsJobLauncher: process.env.GENOFFICE_WINDOWS_JOB_LAUNCHER ?? process.execPath,
    windowsNativeAddon: resolve(
      import.meta.dirname,
      '../../../node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node',
    ),
    ...hostTarget(),
  }
}

describe('Pi Runtime bundle builder', () => {
  it('atomically builds and verifies a fully copied host Runtime', async () => {
    const options = await inputs()
    const verified = await buildPiRuntimeBundle(options)
    expect(verified.root).toBe(options.outputDirectory)
    expect(verified.manifest.nodeVersion).toBe(NODE_VERSION)
    expect(verified.manifest.files.map((file) => file.path)).toEqual([
      'LICENSE.node.txt',
      'THIRD-PARTY-NOTICES.txt',
      'app/main.mjs',
      ...(process.platform === 'win32' ? ['native/win32-x64/win32-console-mode.node'] : []),
      ...(process.platform === 'win32' ? ['node/open-genoffice-job-launcher.exe'] : []),
      `node/open-genoffice-pi-agent-runtime${process.platform === 'win32' ? '.exe' : ''}`,
      'self-test/mcp-stdio-server.mjs',
      'self-test/native-capability-smoke.mjs',
      'self-test/native-smoke-extension.mjs',
    ])
    expect((await lstat(verified.executablePath)).isSymbolicLink()).toBe(false)
    expect((await lstat(verified.executablePath)).ino).not.toBe((await lstat(process.execPath)).ino)
    const entry = await readFile(verified.entryPath, 'utf8')
    expect(entry).toContain('runtime_crash')
    expect(entry).toContain('const require = __genofficeCreateRequire(import.meta.url)')
    expect(verified.capabilitySmokeEntryPath).toBe(
      join(options.outputDirectory, 'self-test/native-capability-smoke.mjs'),
    )
    const capabilitySmoke = await execFileAsync(verified.executablePath, [
      verified.capabilitySmokeEntryPath,
    ])
    expect(capabilitySmoke.stderr).toBe('')
    expect(JSON.parse(capabilitySmoke.stdout)).toMatchObject({
      status: 'passed',
      piEsm: true,
      extension: 'native_smoke_extension',
      nativeAddon: process.platform === 'win32' ? 'win32-console-mode.node' : null,
      mcp: { tool: 'native_smoke_echo', result: 'mcp:windows-native' },
    })

    await expect(buildPiRuntimeBundle(options)).rejects.toEqual(
      new PiRuntimeBundleBuildError('runtime_bundle_output_exists'),
    )
  })

  it('fails closed on a non-host target and invalid Node version', async () => {
    const targetMismatch = await inputs()
    targetMismatch.arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    await expect(buildPiRuntimeBundle(targetMismatch)).rejects.toThrowError(
      'runtime_bundle_host_target_mismatch',
    )

    if (process.platform !== 'win32') {
      const invalidNode = await inputs()
      const fakeNode = join(dirname(invalidNode.notices), 'fake-node')
      await writeFile(fakeNode, '#!/bin/sh\necho v0.0.0\n')
      await chmod(fakeNode, 0o755)
      invalidNode.nodeExecutable = fakeNode
      await expect(buildPiRuntimeBundle(invalidNode)).rejects.toThrowError(
        'runtime_bundle_node_invalid',
      )
    }

    const nonExecutableNode = await inputs()
    nonExecutableNode.nodeExecutable = nonExecutableNode.notices
    await expect(buildPiRuntimeBundle(nonExecutableNode)).rejects.toThrowError(
      'runtime_bundle_node_invalid',
    )

    const buildFailure = await inputs()
    buildFailure.entryPoint = join(dirname(buildFailure.notices), 'missing-entry.ts')
    await expect(buildPiRuntimeBundle(buildFailure)).rejects.toThrowError(
      'runtime_bundle_build_failed',
    )
    await expect(stat(buildFailure.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires the Job Object launcher for every Windows bundle', async () => {
    const actualPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const options = (await inputs()) as import('../src/builder').PiRuntimeBundleBuildOptions
      options.platform = 'win32'
      delete options.windowsJobLauncher
      await expect(buildPiRuntimeBundle(options)).rejects.toThrowError(
        'runtime_bundle_windows_job_launcher_missing',
      )

      const missingAddon = (await inputs()) as import('../src/builder').PiRuntimeBundleBuildOptions
      missingAddon.platform = 'win32'
      delete missingAddon.windowsNativeAddon
      await expect(buildPiRuntimeBundle(missingAddon)).rejects.toThrowError(
        'runtime_bundle_windows_native_addon_missing',
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: actualPlatform })
    }
  })

  it('emits the frozen Windows and Linux manifest layouts', async () => {
    const actualPlatform = process.platform
    for (const platform of ['win32', 'linux'] as const) {
      if (platform === actualPlatform) continue
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      try {
        const options = await inputs()
        options.platform = platform
        const verified = await buildPiRuntimeBundle(options)
        expect(
          verified.manifest.executable.endsWith(platform === 'win32' ? '.exe' : 'runtime'),
        ).toBe(true)
        expect(verified.manifest.libc).toBe(platform === 'linux' ? 'glibc' : undefined)
        expect(verified.manifest.files.every((file) => platform !== 'win32' || !file.mode)).toBe(
          true,
        )
      } finally {
        Object.defineProperty(process, 'platform', {
          configurable: true,
          value: actualPlatform,
        })
      }
    }
  })

  it('exposes a path-free machine CLI contract', async () => {
    const options = await inputs()
    const stdout: string[] = []
    const stderr: string[] = []
    const args = [
      '--output',
      options.outputDirectory,
      '--node-executable',
      options.nodeExecutable,
      '--node-license',
      options.nodeLicense,
      '--entry',
      options.entryPoint,
      '--capability-smoke-entry',
      options.capabilitySmokeEntryPoint,
      '--capability-extension',
      options.capabilityExtension,
      '--mcp-smoke-server',
      options.mcpSmokeServer,
      '--lockfile',
      options.lockfile,
      '--notices',
      options.notices,
      '--platform',
      options.platform,
      '--arch',
      options.arch,
      ...(options.platform === 'win32'
        ? [
            '--windows-job-launcher',
            options.windowsJobLauncher,
            '--windows-native-addon',
            options.windowsNativeAddon,
          ]
        : []),
    ]
    await expect(
      runPiRuntimeBundleBuilderCli(args, {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(0)
    expect(JSON.parse(stdout[0]!)).toMatchObject({ status: 'passed', platform: options.platform })
    expect(stdout[0]).not.toContain(options.outputDirectory)
    expect(stderr).toEqual([])

    await expect(
      runPiRuntimeBundleBuilderCli(['--output'], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(1)
    expect(stderr.at(-1)).toBe('runtime_bundle_arguments_invalid')
    await expect(
      runPiRuntimeBundleBuilderCli(['--output', options.outputDirectory], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(1)
    expect(stderr.at(-1)).toBe('runtime_bundle_arguments_invalid')

    await expect(
      runPiRuntimeBundleBuilderCli(args, {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(1)
    expect(stderr.at(-1)).toBe('runtime_bundle_output_exists')

    const actualPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      get: () => {
        throw new Error('private platform detail')
      },
    })
    try {
      await expect(
        runPiRuntimeBundleBuilderCli(args, {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
      ).resolves.toBe(1)
      expect(stderr.at(-1)).toBe('runtime_bundle_build_failed')
      expect(JSON.stringify(stderr)).not.toContain('private platform detail')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: actualPlatform,
      })
    }
  })

  it('loads through the repository builder entrypoint', async () => {
    const repoRoot = resolve(import.meta.dirname, '../../..')
    await expect(
      execFileAsync(process.execPath, ['tools/build-pi-runtime-bundle.mjs', '--output'], {
        cwd: repoRoot,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: 'runtime_bundle_arguments_invalid\n',
    })
  })
})
