import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSbom, npmSbomInvocation } from '../src/sbom.mjs'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CycloneDX SBOM generation', () => {
  it('runs the active npm CLI through Node so Windows does not spawn npm.cmd', () => {
    expect(
      npmSbomInvocation({ npmExecPath: '/npm/bin/npm-cli.js', execPath: '/bin/node' }),
    ).toEqual({
      executable: '/bin/node',
      args: ['/npm/bin/npm-cli.js', 'sbom', '--omit=dev', '--sbom-format=cyclonedx'],
    })
  })

  it('falls back to the host npm command outside npm run', () => {
    const invocation = npmSbomInvocation({ npmExecPath: '', execPath: '/bin/node' })
    expect(invocation.args).toEqual(['sbom', '--omit=dev', '--sbom-format=cyclonedx'])
    expect(invocation.executable).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm')
  })

  it('validates, completes, and writes the packaged SBOM', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-sbom-'))
    tempRoots.push(repoRoot)
    const output = join(repoRoot, 'nested', 'sbom.cdx.json')
    const execute = vi.fn(() =>
      JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] }),
    )

    expect(
      generateSbom({
        repoRoot,
        output,
        execute,
        npmExecPath: '/npm/bin/npm-cli.js',
        execPath: '/bin/node',
      }),
    ).toEqual({ status: 'passed', format: 'CycloneDX', specVersion: '1.5', components: 1 })
    expect(execute).toHaveBeenCalledWith(
      '/bin/node',
      ['/npm/bin/npm-cli.js', 'sbom', '--omit=dev', '--sbom-format=cyclonedx'],
      expect.objectContaining({ cwd: repoRoot, encoding: 'utf8' }),
    )
    const sbom = JSON.parse(await readFile(output, 'utf8'))
    expect(sbom.components).toEqual([expect.objectContaining({ name: 'node', version: '22.19.0' })])
  })

  it('preserves an npm-provided Node component and rejects malformed documents', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-sbom-'))
    tempRoots.push(repoRoot)
    const output = join(repoRoot, 'sbom.cdx.json')
    const existing = { name: 'node', version: '22.19.0' }
    const execute = vi.fn(() =>
      JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [existing] }),
    )
    generateSbom({ repoRoot, output, execute })
    expect(JSON.parse(await readFile(output, 'utf8')).components).toEqual([existing])

    for (const invalid of [null, {}, { bomFormat: 'CycloneDX', specVersion: '1.4' }]) {
      expect(() =>
        generateSbom({ repoRoot, output, execute: () => JSON.stringify(invalid) }),
      ).toThrow('sbom_generation_invalid')
    }
  })
})
