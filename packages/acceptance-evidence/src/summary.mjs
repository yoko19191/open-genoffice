import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
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

function validateCatalog(value) {
  const candidate = object(value)
  if (candidate?.schemaVersion !== 1 || !Array.isArray(candidate.entries)) {
    throw new Error('summary_catalog_invalid')
  }
  const keys = new Set()
  for (const entry of candidate.entries) {
    if (
      !object(entry) ||
      !['docs', 'pdf', 'sheets', 'slides'].includes(entry.app) ||
      typeof entry.legacyAlias !== 'string' ||
      typeof entry.sourceFile !== 'string' ||
      !['office-executor', 'platform', 'skill', 'resource', 'retired'].includes(entry.disposition)
    ) {
      throw new Error('summary_catalog_invalid')
    }
    const key = `${entry.app}:${entry.legacyAlias}`
    if (keys.has(key)) throw new Error('summary_catalog_invalid')
    keys.add(key)
  }
  const officeExecutors = candidate.entries.filter(
    (entry) => entry.disposition === 'office-executor',
  ).length
  const retiredAliases = candidate.entries.filter((entry) => entry.disposition === 'retired').length
  if (candidate.entries.length !== 63 || officeExecutors !== 46 || retiredAliases !== 2) {
    throw new Error('summary_catalog_invalid')
  }
  return {
    entries: candidate.entries.length,
    officeExecutors,
    reclassified: candidate.entries.length - officeExecutors - retiredAliases,
    retiredAliases,
  }
}

function validateManifestShape(manifest) {
  const fixtureHashes = stringMap(manifest.fixtureHashes, HASH)
  const fixtureSources = stringMap(manifest.fixtureSources)
  const reportHashes = stringMap(manifest.reportHashes, HASH)
  const catalogHashes = manifest.catalogHashes ? stringMap(manifest.catalogHashes, HASH) : {}
  if (
    manifest.schemaVersion !== 1 ||
    !COMMIT.test(manifest.commit) ||
    !Array.isArray(manifest.acceptanceIds) ||
    manifest.acceptanceIds.length === 0 ||
    manifest.acceptanceIds.some((id) => typeof id !== 'string' || !ACCEPTANCE_ID.test(id)) ||
    new Set(manifest.acceptanceIds).size !== manifest.acceptanceIds.length ||
    !['linux', 'macos', 'windows'].includes(manifest.platform) ||
    typeof manifest.arch !== 'string' ||
    manifest.arch.length === 0 ||
    !fixtureHashes ||
    !fixtureSources ||
    Object.keys(fixtureHashes).length !== Object.keys(fixtureSources).length ||
    !reportHashes ||
    !catalogHashes ||
    !Array.isArray(manifest.commands) ||
    manifest.commands.length === 0 ||
    manifest.commands.some((command) => typeof command !== 'string' || command.length === 0) ||
    !Array.isArray(manifest.results) ||
    manifest.results.length === 0 ||
    manifest.redactionCheck !== 'passed'
  ) {
    throw new Error('summary_manifest_invalid')
  }
  return { fixtureHashes, fixtureSources, reportHashes, catalogHashes }
}

function assertPassedReport(report, code) {
  if (
    report.success !== true ||
    (report.numFailedTests ?? 0) !== 0 ||
    (report.numFailedTestSuites ?? 0) !== 0
  ) {
    throw new Error(code)
  }
}

async function readJson(repoRoot, path, missingCode) {
  const file = inside(repoRoot, path)
  let content
  try {
    content = await readFile(file.absolute, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(missingCode, { cause: error })
    throw error
  }
  return { file, content, value: JSON.parse(content) }
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
    throw new Error('summary_ancestry_check_failed', { cause: error })
  }
}

