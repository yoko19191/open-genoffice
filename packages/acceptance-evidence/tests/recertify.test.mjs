import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectAcceptanceSummary } from '../src/summary.mjs'
import {
  parseRecertificationArgs,
  recertifyAcceptanceEvidence,
  runRecertificationCli,
} from '../src/recertify.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')

function catalog() {
  return {
    schemaVersion: 1,
    entries: Array.from({ length: 63 }, (_, index) => ({
      app: ['docs', 'pdf', 'sheets', 'slides'][index % 4],
      legacyAlias: `legacy_${index}`,
      sourceFile: `apps/docs/tool-${index}.ts`,
      disposition: index < 46 ? 'office-executor' : index < 61 ? 'platform' : 'retired',
    })),
  }
}

async function sourceEvidence(
  root,
  { fixtureSource = true, report = { success: true, numFailedTests: 0 }, receipt = false } = {},
) {
  const directory = join(root, 'evidence', 'legacy')
  const reportPath = join(directory, 'reports', 'runtime.json')
  const fixturePath = join(root, 'fixtures', 'headless-fixture')
  await mkdir(join(directory, 'reports'), { recursive: true })
  await mkdir(join(root, 'fixtures'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report))
  await writeFile(fixturePath, '#!/usr/bin/env node\n')
  const receiptValue = [
    {
      operationId: '11111111-1111-4111-8111-111111111111',
      toolCallId: '22222222-2222-4222-8222-222222222222',
      toolId: 'office:docs:apply_commands',
      status: 'completed',
      output: '',
      contextVersionAfter: 'context-2',
      mutationOutcome: 'committed',
      provenance: {
        actorId: '33333333-3333-4333-8333-333333333333',
        runId: '44444444-4444-4444-8444-444444444444',
        documentId: '55555555-5555-4555-8555-555555555555',
      },
    },
  ]
  if (receipt) {
    await mkdir(join(directory, 'receipts'), { recursive: true })
    await writeFile(join(directory, 'receipts', 'operation.json'), JSON.stringify(receiptValue))
  }
  const manifestPath = join(directory, 'evidence.json')
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      commit: 'a'.repeat(40),
      acceptanceIds: ['SA-001', 'SS-007'],
      platform: 'linux',
      arch: 'x64',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      catalogHashes: { docs: '1'.repeat(64) },
      fixtureHashes: { headless: hash('#!/usr/bin/env node\n') },
      ...(fixtureSource ? { fixtureSources: { headless: 'fixtures/headless-fixture' } } : {}),
      commands: ['native-subagent-linux'],
      ...(receipt
        ? {
            receipts: [
              {
                name: 'operation',
                path: 'evidence/legacy/receipts/operation.json',
                sha256: hash(`${JSON.stringify(receiptValue, null, 2)}\n`),
                count: 1,
              },
            ],
          }
        : {}),
      results: [
        {
          suite: 'runtime',
          status: 'passed',
          report: 'evidence/legacy/reports/runtime.json',
        },
      ],
      redactionCheck: 'passed',
    }),
  )
  return { manifestPath, reportPath }
}

