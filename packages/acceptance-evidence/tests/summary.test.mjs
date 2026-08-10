import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectAcceptanceEvidence,
  collectAcceptanceSummary,
  parseAcceptanceSummaryArgs,
  runAcceptanceSummaryCli,
} from '../../../tools/summarize-acceptance-evidence.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function rel(root, path) {
  return relative(root, path).split('\\').join('/')
}

function catalog() {
  return {
    schemaVersion: 1,
    sourceBaselineCommit: 'a'.repeat(40),
    entries: Array.from({ length: 63 }, (_, index) => ({
      app: ['docs', 'pdf', 'sheets', 'slides'][index % 4],
      legacyAlias: `legacy_${index}`,
      targetId: index < 46 ? `office:docs:tool_${index}` : null,
      effect: index % 3 === 0 ? 'mutation' : 'read',
      disposition: index < 46 ? 'office-executor' : index < 61 ? 'platform' : 'retired',
      sourceFile: `apps/docs/tool-${index}.ts`,
    })),
  }
}

function receipt(documentId, mutationOutcome = 'committed') {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    toolCallId: '22222222-2222-4222-8222-222222222222',
    toolId: 'office:docs:apply_commands',
    status: mutationOutcome === 'rolled_back' ? 'failed' : 'completed',
    output: '',
    contextVersionAfter: 'context-2',
    mutationOutcome,
    provenance: {
      actorId: '33333333-3333-4333-8333-333333333333',
      runId: '44444444-4444-4444-8444-444444444444',
      documentId,
    },
  }
}

async function createEvidence(root, name, { acceptanceIds, commit = 'b'.repeat(40) }) {
  const inputDir = join(root, 'inputs', name)
  await mkdir(inputDir, { recursive: true })
  const reportPath = join(inputDir, 'report.json')
  const fixturePath = join(inputDir, 'fixture.json')
  const receiptPath = join(inputDir, 'receipts.json')
  await writeFile(
    reportPath,
    JSON.stringify({ success: true, numFailedTests: 0, numFailedTestSuites: 0 }),
  )
  await writeFile(fixturePath, JSON.stringify({ name }))
  await writeFile(receiptPath, JSON.stringify([receipt(`document-${name}`)]))
  const outputPath = join(root, 'evidence', name, 'evidence.json')
  await collectAcceptanceEvidence({
    repoRoot: root,
    outputPath,
    commit,
    acceptanceIds,
    platform: 'linux',
    arch: 'x64',
    protocolVersion: '1',
    runtimeVersion: '1.0.0',
    catalogHashes: {
      docs: '1'.repeat(64),
      pdf: '2'.repeat(64),
      sheets: '3'.repeat(64),
      slides: '4'.repeat(64),
    },
    fixtures: { [`fixture-${name}`]: fixturePath },
    receipts: { [`receipt-${name}`]: receiptPath },
    commands: ['npm test'],
    suites: [{ suite: name, report: reportPath }],
  })
  return outputPath
}

