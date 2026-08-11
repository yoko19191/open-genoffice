import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const windowsIt = process.platform === 'win32' ? it : it.skip

type ProcessFixture = {
  runtimePid: number
  grandchildPid: number
}

function readFixture(stream: Readable): Promise<ProcessFixture> {
  return new Promise((resolve, reject) => {
    let pending = ''
    stream.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      const newline = pending.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(pending.slice(0, newline)))
    })
    stream.once('error', reject)
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectGone(pids: readonly number[], deadlineMs = 5_000) {
  const deadline = Date.now() + deadlineMs
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(pids.filter(alive)).toEqual([])
}

async function exit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

describe('Windows kill-on-close Job Object launcher', () => {
  windowsIt(
    'reclaims an EOF-resistant child and grandchild across all fault boundaries',
    async () => {
      const launcher = process.env.GENOFFICE_WINDOWS_JOB_LAUNCHER
      const censusOutput = process.env.GENOFFICE_WINDOWS_CENSUS_OUTPUT
      if (!launcher || !censusOutput)
        throw new Error('windows_job_launcher_test_environment_missing')

      const root = await mkdtemp(join(tmpdir(), 'genoffice-job-object-'))
      const fixture = join(root, 'ignore-eof-grandchild.mjs')
      await writeFile(
        fixture,
        [
          "import { spawn } from 'node:child_process'",
          "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })",
          'process.stdout.write(`${JSON.stringify({ runtimePid: process.pid, grandchildPid: grandchild.pid })}\\n`)',
          'process.stdin.resume()',
          "process.stdin.on('end', () => setInterval(() => {}, 1000))",
          'setInterval(() => {}, 1000)',
        ].join('\n'),
      )

      const scenarios: Array<{ name: string; passed: true; deadlineMs: number }> = []
      const launch = () =>
        spawn(launcher, ['--owner-pid', String(process.pid), '--', process.execPath, fixture], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })

      const uiStop = launch()
      const uiStopFixture = await readFixture(uiStop.stdout!)
      const uiStopStartedAt = Date.now()
      await execFileAsync('taskkill.exe', ['/PID', String(uiStopFixture.runtimePid), '/T', '/F'])
      await expectGone([uiStopFixture.runtimePid, uiStopFixture.grandchildPid])
      await exit(uiStop)
      scenarios.push({
        name: 'ui-stop-taskkill-tree',
        passed: true,
        deadlineMs: Date.now() - uiStopStartedAt,
      })

      const runtimeCrash = launch()
      const crashFixture = await readFixture(runtimeCrash.stdout!)
      const crashStartedAt = Date.now()
      process.kill(crashFixture.runtimePid)
      await expectGone([crashFixture.runtimePid, crashFixture.grandchildPid])
      await exit(runtimeCrash)
      scenarios.push({
        name: 'runtime-crash-job-close',
        passed: true,
        deadlineMs: Date.now() - crashStartedAt,
      })

      const ownerScript = join(root, 'hard-exit-owner.mjs')
      await writeFile(
        ownerScript,
        [
          "import { spawn } from 'node:child_process'",
          'const [launcher, fixture] = process.argv.slice(2)',
          "spawn(launcher, ['--owner-pid', String(process.pid), '--', process.execPath, fixture], { stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true })",
          'setTimeout(() => process.exit(73), 250)',
        ].join('\n'),
      )
      const owner = spawn(process.execPath, [ownerScript, launcher, fixture], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const ownerFixture = await readFixture(owner.stdout!)
      await exit(owner)
      const ownerExitStartedAt = Date.now()
      await expectGone([ownerFixture.runtimePid, ownerFixture.grandchildPid])
      scenarios.push({
        name: 'electron-hard-exit-job-close',
        passed: true,
        deadlineMs: Date.now() - ownerExitStartedAt,
      })

      expect(scenarios.every((scenario) => scenario.deadlineMs < 5_000)).toBe(true)
      await mkdir(dirname(censusOutput), { recursive: true })
      await writeFile(
        censusOutput,
        `${JSON.stringify({ schemaVersion: 1, platform: 'windows', scenarios }, null, 2)}\n`,
      )
    },
    20_000,
  )
})
