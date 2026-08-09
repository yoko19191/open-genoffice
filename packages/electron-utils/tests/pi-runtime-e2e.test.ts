import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { verifyPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { createPiRuntimeManager } from '../src'

const execFileAsync = promisify(execFile)

describe('copied Pi Runtime end to end', () => {
  it('verifies, spawns, authenticates, queries, and shuts down without residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-runtime-e2e-'))
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
    const verified = await verifyPiRuntimeBundle(outputDirectory, {
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      arch: process.arch as 'arm64' | 'x64',
    })
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

    await rm(root, { recursive: true, force: true })
  })
})
