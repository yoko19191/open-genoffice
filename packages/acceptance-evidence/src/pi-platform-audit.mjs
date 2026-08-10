import { access, readdir, readFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

const APPROVED_VERSIONS = {
  '@agwab/pi-subagent': '0.4.8',
  '@aws-sdk/client-s3': '3.1106.0',
  '@earendil-works/pi-agent-core': '0.84.0',
  '@earendil-works/pi-ai': '0.84.0',
  '@earendil-works/pi-coding-agent': '0.84.0',
  '@earendil-works/pi-tui': '0.84.0',
  '@modelcontextprotocol/client': '2.0.0',
  '@sinclair/typebox': '0.34.52',
  fflate: '0.8.2',
  tar: '7.5.22',
  webdav: '5.10.0',
}

const RUNTIME_DEPENDENCIES = {
  '@agwab/pi-subagent': '0.4.8',
  '@earendil-works/pi-agent-core': '0.84.0',
  '@earendil-works/pi-ai': '0.84.0',
  '@earendil-works/pi-coding-agent': '0.84.0',
  '@earendil-works/pi-tui': '0.84.0',
  '@genoffice/agent-resource': '*',
  '@genoffice/agent-runtime-protocol': '*',
  '@modelcontextprotocol/client': '2.0.0',
  fflate: '0.8.2',
  tar: '7.5.22',
}

const FORBIDDEN_DEPENDENCIES = ['@agwab/pi-workflow', 'oh-my-pi', 'pi-mcp-adapter', 'pi-mcporter']

const FORBIDDEN_SOURCE = [
  /@genspark\/cli/i,
  /\bgenspark\b/i,
  /\bgsk\b/i,
  /cloudpptx/i,
  /\bAgentLoop\b/,
  /\butilityProcess\b/,
  /\bnpx\b/,
]

const FORBIDDEN_IMPLICIT_NETWORK_SOURCE = [/\bfetch\s*\(/, /node:https?/, /https?:\/\//]

const EXPLICIT_NETWORK_SOURCE = new Set([
  'apps/pi-agent-runtime/src/mcp-oauth-controller.ts',
  'apps/pi-agent-runtime/src/package-source-resolver.ts',
])

const CODEX_IMAGE_PROVIDER_SOURCE = 'apps/pi-agent-runtime/src/codex-oauth-image-provider.ts'
const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const PLATFORM_SEARCH_SOURCE = 'apps/pi-agent-runtime/src/platform-tool-service.ts'
const PLATFORM_TOOL_SCHEMA_SOURCE = 'packages/agent-runtime-protocol/src/platform-tool-catalog.ts'
const PLATFORM_SEARCH_ENDPOINTS = [
  'https://google.serper.dev/search',
  'https://google.serper.dev/images',
  'https://html.duckduckgo.com/html/',
  'https://duckduckgo.com/i.js',
  'https://duckduckgo.com/',
]

function containsForbiddenNetworkSource(relativePath, content) {
  if (EXPLICIT_NETWORK_SOURCE.has(relativePath)) return false
  if (relativePath === PLATFORM_TOOL_SCHEMA_SOURCE) {
    return [/\bfetch\s*\(/, /node:https?/].some((pattern) => pattern.test(content))
  }
  let inspected = content
  if (relativePath === CODEX_IMAGE_PROVIDER_SOURCE) {
    inspected = inspected
      .split(CODEX_RESPONSES_ENDPOINT)
      .join('approved-codex-responses-endpoint')
      .split('this.fetch(RESPONSES_ENDPOINT,')
      .join('approvedCodexResponsesRequest(')
  }
  if (relativePath === PLATFORM_SEARCH_SOURCE && inspected.includes('safeHttpsUrl')) {
    for (const endpoint of PLATFORM_SEARCH_ENDPOINTS) {
      inspected = inspected.split(endpoint).join('approved-platform-search-endpoint')
    }
    const calls = inspected.split('this.fetch(url,').length - 1
    if (calls === 1) inspected = inspected.replace('this.fetch(url,', 'approvedPlatformRequest(')
  }
  return FORBIDDEN_IMPLICIT_NETWORK_SOURCE.some((pattern) => pattern.test(inspected))
}

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
])

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function walk(root, predicate, files = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path, predicate, files)
    } else if (predicate(path)) files.push(path)
  }
  return files
}

