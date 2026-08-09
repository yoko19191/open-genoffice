import { randomUUID } from 'node:crypto'
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
  type ProtocolEnvelope,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import { createAuthenticatedRuntimeServer, createSessionRegistry } from '../src'

const token = 'a'.repeat(64)

async function endpoint(): Promise<string> {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\genoffice-runtime-${randomUUID()}`
  }
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

function hello(
  value = token,
  versions: {
    protocolVersion?: string
    runtimeVersion?: string
    schemaVersion?: string
  } = {},
): string {
  return request('runtime.hello', {
    protocolVersion: versions.protocolVersion ?? PROTOCOL_VERSION,
    runtimeVersion: versions.runtimeVersion ?? RUNTIME_VERSION,
    schemaVersion: versions.schemaVersion ?? SCHEMA_VERSION,
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

function frameReader(socket: Socket) {
  let pending = ''
  const frames: ProtocolEnvelope[] = []
  const waiters: Array<() => void> = []
  socket.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    const lines = pending.split('\n')
    pending = lines.pop()!
    frames.push(...lines.filter(Boolean).map((line) => JSON.parse(line) as ProtocolEnvelope))
    for (const wake of waiters.splice(0)) wake()
  })
  return {
    async next(predicate: (frame: ProtocolEnvelope) => boolean): Promise<ProtocolEnvelope> {
      for (;;) {
        const index = frames.findIndex(predicate)
        if (index !== -1) return frames.splice(index, 1)[0]!
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

describe('authenticated Runtime socket', () => {
  it('does not consume the token after a rejected hello, then serves status and shutdown', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-1',
    })
    if (process.platform !== 'win32') expect((await stat(socketPath)).mode & 0o777).toBe(0o600)

    const attacker = await connect(socketPath)
    attacker.end(`${hello('b'.repeat(64))}\n`)
    expect(await nextLine(attacker)).toBeNull()

    const client = await connect(socketPath)
    const helloResponsePromise = nextLine(client)
    client.write(`${hello()}\n`)
    expect(await helloResponsePromise).toMatchObject({
      kind: 'response',
      result: {
        instanceId: 'instance-1',
        capabilities: [
          'runtime.status',
          'runtime.shutdown',
          'session.create',
          'session.open',
          'session.prompt',
          'session.abort',
          'session.snapshot',
          'session.subscribe',
        ],
      },
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

  it('rejects every mismatched hello version without consuming the token', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-version',
    })

    for (const versions of [
      { protocolVersion: '999' },
      { runtimeVersion: '999.0.0' },
      { schemaVersion: '999' },
    ]) {
      const incompatible = await connect(socketPath)
      incompatible.end(`${hello(token, versions)}\n`)
      expect(await nextLine(incompatible)).toBeNull()
    }

    const compatible = await connect(socketPath)
    const response = nextLine(compatible)
    compatible.write(`${hello()}\n`)
    expect(await response).toMatchObject({
      kind: 'response',
      result: { instanceId: 'instance-version' },
    })
    await runtime.shutdown()
    await runtime.closed
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

  it('carries create, prompt, snapshot, subscribe, idempotency, and document errors over one socket', async () => {
    const socketPath = await endpoint()
    const dataRoot = await mkdtemp(join(tmpdir(), 'genoffice-runtime-session-e2e-'))
    let uuid = 0
    const registry = createSessionRegistry({
      dataRoot,
      instanceId: 'instance-session',
      cursorSecret: Buffer.alloc(32, 9),
      randomUUID: () => {
        uuid += 1
        return `${String(uuid).padStart(8, '0')}-0000-4000-8000-000000000000`
      },
      now: () => new Date('2026-08-09T12:00:00.000Z'),
    })
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-session',
      sessionRegistry: registry,
    })
    const client = await connect(socketPath)
    const reader = frameReader(client)
    client.write(`${hello()}\n`)
    await reader.next((frame) => frame.kind === 'response' && frame.id === 'runtime.hello')

    const createId = 'session-create'
    client.write(
      `${request(
        'session.create',
        {
          operationId: '11111111-1111-4111-8111-111111111111',
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        },
        createId,
      )}\n`,
    )
    const opened = await reader.next(
      (frame) => frame.kind === 'event' && frame.type === 'session.opened',
    )
    const created = await reader.next((frame) => frame.kind === 'response' && frame.id === createId)
    expect(opened).toMatchObject({
      kind: 'event',
      sequence: 1,
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    expect(created).toMatchObject({
      kind: 'response',
      result: { documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' },
    })
    const sessionId = (created as ResponseEnvelope & { result: { sessionId: string } }).result
      .sessionId

    client.write(
      `${request(
        'session.prompt',
        {
          operationId: '22222222-2222-4222-8222-222222222222',
          sessionId,
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          text: 'run through the authenticated socket',
        },
        'session-prompt',
      )}\n`,
    )
    const queued = await reader.next(
      (frame) => frame.kind === 'event' && frame.type === 'run.queued',
    )
    const promptReceipt = await reader.next(
      (frame) => frame.kind === 'response' && frame.id === 'session-prompt',
    )
    const completed = await reader.next(
      (frame) => frame.kind === 'event' && frame.type === 'run.completed',
    )
    expect(
      [queued, completed].map((frame) => (frame.kind === 'event' ? frame.sequence : 0)),
    ).toEqual([2, expect.any(Number)])
    expect(promptReceipt).toMatchObject({ kind: 'response', result: { runId: expect.any(String) } })

    client.write(
      `${request('session.snapshot', { sessionId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }, 'snapshot')}\n`,
    )
    const snapshot = await reader.next(
      (frame) => frame.kind === 'response' && frame.id === 'snapshot',
    )
    expect(snapshot).toMatchObject({ kind: 'response', result: { sessionId } })
    const snapshotResult = (
      snapshot as ResponseEnvelope & {
        result: { cursor: string; messages: Array<{ role: string }> }
      }
    ).result
    expect(snapshotResult.messages[0]).toMatchObject({ role: 'user' })
    const cursor = snapshotResult.cursor

    client.write(
      `${request(
        'session.subscribe',
        { sessionId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', afterCursor: cursor },
        'subscribe',
      )}\n`,
    )
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'subscribe'),
    ).toMatchObject({ kind: 'response', result: { resetRequired: false, events: [] } })

    client.write(
      `${request(
        'session.open',
        {
          operationId: '33333333-3333-4333-8333-333333333333',
          sessionId,
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        },
        'mismatch',
      )}\n`,
    )
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'mismatch'),
    ).toMatchObject({ kind: 'response', error: { code: 'document_mismatch' } })

    client.write(`${request('session.close', {}, 'unsupported')}\n`)
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'unsupported'),
    ).toMatchObject({ kind: 'response', error: { code: 'method_not_found' } })

    client.write(`${request('runtime.shutdown', {}, 'shutdown')}\n`)
    await reader.next((frame) => frame.kind === 'response' && frame.id === 'shutdown')
    await runtime.closed
  })
})
