import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

const FORBIDDEN = [/genspark/i, /@genspark\/cli/i, /\bgsk_/i]
const REQUIRED_SURFACES = ['agent', 'ocr', 'search', 'image', 'media', 'slide', 'project']
const ROUTE_TOKENS = {
  agent: ['session.opened'],
  ocr: ['mineru'],
  search: ['platform:web_search'],
  image: ['platform:image_search', 'generate_image'],
  media: ['platform:analyze_media'],
  slide: ['commit_slide_page'],
  project: ['project.trust.grant'],
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalized(root, path) {
  return relative(root, path).split(sep).join('/')
}

async function collectTreeFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

async function installedManifests(repoRoot) {
  const root = join(repoRoot, 'node_modules')
  const manifests = []
  async function visitPackage(path) {
    const manifest = join(path, 'package.json')
    try {
      manifests.push(manifest)
      await readFile(manifest)
    } catch (error) {
      manifests.pop()
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await visitModules(join(path, 'node_modules'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  async function visitModules(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const child = join(path, entry.name)
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (scoped.isDirectory()) await visitPackage(join(child, scoped.name))
        }
      } else if (entry.isDirectory()) {
        await visitPackage(child)
      }
    }
  }
  await visitModules(root)
  return manifests.sort()
}

function findings(path, bytes) {
  const text = bytes.toString('latin1')
  return FORBIDDEN.some((pattern) => pattern.test(text))
    ? [{ code: 'retired_vendor_match', path, sha256: sha256(bytes) }]
    : []
}

function parseRecorderEvents(text) {
  if (!text.trim()) return []
  return text
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
}

export async function auditPackagedGensparkFree(options) {
  const repoRoot = resolve(options.repoRoot)
  const resourcesRoot = resolve(options.resourcesRoot)
  const [resourcePaths, dependencyPaths, lockBytes, rootPackageBytes] = await Promise.all([
    collectTreeFiles(resourcesRoot),
    installedManifests(repoRoot),
    readFile(join(repoRoot, 'package-lock.json')),
    readFile(join(repoRoot, 'package.json')),
  ])
  const violations = []
  const routeHits = Object.fromEntries(REQUIRED_SURFACES.map((surface) => [surface, []]))
  for (const path of resourcePaths) {
    const bytes = await readFile(path)
    const relativePath = normalized(resourcesRoot, path)
    violations.push(...findings(`resources/${relativePath}`, bytes))
    const text = bytes.toString('latin1').toLowerCase()
    for (const [surface, tokens] of Object.entries(ROUTE_TOKENS)) {
      if (tokens.every((token) => text.includes(token))) routeHits[surface].push(relativePath)
    }
  }
  for (const [path, bytes] of [
    ['package.json', rootPackageBytes],
    ['package-lock.json', lockBytes],
  ]) {
    violations.push(...findings(path, bytes))
  }
  for (const path of dependencyPaths) {
    const bytes = await readFile(path)
    violations.push(
      ...findings(`node_modules/${normalized(join(repoRoot, 'node_modules'), path)}`, bytes),
    )
  }

  const recorderEvents = parseRecorderEvents(options.recorderText)
  const instrumented = new Set(
    recorderEvents.filter((event) => event.kind === 'instrumented').map((event) => event.surface),
  )
  const attempts = recorderEvents.filter((event) => event.kind === 'network_attempt')
  for (const event of attempts) {
    if (
      typeof event.hostname !== 'string' ||
      FORBIDDEN.some((pattern) => pattern.test(event.hostname))
    ) {
      violations.push({ code: 'retired_vendor_network_attempt', path: event.surface ?? 'unknown' })
    }
  }
  if (!instrumented.has('agent') || !instrumented.has('network-routes')) {
    violations.push({ code: 'network_recorder_surface_missing', path: 'network-recorder.jsonl' })
  }

  const smokeRoutes = new Map(
    Array.isArray(options.networkSmoke?.routes)
      ? options.networkSmoke.routes.map((route) => [route.surface, route])
      : [],
  )
  if (options.networkSmoke?.status !== 'passed') {
    violations.push({ code: 'network_smoke_failed', path: 'native-network-smoke' })
  }
  for (const surface of REQUIRED_SURFACES) {
    if (routeHits[surface].length === 0) {
      violations.push({ code: 'packaged_route_missing', path: surface })
    }
    if (surface !== 'agent' && !smokeRoutes.has(surface)) {
      violations.push({ code: 'network_smoke_route_missing', path: surface })
    }
  }
  for (const route of smokeRoutes.values()) {
    for (const host of route.hosts ?? []) {
      if (FORBIDDEN.some((pattern) => pattern.test(String(host)))) {
        violations.push({ code: 'retired_vendor_smoke_host', path: route.surface })
      }
    }
  }

  return {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    commit: options.commit ?? null,
    platform: options.platform,
    arch: options.arch,
    scans: {
      rootManifests: 2,
      installedManifests: dependencyPaths.length,
      packagedFiles: resourcePaths.length,
      unexplainedMatches: violations.filter((item) => item.code === 'retired_vendor_match').length,
    },
    network: {
      recorderProcesses: recorderEvents.filter((event) => event.kind === 'instrumented').length,
      attempts: attempts.length,
      retiredVendorAttempts: violations.filter(
        (item) => item.code === 'retired_vendor_network_attempt',
      ).length,
      surfaces: REQUIRED_SURFACES,
    },
    routes: Object.fromEntries(
      REQUIRED_SURFACES.map((surface) => [
        surface,
        {
          packaged: routeHits[surface].length > 0,
          evidenceFiles: routeHits[surface].map((path) => ({
            name: basename(path),
            pathSha256: sha256(path),
          })),
          ...(surface === 'agent' ? { mode: 'fake-provider' } : smokeRoutes.get(surface)),
        },
      ]),
    ),
    violations,
  }
}

export { parseRecorderEvents }
