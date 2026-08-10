import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertRedacted, inside, sha256, validateReceiptArtifact } from './index.mjs'

const HASH = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const ACCEPTANCE_ID = /^(?:AR|OT|MD|RS|MCP|SA|OCR|SY|SL|GX|PK|QA|OTC|RT|SS|DS)-\d{3}$/

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function stringMap(value, pattern = /^.+$/) {
  const candidate = object(value)
  if (!candidate) return undefined
  for (const [key, item] of Object.entries(candidate)) {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || typeof item !== 'string' || !pattern.test(item)) {
      return undefined
    }
  }
  return candidate
}

function gitIsAncestor(repoRoot, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    return true
  } catch (error) {
    if (error?.status === 1) return false
    throw new Error('recertify_ancestry_check_failed', { cause: error })
  }
}

function validateSourceManifest(value, sourceDirectory) {
  const fixtureHashes = stringMap(value.fixtureHashes, HASH)
  const fixtureSources = value.fixtureSources ? stringMap(value.fixtureSources) : {}
  const reportHashes = value.reportHashes ? stringMap(value.reportHashes, HASH) : undefined
  const catalogHashes = value.catalogHashes ? stringMap(value.catalogHashes, HASH) : {}
  if (
    value.schemaVersion !== 1 ||
    !COMMIT.test(value.commit ?? '') ||
    !Array.isArray(value.acceptanceIds) ||
    value.acceptanceIds.length === 0 ||
    value.acceptanceIds.some((id) => typeof id !== 'string' || !ACCEPTANCE_ID.test(id)) ||
    !['linux', 'macos', 'windows'].includes(value.platform) ||
    typeof value.arch !== 'string' ||
    value.arch.length === 0 ||
    !fixtureHashes ||
    !fixtureSources ||
    (value.reportHashes !== undefined && !reportHashes) ||
    !catalogHashes ||
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.some((command) => typeof command !== 'string' || command.length === 0) ||
    !Array.isArray(value.results) ||
    value.results.length === 0 ||
    value.redactionCheck !== 'passed'
  ) {
    throw new Error('recertify_manifest_invalid')
  }

  const suites = new Set()
  for (const result of value.results) {
    if (
      !object(result) ||
      typeof result.suite !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(result.suite) ||
      suites.has(result.suite) ||
      result.status !== 'passed' ||
      typeof result.report !== 'string' ||
      !result.report.startsWith(`${sourceDirectory}/reports/`) ||
      (reportHashes && !reportHashes[result.suite])
    ) {
      throw new Error('recertify_manifest_invalid')
    }
    suites.add(result.suite)
  }
  if (Object.keys(fixtureSources).some((name) => !fixtureHashes[name])) {
    throw new Error('recertify_manifest_invalid')
  }
  return { fixtureHashes, fixtureSources, reportHashes, catalogHashes }
}