describe('acceptance evidence summary', () => {
  it('revalidates reports, fixture hashes, receipts, catalogs, and complete ID coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const first = await createEvidence(root, 'first', { acceptanceIds: ['OT-001', 'OT-002'] })
    const second = await createEvidence(root, 'second', {
      acceptanceIds: ['OT-003', 'OT-004', 'OT-005', 'OTC-001', 'OTC-002', 'OTC-010'],
    })
    const outputPath = join(root, 'summary.json')

    const summary = await collectAcceptanceSummary({
      repoRoot: root,
      outputPath,
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: [
        'OT-001',
        'OT-002',
        'OT-003',
        'OT-004',
        'OT-005',
        'OTC-001',
        'OTC-002',
        'OTC-010',
      ],
      requiredCatalogNames: ['docs', 'pdf', 'sheets', 'slides'],
      catalogPath,
      manifestPaths: [first, second],
    })

    expect(summary).toMatchObject({
      schemaVersion: 1,
      commit: 'b'.repeat(40),
      status: 'passed',
      redactionCheck: 'passed',
      catalog: { entries: 63, officeExecutors: 46, retiredAliases: 2 },
      receipts: { checked: 2, unknown: 0 },
    })
    expect(summary.acceptanceIds).toHaveLength(8)
    expect(summary.manifests).toHaveLength(2)
    expect(summary.catalogHashes).toEqual({
      docs: '1'.repeat(64),
      pdf: '2'.repeat(64),
      sheets: '3'.repeat(64),
      slides: '4'.repeat(64),
    })
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(summary)
  })

  it.each([
    [
      'different commit',
      'summary_commit_mismatch',
      async (root, manifest) => {
        const value = JSON.parse(await readFile(manifest, 'utf8'))
        value.commit = 'c'.repeat(40)
        await writeFile(manifest, JSON.stringify(value))
      },
    ],
    [
      'fixture drift',
      'summary_fixture_drift',
      async (root) => {
        await writeFile(join(root, 'inputs', 'only', 'fixture.json'), '{"drift":true}')
      },
    ],
    [
      'missing report',
      'summary_report_missing',
      async (root) => {
        await rm(join(root, 'evidence', 'only', 'reports', 'only.json'))
      },
    ],
    [
      'edited report',
      'summary_report_hash_mismatch',
      async (root) => {
        await writeFile(
          join(root, 'evidence', 'only', 'reports', 'only.json'),
          JSON.stringify({ success: true, numFailedTests: 0, edited: true }),
        )
      },
    ],
    [
      'redaction drift',
      'summary_redaction_failed',
      async (root, manifest) => {
        const value = JSON.parse(await readFile(manifest, 'utf8'))
        value.commands = ['https://private.example/run']
        await writeFile(manifest, JSON.stringify(value))
      },
    ],
  ])('rejects %s', async (_label, code, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-invalid-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    await mutate(root, manifest)
    await expect(
      collectAcceptanceSummary({
        repoRoot: root,
        outputPath: join(root, 'summary.json'),
        expectedCommit: 'b'.repeat(40),
        requiredAcceptanceIds: ['OT-001'],
        requiredCatalogNames: ['docs'],
        catalogPath,
        manifestPaths: [manifest],
      }),
    ).rejects.toThrow(code)
  })

  it('rejects missing IDs, catalog hashes, failed reports, and unknown mutation outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-failclosed-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    const options = {
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: ['OT-001', 'OT-002'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [manifest],
    }
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_acceptance_missing')

    const value = JSON.parse(await readFile(manifest, 'utf8'))
    value.acceptanceIds.push('OT-002')
    delete value.catalogHashes.docs
    await writeFile(manifest, JSON.stringify(value))
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_catalog_missing')

    value.catalogHashes.docs = '1'.repeat(64)
    await writeFile(manifest, JSON.stringify(value))
    const reportPath = join(root, value.results[0].report)
    const failed = JSON.stringify({ success: false, numFailedTests: 1 })
    await writeFile(reportPath, failed)
    value.reportHashes.only = sha256(failed)
    await writeFile(manifest, JSON.stringify(value))
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_report_failed')

    const passed = JSON.stringify({ success: true, numFailedTests: 0 })
    await writeFile(reportPath, passed)
    value.reportHashes.only = sha256(passed)
    const receiptPath = join(root, value.receipts[0].path)
    const unknown = `${JSON.stringify([receipt('document-only', 'unknown')], null, 2)}\n`
    await writeFile(receiptPath, unknown)
    value.receipts[0].sha256 = sha256(unknown)
    await writeFile(manifest, JSON.stringify(value))
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_receipt_unknown')
  })

  it.each([
    ['missing shape', {}, 'summary_catalog_invalid'],
    [
      'invalid entry',
      { ...catalog(), entries: [{ ...catalog().entries[0], app: 'writer' }] },
      'summary_catalog_invalid',
    ],
    ['array entry', { ...catalog(), entries: [[]] }, 'summary_catalog_invalid'],
    [
      'duplicate alias',
      {
        ...catalog(),
        entries: catalog().entries.map((entry, index) =>
          index === 1 ? catalog().entries[0] : entry,
        ),
      },
      'summary_catalog_invalid',
    ],
    [
      'wrong totals',
      { ...catalog(), entries: catalog().entries.slice(0, 62) },
      'summary_catalog_invalid',
    ],
  ])('rejects a catalog with %s', async (_label, value, code) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-catalog-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(value))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    await expect(
      collectAcceptanceSummary({
        repoRoot: root,
        outputPath: join(root, 'summary.json'),
        expectedCommit: 'b'.repeat(40),
        requiredAcceptanceIds: ['OT-001'],
        requiredCatalogNames: ['docs'],
        catalogPath,
        manifestPaths: [manifest],
      }),
    ).rejects.toThrow(code)
  })

  it.each([
    [
      'mismatched fixture names',
      'summary_manifest_invalid',
      async (root, value) => {
        value.fixtureHashes = { other: Object.values(value.fixtureHashes)[0] }
      },
    ],
    [
      'invalid fixture map',
      'summary_manifest_invalid',
      async (_root, value) => {
        value.fixtureHashes = null
      },
    ],
    [
      'sensitive fixture',
      'summary_redaction_failed',
      async (root) => {
        await writeFile(
          join(root, 'inputs', 'only', 'fixture.json'),
          JSON.stringify('https://private.example'),
        )
      },
    ],
    [
      'manual failed status',
      'summary_manifest_invalid',
      async (_root, value) => {
        value.results[0].status = 'failed'
      },
    ],
    [
      'missing report hash',
      'summary_manifest_invalid',
      async (_root, value) => {
        delete value.reportHashes.only
      },
    ],
    [
      'sensitive report',
      'summary_redaction_failed',
      async (root, value) => {
        const content = JSON.stringify({ success: true, detail: 'Bearer private-token' })
        await writeFile(join(root, value.results[0].report), content)
        value.reportHashes.only = sha256(content)
      },
    ],
    [
      'invalid receipt metadata',
      'summary_receipt_invalid',
      async (_root, value) => {
        value.receipts[0].count = 0
      },
    ],
    [
      'sensitive receipt',
      'summary_redaction_failed',
      async (root, value) => {
        const content = JSON.stringify('https://private.example')
        await writeFile(join(root, value.receipts[0].path), content)
        value.receipts[0].sha256 = sha256(content)
      },
    ],
    [
      'receipt hash drift',
      'summary_receipt_hash_mismatch',
      async (root, value) => {
        await writeFile(
          join(root, value.receipts[0].path),
          `${JSON.stringify([receipt('changed')])}\n`,
        )
      },
    ],
    [
      'receipt count drift',
      'summary_receipt_invalid',
      async (_root, value) => {
        value.receipts[0].count = 2
      },
    ],
  ])('rejects %s', async (_label, code, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-boundary-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    await mutate(root, value)
    await writeFile(manifest, JSON.stringify(value))
    await expect(
      collectAcceptanceSummary({
        repoRoot: root,
        outputPath: join(root, 'summary.json'),
        expectedCommit: 'b'.repeat(40),
        requiredAcceptanceIds: ['OT-001'],
        requiredCatalogNames: ['docs'],
        catalogPath,
        manifestPaths: [manifest],
      }),
    ).rejects.toThrow(code)
  })

  it('rejects conflicting catalog hashes and incomplete summary metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-conflict-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const first = await createEvidence(root, 'first', { acceptanceIds: ['OT-001'] })
    const second = await createEvidence(root, 'second', { acceptanceIds: ['OT-002'] })
    const value = JSON.parse(await readFile(second, 'utf8'))
    value.catalogHashes.docs = '9'.repeat(64)
    await writeFile(second, JSON.stringify(value))
    const options = {
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: ['OT-001', 'OT-002'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [first, second],
    }
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_catalog_drift')
    await expect(collectAcceptanceSummary({ ...options, expectedCommit: 'short' })).rejects.toThrow(
      'summary_metadata_invalid',
    )
  })

  it('accepts evidence without receipt artifacts but never invents a receipt check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-no-receipt-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    const value = JSON.parse(await readFile(manifest, 'utf8'))
    delete value.receipts
    await writeFile(manifest, JSON.stringify(value))
    const options = {
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: ['OT-001'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [manifest],
    }
    const summary = await collectAcceptanceSummary(options)
    expect(summary.receipts).toEqual({ checked: 0, unknown: 0 })

    delete value.catalogHashes
    await writeFile(manifest, JSON.stringify(value))
    await expect(collectAcceptanceSummary(options)).rejects.toThrow('summary_catalog_missing')
  })

  it('recertifies only ancestor evidence when the policy is explicitly enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-ancestor-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const sourceCommit = 'a'.repeat(40)
    const expectedCommit = 'b'.repeat(40)
    const manifest = await createEvidence(root, 'ancestor', {
      acceptanceIds: ['OT-001', 'RT-001', 'SS-001', 'DS-001'],
      commit: sourceCommit,
    })
    const ancestryChecks = []

    const summary = await collectAcceptanceSummary({
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit,
      ancestorPolicy: 'allow',
      isAncestor: async (ancestor, descendant) => {
        ancestryChecks.push([ancestor, descendant])
        return true
      },
      requiredAcceptanceIds: ['OT-001'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [manifest],
    })

    expect(ancestryChecks).toEqual([[sourceCommit, expectedCommit]])
    expect(summary.recertification).toEqual({
      policy: 'ancestor-only',
      currentManifests: 0,
      ancestorManifests: 1,
    })
    expect(summary.manifests).toEqual([
      expect.objectContaining({ sourceCommit, relation: 'ancestor' }),
    ])
    expect(summary.acceptanceIds).toEqual(['OT-001'])
  })

  it('fails closed when recertification evidence is not an ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-non-ancestor-'))
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'unrelated', {
      acceptanceIds: ['OT-001'],
      commit: 'a'.repeat(40),
    })

    await expect(
      collectAcceptanceSummary({
        repoRoot: root,
        outputPath: join(root, 'summary.json'),
        expectedCommit: 'b'.repeat(40),
        ancestorPolicy: 'allow',
        isAncestor: async () => false,
        requiredAcceptanceIds: ['OT-001'],
        requiredCatalogNames: ['docs'],
        catalogPath,
        manifestPaths: [manifest],
      }),
    ).rejects.toThrow('summary_commit_not_ancestor')
  })

  it('checks ancestry against the repository when no test seam is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-git-ancestor-'))
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    git('init')
    git('config', 'user.name', 'Acceptance Test')
    git('config', 'user.email', 'acceptance@example.invalid')
    const marker = join(root, 'marker.txt')
    await writeFile(marker, 'ancestor\n')
    git('add', 'marker.txt')
    git('commit', '-m', 'ancestor')
    const sourceCommit = git('rev-parse', 'HEAD').trim()
    await writeFile(marker, 'current\n')
    git('commit', '-am', 'current')
    const expectedCommit = git('rev-parse', 'HEAD').trim()
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'git-ancestor', {
      acceptanceIds: ['OT-001'],
      commit: sourceCommit,
    })

    const summary = await collectAcceptanceSummary({
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit,
      ancestorPolicy: 'allow',
      requiredAcceptanceIds: ['OT-001'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [manifest],
    })

    expect(summary.manifests[0]).toMatchObject({ sourceCommit, relation: 'ancestor' })
  })

  it('parses and executes the summary CLI without accepting a manual status', async () => {
    expect(
      parseAcceptanceSummaryArgs([
        '--acceptance',
        'OT-001,OTC-001',
        '--catalog-name',
        'docs,pdf',
        '--catalog',
        'catalog.json',
        '--manifest',
        'evidence/one/evidence.json',
        '--output',
        'evidence/summary.json',
        '--ancestor-policy',
        'allow',
      ]),
    ).toEqual({
      requiredAcceptanceIds: ['OT-001', 'OTC-001'],
      requiredCatalogNames: ['docs', 'pdf'],
      catalogPath: 'catalog.json',
      manifestPaths: ['evidence/one/evidence.json'],
      outputPath: 'evidence/summary.json',
      ancestorPolicy: 'allow',
    })
    expect(() => parseAcceptanceSummaryArgs(['--status', 'passed'])).toThrow(
      'summary_argument_invalid',
    )
    expect(() => parseAcceptanceSummaryArgs(['--output'])).toThrow('summary_argument_invalid')
    expect(() => parseAcceptanceSummaryArgs(['--ancestor-policy', 'ignore'])).toThrow(
      'summary_argument_invalid',
    )

    const root = await mkdtemp(join(tmpdir(), 'genoffice-summary-cli-'))
    await mkdir(join(root, '.git'), { recursive: true })
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const manifest = await createEvidence(root, 'only', { acceptanceIds: ['OT-001'] })
    const summary = await runAcceptanceSummaryCli(
      [
        '--acceptance',
        'OT-001',
        '--catalog-name',
        'docs',
        '--catalog',
        rel(root, catalogPath),
        '--manifest',
        rel(root, manifest),
        '--output',
        'summary.json',
      ],
      root,
      'b'.repeat(40),
    )
    expect(summary.status).toBe('passed')
  })
})