function sameRecord(left, right) {
  return (
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  )
}

function packageNameFromLockPath(path) {
  const marker = 'node_modules/'
  const index = path.lastIndexOf(marker)
  return index === -1 ? null : path.slice(index + marker.length)
}

export async function auditPiPlatformBoundary(repoRootInput) {
  const repoRoot = resolve(repoRootInput)
  const violations = []
  const rootPackage = await readJson(join(repoRoot, 'package.json'))
  const runtimePackage = await readJson(join(repoRoot, 'apps/pi-agent-runtime/package.json'))
  const lock = await readJson(join(repoRoot, 'package-lock.json'))

  if (rootPackage.engines?.node !== '22.19.0') {
    violations.push({
      code: 'node_version_mismatch',
      path: 'package.json',
      message: 'Node must be pinned to 22.19.0',
    })
  }

  if (!sameRecord(runtimePackage.dependencies ?? {}, RUNTIME_DEPENDENCIES)) {
    violations.push({
      code: 'runtime_dependency_set_mismatch',
      path: 'apps/pi-agent-runtime/package.json',
      message: 'Runtime dependencies differ from the approved exact set',
    })
  }

  const installed = new Map()
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    const name = packageNameFromLockPath(path)
    if (!name) continue
    if (!installed.has(name)) installed.set(name, new Set())
    installed.get(name).add(metadata.version)
  }

  for (const [name, expected] of Object.entries(APPROVED_VERSIONS)) {
    const versions = [...(installed.get(name) ?? [])]
    if (versions.length === 0 || versions.some((version) => version !== expected)) {
      violations.push({
        code: 'version_mismatch',
        path: 'package-lock.json',
        message: `${name} must resolve only to ${expected}`,
      })
    }
  }

  for (const name of FORBIDDEN_DEPENDENCIES) {
    if (installed.has(name)) {
      violations.push({
        code: 'forbidden_dependency',
        path: 'package-lock.json',
        message: `${name} is forbidden in the first Pi release`,
      })
    }
  }

  const lockfiles = (
    await walk(repoRoot, (path) =>
      ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(
        basename(path),
      ),
    )
  )
    .map((path) => relative(repoRoot, path).split('\\').join('/'))
    .sort()
  if (lockfiles.length !== 1 || lockfiles[0] !== 'package-lock.json') {
    violations.push({
      code: 'multiple_lockfiles',
      path: '.',
      message: 'The root package-lock.json must be the only JavaScript lockfile',
    })
  }

  const sourceRoots = [
    join(repoRoot, 'apps/pi-agent-runtime/src'),
    join(repoRoot, 'packages/agent-resource/src'),
    join(repoRoot, 'packages/agent-runtime-protocol/src'),
    join(repoRoot, 'packages/pi-runtime-bundle/src'),
  ]
  const sourceFiles = []
  for (const root of sourceRoots) {
    sourceFiles.push(
      ...(await walk(root, (path) => ['.js', '.mjs', '.ts'].includes(extname(path)))),
    )
  }
  for (const path of [
    join(repoRoot, 'packages/electron-utils/src/pi-runtime-manager.ts'),
    join(repoRoot, 'packages/electron-utils/src/pi-runtime-node.ts'),
    join(repoRoot, 'packages/electron-utils/src/pi-runtime-service.ts'),
    join(repoRoot, 'apps/shell/src/shared/pi-runtime-api.ts'),
  ]) {
    try {
      await access(path)
      sourceFiles.push(path)
    } catch {
      // Older fixtures and pre-migration checkouts do not have the new manager yet.
    }
  }
  for (const path of sourceFiles) {
    const content = await readFile(path, 'utf8')
    const relativePath = relative(repoRoot, path).split('\\').join('/')
    if (
      FORBIDDEN_SOURCE.some((pattern) => pattern.test(content)) ||
      containsForbiddenNetworkSource(relativePath, content)
    ) {
      violations.push({
        code: 'production_source_forbidden',
        path: relativePath,
        message: 'New platform production source contains a forbidden runtime or network marker',
      })
    }
  }

  return {
    schemaVersion: 1,
    status: violations.length === 0 ? 'passed' : 'failed',
    lockfiles,
    filesScanned: sourceFiles.length,
    violations,
  }
}
