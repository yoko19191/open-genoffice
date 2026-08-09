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
  parseCredentialBrokerRequest,
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

function resultResponse(requestFrame: ProtocolEnvelope, result: unknown): string {
  if (requestFrame.kind !== 'request') throw new Error('expected_request')
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    id: requestFrame.id,
    correlationId: requestFrame.correlationId,
    result,
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
  it('carries Runtime-initiated credential storage over the authenticated socket only', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-credential',
    })
    const client = await connect(socketPath)
    const reader = frameReader(client)
    client.write(`${hello()}\n`)
    await reader.next((frame) => frame.kind === 'response' && frame.id === 'runtime.hello')

    const credential = { type: 'api_key' as const, key: 'authenticated-socket-secret-canary' }
    const saving = runtime.credentials.modify('openai', async () => credential)
    const getRequest = await reader.next(
      (frame) => frame.kind === 'request' && frame.method === 'credential.get',
    )
    client.write(`${resultResponse(getRequest, null)}\n`)
    const putRequest = await reader.next(
      (frame) => frame.kind === 'request' && frame.method === 'credential.put',
    )
    const trustedPut = parseCredentialBrokerRequest(putRequest)
    expect(trustedPut).toMatchObject({
      params: {
        slot: 'model/openai/default',
        providerId: 'openai',
        kind: 'api_key',
        expectedGeneration: 0,
      },
    })
    const storedPayload =
      trustedPut.method === 'credential.put' ? trustedPut.params.secretPayload : ''
    client.write(
      `${resultResponse(putRequest, {
        credentialId: '11111111-1111-4111-8111-111111111111',
        slot: 'model/openai/default',
        providerId: 'openai',
        kind: 'api_key',
        generation: 1,
        status: 'available',
      })}\n`,
    )
    await expect(saving).resolves.toEqual(credential)
    expect(storedPayload).toBe(JSON.stringify(credential))

    const reading = runtime.credentials.read('openai')
    const readRequest = await reader.next(
      (frame) => frame.kind === 'request' && frame.method === 'credential.get',
    )
    client.write(
      `${resultResponse(readRequest, {
        metadata: {
          credentialId: '11111111-1111-4111-8111-111111111111',
          slot: 'model/openai/default',
          providerId: 'openai',
          kind: 'api_key',
          generation: 1,
          status: 'available',
        },
        secretPayload: storedPayload,
      })}\n`,
    )
    await expect(reading).resolves.toEqual(credential)

    await runtime.shutdown()
    await runtime.closed
  })

  it('accepts write-only credential management while keeping status responses redacted', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-credential-management',
    })
    const client = await connect(socketPath)
    const reader = frameReader(client)
    client.write(`${hello()}\n`)
    await reader.next((frame) => frame.kind === 'response' && frame.id === 'runtime.hello')

    client.write(
      `${request(
        'credential.put',
        {
          providerId: 'openai',
          persistence: 'memory_only',
          secretPayload: '{"type":"api_key","key":"management-secret-canary"}',
        },
        'management-put',
      )}\n`,
    )
    const brokerStatus = await reader.next(
      (frame) => frame.kind === 'request' && frame.method === 'credential.status',
    )
    client.write(
      `${resultResponse(brokerStatus, {
        slot: 'model/openai/default',
        status: 'secure_storage_unavailable',
      })}\n`,
    )
    const putResponse = await reader.next(
      (frame) => frame.kind === 'response' && frame.id === 'management-put',
    )
    expect(putResponse).toMatchObject({
      result: {
        providerId: 'openai',
        persistence: 'memory_only',
        status: 'available',
        kind: 'api_key',
      },
    })
    expect(JSON.stringify(putResponse)).not.toContain('management-secret-canary')

    client.write(`${request('credential.status', { providerId: 'openai' }, 'management-status')}\n`)
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'management-status'),
    ).toMatchObject({ result: { status: 'available', persistence: 'memory_only' } })

    client.write(`${request('credential.delete', { providerId: 'openai' }, 'management-delete')}\n`)
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'management-delete'),
    ).toMatchObject({ result: { status: 'missing', persistence: 'persistent' } })

    await runtime.shutdown()
    await runtime.closed
  })

  it('manages a persistent credential through broker CAS and returns stable errors', async () => {
    const socketPath = await endpoint()
    const runtime = await createAuthenticatedRuntimeServer({
      bootstrap: bootstrap(socketPath),
      actualParentPid: 4242,
      instanceId: 'instance-persistent-credential-management',
    })
    const client = await connect(socketPath)
    const reader = frameReader(client)
    client.write(`${hello()}\n`)
    await reader.next((frame) => frame.kind === 'response' && frame.id === 'runtime.hello')
    const metadata = {
      credentialId: '22222222-2222-4222-8222-222222222222',
      slot: 'model/openai/default',
      providerId: 'openai',
      kind: 'api_key',
      generation: 1,
      status: 'available',
    } as const

    client.write(
      `${request(
        'credential.put',
        {
          providerId: 'openai',
          persistence: 'persistent',
          secretPayload: '{"type":"api_key","key":"persistent-management-canary"}',
        },
        'persistent-put',
      )}\n`,
    )
    const getRequest = await reader.next(
      (frame) => frame.kind === 'request' && frame.method === 'credential.get',
    )
    client.write(`${resultResponse(getRequest, null)}\n`)
    const putRequest = await reader.next(
      (frame) =>
        frame.kind === 'request' && frame.method === 'credential.put' && 'slot' in frame.params,
    )
    client.write(`${resultResponse(putRequest, metadata)}\n`)
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'persistent-put'),
    ).toMatchObject({ result: { status: 'available', persistence: 'persistent' } })

    client.write(`${request('credential.status', { providerId: 'openai' }, 'persistent-status')}\n`)
    const statusRequest = await reader.next(
      (frame) =>
        frame.kind === 'request' && frame.method === 'credential.status' && 'slot' in frame.params,
    )
    client.write(`${resultResponse(statusRequest, metadata)}\n`)
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'persistent-status'),
    ).toMatchObject({ result: { status: 'available', kind: 'api_key' } })

    client.write(`${request('credential.delete', { providerId: 'openai' }, 'persistent-delete')}\n`)
    const deleteStatusRequest = await reader.next(
      (frame) =>
        frame.kind === 'request' && frame.method === 'credential.status' && 'slot' in frame.params,
    )
    client.write(`${resultResponse(deleteStatusRequest, metadata)}\n`)
    const deleteRequest = await reader.next(
      (frame) =>
        frame.kind === 'request' && frame.method === 'credential.delete' && 'slot' in frame.params,
    )
    client.write(
      `${resultResponse(deleteRequest, {
        slot: metadata.slot,
        generation: metadata.generation,
        status: 'deleted',
      })}\n`,
    )
    expect(
      await reader.next((frame) => frame.kind === 'response' && frame.id === 'persistent-delete'),
    ).toMatchObject({ result: { status: 'missing' } })

    client.write(
      `${request(
        'credential.put',
        {
          providerId: 'openai',
          persistence: 'persistent',
          secretPayload: '{"type":"api_key","key":42}',
        },
        'invalid-credential-put',
      )}\n`,
    )
    expect(
      await reader.next(
        (frame) => frame.kind === 'response' && frame.id === 'invalid-credential-put',
      ),
    ).toMatchObject({ error: { code: 'credential_payload_invalid' } })

    await runtime.shutdown()
    await runtime.closed
  })

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
          'credential.put',
          'credential.status',
          'credential.delete',
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
