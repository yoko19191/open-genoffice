import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import {
  packageShellAuditEndpoint,
  packageShellLaunchArgs,
  packageShellLaunchStrategy,
  packageShellLaunchTimeout,
  packageShellShutdownTimeout,
  validatePackageShellSmoke,
} from '../packages/acceptance-evidence/src/package-shell-smoke.mjs'

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (!name?.startsWith('--') || value === undefined) {
    process.stderr.write('package_shell_smoke_arguments_invalid\n')
    process.exit(1)
  }
  values.set(name, value)
}

const executable = values.get('--executable')
const platform = values.get('--platform')
const output = values.get('--output')
if (!executable || !['darwin', 'win32', 'linux'].includes(platform) || !output) {
  process.stderr.write('package_shell_smoke_arguments_invalid\n')
  process.exit(1)
}

const outputPath = resolve(output)
const evidenceDirectory = dirname(outputPath)
const scratch = await mkdtemp(join(tmpdir(), 'genoffice-package-shell-'))
const cleanHome = join(scratch, 'home')
const userData = join(scratch, 'user-data')
const networkReportPath = join(scratch, 'network.jsonl')
const screenshotPath = join(evidenceDirectory, 'first-launch.png')
await Promise.all([
  mkdir(cleanHome),
  mkdir(userData),
  mkdir(evidenceDirectory, { recursive: true }),
])

async function within(promise, timeoutMs, code) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const delay = (timeoutMs) => new Promise((done) => setTimeout(done, timeoutMs))

function packageAuditRequest(endpoint, token, operation, timeoutMs, onConnect = () => {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(endpoint)
    let body = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) rejectRequest(error)
      else resolveRequest(value)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(timeoutMs, () => finish(new Error('package_shell_audit_request_timeout')))
    socket.once('connect', () => {
      onConnect()
      socket.write(`${JSON.stringify({ schemaVersion: 1, token, operation })}\n`)
    })
    socket.on('data', (chunk) => {
      body += chunk
      if (body.length > 32 * 1024 * 1024) {
        finish(new Error('package_shell_audit_response_too_large'))
        return
      }
      const newline = body.indexOf('\n')
      if (newline < 0) return
      try {
        finish(undefined, JSON.parse(body.slice(0, newline)))
      } catch {
        finish(new Error('package_shell_audit_response_invalid'))
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => {
      if (!settled) finish(new Error('package_shell_audit_response_missing'))
    })
  })
}

async function waitForAuditSnapshot(child, endpoint, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let endpointObserved = false
  let unavailableObserved = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('package_shell_process_exited')
    let response
    try {
      response = await packageAuditRequest(
        endpoint,
        token,
        'snapshot',
        Math.max(1, deadline - Date.now()),
        () => {
          endpointObserved = true
        },
      )
    } catch {
      await delay(100)
      continue
    }
    if (response?.status === 'unavailable') {
      unavailableObserved = true
      await delay(100)
      continue
    }
    if (response?.status !== 'ok') throw new Error('package_shell_audit_snapshot_rejected')
    const snapshot = response.snapshot
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('package_shell_audit_snapshot_invalid')
    }
    return snapshot
  }
  if (!endpointObserved) throw new Error('package_shell_audit_endpoint_timeout')
  if (unavailableObserved) throw new Error('package_shell_audit_unavailable_timeout')
  throw new Error('package_shell_audit_snapshot_timeout')
}

async function launchShell(env) {
  if (packageShellLaunchStrategy(platform) === 'electron') {
    const app = await electron.launch({
      executablePath: resolve(executable),
      args: packageShellLaunchArgs(platform, userData),
      env,
      timeout: packageShellLaunchTimeout(platform),
    })
    return {
      page: await app.firstWindow({ timeout: 30_000 }),
      readPaths: () =>
        app.evaluate(
          ({ app: electronApplication }, expected) => ({
            installed: electronApplication.isPackaged,
            userDataIsolated: electronApplication.getPath('userData') === expected.userData,
          }),
          { userData },
        ),
      close: () => app.close(),
      forceClose: async () => {
        await app.close().catch(() => app.process().kill())
      },
    }
  }

  const auditToken = randomBytes(32).toString('hex')
  const auditEndpoint = packageShellAuditEndpoint(
    process.platform,
    process.platform === 'win32' ? scratch : '/tmp',
    randomBytes(16).toString('hex'),
  )
  const child = spawn(resolve(executable), packageShellLaunchArgs(platform, userData), {
    env: {
      ...env,
      GENOFFICE_PACKAGE_AUDIT_TOKEN: auditToken,
      GENOFFICE_PACKAGE_AUDIT_ENDPOINT: auditEndpoint,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let processOutput = ''
  const collectProcessOutput = (stream, label) => {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => {
      processOutput = `${processOutput}[${label}] ${chunk}`.slice(-16 * 1024)
    })
  }
  collectProcessOutput(child.stdout, 'stdout')
  collectProcessOutput(child.stderr, 'stderr')
  const exited = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  )
  const failed = new Promise((_, reject) =>
    child.once('error', () => reject(new Error('package_shell_process_start_failed'))),
  )
  const forceClose = async () => {
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5_000,
          windowsHide: true,
        })
      } else {
        child.kill('SIGKILL')
      }
    }
    child.unref()
    await Promise.race([exited, delay(2_000)])
    if (process.platform !== 'win32') await rm(auditEndpoint, { force: true })
  }
  try {
    const snapshot = await Promise.race([
      waitForAuditSnapshot(child, auditEndpoint, auditToken, packageShellLaunchTimeout(platform)),
      failed,
    ])
    return {
      snapshot,
      close: async () => {
        const acknowledgement = await packageAuditRequest(
          auditEndpoint,
          auditToken,
          'shutdown',
          5_000,
        )
        if (acknowledgement?.status !== 'ok' || acknowledgement.accepted !== true) {
          throw new Error('package_shell_shutdown_rejected')
        }
        const exitResult = await exited
        if (exitResult.code !== 0 || exitResult.signal !== null) {
          throw new Error('package_shell_process_exit_invalid')
        }
      },
      forceClose,
    }
  } catch (error) {
    await forceClose()
    const diagnostic = processOutput
      .replaceAll(auditToken, '[audit-token]')
      .replaceAll(auditEndpoint, '[audit-endpoint]')
      .replaceAll(scratch, '[scratch]')
      .trim()
    if (diagnostic) {
      throw new Error(
        `${error instanceof Error ? error.message : 'package_shell_smoke_failed'}:${JSON.stringify({ exitCode: child.exitCode, output: diagnostic })}`,
        { cause: error },
      )
    }
    throw error
  }
}

