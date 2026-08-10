import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch as hostArch, platform as hostPlatform } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const SENSITIVE_PATTERNS = [
  /\/Users\/[^/]+\//,
  /[A-Za-z]:\\+Users\\+[^\\]+\\+/i,
  /\bBearer\s+\S+/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /data:[^;,]+;base64,/i,
  /https?:\/\/\S+/i,
]

export function inside(repoRoot, inputPath) {
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(repoRoot, inputPath)
  const rel = relative(repoRoot, absolute)
  if (rel === '' || rel.startsWith('..')) {
    throw new Error('evidence_path_invalid')
  }
  return { absolute, relative: rel.split('\\').join('/') }
}

export function assertRedacted(content) {
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error('redaction_failed')
  }
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function validText(value) {
  return typeof value === 'string' && value.length > 0
}

export function validateReceiptArtifact(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('evidence_receipt_invalid')
  for (const receipt of value) {
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      !validText(receipt.operationId) ||
      !validText(receipt.toolCallId) ||
      !validText(receipt.toolId) ||
      !['completed', 'failed'].includes(receipt.status) ||
      typeof receipt.output !== 'string' ||
      !validText(receipt.contextVersionAfter) ||
      !['not_started', 'committed', 'rolled_back', 'unknown'].includes(receipt.mutationOutcome) ||
      !receipt.provenance ||
      typeof receipt.provenance !== 'object' ||
      !validText(receipt.provenance.actorId) ||
      !validText(receipt.provenance.runId) ||
      !validText(receipt.provenance.documentId)
    ) {
      throw new Error('evidence_receipt_invalid')
    }
  }
  return value
}

function assertMetadata(options) {
  const catalogHashes = Object.entries(options.catalogHashes ?? {})
  if (
    !/^[0-9a-f]{40}$/.test(options.commit) ||
    options.acceptanceIds.length === 0 ||
    options.commands.length === 0 ||
    options.suites.length === 0 ||
    !['linux', 'macos', 'windows'].includes(options.platform) ||
    !options.arch ||
    catalogHashes.some(
      ([name, hash]) => !/^[A-Za-z0-9._-]+$/.test(name) || !/^[0-9a-f]{64}$/.test(hash),
    )
  ) {
    throw new Error('evidence_metadata_invalid')
  }
}

export async function collectAcceptanceEvidence(options) {
  assertMetadata(options)
  const repoRoot = resolve(options.repoRoot)
  const output = inside(repoRoot, options.outputPath)
  const fixtureHashes = {}
  const fixtureSources = {}

  for (const [name, fixturePath] of Object.entries(options.fixtures)) {
    const file = inside(repoRoot, fixturePath)
    const content = await readFile(file.absolute)
    assertRedacted(content.toString('utf8'))
    fixtureHashes[name] = sha256(content)
    fixtureSources[name] = file.relative
  }

  const results = []
  const reportHashes = {}
  for (const suite of options.suites) {
    if (!/^[A-Za-z0-9._-]+$/.test(suite.suite)) throw new Error('evidence_suite_name_invalid')
    const file = inside(repoRoot, suite.report)
    const content = await readFile(file.absolute, 'utf8')
    const sanitizedContent = content.split(repoRoot).join('<repo>')
    assertRedacted(sanitizedContent)
    const report = JSON.parse(sanitizedContent)
    if (
      report.success !== true ||
      (report.numFailedTests ?? 0) !== 0 ||
      (report.numFailedTestSuites ?? 0) !== 0
    ) {
      throw new Error('evidence_suite_failed')
    }
    const sanitizedReport = resolve(dirname(output.absolute), 'reports', `${suite.suite}.json`)
    await mkdir(dirname(sanitizedReport), { recursive: true })
    const reportContent = `${JSON.stringify(report, null, 2)}\n`
    await writeFile(sanitizedReport, reportContent)
    reportHashes[suite.suite] = sha256(reportContent)
    results.push({
      suite: suite.suite,
      status: 'passed',
      report: relative(repoRoot, sanitizedReport).split('\\').join('/'),
    })
  }

  const receipts = []
  for (const [name, receiptPath] of Object.entries(options.receipts ?? {})) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('evidence_receipt_name_invalid')
    const file = inside(repoRoot, receiptPath)
    const content = await readFile(file.absolute, 'utf8')
    assertRedacted(content)
    const parsed = validateReceiptArtifact(JSON.parse(content))
    const receiptContent = `${JSON.stringify(parsed, null, 2)}\n`
    const copiedReceipt = resolve(dirname(output.absolute), 'receipts', `${name}.json`)
    await mkdir(dirname(copiedReceipt), { recursive: true })
    await writeFile(copiedReceipt, receiptContent)
    receipts.push({
      name,
      path: relative(repoRoot, copiedReceipt).split('\\').join('/'),
      sha256: sha256(receiptContent),
      count: parsed.length,
    })
  }

  const evidence = {
    schemaVersion: 1,
    commit: options.commit,
    acceptanceIds: [...new Set(options.acceptanceIds)].sort(),
    platform: options.platform,
    arch: options.arch,
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}),
    ...(Object.keys(options.catalogHashes ?? {}).length > 0
      ? { catalogHashes: options.catalogHashes }
      : {}),
    fixtureHashes,
    fixtureSources,
    reportHashes,
    ...(receipts.length > 0 ? { receipts } : {}),
    commands: options.commands,
    results,
    redactionCheck: 'passed',
  }

  await mkdir(dirname(output.absolute), { recursive: true })
  await writeFile(output.absolute, `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}

function assignment(value) {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('evidence_argument_invalid')
  }
  return [value.slice(0, separator), value.slice(separator + 1)]
}

export function parseAcceptanceEvidenceArgs(argv) {
  const parsed = {
    acceptanceIds: [],
    catalogHashes: {},
    fixtures: {},
    receipts: {},
    suites: [],
    commands: [],
  }

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error('evidence_argument_invalid')

    if (flag === '--acceptance') parsed.acceptanceIds.push(...value.split(',').filter(Boolean))
    else if (flag === '--catalog') {
      const [name, hash] = assignment(value)
      parsed.catalogHashes[name] = hash
    } else if (flag === '--fixture') {
      const [name, path] = assignment(value)
      parsed.fixtures[name] = path
    } else if (flag === '--receipt') {
      const [name, path] = assignment(value)
      parsed.receipts[name] = path
    } else if (flag === '--suite') {
      const [suite, report] = assignment(value)
      parsed.suites.push({ suite, report })
    } else if (flag === '--command') parsed.commands.push(value)
    else if (flag === '--output') parsed.outputPath = value
    else if (flag === '--protocol') parsed.protocolVersion = value
    else if (flag === '--runtime') parsed.runtimeVersion = value
    else throw new Error('evidence_argument_invalid')
  }

  return parsed
}

export function normalizeEvidencePlatform(value) {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  return 'linux'
}

export async function runAcceptanceEvidenceCli(argv, repoRoot = process.cwd()) {
  const parsed = parseAcceptanceEvidenceArgs(argv)
  return collectAcceptanceEvidence({
    ...parsed,
    repoRoot,
    outputPath: parsed.outputPath ?? 'evidence/evidence.json',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    platform: normalizeEvidencePlatform(hostPlatform()),
    arch: hostArch(),
  })
}
