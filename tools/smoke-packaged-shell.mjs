import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import {
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

let electronApp
try {
  electronApp = await electron.launch({
    executablePath: resolve(executable),
    args: platform === 'linux' ? ['--no-sandbox'] : [],
    env: {
      ...process.env,
      HOME: cleanHome,
      USERPROFILE: cleanHome,
      GENOFFICE_USER_DATA: userData,
      GENOFFICE_PACKAGE_NETWORK_AUDIT: '1',
      GENOFFICE_PACKAGE_AGENT_RESOURCE_HOME: join(cleanHome, '.open-genoffice'),
      GENOFFICE_NETWORK_REPORT: networkReportPath,
      GENOFFICE_NETWORK_SURFACE: 'shell-first-launch',
    },
    timeout: packageShellLaunchTimeout(platform),
  })
  const page = await electronApp.firstWindow({ timeout: 30_000 })
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

  const paths = await electronApp.evaluate(
    ({ app }, expected) => ({
      installed: app.isPackaged,
      userDataIsolated: app.getPath('userData') === expected.userData,
    }),
    { userData },
  )
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
  await within(electronApp.close(), 15_000, 'package_shell_shutdown_timeout')
  electronApp = undefined

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
  if (electronApp) {
    await within(electronApp.close(), 5_000, 'package_shell_force_close').catch(() => {
      electronApp.process().kill()
    })
  }
  await rm(scratch, { recursive: true, force: true })
}
