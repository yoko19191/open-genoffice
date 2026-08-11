import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const PATTERNS = {
  brand: /genspark/gi,
  cli: /@genspark\/cli/gi,
  cloudMarker: /cloudpptx|cloud-page-generate|slide_generate/gi,
  endpoint: /https?:\/\/(?:www\.)?genspark\.ai/gi,
  gsk: /\bgsk\b/gi,
}

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.scratch',
  'coverage',
  'dist',
  'evidence',
  'node_modules',
  'out',
  'release',
  'reports',
  'tests',
])

function lineHash(line) {
  return createHash('sha256').update(line.trim()).digest('hex')
}

async function walk(root, files = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path, files)
    } else {
      files.push(path)
    }
  }
  return files
}

function isProductionFile(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/')
  if (rel.startsWith('packages/acceptance-evidence/')) return false
  if (rel === 'package.json' || rel === 'package-lock.json') return true
  if (rel.startsWith('.github/')) return SOURCE_EXTENSIONS.has(extname(path))
  if (!rel.startsWith('apps/') && !rel.startsWith('packages/')) return false
  return (
    rel.includes('/src/') ||
    basename(path) === 'package.json' ||
    basename(path) === 'electron-builder.cjs'
  )
}

export async function scanGensparkProduction(repoRootInput) {
  const repoRoot = resolve(repoRootInput)
  const roots = ['apps', 'packages', '.github']
  const candidates = [join(repoRoot, 'package.json'), join(repoRoot, 'package-lock.json')]
  for (const root of roots) {
    try {
      candidates.push(...(await walk(join(repoRoot, root))))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const files = []
  let totalOccurrences = 0
  for (const path of [...new Set(candidates)].filter((file) => isProductionFile(repoRoot, file))) {
    if (!SOURCE_EXTENSIONS.has(extname(path))) continue
    let content
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const matchedLines = []
    let fileOccurrences = 0
    for (const line of content.split(/\r?\n/)) {
      for (const [category, pattern] of Object.entries(PATTERNS)) {
        const count = [...line.matchAll(pattern)].length
        if (count === 0) continue
        matchedLines.push(`${category}:${count}:${lineHash(line)}`)
        fileOccurrences += count
        totalOccurrences += count
      }
    }
    if (fileOccurrences > 0) {
      files.push({
        file: relative(repoRoot, path).split(sep).join('/'),
        totalOccurrences: fileOccurrences,
        fingerprint: createHash('sha256').update(matchedLines.sort().join('\n')).digest('hex'),
      })
    }
  }

  files.sort((left, right) => left.file.localeCompare(right.file))
  return { schemaVersion: 1, totalOccurrences, files }
}

export async function auditGensparkProduction(repoRoot, options) {
  const scan = await scanGensparkProduction(repoRoot)
  const violations = []

  if (options.mode === 'zero') {
    for (const file of scan.files) {
      violations.push({ code: 'genspark_occurrence_remaining', file: file.file })
    }
  } else if (options.mode === 'baseline' && options.baseline?.schemaVersion === 1) {
    const allowed = new Map(options.baseline.files.map((file) => [file.file, file]))
    for (const file of scan.files) {
      const previous = allowed.get(file.file)
      if (!previous || previous.fingerprint !== file.fingerprint) {
        violations.push({ code: 'genspark_legacy_growth', file: file.file })
      }
    }
  } else {
    violations.push({ code: 'genspark_audit_mode_invalid', file: '.' })
  }

  return {
    schemaVersion: 1,
    mode: options.mode,
    status: violations.length === 0 ? 'passed' : 'failed',
    totalOccurrences: scan.totalOccurrences,
    filesScannedWithOccurrences: scan.files.length,
    violations,
  }
}
