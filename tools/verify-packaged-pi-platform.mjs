import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  piCliCommandRelativePath,
  SUBAGENT_SMOKE_ENTRY_RELATIVE_PATH,
  verifyPiRuntimeBundle,
} from '@genoffice/pi-runtime-bundle'
import { auditPackagedGensparkFree } from '../packages/acceptance-evidence/src/genspark-package-audit.mjs'

const execFileAsync = promisify(execFile)
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || value === undefined) {
    process.stderr.write('packaged_pi_platform_arguments_invalid\n')
    process.exit(1)
  }
  values.set(name, value)
}

const resources = values.get('--resources')
const platform = values.get('--platform')
const arch = values.get('--arch')
const output = values.get('--output')
if (
  !resources ||
  !['darwin', 'win32', 'linux'].includes(platform) ||
  !['arm64', 'x64'].includes(arch) ||
  !output
) {
  process.stderr.write('packaged_pi_platform_arguments_invalid\n')
  process.exit(1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function collectFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error('packaged_pi_platform_link_forbidden')
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) files.push(path)
      else throw new Error('packaged_pi_platform_file_invalid')
    }
  }
  await visit(root)
  return files
}

const networkRecorderPath = resolve(import.meta.dirname, 'package-network-recorder.cjs')

async function run(executable, args, surface, networkReportPath) {
  const preload = `--require=${networkRecorderPath.split('\\').join('/')}`
  return execFileAsync(executable, args, {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      GENOFFICE_NETWORK_REPORT: networkReportPath,
      GENOFFICE_NETWORK_SURFACE: surface,
    },
  })
}

try {
  const resourcesRoot = resolve(resources)
  const outputPath = resolve(output)
  const evidenceDirectory = dirname(outputPath)
  const networkReportPath = join(evidenceDirectory, 'network.jsonl')
  const retiredVendorFreePath = join(evidenceDirectory, 'retired-vendor-free.json')
  await mkdir(evidenceDirectory, { recursive: true })
  await rm(networkReportPath, { force: true })
  const runtimeRoot = join(resourcesRoot, 'pi-runtime')
  const verified = await verifyPiRuntimeBundle(runtimeRoot, { platform, arch })
  const [sbomBytes, files] = await Promise.all([
    readFile(join(resourcesRoot, 'sbom.cdx.json')),
    collectFiles(resourcesRoot),
  ])
  const sbom = JSON.parse(sbomBytes.toString('utf8'))
  const componentNames = new Set(
    Array.isArray(sbom.components) ? sbom.components.map((component) => component?.name) : [],
  )
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.5' ||
    !componentNames.has('node') ||
    !componentNames.has('pi-agent-runtime')
  ) {
    throw new Error('packaged_pi_platform_sbom_invalid')
  }
  for (const updateConfig of ['app-update.yml', 'app-update.yaml']) {
    if (await lstat(join(resourcesRoot, updateConfig)).catch(() => undefined)) {
      throw new Error('packaged_pi_platform_update_feed_present')
    }
  }
  const forbidden = ['genspark', '@genspark/cli', 'gsk_']
  for (const path of files) {
    const text = (await readFile(path)).toString('latin1').toLowerCase()
    if (forbidden.some((token) => text.includes(token))) {
      throw new Error('packaged_pi_platform_retired_vendor_present')
    }
  }

  const piCommand = join(runtimeRoot, ...piCliCommandRelativePath(platform).split('/'))
  const piVersion = (await run(piCommand, ['--version'], 'agent', networkReportPath)).stdout.trim()
  if (piVersion !== verified.manifest.piVersion) {
    throw new Error('packaged_pi_platform_pi_version_mismatch')
  }
  const capability = JSON.parse(
    (
      await run(
        verified.executablePath,
        [verified.capabilitySmokeEntryPath],
        'agent',
        networkReportPath,
      )
    ).stdout,
  )
  const subagent = JSON.parse(
    (
      await run(
        verified.executablePath,
        [join(runtimeRoot, ...SUBAGENT_SMOKE_ENTRY_RELATIVE_PATH.split('/'))],
        'agent',
        networkReportPath,
      )
    ).stdout,
  )
  const networkSmoke = JSON.parse(
    (
      await run(
        verified.executablePath,
        [verified.networkSmokeEntryPath],
        'network-routes',
        networkReportPath,
      )
    ).stdout,
  )
  const debugFrames = (
    await run(
      verified.executablePath,
      [verified.entryPath, '--debug-stdio'],
      'agent',
      networkReportPath,
    )
  ).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  if (
    capability.status !== 'passed' ||
    subagent.status !== 'passed' ||
    networkSmoke.status !== 'passed' ||
    !debugFrames.some((frame) => frame.type === 'session.opened') ||
    debugFrames.at(-1)?.type !== 'run.completed'
  ) {
    throw new Error('packaged_pi_platform_smoke_failed')
  }
  const glibcVersion =
    platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime : undefined
  if (platform === 'linux' && !glibcVersion) {
    throw new Error('packaged_pi_platform_glibc_missing')
  }
  const retiredVendorFree = await auditPackagedGensparkFree({
    repoRoot: resolve(import.meta.dirname, '..'),
    resourcesRoot,
    recorderText: await readFile(networkReportPath, 'utf8'),
    networkSmoke,
    commit: process.env.GITHUB_SHA ?? null,
    platform,
    arch,
  })
  await writeFile(retiredVendorFreePath, `${JSON.stringify(retiredVendorFree, null, 2)}\n`)
  if (retiredVendorFree.status !== 'passed') {
    throw new Error('packaged_pi_platform_genspark_free_failed')
  }

  const evidence = {
    schemaVersion: 1,
    status: 'passed',
    commit: process.env.GITHUB_SHA ?? null,
    platform,
    arch,
    unsigned: true,
    libc: platform === 'linux' ? { family: 'glibc', version: glibcVersion } : null,
    updateFeedEmbedded: false,
    retiredVendorMatches: 0,
    retiredVendorFree: {
      reportSha256: sha256(await readFile(retiredVendorFreePath)),
      installedManifests: retiredVendorFree.scans.installedManifests,
      packagedFiles: retiredVendorFree.scans.packagedFiles,
      networkAttempts: retiredVendorFree.network.attempts,
      networkSurfaces: retiredVendorFree.network.surfaces,
    },
    runtime: {
      version: verified.manifest.runtimeVersion,
      protocolVersion: verified.manifest.protocolVersion,
      nodeVersion: verified.manifest.nodeVersion,
      piVersion,
      manifestSha256: verified.manifestSha256,
      treeSha256: verified.manifest.treeSha256,
    },
    sbom: {
      format: sbom.bomFormat,
      specVersion: sbom.specVersion,
      sha256: sha256(sbomBytes),
      components: sbom.components.length,
    },
    smoke: {
      piEsm: capability.piEsm === true,
      extension: capability.extension,
      mcp: capability.mcp?.tool,
      subagent: subagent.result,
      reconciled: subagent.reconciled,
      debugFrames: debugFrames.length,
      terminal: debugFrames.at(-1)?.type,
    },
  }
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify({
      status: evidence.status,
      platform: evidence.platform,
      arch: evidence.arch,
      manifestSha256: evidence.runtime.manifestSha256,
      sbomSha256: evidence.sbom.sha256,
    })}\n`,
  )
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'packaged_pi_platform_verification_failed'}\n`,
  )
  process.exit(1)
}