export async function collectAcceptanceSummary(options) {
  if (
    !COMMIT.test(options.expectedCommit ?? '') ||
    !Array.isArray(options.requiredAcceptanceIds) ||
    options.requiredAcceptanceIds.length === 0 ||
    !Array.isArray(options.requiredCatalogNames) ||
    options.requiredCatalogNames.length === 0 ||
    !Array.isArray(options.manifestPaths) ||
    options.manifestPaths.length === 0 ||
    (options.ancestorPolicy !== undefined && options.ancestorPolicy !== 'allow') ||
    (options.isAncestor !== undefined && typeof options.isAncestor !== 'function')
  ) {
    throw new Error('summary_metadata_invalid')
  }
  const repoRoot = resolve(options.repoRoot)
  const output = inside(repoRoot, options.outputPath)
  const catalogInput = await readJson(repoRoot, options.catalogPath, 'summary_catalog_missing')
  assertRedacted(catalogInput.content)
  const catalog = validateCatalog(catalogInput.value)
  const catalogCanonical = `${JSON.stringify(catalogInput.value, null, 2)}\n`
  const covered = new Map()
  const catalogHashes = new Map()
  const manifests = []
  let receiptsChecked = 0
  let currentManifests = 0
  let ancestorManifests = 0

  for (const manifestPath of options.manifestPaths) {
    const input = await readJson(repoRoot, manifestPath, 'summary_manifest_missing')
    const sanitizedManifest = input.content.split(repoRoot).join('<repo>')
    try {
      assertRedacted(sanitizedManifest)
    } catch {
      throw new Error('summary_redaction_failed')
    }
    const manifest = JSON.parse(sanitizedManifest)
    const {
      fixtureHashes,
      fixtureSources,
      reportHashes,
      catalogHashes: hashes,
    } = validateManifestShape(manifest)
    let relation = 'current'
    if (manifest.commit !== options.expectedCommit) {
      if (options.ancestorPolicy !== 'allow') throw new Error('summary_commit_mismatch')
      const isAncestor =
        options.isAncestor ??
        ((ancestor, descendant) => gitIsAncestor(repoRoot, ancestor, descendant))
      if (!(await isAncestor(manifest.commit, options.expectedCommit))) {
        throw new Error('summary_commit_not_ancestor')
      }
      relation = 'ancestor'
      ancestorManifests += 1
    } else {
      currentManifests += 1
    }

    if (manifest.recertification !== undefined) {
      const recertification = object(manifest.recertification)
      if (
        !recertification ||
        typeof recertification.sourcePath !== 'string' ||
        !HASH.test(recertification.sourceManifestSha256 ?? '') ||
        !COMMIT.test(recertification.sourceCommit ?? '') ||
        !['current', 'ancestor'].includes(recertification.relation) ||
        !Array.isArray(recertification.omittedFixtureClaims)
      ) {
        throw new Error('summary_recertification_invalid')
      }
      const sourceManifest = inside(repoRoot, recertification.sourcePath)
      const sourceContent = await readFile(sourceManifest.absolute)
      if (sha256(sourceContent) !== recertification.sourceManifestSha256) {
        throw new Error('summary_source_manifest_hash_mismatch')
      }
    }

    for (const [name, source] of Object.entries(fixtureSources)) {
      if (!(name in fixtureHashes)) throw new Error('summary_manifest_invalid')
      const fixture = inside(repoRoot, source)
      let content
      try {
        content = await readFile(fixture.absolute)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error('summary_fixture_missing', { cause: error })
        }
        throw error
      }
      try {
        assertRedacted(content.toString('utf8'))
      } catch {
        throw new Error('summary_redaction_failed')
      }
      if (sha256(content) !== fixtureHashes[name]) throw new Error('summary_fixture_drift')
    }

    const manifestDirectory = `${dirname(input.file.relative)}/reports/`
    for (const result of manifest.results) {
      if (
        !object(result) ||
        typeof result.suite !== 'string' ||
        result.status !== 'passed' ||
        typeof result.report !== 'string' ||
        !result.report.startsWith(manifestDirectory) ||
        !HASH.test(reportHashes[result.suite] ?? '')
      ) {
        throw new Error('summary_manifest_invalid')
      }
      const report = await readJson(repoRoot, result.report, 'summary_report_missing')
      try {
        assertRedacted(report.content)
      } catch {
        throw new Error('summary_redaction_failed')
      }
      if (sha256(report.content) !== reportHashes[result.suite]) {
        throw new Error('summary_report_hash_mismatch')
      }
      assertPassedReport(report.value, 'summary_report_failed')
      if (report.value.sourceReport !== undefined) {
        const sourceReport = object(report.value.sourceReport)
        const recertification = object(manifest.recertification)
        if (
          !sourceReport ||
          typeof sourceReport.path !== 'string' ||
          !HASH.test(sourceReport.sha256 ?? '') ||
          !recertification ||
          !sourceReport.path.startsWith(`${dirname(recertification.sourcePath)}/reports/`)
        ) {
          throw new Error('summary_source_report_invalid')
        }
        const source = await readJson(repoRoot, sourceReport.path, 'summary_source_report_missing')
        try {
          assertRedacted(source.content)
        } catch {
          throw new Error('summary_redaction_failed')
        }
        const canonical = `${JSON.stringify(source.value, null, 2)}\n`
        if (sha256(canonical) !== sourceReport.sha256) {
          throw new Error('summary_source_report_hash_mismatch')
        }
        assertPassedReport(source.value, 'summary_source_report_failed')
      }
    }

    for (const receipt of manifest.receipts ?? []) {
      if (
        !object(receipt) ||
        typeof receipt.name !== 'string' ||
        typeof receipt.path !== 'string' ||
        !receipt.path.startsWith(`${dirname(input.file.relative)}/receipts/`) ||
        !HASH.test(receipt.sha256 ?? '') ||
        !Number.isInteger(receipt.count) ||
        receipt.count < 1
      ) {
        throw new Error('summary_receipt_invalid')
      }
      const artifact = await readJson(repoRoot, receipt.path, 'summary_receipt_missing')
      try {
        assertRedacted(artifact.content)
      } catch {
        throw new Error('summary_redaction_failed')
      }
      if (sha256(artifact.content) !== receipt.sha256) {
        throw new Error('summary_receipt_hash_mismatch')
      }
      const receipts = validateReceiptArtifact(artifact.value)
      if (receipts.length !== receipt.count) throw new Error('summary_receipt_invalid')
      if (receipts.some((item) => item.mutationOutcome === 'unknown')) {
        throw new Error('summary_receipt_unknown')
      }
      receiptsChecked += receipts.length
    }

    for (const [name, hash] of Object.entries(hashes)) {
      const previous = catalogHashes.get(name)
      if (previous && previous !== hash) throw new Error('summary_catalog_drift')
      catalogHashes.set(name, hash)
    }
    for (const acceptanceId of manifest.acceptanceIds) {
      covered.set(acceptanceId, [...(covered.get(acceptanceId) ?? []), input.file.relative])
    }
    manifests.push({
      path: input.file.relative,
      sha256: sha256(input.content),
      sourceCommit: manifest.commit,
      relation,
      platform: manifest.platform,
      arch: manifest.arch,
    })
  }

  const missingAcceptance = options.requiredAcceptanceIds.filter((id) => !covered.has(id))
  if (missingAcceptance.length > 0) throw new Error('summary_acceptance_missing')
  const missingCatalog = options.requiredCatalogNames.filter((name) => !catalogHashes.has(name))
  if (missingCatalog.length > 0) throw new Error('summary_catalog_missing')

  const acceptanceIds = [...new Set(options.requiredAcceptanceIds)].sort()
  const summary = {
    schemaVersion: 1,
    commit: options.expectedCommit,
    status: 'passed',
    acceptanceIds,
    coverage: Object.fromEntries(acceptanceIds.map((id) => [id, covered.get(id)])),
    catalog: {
      path: catalogInput.file.relative,
      sha256: sha256(catalogCanonical),
      ...catalog,
    },
    catalogHashes: Object.fromEntries(
      options.requiredCatalogNames.sort().map((name) => [name, catalogHashes.get(name)]),
    ),
    receipts: { checked: receiptsChecked, unknown: 0 },
    recertification: {
      policy: options.ancestorPolicy === 'allow' ? 'ancestor-only' : 'exact-commit',
      currentManifests,
      ancestorManifests,
    },
    manifests: manifests.sort((left, right) => left.path.localeCompare(right.path)),
    redactionCheck: 'passed',
  }
  await mkdir(dirname(output.absolute), { recursive: true })
  await writeFile(output.absolute, `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

export function parseAcceptanceSummaryArgs(argv) {
  const parsed = { requiredAcceptanceIds: [], requiredCatalogNames: [], manifestPaths: [] }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error('summary_argument_invalid')
    if (flag === '--acceptance') {
      parsed.requiredAcceptanceIds.push(...value.split(',').filter(Boolean))
    } else if (flag === '--catalog-name') {
      parsed.requiredCatalogNames.push(...value.split(',').filter(Boolean))
    } else if (flag === '--catalog') parsed.catalogPath = value
    else if (flag === '--manifest') parsed.manifestPaths.push(value)
    else if (flag === '--output') parsed.outputPath = value
    else if (flag === '--ancestor-policy' && value === 'allow') parsed.ancestorPolicy = value
    else throw new Error('summary_argument_invalid')
  }
  return parsed
}

export async function runAcceptanceSummaryCli(argv, repoRoot = process.cwd(), commit) {
  const parsed = parseAcceptanceSummaryArgs(argv)
  return collectAcceptanceSummary({
    ...parsed,
    repoRoot,
    expectedCommit:
      commit ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    outputPath: parsed.outputPath ?? 'evidence/summary.json',
  })
}