export async function recertifyAcceptanceEvidence(options) {
  if (
    !COMMIT.test(options.expectedCommit ?? '') ||
    !options.sourceManifestPath ||
    !options.outputPath ||
    (options.ancestorPolicy !== undefined && options.ancestorPolicy !== 'allow') ||
    (options.isAncestor !== undefined && typeof options.isAncestor !== 'function')
  ) {
    throw new Error('recertify_metadata_invalid')
  }
  const repoRoot = resolve(options.repoRoot)
  const sourceFile = inside(repoRoot, options.sourceManifestPath)
  const outputFile = inside(repoRoot, options.outputPath)
  if (sourceFile.relative === outputFile.relative) throw new Error('recertify_metadata_invalid')
  const sourceContent = await readFile(sourceFile.absolute, 'utf8')
  const sanitizedSource = sourceContent.split(repoRoot).join('<repo>')
  assertRedacted(sanitizedSource)
  const source = JSON.parse(sanitizedSource)
  const sourceDirectory = dirname(sourceFile.relative)
  const { fixtureHashes, fixtureSources, reportHashes, catalogHashes } = validateSourceManifest(
    source,
    sourceDirectory,
  )

  if (source.commit !== options.expectedCommit) {
    if (options.ancestorPolicy !== 'allow') throw new Error('summary_commit_mismatch')
    const isAncestor =
      options.isAncestor ??
      ((ancestor, descendant) => gitIsAncestor(repoRoot, ancestor, descendant))
    if (!(await isAncestor(source.commit, options.expectedCommit))) {
      throw new Error('summary_commit_not_ancestor')
    }
  }

  const fixtures = {}
  for (const [name, fixturePath] of Object.entries(fixtureSources)) {
    const fixture = inside(repoRoot, fixturePath)
    const content = await readFile(fixture.absolute)
    assertRedacted(content.toString('utf8'))
    if (sha256(content) !== fixtureHashes[name]) throw new Error('recertify_fixture_drift')
    fixtures[name] = fixture.relative
  }

  const sourceReports = new Map()
  for (const result of source.results) {
    const report = inside(repoRoot, result.report)
    const content = (await readFile(report.absolute, 'utf8')).split(repoRoot).join('<repo>')
    assertRedacted(content)
    const parsed = JSON.parse(content)
    if (
      (parsed.success !== true && parsed.status !== 'passed') ||
      parsed.success === false ||
      (parsed.status !== undefined && parsed.status !== 'passed') ||
      (parsed.numFailedTests ?? 0) !== 0 ||
      (parsed.numFailedTestSuites ?? 0) !== 0
    ) {
      throw new Error('evidence_suite_failed')
    }
    const canonicalHash = sha256(`${JSON.stringify(parsed, null, 2)}\n`)
    if (reportHashes && canonicalHash !== reportHashes[result.suite]) {
      throw new Error('recertify_report_hash_mismatch')
    }
    sourceReports.set(result.suite, { parsed, canonicalHash })
  }

  const outputDirectory = dirname(outputFile.absolute)
  const outputRelativeDirectory = dirname(outputFile.relative)
  const results = []
  const recertifiedReportHashes = {}
  for (const result of source.results) {
    const verified = sourceReports.get(result.suite)
    const attestation = {
      schemaVersion: 1,
      status: 'passed',
      success: true,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      sourceReport: { path: result.report, sha256: verified.canonicalHash },
      counts: {
        passedTests: verified.parsed.numPassedTests ?? 0,
        passedTestSuites: verified.parsed.numPassedTestSuites ?? 0,
      },
    }
    const content = `${JSON.stringify(attestation, null, 2)}\n`
    const path = resolve(outputDirectory, 'reports', `${result.suite}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    recertifiedReportHashes[result.suite] = sha256(content)
    results.push({
      suite: result.suite,
      status: 'passed',
      report: `${outputRelativeDirectory}/reports/${result.suite}.json`,
    })
  }

  const receipts = []
  for (const receipt of source.receipts ?? []) {
    if (
      !object(receipt) ||
      typeof receipt.name !== 'string' ||
      typeof receipt.path !== 'string' ||
      !receipt.path.startsWith(`${sourceDirectory}/receipts/`) ||
      !HASH.test(receipt.sha256 ?? '') ||
      !Number.isInteger(receipt.count) ||
      receipt.count < 1
    ) {
      throw new Error('recertify_receipt_invalid')
    }
    const sourceReceipt = inside(repoRoot, receipt.path)
    const content = await readFile(sourceReceipt.absolute, 'utf8')
    assertRedacted(content)
    const parsed = validateReceiptArtifact(JSON.parse(content))
    const canonical = `${JSON.stringify(parsed, null, 2)}\n`
    if (sha256(canonical) !== receipt.sha256 || parsed.length !== receipt.count) {
      throw new Error('recertify_receipt_hash_mismatch')
    }
    const path = resolve(outputDirectory, 'receipts', `${receipt.name}.json`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, canonical)
    receipts.push({
      name: receipt.name,
      path: `${outputRelativeDirectory}/receipts/${receipt.name}.json`,
      sha256: sha256(canonical),
      count: parsed.length,
    })
  }

  const recertified = {
    schemaVersion: 1,
    commit: options.expectedCommit,
    acceptanceIds: source.acceptanceIds,
    platform: source.platform,
    arch: source.arch,
    protocolVersion: source.protocolVersion,
    runtimeVersion: source.runtimeVersion,
    catalogHashes,
    fixtureHashes: Object.fromEntries(
      Object.keys(fixtures).map((name) => [name, fixtureHashes[name]]),
    ),
    fixtureSources: fixtures,
    reportHashes: recertifiedReportHashes,
    ...(receipts.length > 0 ? { receipts } : {}),
    commands: [...source.commands, `recertified-from:${sourceFile.relative}`],
    results,
    redactionCheck: 'passed',
  }
  recertified.recertification = {
    sourcePath: sourceFile.relative,
    sourceManifestSha256: sha256(sourceContent),
    sourceCommit: source.commit,
    relation: source.commit === options.expectedCommit ? 'current' : 'ancestor',
    omittedFixtureClaims: Object.keys(fixtureHashes)
      .filter((name) => !fixtureSources[name])
      .sort(),
  }
  await writeFile(outputFile.absolute, `${JSON.stringify(recertified, null, 2)}\n`)
  return recertified
}

export function parseRecertificationArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error('recertify_argument_invalid')
    if (flag === '--source') parsed.sourceManifestPath = value
    else if (flag === '--output') parsed.outputPath = value
    else if (flag === '--ancestor-policy' && value === 'allow') parsed.ancestorPolicy = value
    else throw new Error('recertify_argument_invalid')
  }
  return parsed
}

export async function runRecertificationCli(argv, repoRoot = process.cwd(), commit) {
  const parsed = parseRecertificationArgs(argv)
  return recertifyAcceptanceEvidence({
    ...parsed,
    repoRoot,
    expectedCommit:
      commit ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  })
}