let shellDriver
try {
  shellDriver = await launchShell({
    ...process.env,
    HOME: cleanHome,
    USERPROFILE: cleanHome,
    GENOFFICE_USER_DATA: userData,
    GENOFFICE_PACKAGE_NETWORK_AUDIT: '1',
    GENOFFICE_PACKAGE_AGENT_RESOURCE_HOME: join(cleanHome, '.open-genoffice'),
    GENOFFICE_NETWORK_REPORT: networkReportPath,
    GENOFFICE_NETWORK_SURFACE: 'shell-first-launch',
  })
  let snapshot
  if ('page' in shellDriver) {
    const { page } = shellDriver
    await page.waitForLoadState('domcontentloaded')
    const skip = page.locator('.onb-skip')
    if (await skip.isVisible()) await skip.click()
    await page.locator('.quick-cards').waitFor({ state: 'visible', timeout: 15_000 })

    let health
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      health = await page.evaluate(() => globalThis.aiOfficeAgent.health())
      if (health.state === 'ready') break
      if (health.state === 'crashed' || health.state === 'unavailable') break
      await delay(100)
    }

    snapshot = {
      ...(await shellDriver.readPaths()),
      health,
      quickActions: await page.locator('.quick-card').evaluateAll((buttons) =>
        buttons.map((button) => ({
          label: button.querySelector('.quick-title')?.textContent?.trim() ?? '',
          disabled: button.tagName === 'BUTTON' && button.disabled === true,
        })),
      ),
      bodyText: await page.locator('body').innerText(),
      mineru: await within(
        page.evaluate(() => globalThis.aiOfficeMineruOcr.status()),
        10_000,
        'package_shell_mineru_timeout',
      ),
      models: await within(
        page.evaluate(() => globalThis.aiOfficeAgent.modelCatalog()),
        10_000,
        'package_shell_models_timeout',
      ),
      mcp: await within(
        page.evaluate(() => globalThis.aiOfficeAgent.mcpCatalog()),
        10_000,
        'package_shell_mcp_timeout',
      ),
      packages: await within(
        page.evaluate(() => globalThis.aiOfficeAgent.packageCatalog('global')),
        10_000,
        'package_shell_packages_timeout',
      ),
      resources: await within(
        page.evaluate(() => globalThis.aiOfficeAgent.resourceCatalog()),
        10_000,
        'package_shell_resources_timeout',
      ),
    }
    await page.screenshot({ path: screenshotPath, fullPage: true })
  } else {
    const { screenshotBase64, ...auditSnapshot } = shellDriver.snapshot
    if (typeof screenshotBase64 !== 'string') {
      throw new Error('package_shell_screenshot_invalid')
    }
    const screenshot = Buffer.from(screenshotBase64, 'base64')
    if (
      screenshot.length < 8 ||
      !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new Error('package_shell_screenshot_invalid')
    }
    snapshot = auditSnapshot
    await writeFile(screenshotPath, screenshot)
  }
  const screenshotSha256 = createHash('sha256')
    .update(await readFile(screenshotPath))
    .digest('hex')
  await within(
    shellDriver.close(),
    packageShellShutdownTimeout(platform),
    'package_shell_shutdown_timeout',
  )
  shellDriver = undefined

  const networkEvents = (await readFile(networkReportPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const homeEntries = await readdir(cleanHome)
  const report = validatePackageShellSmoke({
    ...snapshot,
    resourceHomeIsolated: homeEntries.includes('.open-genoffice'),
    homeEntries,
    networkEvents,
    screenshotSha256,
    shutdownCompleted: true,
  })
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        commit: process.env.GITHUB_SHA ?? null,
        platform,
        ...report,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ status: report.status, platform, runtimeState: report.runtimeState })}\n`,
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'package_shell_smoke_failed'}\n`)
  process.exitCode = 1
} finally {
  if (shellDriver) {
    await within(shellDriver.forceClose(), 5_000, 'package_shell_force_close').catch(
      () => undefined,
    )
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
