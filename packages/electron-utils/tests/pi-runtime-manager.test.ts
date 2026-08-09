import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  type BootstrapRecord,
  type RuntimeBundleManifest,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import {
  PiRuntimeManager,
  PiRuntimeManagerError,
  createPrivateRuntimeEndpoint,
  type PiRuntimeChild,
  type PiRuntimeManagerDependencies,
} from '../src'

function verifiedBundle(): VerifiedPiRuntimeBundle {
  const manifest = {
    runtimeName: RUNTIME_NAME,
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  } as RuntimeBundleManifest
  return Object.freeze({
    kind: 'verified-pi-runtime-bundle',
    root: '/installed/pi-agent-runtime',
    executablePath: '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
    entryPath: '/installed/pi-agent-runtime/app/main.mjs',
    capabilitySmokeEntryPath: '/installed/pi-agent-runtime/self-test/native-capability-smoke.mjs',
    windowsJobLauncherPath: '/installed/pi-agent-runtime/node/open-genoffice-job-launcher.exe',
    manifest,
    manifestSha256: 'f'.repeat(64),
  })
}

class FakeRuntimeSocket extends Duplex {
  constructor(
    private readonly bootstrap: () => BootstrapRecord,
    private readonly child: FakeRuntimeChild,
    private readonly options: ManagerHarnessOptions,
  ) {
    super()
  }

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const request = JSON.parse(chunk.toString('utf8').trim())
    const instanceId = 'runtime-instance-1'
    const runtimePid = this.options.helloPid ?? 8128
    if (this.options.prelude && request.method === 'runtime.hello') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: 'runtime-prelude',
          method: 'runtime.status',
          correlationId: 'runtime-prelude-correlation',
          params: {},
        })}\n`,
      )
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: 'unknown-response',
          correlationId: 'unknown-response-correlation',
          result: {},
        })}\n`,
      )
    }
    if (request.method === 'runtime.status' && this.options.statusMode === 'hang') {
      callback()
      return
    }
    if (request.method === 'runtime.status' && this.options.statusMode === 'protocol-error') {
      this.push('{invalid}\n')
      callback()
      return
    }
    const snapshot = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      messages: [],
      lastSequence: 1,
      cursor: 'cursor-1',
    }
    const defaultResult =
      request.method === 'runtime.hello'
        ? {
            pid: runtimePid,
            instanceId,
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
          }
        : request.method === 'runtime.status'
          ? { pid: runtimePid, instanceId, runtimeVersion: RUNTIME_VERSION }
          : request.method === 'session.create' || request.method === 'session.open'
            ? {
                sessionId: snapshot.sessionId,
                documentId: snapshot.documentId,
                snapshot,
                cursor: snapshot.cursor,
              }
            : request.method === 'session.prompt'
              ? { runId: 'run-1', acceptedCursor: 'cursor-1' }
              : request.method === 'session.abort'
                ? { runId: 'run-1', state: 'cancelling', acceptedCursor: 'cursor-2' }
                : request.method === 'session.snapshot'
                  ? snapshot
                  : request.method === 'session.subscribe'
                    ? { resetRequired: false, snapshot, events: [] }
                    : { shuttingDown: true }
    const result =
      request.method === 'runtime.hello' && 'helloResult' in this.options
        ? this.options.helloResult
        : request.method === 'runtime.status' && 'statusResult' in this.options
          ? this.options.statusResult
          : request.method.startsWith('session.') && 'sessionResult' in this.options
            ? this.options.sessionResult
            : defaultResult
    if (request.method === 'runtime.status' && this.options.statusMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'unavailable',
            message: 'unavailable',
            retryable: true,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    if (request.method.startsWith('session.') && this.options.sessionMode === 'error-response') {
      this.push(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: request.id,
          correlationId: request.correlationId,
          error: {
            code: 'unavailable',
            message: 'unavailable',
            retryable: true,
            correlationId: request.correlationId,
          },
        })}\n`,
      )
      callback()
      return
    }
    this.push(
      `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: request.id,
        correlationId: request.correlationId,
        result,
      })}\n`,
    )
    if (request.method === 'runtime.shutdown') {
      queueMicrotask(() => {
        this.push(null)
        this.child.emit('exit', 0, null)
      })
    }
    callback()
  }
}

type ManagerHarnessOptions = {
  helloPid?: number
  helloResult?: unknown
  statusResult?: unknown
  statusMode?: 'hang' | 'protocol-error' | 'error-response'
  prelude?: boolean
  endpointFailure?: boolean
  childError?: boolean
  sessionResult?: unknown
  sessionMode?: 'error-response'
}

class FakeRuntimeChild extends EventEmitter implements PiRuntimeChild {
  readonly pid = 8128
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly writes: string[] = []
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString('utf8'))
      callback()
    },
  })
  readonly kill = vi.fn(() => {
    this.emit('exit', null, 'SIGTERM')
    return true
  })
}

function managerHarness(options: ManagerHarnessOptions = {}) {
  const child = new FakeRuntimeChild()
  const cleanup = vi.fn(async () => {})
  const spawn = vi.fn(() => child)
  let parsedBootstrap: BootstrapRecord | undefined
  const dependencies: PiRuntimeManagerDependencies = {
    spawn,
    createEndpoint: vi.fn(async () => {
      if (options.endpointFailure) throw new Error('private endpoint detail')
      return {
        endpoint: '/private/runtime.sock',
        cleanup,
      }
    }),
    connect: vi.fn(async () => {
      parsedBootstrap = JSON.parse(child.writes[0]!)
      if (options.childError) {
        queueMicrotask(() => child.emit('error', new Error('private spawn detail')))
        return new Promise<FakeRuntimeSocket>(() => {})
      }
      return new FakeRuntimeSocket(() => parsedBootstrap!, child, options)
    }),
    randomBytes: vi.fn(() => Buffer.alloc(32, 0xab)),
    randomUUID: vi.fn(() => 'abababab-abab-4bab-8bab-abababababab'),
  }
  return { child, cleanup, dependencies, spawn, bootstrap: () => parsedBootstrap! }
}

describe('PiRuntimeManager', () => {
  it('starts only the verified executable, authenticates, serves health, and shuts down', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )

    const firstStart = manager.start()
    const secondStart = manager.start()
    await expect(firstStart).resolves.toMatchObject({
      state: 'ready',
      pid: 8128,
      instanceId: 'runtime-instance-1',
      runtimeVersion: RUNTIME_VERSION,
    })
    await expect(secondStart).resolves.toEqual(await firstStart)
    await expect(manager.start()).resolves.toEqual(await firstStart)
    expect(harness.spawn).toHaveBeenCalledTimes(1)
    expect(harness.spawn).toHaveBeenCalledWith(
      '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
      ['/installed/pi-agent-runtime/app/main.mjs'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      },
    )
    expect(harness.bootstrap()).toMatchObject({
      kind: 'bootstrap',
      parentPid: 7070,
      endpoint: '/private/runtime.sock',
      token: 'ab'.repeat(32),
    })
    expect(JSON.stringify(harness.spawn.mock.calls)).not.toContain('ab'.repeat(32))
    await expect(manager.status()).resolves.toMatchObject({ state: 'ready', pid: 8128 })
    await expect(manager.shutdown()).resolves.toBeUndefined()
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(manager.state).toBe('stopped')
    expect(harness.cleanup).toHaveBeenCalledOnce()
  })

  it('uses narrow typed Session methods and forwards validated native events in socket order', async () => {
    const harness = managerHarness()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = 'abababab-abab-4bab-8bab-abababababab'
    await expect(
      manager.createSession({ operationId, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }),
    ).resolves.toMatchObject({
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cursor: 'cursor-1',
    })
    await expect(
      manager.openSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' })
    await expect(
      manager.promptSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        text: 'hello',
      }),
    ).resolves.toEqual({ runId: 'run-1', acceptedCursor: 'cursor-1' })
    await expect(
      manager.abortSession({
        operationId,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        runId: 'run-1',
      }),
    ).resolves.toEqual({ runId: 'run-1', state: 'cancelling', acceptedCursor: 'cursor-2' })
    await expect(
      manager.snapshotSession({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ lastSequence: 1 })
    await expect(
      manager.subscribeSession({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: 'cursor-1',
      }),
    ).resolves.toMatchObject({ resetRequired: false, events: [] })
    await manager.shutdown()
  })

  it('starts Windows Runtime through the kill-on-close Job Object launcher', async () => {
    const harness = managerHarness({ helloPid: 9001 })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'win32', parentPid: 7070 },
      harness.dependencies,
    )

    await expect(manager.start()).resolves.toMatchObject({ pid: 9001 })
    expect(harness.spawn).toHaveBeenCalledWith(
      '/installed/pi-agent-runtime/node/open-genoffice-job-launcher.exe',
      [
        '--owner-pid',
        '7070',
        '--',
        '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
        '/installed/pi-agent-runtime/app/main.mjs',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      },
    )
    expect(harness.bootstrap()).toMatchObject({ parentPid: 8128 })
    await manager.shutdown()
  })

  it.each([
    ['createSession', 'session_connection_receipt_invalid'],
    ['openSession', 'session_connection_receipt_invalid'],
    ['promptSession', 'session_prompt_receipt_invalid'],
    ['abortSession', 'session_abort_receipt_invalid'],
    ['snapshotSession', 'session_snapshot_invalid'],
    ['subscribeSession', 'session_subscription_receipt_invalid'],
  ] as const)('maps an invalid %s result to a stable redacted error', async (method, code) => {
    const harness = managerHarness({ sessionResult: null })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    const input =
      method === 'createSession'
        ? { operationId: 'abababab-abab-4bab-8bab-abababababab', documentId: bound.documentId }
        : method === 'openSession'
          ? { operationId: 'abababab-abab-4bab-8bab-abababababab', ...bound }
          : method === 'promptSession'
            ? {
                operationId: 'abababab-abab-4bab-8bab-abababababab',
                ...bound,
                text: 'hello',
              }
            : method === 'abortSession'
              ? {
                  operationId: 'abababab-abab-4bab-8bab-abababababab',
                  ...bound,
                  runId: 'run-1',
                }
              : bound
    await expect(manager[method](input as never)).rejects.toEqual(new PiRuntimeManagerError(code))
    await manager.shutdown()
  })

  it('preserves stable Runtime errors across every narrow Session method', async () => {
    const harness = managerHarness({ sessionMode: 'error-response' })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    const operationId = 'abababab-abab-4bab-8bab-abababababab'
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    const calls = [
      manager.createSession({ operationId, documentId: bound.documentId }),
      manager.openSession({ operationId, ...bound }),
      manager.promptSession({ operationId, ...bound, text: 'hello' }),
      manager.abortSession({ operationId, ...bound, runId: 'run-1' }),
      manager.snapshotSession(bound),
      manager.subscribeSession(bound),
    ]
    await Promise.all(
      calls.map((call) => expect(call).rejects.toEqual(new PiRuntimeManagerError('unavailable'))),
    )
    await manager.shutdown()
  })

  it('fails closed on a mismatched hello and kills the child without leaking the token', async () => {
    const harness = managerHarness({ helloResult: null })
    const diagnostic = vi.fn()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'win32', parentPid: 7070, diagnostic },
      harness.dependencies,
    )
    await expect(manager.start()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_hello_invalid'),
    )
    expect(manager.state).toBe('crashed')
    expect(harness.child.kill).toHaveBeenCalledOnce()
    expect(harness.cleanup).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledWith('runtime_hello_invalid')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('ab'.repeat(32))
    await expect(manager.shutdown()).resolves.toBeUndefined()
  })

  it('maps raw startup errors and unavailable status to stable manager errors', async () => {
    const unavailable = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      managerHarness().dependencies,
    )
    await expect(unavailable.status()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_unavailable'),
    )

    const harness = managerHarness({ endpointFailure: true })
    const diagnostic = vi.fn()
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070, diagnostic },
      harness.dependencies,
    )
    await expect(manager.start()).rejects.toEqual(new PiRuntimeManagerError('runtime_start_failed'))
    expect(diagnostic).toHaveBeenCalledWith('runtime_start_failed')

    const childFailure = managerHarness({ childError: true })
    const childFailureManager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      childFailure.dependencies,
    )
    await expect(childFailureManager.start()).rejects.toEqual(
      new PiRuntimeManagerError('runtime_start_failed'),
    )
    expect(childFailure.child.kill).toHaveBeenCalledOnce()
    expect(childFailure.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'an invalid status payload',
      options: { statusResult: null },
      code: 'runtime_status_invalid',
    },
    {
      name: 'a Runtime error response',
      options: { statusMode: 'error-response' as const },
      code: 'unavailable',
    },
    {
      name: 'an invalid protocol frame',
      options: { statusMode: 'protocol-error' as const },
      code: 'runtime_protocol_invalid',
    },
  ])('rejects $name without corrupting the manager', async ({ options, code }) => {
    const harness = managerHarness({ ...options, prelude: true })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
      harness.dependencies,
    )
    await manager.start()
    await expect(manager.status()).rejects.toEqual(new PiRuntimeManagerError(code))
    harness.child.emit('exit', 70, null)
  })

  it('rejects an in-flight request when the socket errors or the child crashes', async () => {
    for (const failure of ['socket', 'child'] as const) {
      const harness = managerHarness({ statusMode: 'hang' })
      const manager = new PiRuntimeManager(
        { bundle: verifiedBundle(), platform: 'darwin', parentPid: 7070 },
        harness.dependencies,
      )
      await manager.start()
      const status = manager.status()
      if (failure === 'socket') {
        ;(harness.dependencies.connect as ReturnType<typeof vi.fn>).mock.results[0]!.value.then(
          (socket: FakeRuntimeSocket) => socket.emit('error', new Error('private socket detail')),
        )
        await expect(status).rejects.toEqual(new PiRuntimeManagerError('runtime_connection_error'))
      } else {
        harness.child.emit('exit', 70, null)
        await expect(status).rejects.toEqual(new PiRuntimeManagerError('runtime_crashed'))
      }
    }
  })

  it('marks an unexpected child exit as crashed', async () => {
    const harness = managerHarness()
    const diagnostic = vi.fn()
    const lifecycle: string[] = []
    harness.cleanup.mockImplementation(async () => {
      lifecycle.push('cleanup')
    })
    const onCrash = vi.fn(() => {
      lifecycle.push('crash')
    })
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'linux', parentPid: 7070, diagnostic, onCrash },
      harness.dependencies,
    )
    await manager.start()
    harness.child.emit('exit', 70, null)
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledOnce())
    harness.child.emit('exit', 70, null)
    expect(diagnostic).toHaveBeenCalledWith('runtime_crashed')
    expect(harness.cleanup).toHaveBeenCalledOnce()
    expect(onCrash).toHaveBeenCalledOnce()
    expect(lifecycle).toEqual(['cleanup', 'crash'])
  })
})

describe('private Runtime endpoints', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it

  posixIt('creates a 0700 POSIX instance directory and removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-endpoint-test-'))
    await chmod(root, 0o700)
    const endpoint = await createPrivateRuntimeEndpoint(
      'darwin',
      () => Buffer.alloc(12, 0xcd),
      root,
    )
    expect(endpoint.endpoint.endsWith(`${sep}runtime.sock`)).toBe(true)
    expect((await stat(join(endpoint.endpoint, '..'))).mode & 0o777).toBe(0o700)
    await endpoint.cleanup()
    await expect(stat(join(endpoint.endpoint, '..'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates a 96-bit Windows Named Pipe without a temp directory', async () => {
    const endpoint = await createPrivateRuntimeEndpoint('win32', () => Buffer.alloc(12, 0xcd))
    expect(endpoint.endpoint).toBe(`\\\\.\\pipe\\open-genoffice-${'cd'.repeat(12)}`)
    await expect(endpoint.cleanup()).resolves.toBeUndefined()
  })
})