describe('legacy acceptance evidence recertification', () => {
  it('revalidates reports and arbitrary fixture bytes into a modern current manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-'))
    const { manifestPath, reportPath } = await sourceEvidence(root, { receipt: true })
    const outputPath = join(root, 'evidence', 'recertified', 'evidence.json')
    const recertified = await recertifyAcceptanceEvidence({
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath,
      expectedCommit: 'b'.repeat(40),
      ancestorPolicy: 'allow',
      isAncestor: async () => true,
    })

    expect(recertified).toMatchObject({
      commit: 'b'.repeat(40),
      platform: 'linux',
      arch: 'x64',
      fixtureSources: { headless: 'fixtures/headless-fixture' },
      recertification: {
        sourceCommit: 'a'.repeat(40),
        sourcePath: 'evidence/legacy/evidence.json',
        omittedFixtureClaims: [],
      },
    })
    expect(recertified.reportHashes.runtime).toMatch(/^[0-9a-f]{64}$/)
    expect(recertified.receipts).toEqual([expect.objectContaining({ name: 'operation', count: 1 })])
    const attestationPath = join(root, 'evidence', 'recertified', 'reports', 'runtime.json')
    expect(JSON.parse(await readFile(attestationPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      status: 'passed',
      success: true,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      sourceReport: {
        path: 'evidence/legacy/reports/runtime.json',
        sha256: hash(`${JSON.stringify({ success: true, numFailedTests: 0 }, null, 2)}\n`),
      },
      counts: { passedTests: 0, passedTestSuites: 0 },
    })

    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const summary = await collectAcceptanceSummary({
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: ['SA-001'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [outputPath],
    })
    expect(summary.status).toBe('passed')

    await writeFile(reportPath, JSON.stringify({ success: true, edited: true }))
    await expect(
      collectAcceptanceSummary({
        repoRoot: root,
        outputPath: join(root, 'summary-after-drift.json'),
        expectedCommit: 'b'.repeat(40),
        requiredAcceptanceIds: ['SA-001'],
        requiredCatalogNames: ['docs'],
        catalogPath,
        manifestPaths: [outputPath],
      }),
    ).rejects.toThrow('summary_source_report_hash_mismatch')
  })

  it('records unverifiable legacy fixture claims without treating them as fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-omitted-'))
    const { manifestPath } = await sourceEvidence(root, { fixtureSource: false })
    const recertified = await recertifyAcceptanceEvidence({
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath: join(root, 'evidence', 'recertified', 'evidence.json'),
      expectedCommit: 'b'.repeat(40),
      ancestorPolicy: 'allow',
      isAncestor: async () => true,
    })

    expect(recertified.fixtureHashes).toEqual({})
    expect(recertified.fixtureSources).toEqual({})
    expect(recertified.recertification.omittedFixtureClaims).toEqual(['headless'])
  })

  it('fails closed on recertification and source-report attestation drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-summary-invalid-'))
    const { manifestPath, reportPath } = await sourceEvidence(root)
    const sourceManifestContent = await readFile(manifestPath, 'utf8')
    const outputPath = join(root, 'evidence', 'recertified', 'evidence.json')
    await recertifyAcceptanceEvidence({
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath,
      expectedCommit: 'b'.repeat(40),
      ancestorPolicy: 'allow',
      isAncestor: async () => true,
    })
    const catalogPath = join(root, 'catalog.json')
    await writeFile(catalogPath, JSON.stringify(catalog()))
    const summaryOptions = {
      repoRoot: root,
      outputPath: join(root, 'summary.json'),
      expectedCommit: 'b'.repeat(40),
      requiredAcceptanceIds: ['SA-001'],
      requiredCatalogNames: ['docs'],
      catalogPath,
      manifestPaths: [outputPath],
    }

    await writeFile(manifestPath, `${sourceManifestContent}\n`)
    await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
      'summary_source_manifest_hash_mismatch',
    )
    await writeFile(manifestPath, sourceManifestContent)

    const originalManifest = JSON.parse(await readFile(outputPath, 'utf8'))
    for (const mutate of [
      (value) => (value.recertification = []),
      (value) => (value.recertification.sourcePath = 1),
      (value) => (value.recertification.sourceManifestSha256 = 'short'),
      (value) => (value.recertification.sourceCommit = 'short'),
      (value) => (value.recertification.relation = 'unrelated'),
      (value) => (value.recertification.omittedFixtureClaims = null),
    ]) {
      const manifest = structuredClone(originalManifest)
      mutate(manifest)
      await writeFile(outputPath, JSON.stringify(manifest))
      await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
        'summary_recertification_invalid',
      )
    }
    await writeFile(outputPath, JSON.stringify(originalManifest))

    const attestationPath = join(root, originalManifest.results[0].report)
    const originalAttestation = JSON.parse(await readFile(attestationPath, 'utf8'))
    const writeAttestation = async (attestation) => {
      const content = `${JSON.stringify(attestation, null, 2)}\n`
      await writeFile(attestationPath, content)
      const manifest = structuredClone(originalManifest)
      manifest.reportHashes.runtime = hash(content)
      await writeFile(outputPath, JSON.stringify(manifest))
    }
    const invalidAttestation = structuredClone(originalAttestation)
    invalidAttestation.sourceReport.path = 'fixtures/headless-fixture'
    await writeAttestation(invalidAttestation)
    await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
      'summary_source_report_invalid',
    )

    await writeAttestation(originalAttestation)
    await rm(reportPath)
    await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
      'summary_source_report_missing',
    )

    await writeFile(
      reportPath,
      JSON.stringify({ success: true, detail: 'https://private.example' }),
    )
    const sensitive = structuredClone(originalAttestation)
    sensitive.sourceReport.sha256 = hash(
      `${JSON.stringify({ success: true, detail: 'https://private.example' }, null, 2)}\n`,
    )
    await writeAttestation(sensitive)
    await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
      'summary_redaction_failed',
    )

    await writeFile(reportPath, JSON.stringify({ success: false, numFailedTests: 1 }))
    const failed = structuredClone(originalAttestation)
    failed.sourceReport.sha256 = hash(
      `${JSON.stringify({ success: false, numFailedTests: 1 }, null, 2)}\n`,
    )
    await writeAttestation(failed)
    await expect(collectAcceptanceSummary(summaryOptions)).rejects.toThrow(
      'summary_source_report_failed',
    )
  })

  it.each([
    ['strict commit mismatch', {}, 'summary_commit_mismatch'],
    [
      'non-ancestor source',
      { ancestorPolicy: 'allow', isAncestor: async () => false },
      'summary_commit_not_ancestor',
    ],
    [
      'failed report',
      { ancestorPolicy: 'allow', isAncestor: async () => true, failedReport: true },
      'evidence_suite_failed',
    ],
  ])('rejects %s', async (_label, overrides, code) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-invalid-'))
    const { failedReport, ...options } = overrides
    const { manifestPath } = await sourceEvidence(root, {
      report: failedReport ? { success: false, numFailedTests: 1 } : undefined,
    })
    await expect(
      recertifyAcceptanceEvidence({
        repoRoot: root,
        sourceManifestPath: manifestPath,
        outputPath: join(root, 'evidence', 'recertified', 'evidence.json'),
        expectedCommit: 'b'.repeat(40),
        ...options,
      }),
    ).rejects.toThrow(code)
  })

  it('rejects report hash drift and paths outside the source report directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-drift-'))
    const { manifestPath, reportPath } = await sourceEvidence(root)
    const source = JSON.parse(await readFile(manifestPath, 'utf8'))
    source.reportHashes = { runtime: 'f'.repeat(64) }
    await writeFile(manifestPath, JSON.stringify(source))
    const options = {
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath: join(root, 'evidence', 'recertified', 'evidence.json'),
      expectedCommit: 'b'.repeat(40),
      ancestorPolicy: 'allow',
      isAncestor: async () => true,
    }
    await expect(recertifyAcceptanceEvidence(options)).rejects.toThrow(
      'recertify_report_hash_mismatch',
    )

    delete source.reportHashes
    source.results[0].report = 'fixtures/headless-fixture'
    await writeFile(manifestPath, JSON.stringify(source))
    await expect(recertifyAcceptanceEvidence(options)).rejects.toThrow('recertify_manifest_invalid')
    expect(await readFile(reportPath, 'utf8')).toContain('success')
  })

  it.each([
    ['schema', (value) => (value.schemaVersion = 2)],
    ['commit', (value) => (value.commit = 'short')],
    ['acceptance array', (value) => (value.acceptanceIds = null)],
    ['acceptance empty', (value) => (value.acceptanceIds = [])],
    ['acceptance type', (value) => (value.acceptanceIds = [1])],
    ['acceptance format', (value) => (value.acceptanceIds = ['UNKNOWN-001'])],
    ['platform', (value) => (value.platform = 'freebsd')],
    ['arch type', (value) => (value.arch = 1)],
    ['arch empty', (value) => (value.arch = '')],
    ['fixture hashes shape', (value) => (value.fixtureHashes = null)],
    ['fixture hash key', (value) => (value.fixtureHashes = { 'bad key': '1'.repeat(64) })],
    ['fixture hash type', (value) => (value.fixtureHashes = { headless: 1 })],
    ['fixture hash format', (value) => (value.fixtureHashes = { headless: 'short' })],
    ['fixture source shape', (value) => (value.fixtureSources = [])],
    ['fixture source missing hash', (value) => (value.fixtureSources = { other: 'fixture' })],
    ['catalog hash shape', (value) => (value.catalogHashes = [])],
    ['report hash shape', (value) => (value.reportHashes = [])],
    ['commands array', (value) => (value.commands = null)],
    ['commands empty', (value) => (value.commands = [])],
    ['command type', (value) => (value.commands = [1])],
    ['command empty', (value) => (value.commands = [''])],
    ['results array', (value) => (value.results = null)],
    ['results empty', (value) => (value.results = [])],
    ['redaction flag', (value) => (value.redactionCheck = 'failed')],
    ['result object', (value) => (value.results = [null])],
    ['suite type', (value) => (value.results[0].suite = 1)],
    ['suite format', (value) => (value.results[0].suite = 'bad suite')],
    ['suite duplicate', (value) => value.results.push({ ...value.results[0] })],
    ['result status', (value) => (value.results[0].status = 'failed')],
    ['report type', (value) => (value.results[0].report = 1)],
    ['missing declared report hash', (value) => (value.reportHashes = { other: '1'.repeat(64) })],
  ])('rejects invalid legacy manifest field: %s', async (_label, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-shape-'))
    const { manifestPath } = await sourceEvidence(root)
    const source = JSON.parse(await readFile(manifestPath, 'utf8'))
    mutate(source)
    await writeFile(manifestPath, JSON.stringify(source))
    await expect(
      recertifyAcceptanceEvidence({
        repoRoot: root,
        sourceManifestPath: manifestPath,
        outputPath: join(root, 'evidence', 'current', 'evidence.json'),
        expectedCommit: 'a'.repeat(40),
      }),
    ).rejects.toThrow('recertify_manifest_invalid')
  })

  it.each([
    [{ expectedCommit: 'short' }, 'recertify_metadata_invalid'],
    [{ sourceManifestPath: '' }, 'recertify_metadata_invalid'],
    [{ outputPath: '' }, 'recertify_metadata_invalid'],
    [{ ancestorPolicy: 'ignore' }, 'recertify_metadata_invalid'],
    [{ isAncestor: true }, 'recertify_metadata_invalid'],
  ])('rejects invalid recertification metadata', async (override, code) => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-metadata-'))
    const { manifestPath } = await sourceEvidence(root)
    await expect(
      recertifyAcceptanceEvidence({
        repoRoot: root,
        sourceManifestPath: manifestPath,
        outputPath: join(root, 'evidence', 'current', 'evidence.json'),
        expectedCommit: 'a'.repeat(40),
        ...override,
      }),
    ).rejects.toThrow(code)
  })

  it('rejects same-path output, fixture drift, and every failed report shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-runtime-invalid-'))
    const { manifestPath } = await sourceEvidence(root)
    const base = {
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath: join(root, 'evidence', 'current', 'evidence.json'),
      expectedCommit: 'a'.repeat(40),
    }
    await expect(
      recertifyAcceptanceEvidence({ ...base, outputPath: manifestPath }),
    ).rejects.toThrow('recertify_metadata_invalid')
    await writeFile(join(root, 'fixtures', 'headless-fixture'), 'drift\n')
    await expect(recertifyAcceptanceEvidence(base)).rejects.toThrow('recertify_fixture_drift')

    await writeFile(join(root, 'fixtures', 'headless-fixture'), '#!/usr/bin/env node\n')
    for (const report of [
      { status: 'failed' },
      { status: 'passed', success: false },
      { success: true, status: 'failed' },
      { success: true, numFailedTests: 1 },
      { success: true, numFailedTestSuites: 1 },
    ]) {
      await writeFile(
        join(root, 'evidence', 'legacy', 'reports', 'runtime.json'),
        JSON.stringify(report),
      )
      await expect(recertifyAcceptanceEvidence(base)).rejects.toThrow('evidence_suite_failed')
    }
  })

  it('uses Git for ancestor, divergence, and invalid-object checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-git-'))
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    git('init')
    git('config', 'user.name', 'Acceptance Test')
    git('config', 'user.email', 'acceptance@example.invalid')
    await writeFile(join(root, 'marker.txt'), 'base\n')
    git('add', 'marker.txt')
    git('commit', '-m', 'base')
    const baseCommit = git('rev-parse', 'HEAD').trim()
    await writeFile(join(root, 'marker.txt'), 'current\n')
    git('commit', '-am', 'current')
    const currentCommit = git('rev-parse', 'HEAD').trim()
    const { manifestPath } = await sourceEvidence(root)
    const source = JSON.parse(await readFile(manifestPath, 'utf8'))
    source.commit = baseCommit
    await writeFile(manifestPath, JSON.stringify(source))
    const options = {
      repoRoot: root,
      sourceManifestPath: manifestPath,
      outputPath: join(root, 'evidence', 'current', 'evidence.json'),
      expectedCommit: currentCommit,
      ancestorPolicy: 'allow',
    }
    await expect(recertifyAcceptanceEvidence(options)).resolves.toMatchObject({
      recertification: { relation: 'ancestor' },
    })

    git('checkout', '-b', 'divergent', baseCommit)
    await writeFile(join(root, 'marker.txt'), 'divergent\n')
    git('commit', '-am', 'divergent')
    source.commit = git('rev-parse', 'HEAD').trim()
    await writeFile(manifestPath, JSON.stringify(source))
    await expect(recertifyAcceptanceEvidence(options)).rejects.toThrow(
      'summary_commit_not_ancestor',
    )

    source.commit = 'f'.repeat(40)
    await writeFile(manifestPath, JSON.stringify(source))
    await expect(recertifyAcceptanceEvidence(options)).rejects.toThrow(
      'recertify_ancestry_check_failed',
    )
  })

  it('parses and runs the narrow recertification CLI contract', async () => {
    expect(
      parseRecertificationArgs([
        '--source',
        'evidence/legacy/evidence.json',
        '--output',
        'evidence/current/evidence.json',
        '--ancestor-policy',
        'allow',
      ]),
    ).toEqual({
      sourceManifestPath: 'evidence/legacy/evidence.json',
      outputPath: 'evidence/current/evidence.json',
      ancestorPolicy: 'allow',
    })
    expect(() => parseRecertificationArgs(['--source'])).toThrow('recertify_argument_invalid')
    expect(() => parseRecertificationArgs(['--ancestor-policy', 'ignore'])).toThrow(
      'recertify_argument_invalid',
    )

    const root = await mkdtemp(join(tmpdir(), 'genoffice-recertify-cli-'))
    const { manifestPath } = await sourceEvidence(root)
    const recertified = await runRecertificationCli(
      ['--source', manifestPath, '--output', 'evidence/current/evidence.json'],
      root,
      'a'.repeat(40),
    )
    expect(recertified.recertification.relation).toBe('current')
  })
})
