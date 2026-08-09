import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import baseline from '../fixtures/genspark-legacy-baseline.json' with { type: 'json' }
import { auditGensparkProduction, scanGensparkProduction } from '../src/genspark-audit.mjs'

describe('Genspark production audit', () => {
  it('allows only a shrinking subset of the hashed legacy baseline', async () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname
    const report = await auditGensparkProduction(repoRoot, { mode: 'baseline', baseline })
    expect(report.status).toBe('passed')
    expect(report.totalOccurrences).toBeGreaterThan(0)
    expect(report.violations).toEqual([])
  })

  it('shows that zero mode remains closed until G8 removes every occurrence', async () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname
    const report = await auditGensparkProduction(repoRoot, { mode: 'zero' })
    expect(report.status).toBe('failed')
    expect(report.violations[0].code).toBe('genspark_occurrence_remaining')
  })

  it('rejects a new production occurrence even when its category already exists', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-genspark-audit-'))
    await mkdir(join(repoRoot, 'apps/demo/src'), { recursive: true })
    await writeFile(
      join(repoRoot, 'apps/demo/src/index.ts'),
      "export const endpoint = 'genspark.example'",
    )
    await writeFile(join(repoRoot, 'apps/demo/src/ignored.bin'), 'genspark')

    const scan = await scanGensparkProduction(repoRoot)
    expect(scan.files).toHaveLength(1)
    const report = await auditGensparkProduction(repoRoot, {
      mode: 'baseline',
      baseline: { schemaVersion: 1, files: [] },
    })
    expect(report.status).toBe('failed')
    expect(report.violations[0]).toMatchObject({
      code: 'genspark_legacy_growth',
      file: 'apps/demo/src/index.ts',
    })
  })

  it('passes zero mode for a clean production tree', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-genspark-clean-'))
    await mkdir(join(repoRoot, 'packages/clean/src'), { recursive: true })
    await writeFile(join(repoRoot, 'packages/clean/src/index.ts'), 'export const clean = true')
    await expect(auditGensparkProduction(repoRoot, { mode: 'zero' })).resolves.toMatchObject({
      status: 'passed',
      totalOccurrences: 0,
    })
  })

  it('fails closed for an invalid audit mode or unreadable production candidate', async () => {
    const cleanRoot = await mkdtemp(join(tmpdir(), 'genoffice-genspark-invalid-mode-'))
    await expect(
      auditGensparkProduction(cleanRoot, { mode: 'unexpected', baseline: { schemaVersion: 1 } }),
    ).resolves.toMatchObject({
      status: 'failed',
      violations: [{ code: 'genspark_audit_mode_invalid', file: '.' }],
    })

    const unreadableRoot = await mkdtemp(join(tmpdir(), 'genoffice-genspark-unreadable-'))
    await mkdir(join(unreadableRoot, 'package.json'))
    await expect(scanGensparkProduction(unreadableRoot)).rejects.toMatchObject({ code: 'EISDIR' })

    const invalidTreeRoot = await mkdtemp(join(tmpdir(), 'genoffice-genspark-invalid-tree-'))
    await writeFile(join(invalidTreeRoot, 'apps'), 'not-a-directory')
    await expect(scanGensparkProduction(invalidTreeRoot)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
