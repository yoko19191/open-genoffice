import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseProtocolFrame } from '@genoffice/agent-runtime-protocol'
import { verifyPiRuntimeBundle, type VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { createInstalledPiRuntimeService, createPiRuntimeManager } from '../src'

const execFileAsync = promisify(execFile)

async function buildCopiedRuntime(root: string): Promise<VerifiedPiRuntimeBundle> {
  const notices = join(root, 'THIRD-PARTY-NOTICES.txt')
  const outputDirectory = join(root, 'bundle')
  await writeFile(notices, 'Runtime E2E fixture notices\n')
  const repoRoot = resolve(import.meta.dirname, '../../..')
  await execFileAsync(
    process.execPath,
    [
      'tools/build-pi-runtime-bundle.mjs',
      '--output',
      outputDirectory,
      '--node-executable',
      process.execPath,
      '--node-license',
      resolve(dirname(process.execPath), '../LICENSE'),
      '--entry',
      resolve(repoRoot, 'apps/pi-agent-runtime/src/main.ts'),
      '--lockfile',
      resolve(repoRoot, 'package-lock.json'),
      '--notices',
      notices,
      '--platform',
      process.platform,
      '--arch',
      process.arch,
    ],
    { cwd: repoRoot },
  )
  return verifyPiRuntimeBundle(outputDirectory, {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    arch: process.arch as 'arm64' | 'x64',
  })
}

describe('copied Pi Runtime end to end', () => {
  it('verifies, spawns, authenticates, queries, and shuts down without residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-e2e-'))
    const verified = await buildCopiedRuntime(root)
    const diagnostics: string[] = []
    const manager = createPiRuntimeManager({
      bundle: verified,
      platform: process.platform,
      parentPid: process.pid,
      startupTimeoutMs: 5_000,
      diagnostic: (code) => diagnostics.push(code),
    })

    const health = await manager.start()
    expect(health.pid).toBeGreaterThan(0)
    await expect(manager.status()).resolves.toEqual(health)
    await manager.shutdown()
    expect(manager.state).toBe('stopped')
    expect(diagnostics).toEqual([])
    expect(() => process.kill(health.pid, 0)).toThrow()

    const service = createInstalledPiRuntimeService({
      bundleRoot: verified.root,
      platform: process.platform,
      arch: process.arch as 'arm64' | 'x64',
      parentPid: process.pid,
      startupTimeoutMs: 5_000,
    })
    await expect(service.initialize()).resolves.toMatchObject({ state: 'ready' })
    await service.shutdown()
    expect(service.health()).toMatchObject({ state: 'stopped' })

    await rm(root, { recursive: true, force: true })
  })

  it('runs debug stdio with a disposable HOME, fake credentials, and blocked network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-debug-e2e-'))
    const verified = await buildCopiedRuntime(root)
    const home = join(root, 'home')
    const temporaryDirectory = join(root, 'tmp')
    const legacyHome = join(home, '.open-genoffice')
    const canary = join(home, 'real-home-canary')
    const networkBlocker = join(root, 'block-network.cjs')
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(temporaryDirectory, { recursive: true }),
    ])
    await Promise.all([
      writeFile(canary, 'must remain unread and unchanged\n'),
      writeFile(
        networkBlocker,
        [
          "const net = require('node:net')",
          "const http = require('node:http')",
          "const https = require('node:https')",
          "const fail = () => { throw new Error('network_forbidden') }",
          'net.connect = fail',
          'net.createConnection = fail',
          'http.request = fail',
          'http.get = fail',
          'https.request = fail',
          'https.get = fail',
          'globalThis.fetch = fail',
          "require('node:module').syncBuiltinESMExports()",
        ].join('\n'),
      ),
    ])

    const { stdout, stderr } = await execFileAsync(
      verified.executablePath,
      ['--require', networkBlocker, verified.entryPath, '--debug-stdio'],
      {
        env: {
          HOME: home,
          USERPROFILE: home,
          TMPDIR: temporaryDirectory,
          TMP: temporaryDirectory,
          TEMP: temporaryDirectory,
          CI: 'true',
        },
      },
    )
    const frames = stdout.trim().split('\n').map(parseProtocolFrame)
    expect(frames).toHaveLength(9)
    expect(frames[0]).toMatchObject({ kind: 'event', type: 'session.opened' })
    expect(frames.at(-1)).toMatchObject({ kind: 'event', type: 'run.completed' })
    expect(stderr).toBe('')
    expect(await readFile(canary, 'utf8')).toBe('must remain unread and unchanged\n')
    await expect(access(legacyHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(temporaryDirectory)).toEqual([])

    await rm(root, { recursive: true, force: true })
  })
})
