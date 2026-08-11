import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NODE_VERSION } from '@genoffice/agent-runtime-protocol'
import {
  OFFICIAL_NODE_DISTRIBUTIONS,
  OfficialNodeDistributionError,
  acquireOfficialNodeDistribution,
  acquireOfficialNodeDistributionWithDependencies,
  extractOfficialNodeArchive,
  officialNodeArchiveSha256,
  officialNodeTarExecutable,
  officialNodeVersion,
  runOfficialNodeDistributionCli,
  type AcquireOfficialNodeDistributionDependencies,
} from '../src/node-distribution'

const target = { platform: 'darwin' as const, arch: 'arm64' as const }
const selected = OFFICIAL_NODE_DISTRIBUTIONS['darwin-arm64']

async function destination(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'official-node-test-')), 'node-distribution')
}

function dependencies(
  overrides: Partial<AcquireOfficialNodeDistributionDependencies> = {},
): AcquireOfficialNodeDistributionDependencies {
  return {
    fetchImpl: vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    })),
    hashArchive: () => selected.sha256,
    extractArchive: async (_archive, staging) => {
      const root = join(staging, selected.directory)
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(join(root, selected.executable), 'official node fixture\n')
      await writeFile(join(root, selected.license), 'Node.js fixture license\n')
    },
    executeNode: async () => `v${NODE_VERSION}\n`,
    ...overrides,
  }
}

describe('official Node distribution acquisition', () => {
  it('pins the three supported release archives to exact official hashes', () => {
    expect(OFFICIAL_NODE_DISTRIBUTIONS).toEqual({
      'darwin-arm64': expect.objectContaining({
        archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
        sha256: 'c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d',
      }),
      'win32-x64': expect.objectContaining({
        archive: `node-v${NODE_VERSION}-win-x64.zip`,
        sha256: 'ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86',
      }),
      'linux-x64': expect.objectContaining({
        archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
        sha256: 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2',
      }),
    })
  })

  it('uses the Windows system libarchive instead of Git Bash GNU tar for ZIP archives', () => {
    expect(officialNodeTarExecutable('win32', String.raw`D:\Windows`)).toBe(
      join(String.raw`D:\Windows`, 'System32', 'tar.exe'),
    )
    expect(officialNodeTarExecutable('win32', '')).toBe(
      join(String.raw`C:\Windows`, 'System32', 'tar.exe'),
    )
    expect(officialNodeTarExecutable('linux')).toBe('tar')
    expect(officialNodeTarExecutable('darwin')).toBe('tar')
  })

  it('downloads, verifies, extracts, version-checks, and atomically publishes one archive', async () => {
    const output = await destination()
    const deps = dependencies()
    const acquired = await acquireOfficialNodeDistributionWithDependencies(
      { outputDirectory: output, ...target },
      deps,
    )

    expect(deps.fetchImpl).toHaveBeenCalledWith(
      `https://nodejs.org/dist/v${NODE_VERSION}/${selected.archive}`,
    )
    expect(acquired).toEqual({
      root: output,
      executable: join(output, 'bin', 'node'),
      license: join(output, 'LICENSE'),
      archive: selected.archive,
      archiveSha256: selected.sha256,
    })
    expect(await readFile(acquired.license, 'utf8')).toContain('Node.js')
  })

  it('rejects unsupported targets and existing output before network access', async () => {
    await expect(
      acquireOfficialNodeDistributionWithDependencies(
        {
          outputDirectory: await destination(),
          platform: 'darwin',
          arch: 'x64',
        },
        dependencies(),
      ),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_target_unsupported'))

    const output = await destination()
    await mkdir(output)
    const deps = dependencies()
    await expect(
      acquireOfficialNodeDistributionWithDependencies({ outputDirectory: output, ...target }, deps),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_output_exists'))
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed on download errors, non-success responses, or hash drift', async () => {
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new Error('network detail')
      }),
      vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
    ]) {
      await expect(
        acquireOfficialNodeDistributionWithDependencies(
          { outputDirectory: await destination(), ...target },
          dependencies({ fetchImpl }),
        ),
      ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_download_failed'))
    }
    await expect(
      acquireOfficialNodeDistributionWithDependencies(
        { outputDirectory: await destination(), ...target },
        dependencies({ hashArchive: () => '0'.repeat(64) }),
      ),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_hash_mismatch'))
  })

  it('rejects incomplete extracted layouts and version drift without publishing output', async () => {
    const missingOutput = await destination()
    await expect(
      acquireOfficialNodeDistributionWithDependencies(
        { outputDirectory: missingOutput, ...target },
        dependencies({ extractArchive: async () => undefined }),
      ),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_layout_invalid'))
    await expect(access(missingOutput)).rejects.toMatchObject({ code: 'ENOENT' })

    const versionOutput = await destination()
    await expect(
      acquireOfficialNodeDistributionWithDependencies(
        { outputDirectory: versionOutput, ...target },
        dependencies({ executeNode: async () => 'v0.0.0\n' }),
      ),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_version_mismatch'))
    await expect(access(versionOutput)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('exposes a stable path-free CLI failure contract', async () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    await expect(runOfficialNodeDistributionCli(['--output'], { stdout, stderr })).resolves.toBe(1)
    await expect(
      runOfficialNodeDistributionCli(['--output', 'missing-other-arguments'], { stdout, stderr }),
    ).resolves.toBe(1)
    await expect(
      runOfficialNodeDistributionCli(
        ['--output', 'unused', '--platform', 'darwin', '--arch', 'x64'],
        { stdout, stderr },
      ),
    ).resolves.toBe(1)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith('node_distribution_arguments_invalid')
    expect(stderr).toHaveBeenCalledWith('node_distribution_target_unsupported')
  })

  it('uses the production hash, executable probe, and stable extractor failure', async () => {
    expect(officialNodeArchiveSha256(Buffer.from('node archive'))).toMatch(/^[0-9a-f]{64}$/)
    await expect(officialNodeVersion(process.execPath)).resolves.toBe(`v${NODE_VERSION}\n`)
    const root = await mkdtemp(join(tmpdir(), 'official-node-invalid-archive-'))
    const archive = join(root, 'invalid.tar.xz')
    await writeFile(archive, 'not an archive')
    await expect(extractOfficialNodeArchive(archive, root)).rejects.toEqual(
      new OfficialNodeDistributionError('node_distribution_extract_failed'),
    )
    await expect(
      acquireOfficialNodeDistribution({
        outputDirectory: await destination(),
        platform: 'darwin',
        arch: 'x64',
      }),
    ).rejects.toEqual(new OfficialNodeDistributionError('node_distribution_target_unsupported'))
  })
})
