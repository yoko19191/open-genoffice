import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type BootstrapRecord,
} from '@genoffice/agent-runtime-protocol'
import {
  PI_SUBAGENT_AGENT_DIR_ENV,
  RUNTIME_EXIT_CODES,
  RuntimeBootstrapError,
  runRuntimeProcess,
} from '../src'

async function endpoint(): Promise<string> {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\genoffice-runtime-process-${randomUUID()}`
  }
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
    const resourceHome = join(tmpdir(), `genoffice-resource-process-${randomUUID()}`)
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    const running = runRuntimeProcess({
      stdin,
      stderr,
      actualParentPid: 6160,
      instanceId: 'process-instance-1',
      resourceHome,
    })
    stdin.end(`${JSON.stringify(bootstrap(socketPath))}\n`)
    await expect(running).resolves.toBe(RUNTIME_EXIT_CODES.ok)
    if (process.platform !== 'win32') {
      await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(JSON.parse(await readFile(join(resourceHome, 'schema.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      createdByRuntimeVersion: RUNTIME_VERSION,
    })
  })

  it('initializes the explicit Resource Home before starting the private server', async () => {
    const calls: string[] = []
    const runtime = {
      closed: Promise.resolve(),
      shutdown: async () => {},
      credentials: new InMemoryCredentialStore(),
    }
    const previousAgentDirectory = process.env[PI_SUBAGENT_AGENT_DIR_ENV]
    process.env[PI_SUBAGENT_AGENT_DIR_ENV] = '/external/pi-agent'
    try {
      await expect(
        runRuntimeProcess({
          stdin: new PassThrough(),
          stderr: new PassThrough(),
          actualParentPid: 6160,
          instanceId: 'process-instance-resource-home',
          platform: 'linux',
          resourceHome: '/isolated/.open-genoffice',
          initializeResourceHome: async (options) => {
            calls.push(
              `resource:${options.rootDirectory}:${options.runtimeVersion}:${options.platform}`,
            )
          },
          startRuntime: async (options) => {
            expect(options.resourceHome).toBe('/isolated/.open-genoffice')
            expect(process.env[PI_SUBAGENT_AGENT_DIR_ENV]).toBe(
              join('/isolated/.open-genoffice', 'state', 'subagent-pi-agent'),
            )
            calls.push('runtime')
            return runtime
          },
        }),
      ).resolves.toBe(RUNTIME_EXIT_CODES.ok)
      expect(calls).toEqual(['resource:/isolated/.open-genoffice:1.0.0:linux', 'runtime'])
      expect(process.env[PI_SUBAGENT_AGENT_DIR_ENV]).toBe('/external/pi-agent')
    } finally {
      if (previousAgentDirectory === undefined) delete process.env[PI_SUBAGENT_AGENT_DIR_ENV]
      else process.env[PI_SUBAGENT_AGENT_DIR_ENV] = previousAgentDirectory
    }
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
        initializeResourceHome: async () => {},
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
import { randomUUID } from 'node:crypto'
