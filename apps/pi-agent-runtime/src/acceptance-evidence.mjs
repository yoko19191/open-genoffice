import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch as hostArch, platform as hostPlatform } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const REDACTION_PATTERNS = [
  /\/Users\/[^/]+\//,
  /[A-Za-z]:\\+Users\\+[^\\]+\\+/i,
  /\bBearer\s+\S+/i,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /data:[^;,]+;base64,/i,
  /https?:\/\/\S+/i,
]

function inside(repoRoot, inputPath) {
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(repoRoot, inputPath)
  const rel = relative(repoRoot, absolute)
  if (rel === '' || rel.startsWith('..')) {
    throw new Error('evidence_path_invalid')
  }
  return { absolute, relative: rel.split('\\').join('/') }
}

function assertRedacted(content) {
  if (REDACTION_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error('redaction_failed')
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function assertMetadata(options) {
  if (
    !/^[0-9a-f]{40}$/.test(options.commit) ||
    options.acceptanceIds.length === 0 ||
    options.commands.length === 0 ||
    options.suites.length === 0 ||
    !['linux', 'macos', 'windows'].includes(options.platform) ||
    !options.arch
  ) {
    throw new Error('evidence_metadata_invalid')
  }
}

export async function collectAcceptanceEvidence(options) {
  assertMetadata(options)
  const repoRoot = resolve(options.repoRoot)
  const output = inside(repoRoot, options.outputPath)
  const fixtureHashes = {}

  for (const [name, fixturePath] of Object.entries(options.fixtures)) {
    const file = inside(repoRoot, fixturePath)
    const content = await readFile(file.absolute)
    assertRedacted(content.toString('utf8'))
    fixtureHashes[name] = sha256(content)
  }

  const results = []
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
    await writeFile(sanitizedReport, `${JSON.stringify(report, null, 2)}\n`)
    results.push({
      suite: suite.suite,
      status: 'passed',
      report: relative(repoRoot, sanitizedReport).split('\\').join('/'),
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
    fixtureHashes,
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
    fixtures: {},
    suites: [],
    commands: [],
  }

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error('evidence_argument_invalid')

    if (flag === '--acceptance') parsed.acceptanceIds.push(...value.split(',').filter(Boolean))
    else if (flag === '--fixture') {
      const [name, path] = assignment(value)
      parsed.fixtures[name] = path
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
