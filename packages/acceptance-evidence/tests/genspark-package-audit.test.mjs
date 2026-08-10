import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { auditPackagedGensparkFree, parseRecorderEvents } from '../src/genspark-package-audit.mjs'

const execFileAsync = promisify(execFile)
const routeText = [
  'session.opened',
  'mineru',
  'platform:web_search',
  'platform:image_search generate_image',
  'platform:analyze_media',
  'commit_slide_page',
  'project.trust.grant',
].join('\n')
const smoke = {
  status: 'passed',
  routes: ['ocr', 'search', 'image']
    .map((surface) => ({
      surface,
      mode: 'fetch-intercepted',
      hosts: [`${surface}.example`],
    }))
    .concat(
      ['media', 'slide', 'project'].map((surface) => ({
        surface,
        mode: 'local-only',
        hosts: [],
      })),
    ),
}

async function fixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'genspark-package-audit-'))
  const resourcesRoot = join(repoRoot, 'resources')
  await mkdir(join(repoRoot, 'node_modules', 'clean'), { recursive: true })
  await mkdir(join(repoRoot, 'node_modules', 'clean', 'node_modules', 'nested'), {
    recursive: true,
  })
  await mkdir(join(repoRoot, 'node_modules', 'missing-manifest'), { recursive: true })
  await mkdir(join(repoRoot, 'node_modules', '.cache'), { recursive: true })
  await mkdir(join(repoRoot, 'node_modules', '@scope', 'clean'), { recursive: true })
  await mkdir(resourcesRoot)
  await writeFile(join(repoRoot, 'package.json'), '{"name":"clean"}')
  await writeFile(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}')
  await writeFile(join(repoRoot, 'node_modules', 'clean', 'package.json'), '{"name":"clean"}')
  await writeFile(
    join(repoRoot, 'node_modules', 'clean', 'node_modules', 'nested', 'package.json'),
    '{"name":"nested"}',
  )
  await writeFile(
    join(repoRoot, 'node_modules', '@scope', 'clean', 'package.json'),
    '{"name":"@scope/clean"}',
  )
  await symlink(join(repoRoot, 'node_modules', 'clean'), join(repoRoot, 'node_modules', 'linked'))
  await writeFile(join(resourcesRoot, 'app.asar'), routeText)
  await symlink(join(resourcesRoot, 'app.asar'), join(resourcesRoot, 'ignored-link'))
  return { repoRoot, resourcesRoot }
}

function recorder(...events) {
  return events.map((event) => JSON.stringify({ schemaVersion: 1, pid: 1, ...event })).join('\n')
}

describe('packaged Genspark-Free audit', () => {
  it('scans dependency manifests, installed resources, routes, and instrumented network smoke', async () => {
    const paths = await fixture()
    const report = await auditPackagedGensparkFree({
      ...paths,
      recorderText: recorder(
        { kind: 'instrumented', surface: 'agent' },
        { kind: 'instrumented', surface: 'network-routes' },
        {
          kind: 'network_attempt',
          surface: 'agent',
          hostname: 'approved.example',
          outcome: 'blocked',
        },
      ),
      networkSmoke: smoke,
      commit: 'a'.repeat(40),
      platform: 'darwin',
      arch: 'arm64',
    })
    expect(report).toMatchObject({
      status: 'passed',
      commit: 'a'.repeat(40),
      scans: { rootManifests: 2, unexplainedMatches: 0 },
      network: { attempts: 1, retiredVendorAttempts: 0 },
      violations: [],
    })
    expect(Object.values(report.routes).every((route) => route.packaged)).toBe(true)
    expect(report.scans.installedManifests).toBeGreaterThanOrEqual(3)
    expect(report.routes.search.hosts).toEqual(['search.example'])
    expect(report.routes.agent.mode).toBe('fake-provider')
  })

  it('fails closed on dependency, resource, recorder, route, and smoke violations', async () => {
    const paths = await fixture()
    await writeFile(
      join(paths.repoRoot, 'node_modules', 'clean', 'package.json'),
      '{"name":"@genspark/cli"}',
    )
    await writeFile(join(paths.resourcesRoot, 'app.asar'), 'genspark')
    const report = await auditPackagedGensparkFree({
      ...paths,
      recorderText: recorder(
        {
          kind: 'network_attempt',
          surface: 'agent',
          hostname: 'api.genspark.example',
        },
        { kind: 'network_attempt', surface: 'unknown' },
      ),
      networkSmoke: {
        status: 'failed',
        routes: [{ surface: 'ocr' }, { surface: 'image', hosts: ['genspark.example'] }],
      },
      platform: 'linux',
      arch: 'x64',
    })
    expect(report.status).toBe('failed')
    expect(new Set(report.violations.map((item) => item.code))).toEqual(
      new Set([
        'network_recorder_surface_missing',
        'network_smoke_failed',
        'network_smoke_route_missing',
        'packaged_route_missing',
        'retired_vendor_match',
        'retired_vendor_network_attempt',
        'retired_vendor_smoke_host',
      ]),
    )
    expect(report.scans.unexplainedMatches).toBe(2)

    const missingSmoke = await auditPackagedGensparkFree({
      ...paths,
      recorderText: recorder(
        { kind: 'instrumented', surface: 'agent' },
        { kind: 'instrumented', surface: 'network-routes' },
      ),
      platform: 'linux',
      arch: 'x64',
    })
    expect(missingSmoke.violations.some((item) => item.code === 'network_smoke_failed')).toBe(true)
  })

  it('records and blocks remote DNS/HTTP while preserving local and unconfigured processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-network-recorder-'))
    const reportPath = join(root, 'events.jsonl')
    const recorderPath = resolve(import.meta.dirname, '../../../tools/package-network-recorder.cjs')
    const script = [
      "const dns = require('node:dns')",
      "for (const call of [() => fetch('https://remote.invalid'), () => dns.lookup('remote.invalid')]) {",
      '  try { call() } catch (error) { if (error.code !== "GENOFFICE_PACKAGE_NETWORK_FORBIDDEN") process.exit(2) }',
      '}',
      "require('node:http').get('http://localhost').on('error', () => {})",
    ].join('\n')
    await execFileAsync(process.execPath, ['-r', recorderPath, '-e', script], {
      env: {
        ...process.env,
        GENOFFICE_NETWORK_REPORT: reportPath,
        GENOFFICE_NETWORK_SURFACE: 'network-routes',
      },
    })
    const events = parseRecorderEvents(await readFile(reportPath, 'utf8'))
    expect(events.filter((event) => event.kind === 'instrumented')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'network_attempt')).toMatchObject([
      { protocol: 'fetch', hostname: 'remote.invalid', outcome: 'blocked' },
      { protocol: 'dns', hostname: 'remote.invalid', outcome: 'blocked' },
    ])
    await expect(
      execFileAsync(process.execPath, ['-r', recorderPath, '-e', 'process.exit(0)']),
    ).resolves.toBeDefined()
    expect(parseRecorderEvents('')).toEqual([])
    expect(() => parseRecorderEvents('{')).toThrow()
  })
})
