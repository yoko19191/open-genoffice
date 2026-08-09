import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type BootstrapRecord,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import { createAuthenticatedRuntimeServer } from '../src'

const token = 'a'.repeat(64)

async function endpoint(): Promise<string> {
  const socketRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(socketRoot, 'genoffice-runtime-'))
  await chmod(directory, 0o700)
  return join(directory, 'runtime.sock')
}

function bootstrap(socketPath: string): BootstrapRecord {
  return {
    kind: 'bootstrap',
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
    parentPid: 4242,
    endpoint: socketPath,
    token,
  }
}

function request(method: string, params: unknown, id = method) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id,
    method,
    correlationId: `correlation-${id}`,
    params,
  })
}

function hello(value = token): string {
  return request('runtime.hello', {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
    token: value,
  })
}

async function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => resolve(socket))
    socket.once('error', reject)
  })
}

async function nextLine(socket: Socket): Promise<ResponseEnvelope | null> {
  return new Promise((resolve, reject) => {
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      const newline = pending.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(pending.slice(0, newline)))
    })
    socket.once('close', () => resolve(null))
    socket.once('error', reject)
  })
}

describe('authenticated Runtime socket', () => {
  it('does not consume the token after a rejected hello, then serves status and shutdown', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-1',
    })
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)

    const attacker = await connect(socketPath)
    attacker.end(`${hello('b'.repeat(64))}\n`)
    expect(await nextLine(attacker)).toBeNull()

    const client = await connect(socketPath)
    const helloResponsePromise = nextLine(client)
    client.write(`${hello()}\n`)
    expect(await helloResponsePromise).toMatchObject({
      kind: 'response',
      result: { instanceId: 'instance-1', capabilities: ['runtime.status', 'runtime.shutdown'] },
    })

    const statusPromise = nextLine(client)
    client.write(`${request('runtime.status', {})}\n`)
    expect(await statusPromise).toMatchObject({
      kind: 'response',
      result: { instanceId: 'instance-1', runtimeVersion: RUNTIME_VERSION },
    })

    const shutdownPromise = nextLine(client)
    client.write(`${request('runtime.shutdown', {})}\n`)
    expect(await shutdownPromise).toMatchObject({
      kind: 'response',
      result: { shuttingDown: true },
    })
    await runtime.closed
  })

  it('rejects parent PID mismatch before creating the endpoint', async () => {
    const socketPath = await endpoint()
    await expect(
      createAuthenticatedRuntimeServer({
        bootstrap: bootstrap(socketPath),
        actualParentPid: 7,
        instanceId: 'instance-2',
      }),
    ).rejects.toThrow('invalid_parent_pid')
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects every second connection after consuming the token', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-3',
      platform: 'win32',
    })
    const first = await connect(socketPath)
    const firstResponse = nextLine(first)
    first.write(`${hello()}\n`)
    expect(await firstResponse).toMatchObject({
      kind: 'response',
      result: { instanceId: 'instance-3' },
    })

    const reused = await connect(socketPath)
    expect(await nextLine(reused)).toBeNull()
    const shutdown = runtime.shutdown()
    expect(runtime.shutdown()).toBe(shutdown)
    await shutdown
    await runtime.closed
  })

  it('rejects malformed, non-request, and post-authentication unknown frames', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-4',
    })

    const malformed = await connect(socketPath)
    malformed.end('{not-json}\n')
    expect(await nextLine(malformed)).toBeNull()

    const nonRequest = await connect(socketPath)
    nonRequest.end(
      `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: 'response-before-hello',
        correlationId: 'correlation-response-before-hello',
        result: {},
      })}\n`,
    )
    expect(await nextLine(nonRequest)).toBeNull()

    const client = await connect(socketPath)
    const helloResponsePromise = nextLine(client)
    client.write(`${hello()}\n`)
    expect(await helloResponsePromise).toMatchObject({
      kind: 'response',
      result: { instanceId: 'instance-4' },
    })

    const rejectedRequest = nextLine(client)
    client.end(`${hello()}\n`)
    expect(await rejectedRequest).toBeNull()
    await runtime.shutdown()
    await runtime.closed
  })
})
