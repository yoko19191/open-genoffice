import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type BootstrapRecord,
} from '@genoffice/agent-runtime-protocol'
import { RUNTIME_EXIT_CODES, RuntimeBootstrapError, runRuntimeProcess } from '../src'

async function endpoint(): Promise<string> {
  const socketRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(socketRoot, 'genoffice-runtime-process-'))
  await chmod(directory, 0o700)
  return join(directory, 'runtime.sock')
}

function bootstrap(socketPath: string): BootstrapRecord {
  return {
    kind: 'bootstrap',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parentPid: 6160,
    endpoint: socketPath,
    token: 'e'.repeat(64),
  }
}

describe('Runtime process entry', () => {
  it('maps orderly parent EOF to exit 0 and removes the endpoint', async () => {
    const socketPath = await endpoint()
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    const running = runRuntimeProcess({
      stdin,
      stderr,
      actualParentPid: 6160,
      instanceId: 'process-instance-1',
    })
    stdin.end(`${JSON.stringify(bootstrap(socketPath))}\n`)
    await expect(running).resolves.toBe(RUNTIME_EXIT_CODES.ok)
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes only the stable diagnostic code for known and unknown failures', async () => {
    for (const failure of [
      new RuntimeBootstrapError('invalid_bootstrap', RUNTIME_EXIT_CODES.bootstrap),
      new Error('private endpoint and token detail'),
    ]) {
      const stderr = new PassThrough()
      let output = ''
      stderr.on('data', (chunk) => {
        output += chunk.toString('utf8')
      })
      const exitCode = await runRuntimeProcess({
        stdin: new PassThrough(),
        stderr,
        actualParentPid: 6160,
        instanceId: 'process-instance-error',
        startRuntime: async () => {
          throw failure
        },
      })
      expect(exitCode).toBe(
        failure instanceof RuntimeBootstrapError
          ? RUNTIME_EXIT_CODES.bootstrap
          : RUNTIME_EXIT_CODES.crash,
      )
      expect(output).toBe(
        `${JSON.stringify({
          code: failure instanceof RuntimeBootstrapError ? 'invalid_bootstrap' : 'runtime_crash',
        })}\n`,
      )
      expect(output).not.toContain('private endpoint')
    }
  })
})
