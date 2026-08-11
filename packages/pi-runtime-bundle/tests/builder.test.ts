import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
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
    nodeLicense: resolve(
      dirname(process.execPath),
      process.execPath.toLowerCase().endsWith('.exe') ? 'LICENSE' : '../LICENSE',
    ),
    entryPoint: resolve(import.meta.dirname, '../../../apps/pi-agent-runtime/src/main.ts'),
    capabilitySmokeEntryPoint: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-capability-smoke.ts',
    ),
    networkSmokeEntryPoint: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-network-smoke.ts',
    ),
    subagentSmokeEntryPoint: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-subagent-smoke.ts',
    ),
    capabilityExtension: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/native-smoke-extension.mjs',
    ),
    mcpSmokeServer: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/mcp-stdio-server.mjs',
    ),
    piHeadlessFixture: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/fixtures/pi-headless-fixture',
    ),
    piCliEntryPoint: resolve(
      import.meta.dirname,
      '../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    ),
    piSubagentApiEntryPoint: resolve(
      import.meta.dirname,
      '../../../node_modules/@agwab/pi-subagent/src/api.ts',
    ),
    piSubagentWorkerEntryPoint: resolve(
      import.meta.dirname,
      '../../../node_modules/@agwab/pi-subagent/src/workers/durable-worker.mjs',
    ),
    builtInSkillsDirectory: resolve(
      import.meta.dirname,
      '../../../apps/pi-agent-runtime/built-in/skills',
    ),
    lockfile: resolve(import.meta.dirname, '../../../package-lock.json'),
    notices: noticesPath,
    windowsJobLauncher: process.env.GENOFFICE_WINDOWS_JOB_LAUNCHER ?? process.execPath,
    windowsPiLauncher: process.env.GENOFFICE_WINDOWS_PI_LAUNCHER ?? process.execPath,
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
      'app/package.json',
      'app/pi-cli.mjs',
      'built-in/skills/open-genoffice-sheets-workbook/SKILL.md',
      'built-in/skills/open-genoffice-sheets-workbook/agents/openai.yaml',
      'built-in/skills/open-genoffice-sheets-workbook/references/charts.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/data-attribution.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/data.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/financial-formatting.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/formatting.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/layout.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/pivot.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/shape-image.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/structure.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/table.md',
      'built-in/skills/open-genoffice-sheets-workbook/references/writing.md',
      'built-in/skills/open-genoffice-slides-authoring/SKILL.md',
      'built-in/skills/open-genoffice-slides-authoring/agents/openai.yaml',
      ...(process.platform === 'win32' ? ['native/win32-x64/win32-console-mode.node'] : []),
      ...(process.platform === 'win32' ? ['node/open-genoffice-job-launcher.exe'] : []),
      `node/open-genoffice-pi-agent-runtime${process.platform === 'win32' ? '.exe' : ''}`,
      `node/open-genoffice-pi-cli${process.platform === 'win32' ? '.exe' : ''}`,
      `node/open-genoffice-pi-smoke${process.platform === 'win32' ? '.exe' : ''}`,
      `node/pi${process.platform === 'win32' ? '.exe' : ''}`,
      'self-test/mcp-stdio-server.mjs',
      'self-test/native-capability-smoke.mjs',
      'self-test/native-network-smoke.mjs',
      'self-test/native-smoke-extension.mjs',
      'self-test/native-subagent-smoke.mjs',
      'self-test/pi-headless-fixture.mjs',
      'workers/durable-worker.mjs',
    ])
    const copiedNode = await lstat(verified.executablePath)
    expect(copiedNode.isSymbolicLink()).toBe(false)
    expect(copiedNode.nlink).toBe(1)
    if (process.platform !== 'win32') {
      expect(copiedNode.ino).not.toBe((await lstat(process.execPath)).ino)
    }
    const entry = await readFile(verified.entryPath, 'utf8')
    expect(entry).toContain('runtime_crash')
    expect(entry).toContain('const require = __genofficeCreateRequire(import.meta.url)')
    if (process.platform === 'linux') {
      expect((await lstat(verified.entryPath)).mode & 0o777).toBe(0o755)
    }
    expect(
      JSON.parse(await readFile(join(options.outputDirectory, 'app/package.json'), 'utf8')),
    ).toMatchObject({
      name: '@earendil-works/pi-coding-agent',
      version: '0.84.0',
      type: 'module',
      private: true,
    })
    const piVersion = await execFileAsync(
      join(
        options.outputDirectory,
        `node/open-genoffice-pi-cli${process.platform === 'win32' ? '.exe' : ''}`,
      ),
      ['--version'],
    )
    expect(piVersion.stdout.trim()).toBe('0.84.0')
    expect(piVersion.stderr).toBe('')
    expect(
      await readFile(
        join(options.outputDirectory, 'built-in/skills/open-genoffice-sheets-workbook/SKILL.md'),
        'utf8',
      ),
    ).toContain('propose_operations')
    expect(
      await readFile(
        join(options.outputDirectory, 'built-in/skills/open-genoffice-slides-authoring/SKILL.md'),
        'utf8',
      ),
    ).toContain('commit_slide_page')
    expect(verified.capabilitySmokeEntryPath).toBe(
      join(options.outputDirectory, 'self-test/native-capability-smoke.mjs'),
    )
    expect(verified.networkSmokeEntryPath).toBe(
      join(options.outputDirectory, 'self-test/native-network-smoke.mjs'),
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
    const networkSmoke = await execFileAsync(verified.executablePath, [
      verified.networkSmokeEntryPath,
    ])
    expect(networkSmoke.stderr).toBe('')
    expect(JSON.parse(networkSmoke.stdout)).toMatchObject({
      status: 'passed',
      routes: [
        { surface: 'ocr', mode: 'fetch-intercepted', hosts: ['mineru.net'] },
        { surface: 'search', mode: 'fetch-intercepted', hosts: ['google.serper.dev'] },
        { surface: 'image', mode: 'fetch-intercepted' },
        { surface: 'media', mode: 'local-only', hosts: [] },
        { surface: 'slide', mode: 'local-only', hosts: [] },
        { surface: 'project', mode: 'local-only', hosts: [] },
      ],
    })
    const subagentSmoke = await execFileAsync(verified.executablePath, [
      join(options.outputDirectory, 'self-test/native-subagent-smoke.mjs'),
    ])
    expect(subagentSmoke.stderr).toBe('')
    expect(JSON.parse(subagentSmoke.stdout)).toMatchObject({
      status: 'passed',
      backend: 'headless',
      result: 'fixture child completed',
      reconciled: 'completed',
    })

    await expect(buildPiRuntimeBundle(options)).rejects.toEqual(
      new PiRuntimeBundleBuildError('runtime_bundle_output_exists'),
    )
  }, 30_000)

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

    const invalidSubagentImport = await inputs()
    invalidSubagentImport.entryPoint = join(
      dirname(invalidSubagentImport.notices),
      'pi-subagent-engine.ts',
    )
    await writeFile(invalidSubagentImport.entryPoint, 'export {}\n')
    await expect(buildPiRuntimeBundle(invalidSubagentImport)).rejects.toThrowError(
      'runtime_bundle_build_failed',
    )
  })

  it('supports an empty built-in set and rejects non-file Skill entries', async () => {
    const { builtInSkillsDirectory: _builtInSkillsDirectory, ...empty } = await inputs()
    const verified = await buildPiRuntimeBundle(empty)
    expect(verified.manifest.files.some((file) => file.path.startsWith('built-in/'))).toBe(false)

    const invalid = await inputs()
    const skills = await mkdtemp(join(tmpdir(), 'pi-runtime-invalid-skill-'))
    const skill = join(skills, 'invalid-skill')
    await mkdir(skill)
    await symlink(invalid.notices, join(skill, 'SKILL.md'))
    invalid.builtInSkillsDirectory = skills
    await expect(buildPiRuntimeBundle(invalid)).rejects.toThrowError('runtime_bundle_build_failed')
  }, 30_000)

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

      const missingPiLauncher =
        (await inputs()) as import('../src/builder').PiRuntimeBundleBuildOptions
      missingPiLauncher.platform = 'win32'
      delete missingPiLauncher.windowsPiLauncher
      await expect(buildPiRuntimeBundle(missingPiLauncher)).rejects.toThrowError(
        'runtime_bundle_windows_pi_launcher_missing',
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
    const representablePlatforms =
      actualPlatform === 'win32' ? (['win32'] as const) : (['win32', 'linux'] as const)
    for (const platform of representablePlatforms) {
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
  }, 30_000)

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
      '--network-smoke-entry',
      options.networkSmokeEntryPoint,
      '--subagent-smoke-entry',
      options.subagentSmokeEntryPoint,
      '--capability-extension',
      options.capabilityExtension,
      '--mcp-smoke-server',
      options.mcpSmokeServer,
      '--pi-headless-fixture',
      options.piHeadlessFixture,
      '--pi-cli-entry',
      options.piCliEntryPoint,
      '--pi-subagent-api-entry',
      options.piSubagentApiEntryPoint,
      '--pi-subagent-worker-entry',
      options.piSubagentWorkerEntryPoint,
      '--built-in-skills',
      options.builtInSkillsDirectory,
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
            '--windows-pi-launcher',
            options.windowsPiLauncher,
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
  }, 30_000)

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
