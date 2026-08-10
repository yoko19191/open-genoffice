import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, chromium } from 'playwright'
import {
  packageShellLaunchArgs,
  packageShellLaunchStrategy,
  packageShellLaunchTimeout,
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

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
  if (!address || typeof address === 'string') throw new Error('package_shell_cdp_port_invalid')
  return address.port
}

async function waitForCdp(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('package_shell_process_exited')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      })
      const version = response.ok ? await response.json() : undefined
      if (typeof version?.webSocketDebuggerUrl === 'string') return
    } catch {
      // The packaged app is still starting; retry until the same bounded launch deadline.
    }
    await delay(100)
  }
  throw new Error('package_shell_cdp_timeout')
}

async function waitForCdpPage(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())[0]
    if (page) return page
    await delay(100)
  }
  throw new Error('package_shell_window_timeout')
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

  const port = await reserveLoopbackPort()
  const child = spawn(resolve(executable), packageShellLaunchArgs(platform, userData, port), {
    env,
    stdio: 'ignore',
    windowsHide: true,
  })
  const exited = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  )
  const failed = new Promise((_, reject) =>
    child.once('error', () => reject(new Error('package_shell_process_start_failed'))),
  )
  await Promise.race([waitForCdp(port, child, packageShellLaunchTimeout(platform)), failed])
  const browser = await within(
    chromium.connectOverCDP(`http://127.0.0.1:${port}`),
    packageShellLaunchTimeout(platform),
    'package_shell_cdp_connect_timeout',
  )
  const page = await waitForCdpPage(browser, 30_000)
  return {
    page,
    readPaths: async () => {
      const version = await page.evaluate(() => globalThis.aiOffice?.getAppVersion?.())
      return {
        installed: typeof version === 'string' && version.length > 0,
        userDataIsolated: (await readdir(userData)).length > 0,
      }
    },
    close: async () => {
      await page.close()
      const result = await exited
      if (result.code !== 0 || result.signal !== null) {
        throw new Error('package_shell_process_exit_invalid')
      }
      await browser.close().catch(() => undefined)
    },
    forceClose: async () => {
      await browser.close().catch(() => undefined)
      if (child.exitCode === null) child.kill()
    },
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
    await new Promise((done) => setTimeout(done, 100))
  }

  const paths = await shellDriver.readPaths()
  const quickActions = await page.locator('.quick-card').evaluateAll((buttons) =>
    buttons.map((button) => ({
      label: button.querySelector('.quick-title')?.textContent?.trim() ?? '',
      disabled: button.tagName === 'BUTTON' && button.disabled === true,
    })),
  )
  const bodyText = await page.locator('body').innerText()
  const mineru = await within(
    page.evaluate(() => globalThis.aiOfficeMineruOcr.status()),
    10_000,
    'package_shell_mineru_timeout',
  )
  const models = await within(
    page.evaluate(() => globalThis.aiOfficeAgent.modelCatalog()),
    10_000,
    'package_shell_models_timeout',
  )
  const mcp = await within(
    page.evaluate(() => globalThis.aiOfficeAgent.mcpCatalog()),
    10_000,
    'package_shell_mcp_timeout',
  )
  const packages = await within(
    page.evaluate(() => globalThis.aiOfficeAgent.packageCatalog('global')),
    10_000,
    'package_shell_packages_timeout',
  )
  const resources = await within(
    page.evaluate(() => globalThis.aiOfficeAgent.resourceCatalog()),
    10_000,
    'package_shell_resources_timeout',
  )

  await page.screenshot({ path: screenshotPath, fullPage: true })
  const screenshotSha256 = createHash('sha256')
    .update(await readFile(screenshotPath))
    .digest('hex')
  await within(shellDriver.close(), 15_000, 'package_shell_shutdown_timeout')
  shellDriver = undefined

  const networkEvents = (await readFile(networkReportPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const homeEntries = await readdir(cleanHome)
  const report = validatePackageShellSmoke({
    ...paths,
    resourceHomeIsolated: homeEntries.includes('.open-genoffice'),
    health,
    quickActions,
    bodyText,
    mineru,
    models,
    mcp,
    packages,
    resources,
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
  await rm(scratch, { recursive: true, force: true })
}
