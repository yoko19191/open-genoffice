import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
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
  RuntimeBundleVerificationError,
  runPiRuntimeBundleVerifierCli,
  verifyPiRuntimeBundle,
  type RuntimeBundleTarget,
} from '../src'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const execFileAsync = promisify(execFile)

async function fixtureBundle() {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-bundle-'))
  const fileContents = new Map([
    ['node/open-genoffice-pi-agent-runtime', '#!/bin/sh\n'],
    ...(process.platform === 'win32'
      ? ([['node/open-genoffice-job-launcher.exe', 'job launcher\n']] as const)
      : []),
    ['app/main.mjs', 'export {}\n'],
    ['self-test/mcp-stdio-server.mjs', 'export {}\n'],
    ['self-test/native-capability-smoke.mjs', 'export {}\n'],
    ['self-test/native-smoke-extension.mjs', 'export default () => {}\n'],
    ['THIRD-PARTY-NOTICES.txt', 'fixture notice\n'],
    ['LICENSE.node.txt', 'fixture license\n'],
    ...(process.platform === 'win32'
      ? ([['native/win32-x64/win32-console-mode.node', 'native addon\n']] as const)
      : []),
  ])
  for (const [path, contents] of fileContents) {
    const target = join(root, ...path.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
    await chmod(target, path.startsWith('node/') ? 0o755 : 0o644)
  }
  const files = [...fileContents]
    .map(([path, contents]) => ({
      path,
      sha256: hash(contents),
      size: Buffer.byteLength(contents),
      ...(process.platform === 'win32'
        ? {}
        : { mode: path.startsWith('node/') ? ('0755' as const) : ('0644' as const) }),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const manifest: RuntimeBundleManifest = {
    manifestVersion: 1,
    runtimeName: RUNTIME_NAME,
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: NODE_VERSION,
    piVersion: PI_VERSION,
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    arch: process.arch as 'arm64' | 'x64',
    ...(process.platform === 'linux' ? { libc: 'glibc' as const } : {}),
    executable: 'node/open-genoffice-pi-agent-runtime',
    entry: 'app/main.mjs',
    treeSha256: canonicalRuntimeTreeHash(files),
    files,
    noticesSha256: hash(fileContents.get('THIRD-PARTY-NOTICES.txt')!),
    generatedFromLockSha256: 'd'.repeat(64),
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { root, manifest }
}

async function writeManifest(root: string, manifest: RuntimeBundleManifest) {
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function refreshTreeHash(manifest: RuntimeBundleManifest) {
  manifest.treeSha256 = canonicalRuntimeTreeHash(manifest.files)
}

describe('installed Pi Runtime bundle verifier', () => {
  it('returns an immutable launch descriptor for an exact complete tree', async () => {
    const { root, manifest } = await fixtureBundle()
    const verified = await verifyPiRuntimeBundle(root, {
      platform: manifest.platform,
      arch: manifest.arch,
    })

    expect(verified).toMatchObject({
      kind: 'verified-pi-runtime-bundle',
      root,
      executablePath: join(root, 'node/open-genoffice-pi-agent-runtime'),
      entryPath: join(root, 'app/main.mjs'),
      manifest,
    })
    expect(Object.isFrozen(verified)).toBe(true)
    expect(verified.manifestSha256).toBe(hash(await readFile(join(root, 'manifest.json'))))
  })

  it.each([
    ['platform', { platform: process.platform === 'darwin' ? 'linux' : 'darwin' }],
    ['architecture', { arch: process.arch === 'arm64' ? 'x64' : 'arm64' }],
  ] satisfies Array<[string, Partial<RuntimeBundleTarget>]>)(
    'rejects a target %s mismatch',
    async (_name, override) => {
      const { root, manifest } = await fixtureBundle()
      const targetOverride: Partial<RuntimeBundleTarget> = override
      await expect(
        verifyPiRuntimeBundle(root, {
          platform: targetOverride.platform ?? manifest.platform,
          arch: targetOverride.arch ?? manifest.arch,
        }),
      ).rejects.toThrowError('runtime_bundle_target_mismatch')
    },
  )

  it.each([
    {
      name: 'changed bytes',
      mutate: async (root: string) => writeFile(join(root, 'app/main.mjs'), 'changed\n'),
      code: 'runtime_bundle_file_mismatch',
    },
    {
      name: 'an unregistered file',
      mutate: async (root: string) => writeFile(join(root, 'app/extra.mjs'), 'extra\n'),
      code: 'runtime_bundle_unregistered_file',
    },
    {
      name: 'a symlink',
      mutate: async (root: string) => symlink('main.mjs', join(root, 'app/link.mjs')),
      code: 'runtime_bundle_link_forbidden',
    },
    {
      name: 'a hardlink',
      mutate: async (root: string) =>
        link(join(root, 'app/main.mjs'), join(root, 'app/hardlink.mjs')),
      code: 'runtime_bundle_link_forbidden',
    },
  ])('rejects $name', async ({ mutate, code }) => {
    const { root, manifest } = await fixtureBundle()
    await mutate(root)
    await expect(
      verifyPiRuntimeBundle(root, { platform: manifest.platform, arch: manifest.arch }),
    ).rejects.toEqual(new RuntimeBundleVerificationError(code))
  })

  it('rejects unsafe, duplicate, unsorted, and missing launch paths before walking', async () => {
    for (const mutate of [
      (manifest: RuntimeBundleManifest) => {
        manifest.files[0]!.path = '../escape'
      },
      (manifest: RuntimeBundleManifest) => {
        manifest.files[1]!.path = manifest.files[0]!.path.toUpperCase()
      },
      (manifest: RuntimeBundleManifest) => {
        manifest.files.reverse()
      },
      (manifest: RuntimeBundleManifest) => {
        manifest.entry = 'app/missing.mjs'
      },
    ]) {
      const { root, manifest } = await fixtureBundle()
      mutate(manifest)
      await writeManifest(root, manifest)
      await expect(
        verifyPiRuntimeBundle(root, { platform: manifest.platform, arch: manifest.arch }),
      ).rejects.toThrowError(/^runtime_bundle_/)
    }
  })

  it('rejects case-folded duplicates and a missing notices registration', async () => {
    const duplicate = await fixtureBundle()
    duplicate.manifest.files[1]!.path = duplicate.manifest.files[0]!.path.toLowerCase()
    await writeManifest(duplicate.root, duplicate.manifest)
    await expect(
      verifyPiRuntimeBundle(duplicate.root, {
        platform: duplicate.manifest.platform,
        arch: duplicate.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_path_duplicate')

    const missingNotices = await fixtureBundle()
    missingNotices.manifest.files = missingNotices.manifest.files.filter(
      (file) => file.path !== 'THIRD-PARTY-NOTICES.txt',
    )
    await writeManifest(missingNotices.root, missingNotices.manifest)
    await expect(
      verifyPiRuntimeBundle(missingNotices.root, {
        platform: missingNotices.manifest.platform,
        arch: missingNotices.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_notices_missing')
  })

  it.each([
    'self-test/native-capability-smoke.mjs',
    'self-test/native-smoke-extension.mjs',
    'self-test/mcp-stdio-server.mjs',
  ])('rejects a bundle missing required self-test file %s', async (missingPath) => {
    const { root, manifest } = await fixtureBundle()
    manifest.files = manifest.files.filter((file) => file.path !== missingPath)
    refreshTreeHash(manifest)
    await writeManifest(root, manifest)
    await expect(
      verifyPiRuntimeBundle(root, { platform: manifest.platform, arch: manifest.arch }),
    ).rejects.toThrowError('runtime_bundle_self_test_missing')
  })

  it('rejects invalid roots, manifests, tree hashes, and missing registered files', async () => {
    const rootFile = join(await mkdtemp(join(tmpdir(), 'pi-runtime-root-file-')), 'bundle')
    await writeFile(rootFile, 'not a directory')
    await expect(
      verifyPiRuntimeBundle(rootFile, { platform: 'darwin', arch: 'arm64' }),
    ).rejects.toThrowError('runtime_bundle_root_invalid')
    await expect(
      verifyPiRuntimeBundle(`${rootFile}-missing`, { platform: 'darwin', arch: 'arm64' }),
    ).rejects.toThrowError('runtime_bundle_root_invalid')

    const invalidManifest = await fixtureBundle()
    await writeFile(join(invalidManifest.root, 'manifest.json'), '{}\n')
    await expect(
      verifyPiRuntimeBundle(invalidManifest.root, {
        platform: invalidManifest.manifest.platform,
        arch: invalidManifest.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_manifest_invalid')

    const badTree = await fixtureBundle()
    badTree.manifest.treeSha256 = 'e'.repeat(64)
    await writeManifest(badTree.root, badTree.manifest)
    await expect(
      verifyPiRuntimeBundle(badTree.root, {
        platform: badTree.manifest.platform,
        arch: badTree.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_tree_hash_mismatch')

    const missingFile = await fixtureBundle()
    await unlink(join(missingFile.root, 'app/main.mjs'))
    await expect(
      verifyPiRuntimeBundle(missingFile.root, {
        platform: missingFile.manifest.platform,
        arch: missingFile.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_registered_file_missing')
  })

  it('verifies size, hash, mode, executable permission, and notices independently', async () => {
    const cases: Array<{
      code: string
      mutate: (root: string, manifest: RuntimeBundleManifest) => Promise<void> | void
    }> = [
      {
        code: 'runtime_bundle_file_mismatch',
        mutate: (_root, manifest) => {
          manifest.files.find((file) => file.path === 'app/main.mjs')!.size += 1
          refreshTreeHash(manifest)
        },
      },
      {
        code: 'runtime_bundle_file_mismatch',
        mutate: async (root) => writeFile(join(root, 'app/main.mjs'), 'changed!!\n'),
      },
      ...(process.platform === 'win32'
        ? []
        : [
            {
              code: 'runtime_bundle_file_mismatch',
              mutate: (_root: string, manifest: RuntimeBundleManifest) => {
                manifest.files.find((file) => file.path === 'app/main.mjs')!.mode = '0600'
                refreshTreeHash(manifest)
              },
            },
            {
              code: 'runtime_bundle_executable_mode_invalid',
              mutate: async (root: string, manifest: RuntimeBundleManifest) => {
                const executable = manifest.files.find((file) => file.path === manifest.executable)!
                executable.mode = '0644'
                refreshTreeHash(manifest)
                await chmod(join(root, manifest.executable), 0o644)
              },
            },
          ]),
      {
        code: 'runtime_bundle_notices_mismatch',
        mutate: (_root, manifest) => {
          manifest.noticesSha256 = 'f'.repeat(64)
        },
      },
    ]

    for (const testCase of cases) {
      const { root, manifest } = await fixtureBundle()
      await testCase.mutate(root, manifest)
      await writeManifest(root, manifest)
      await expect(
        verifyPiRuntimeBundle(root, { platform: manifest.platform, arch: manifest.arch }),
      ).rejects.toThrowError(testCase.code)
    }
  })

  it('accepts a Windows target without POSIX modes and rejects missing Linux glibc', async () => {
    const missingLauncher = await fixtureBundle()
    missingLauncher.manifest.platform = 'win32'
    delete missingLauncher.manifest.libc
    missingLauncher.manifest.files = missingLauncher.manifest.files.filter(
      (file) => file.path !== 'node/open-genoffice-job-launcher.exe',
    )
    for (const file of missingLauncher.manifest.files) delete file.mode
    refreshTreeHash(missingLauncher.manifest)
    await writeManifest(missingLauncher.root, missingLauncher.manifest)
    await expect(
      verifyPiRuntimeBundle(missingLauncher.root, {
        platform: 'win32',
        arch: missingLauncher.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_windows_job_launcher_missing')

    const missingNativeAddon = await fixtureBundle()
    missingNativeAddon.manifest.platform = 'win32'
    delete missingNativeAddon.manifest.libc
    if (
      !missingNativeAddon.manifest.files.some(
        (file) => file.path === 'node/open-genoffice-job-launcher.exe',
      )
    ) {
      const contents = 'job launcher\n'
      const path = 'node/open-genoffice-job-launcher.exe'
      await writeFile(join(missingNativeAddon.root, path), contents)
      missingNativeAddon.manifest.files.push({
        path,
        sha256: hash(contents),
        size: Buffer.byteLength(contents),
      })
    }
    missingNativeAddon.manifest.files = missingNativeAddon.manifest.files.filter(
      (file) => file.path !== 'native/win32-x64/win32-console-mode.node',
    )
    missingNativeAddon.manifest.files.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    for (const file of missingNativeAddon.manifest.files) delete file.mode
    refreshTreeHash(missingNativeAddon.manifest)
    await writeManifest(missingNativeAddon.root, missingNativeAddon.manifest)
    await expect(
      verifyPiRuntimeBundle(missingNativeAddon.root, {
        platform: 'win32',
        arch: missingNativeAddon.manifest.arch,
      }),
    ).rejects.toThrowError('runtime_bundle_windows_native_addon_missing')

    const windows = await fixtureBundle()
    if (
      !windows.manifest.files.some((file) => file.path === 'node/open-genoffice-job-launcher.exe')
    ) {
      const contents = 'job launcher\n'
      const path = 'node/open-genoffice-job-launcher.exe'
      await writeFile(join(windows.root, path), contents)
      windows.manifest.files.push({
        path,
        sha256: hash(contents),
        size: Buffer.byteLength(contents),
      })
      windows.manifest.files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
    }
    if (
      !windows.manifest.files.some(
        (file) => file.path === 'native/win32-x64/win32-console-mode.node',
      )
    ) {
      const contents = 'native addon\n'
      const path = 'native/win32-x64/win32-console-mode.node'
      await mkdir(join(windows.root, 'native/win32-x64'), { recursive: true })
      await writeFile(join(windows.root, path), contents)
      windows.manifest.files.push({
        path,
        sha256: hash(contents),
        size: Buffer.byteLength(contents),
      })
      windows.manifest.files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
    }
    windows.manifest.platform = 'win32'
    delete windows.manifest.libc
    for (const file of windows.manifest.files) delete file.mode
    refreshTreeHash(windows.manifest)
    await writeManifest(windows.root, windows.manifest)
    await expect(
      verifyPiRuntimeBundle(windows.root, { platform: 'win32', arch: windows.manifest.arch }),
    ).resolves.toMatchObject({ kind: 'verified-pi-runtime-bundle' })

    const linux = await fixtureBundle()
    linux.manifest.platform = 'linux'
    delete linux.manifest.libc
    await writeManifest(linux.root, linux.manifest)
    await expect(
      verifyPiRuntimeBundle(linux.root, { platform: 'linux', arch: linux.manifest.arch }),
    ).rejects.toThrowError('runtime_bundle_target_mismatch')
  })

  it('provides a secret-free machine CLI result and fails closed on arguments or bundles', async () => {
    const { root, manifest } = await fixtureBundle()
    const stdout = vi.fn()
    const stderr = vi.fn()
    await expect(
      runPiRuntimeBundleVerifierCli(
        ['--bundle', root, '--platform', manifest.platform, '--arch', manifest.arch],
        { stdout, stderr },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
      status: 'passed',
      runtimeVersion: RUNTIME_VERSION,
      platform: manifest.platform,
      arch: manifest.arch,
    })
    expect(stdout.mock.calls[0]![0]).not.toContain(root)
    expect(stderr).not.toHaveBeenCalled()

    await expect(runPiRuntimeBundleVerifierCli(['--bundle'], { stdout, stderr })).resolves.toBe(1)
    expect(stderr).toHaveBeenLastCalledWith('runtime_bundle_arguments_invalid')
    await expect(
      runPiRuntimeBundleVerifierCli(
        ['bundle', root, '--platform', manifest.platform, '--arch', manifest.arch],
        { stdout, stderr },
      ),
    ).resolves.toBe(1)
    await expect(
      runPiRuntimeBundleVerifierCli(
        ['--bundle', root, '--platform', 'invalid', '--arch', manifest.arch],
        { stdout, stderr },
      ),
    ).resolves.toBe(1)

    await writeFile(join(root, 'app/main.mjs'), 'tampered\n')
    await expect(
      runPiRuntimeBundleVerifierCli(
        ['--bundle', root, '--platform', manifest.platform, '--arch', manifest.arch],
        { stdout, stderr },
      ),
    ).resolves.toBe(1)
    expect(stderr).toHaveBeenLastCalledWith('runtime_bundle_file_mismatch')
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(root)
  })

  it('runs through the repository verifier entrypoint', async () => {
    const { root, manifest } = await fixtureBundle()
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        'tools/verify-pi-runtime-bundle.mjs',
        '--bundle',
        root,
        '--platform',
        manifest.platform,
        '--arch',
        manifest.arch,
      ],
      { cwd: repoRoot },
    )
    expect(JSON.parse(stdout)).toMatchObject({ status: 'passed', platform: manifest.platform })
    expect(stdout).not.toContain(root)
    expect(stderr).toBe('')
  })
})
