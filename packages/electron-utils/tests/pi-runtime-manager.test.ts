import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, stat } from 'node:fs/promises'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const defaultResult =
      request.method === 'runtime.hello'
        ? { pid: 8128, instanceId, capabilities: ['runtime.status', 'runtime.shutdown'] }
        : request.method === 'runtime.status'
          ? { pid: 8128, instanceId, runtimeVersion: RUNTIME_VERSION }
          : { shuttingDown: true }
    const result =
      request.method === 'runtime.hello' && 'helloResult' in this.options
        ? this.options.helloResult
        : request.method === 'runtime.status' && 'statusResult' in this.options
          ? this.options.statusResult
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
  helloResult?: unknown
  statusResult?: unknown
  statusMode?: 'hang' | 'protocol-error' | 'error-response'
  prelude?: boolean
  endpointFailure?: boolean
  childError?: boolean
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
    const manager = new PiRuntimeManager(
      { bundle: verifiedBundle(), platform: 'linux', parentPid: 7070, diagnostic },
      harness.dependencies,
    )
    await manager.start()
    harness.child.emit('exit', 70, null)
    await vi.waitFor(() => expect(manager.state).toBe('crashed'))
    expect(diagnostic).toHaveBeenCalledWith('runtime_crashed')
    expect(harness.cleanup).toHaveBeenCalledOnce()
  })
})

describe('private Runtime endpoints', () => {
  it('creates a 0700 POSIX instance directory and removes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-endpoint-test-'))
    await chmod(root, 0o700)
    const endpoint = await createPrivateRuntimeEndpoint(
      'darwin',
      () => Buffer.alloc(12, 0xcd),
      root,
    )
    expect(endpoint.endpoint.endsWith('/runtime.sock')).toBe(true)
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
