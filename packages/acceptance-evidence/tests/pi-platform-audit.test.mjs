import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditPiPlatformBoundary } from '../src/pi-platform-audit.mjs'

describe('Pi platform production boundary audit', () => {
  it('accepts the pinned root lockfile and secret-free new platform sources', async () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname
    const report = await auditPiPlatformBoundary(repoRoot)
    expect(report.status).toBe('passed')
    expect(report.lockfiles).toEqual(['package-lock.json'])
    expect(report.filesScanned).toBeGreaterThanOrEqual(2)
    expect(report.violations).toEqual([])
  })

  it('reports dependency, lockfile, Node, and source boundary violations together', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-platform-audit-'))
    await mkdir(join(repoRoot, 'apps/pi-agent-runtime/src'), { recursive: true })
    await mkdir(join(repoRoot, 'packages/agent-runtime-protocol/src'), { recursive: true })
    await mkdir(join(repoRoot, 'packages/pi-runtime-bundle/src'), { recursive: true })
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }))
    await writeFile(
      join(repoRoot, 'package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/@earendil-works/pi-ai': { version: '0.84.1' },
          'node_modules/pi-mcp-adapter': { version: '2.21.1' },
        },
      }),
    )
    await writeFile(join(repoRoot, 'apps/pi-agent-runtime/package-lock.json'), '{}')
    await writeFile(
      join(repoRoot, 'apps/pi-agent-runtime/package.json'),
      JSON.stringify({ dependencies: { '@genspark/cli': '1.4.2' } }),
    )
    await writeFile(
      join(repoRoot, 'apps/pi-agent-runtime/src/index.ts'),
      "fetch('https://www.genspark.ai'); class AgentLoop {}",
    )
    await writeFile(join(repoRoot, 'packages/agent-runtime-protocol/src/index.ts'), 'export {}')
    await writeFile(join(repoRoot, 'packages/pi-runtime-bundle/src/index.ts'), 'export {}')

    const report = await auditPiPlatformBoundary(repoRoot)
    expect(report.status).toBe('failed')
    expect(new Set(report.violations.map((violation) => violation.code))).toEqual(
      new Set([
        'forbidden_dependency',
        'multiple_lockfiles',
        'node_version_mismatch',
        'production_source_forbidden',
        'runtime_dependency_set_mismatch',
        'version_mismatch',
      ]),
    )
  })

  it('fails closed when dependency maps are absent', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-platform-empty-audit-'))
    await mkdir(join(repoRoot, 'apps/pi-agent-runtime/src'), { recursive: true })
    await mkdir(join(repoRoot, 'packages/agent-runtime-protocol/src'), { recursive: true })
    await mkdir(join(repoRoot, 'packages/pi-runtime-bundle/src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'package.json'),
      JSON.stringify({ engines: { node: '22.19.0' } }),
    )
    await writeFile(join(repoRoot, 'package-lock.json'), '{}')
    await writeFile(join(repoRoot, 'apps/pi-agent-runtime/package.json'), '{}')
    await writeFile(join(repoRoot, 'apps/pi-agent-runtime/src/index.ts'), 'export {}')
    await writeFile(join(repoRoot, 'packages/agent-runtime-protocol/src/index.ts'), 'export {}')
    await writeFile(join(repoRoot, 'packages/pi-runtime-bundle/src/index.ts'), 'export {}')

    const report = await auditPiPlatformBoundary(repoRoot)
    expect(report.status).toBe('failed')
    expect(report.violations.some((violation) => violation.code === 'version_mismatch')).toBe(true)
    expect(
      report.violations.some((violation) => violation.code === 'runtime_dependency_set_mismatch'),
    ).toBe(true)
  })
})
