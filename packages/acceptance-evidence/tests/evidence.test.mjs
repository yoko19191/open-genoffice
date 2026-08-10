import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectAcceptanceEvidence,
  normalizeEvidencePlatform,
  parseAcceptanceEvidenceArgs,
  runAcceptanceEvidenceCli,
} from '../../../tools/collect-acceptance-evidence.mjs'

async function createInputs(report = { success: true, numFailedTests: 0, numFailedTestSuites: 0 }) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'genoffice-evidence-'))
  const reportPath = join(repoRoot, 'reports', 'runtime.json')
  const fixturePath = join(repoRoot, 'fixtures', 'fake-provider.json')
  const outputPath = join(repoRoot, 'evidence', 'evidence.json')
  await mkdir(join(repoRoot, 'reports'), { recursive: true })
  await mkdir(join(repoRoot, 'fixtures'), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report))
  await writeFile(fixturePath, '{"events":["message.started","run.completed"]}')
  return { repoRoot, reportPath, fixturePath, outputPath }
}

describe('acceptance evidence workspace', () => {
  it('derives passed results and fixture hashes from verified files', async () => {
    const input = await createInputs()
    const evidence = await collectAcceptanceEvidence({
      repoRoot: input.repoRoot,
      outputPath: input.outputPath,
      commit: 'a'.repeat(40),
      acceptanceIds: ['AR-001', 'AR-002', 'AR-006', 'QA-001'],
      platform: 'linux',
      arch: 'x64',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      catalogHashes: { pdf: 'f'.repeat(64) },
      fixtures: { fakeProvider: input.fixturePath },
      commands: ['npm run test -w @genoffice/pi-agent-runtime'],
      suites: [{ suite: 'pi-agent-runtime', report: input.reportPath }],
    })

    expect(JSON.parse(await readFile(input.outputPath, 'utf8'))).toEqual(evidence)
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      commit: 'a'.repeat(40),
      acceptanceIds: ['AR-001', 'AR-002', 'AR-006', 'QA-001'],
      platform: 'linux',
      arch: 'x64',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      catalogHashes: { pdf: 'f'.repeat(64) },
      redactionCheck: 'passed',
      results: [
        {
          suite: 'pi-agent-runtime',
          status: 'passed',
          report: 'evidence/reports/pi-agent-runtime.json',
        },
      ],
    })
    expect(evidence.fixtureHashes.fakeProvider).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(join(input.repoRoot, evidence.results[0].report), 'utf8')).toContain(
      '"success": true',
    )
  })

  it.each([
    ['failed suite', { success: false, numFailedTests: 0, numFailedTestSuites: 0 }],
    ['failed test', { success: true, numFailedTests: 1, numFailedTestSuites: 0 }],
    ['failed test suite', { success: true, numFailedTests: 0, numFailedTestSuites: 1 }],
    ['user path leak', { success: true, numFailedTests: 0, detail: '/Users/alice/private.docx' }],
    ['Windows path leak', { success: true, detail: String.raw`C:\Users\alice\private.docx` }],
    ['token leak', { success: true, numFailedTests: 0, detail: 'Bearer private-token' }],
    ['API key leak', { success: true, detail: 'sk-private_token_123456' }],
    ['base64 leak', { success: true, detail: 'data:image/png;base64,private' }],
    ['URL leak', { success: true, detail: 'https://private.example/path?token=x' }],
  ])('rejects %s instead of emitting passed evidence', async (_label, report) => {
    const input = await createInputs(report)
    await expect(
      collectAcceptanceEvidence({
        repoRoot: input.repoRoot,
        outputPath: input.outputPath,
        commit: 'b'.repeat(40),
        acceptanceIds: ['QA-001'],
        platform: 'macos',
        arch: 'arm64',
        fixtures: { fakeProvider: input.fixturePath },
        commands: ['synthetic-test'],
        suites: [{ suite: 'runtime', report: input.reportPath }],
      }),
    ).rejects.toThrow(_label.startsWith('failed') ? 'evidence_suite_failed' : 'redaction_failed')
  })

  it.each([
    ['commit', { commit: 'short' }],
    ['acceptance IDs', { acceptanceIds: [] }],
    ['commands', { commands: [] }],
    ['suites', { suites: [] }],
    ['platform', { platform: 'aix' }],
    ['arch', { arch: '' }],
  ])('rejects incomplete %s metadata', async (_label, override) => {
    const input = await createInputs()
    await expect(
      collectAcceptanceEvidence({
        repoRoot: input.repoRoot,
        outputPath: input.outputPath,
        commit: 'c'.repeat(40),
        acceptanceIds: ['QA-001'],
        platform: 'linux',
        arch: 'x64',
        fixtures: { fakeProvider: input.fixturePath },
        commands: ['synthetic-test'],
        suites: [{ suite: 'runtime', report: input.reportPath }],
        ...override,
      }),
    ).rejects.toThrow('evidence_metadata_invalid')
  })

  it('rejects evidence paths outside the repository root', async () => {
    const input = await createInputs()
    await expect(
      collectAcceptanceEvidence({
        repoRoot: input.repoRoot,
        outputPath: input.repoRoot,
        commit: 'd'.repeat(40),
        acceptanceIds: ['QA-001'],
        platform: 'windows',
        arch: 'x64',
        fixtures: { fakeProvider: input.fixturePath },
        commands: ['synthetic-test'],
        suites: [{ suite: 'runtime', report: input.reportPath }],
      }),
    ).rejects.toThrow('evidence_path_invalid')
  })

  it('rejects malformed catalog hashes instead of recording unverifiable metadata', async () => {
    const input = await createInputs()
    await expect(
      collectAcceptanceEvidence({
        repoRoot: input.repoRoot,
        outputPath: input.outputPath,
        commit: 'd'.repeat(40),
        acceptanceIds: ['OT-001'],
        platform: 'macos',
        arch: 'arm64',
        catalogHashes: { pdf: 'not-a-sha256' },
        fixtures: { fakeProvider: input.fixturePath },
        commands: ['synthetic-test'],
        suites: [{ suite: 'runtime', report: input.reportPath }],
      }),
    ).rejects.toThrow('evidence_metadata_invalid')
  })

  it('rejects a suite name that cannot be used as an evidence report filename', async () => {
    const input = await createInputs()
    await expect(
      collectAcceptanceEvidence({
        repoRoot: input.repoRoot,
        outputPath: input.outputPath,
        commit: 'e'.repeat(40),
        acceptanceIds: ['QA-001'],
        platform: 'linux',
        arch: 'x64',
        fixtures: { fakeProvider: input.fixturePath },
        commands: ['synthetic-test'],
        suites: [{ suite: '../escape', report: input.reportPath }],
      }),
    ).rejects.toThrow('evidence_suite_name_invalid')
  })

  it('parses repeatable CLI inputs without accepting a manual status', () => {
    expect(
      parseAcceptanceEvidenceArgs([
        '--acceptance',
        'AR-001,QA-001',
        '--fixture',
        'fake=fixtures/fake.json',
        '--catalog',
        `pdf=${'f'.repeat(64)}`,
        '--suite',
        'runtime=reports/runtime.json',
        '--command',
        'npm test',
        '--output',
        'evidence/evidence.json',
        '--protocol',
        '1',
        '--runtime',
        '1.0.0',
      ]),
    ).toMatchObject({
      acceptanceIds: ['AR-001', 'QA-001'],
      fixtures: { fake: 'fixtures/fake.json' },
      catalogHashes: { pdf: 'f'.repeat(64) },
      suites: [{ suite: 'runtime', report: 'reports/runtime.json' }],
      commands: ['npm test'],
      outputPath: 'evidence/evidence.json',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
    })
    expect(() => parseAcceptanceEvidenceArgs(['--status', 'passed'])).toThrow(
      'evidence_argument_invalid',
    )
    expect(() => parseAcceptanceEvidenceArgs(['--output'])).toThrow('evidence_argument_invalid')
    expect(() => parseAcceptanceEvidenceArgs(['--fixture', '=path'])).toThrow(
      'evidence_argument_invalid',
    )
    expect(() => parseAcceptanceEvidenceArgs(['--suite', 'suite='])).toThrow(
      'evidence_argument_invalid',
    )
  })

  it('normalizes all supported host platform names', () => {
    expect(normalizeEvidencePlatform('darwin')).toBe('macos')
    expect(normalizeEvidencePlatform('win32')).toBe('windows')
    expect(normalizeEvidencePlatform('linux')).toBe('linux')
  })

  it('runs the CLI path using verified relative inputs', async () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname
    const tempRoot = await mkdtemp(join(repoRoot, '.evidence-test-'))
    const relativeRoot = tempRoot.slice(repoRoot.length)
    await writeFile(join(tempRoot, 'report.json'), JSON.stringify({ success: true }))
    await writeFile(join(tempRoot, 'fixture.json'), '{"synthetic":true}')

    try {
      const evidence = await runAcceptanceEvidenceCli(
        [
          '--acceptance',
          'QA-001',
          '--fixture',
          `fake=${relativeRoot}/fixture.json`,
          '--suite',
          `runtime=${relativeRoot}/report.json`,
          '--command',
          'synthetic-test',
          '--output',
          `${relativeRoot}/evidence.json`,
        ],
        repoRoot,
      )
      expect(evidence.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(evidence.platform).toBe(normalizeEvidencePlatform(process.platform))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
