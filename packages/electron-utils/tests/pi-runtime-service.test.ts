import { describe, expect, it, vi } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { PiRuntimeService } from '../src'

const verified = {
  kind: 'verified-pi-runtime-bundle',
  root: '/resources/pi-runtime',
  executablePath: '/resources/pi-runtime/node/open-genoffice-pi-agent-runtime',
  entryPath: '/resources/pi-runtime/app/main.mjs',
  manifest: { runtimeVersion: RUNTIME_VERSION },
  manifestSha256: 'a'.repeat(64),
} as unknown as VerifiedPiRuntimeBundle

function manager(overrides: Record<string, unknown> = {}) {
  return {
    state: 'stopped',
    start: vi.fn(async () => ({
      state: 'ready' as const,
      pid: 42,
      instanceId: 'private-instance',
      runtimeVersion: RUNTIME_VERSION,
    })),
    status: vi.fn(async () => ({ pid: 42, instanceId: 'private-instance' })),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  }
}

function service(options: {
  verify?: () => Promise<VerifiedPiRuntimeBundle>
  runtimeManager?: ReturnType<typeof manager>
}) {
  const runtimeManager = options.runtimeManager ?? manager()
  const createManager = vi.fn(() => runtimeManager)
  return {
    runtimeManager,
    createManager,
    instance: new PiRuntimeService(
      {
        bundleRoot: '/resources/pi-runtime',
        platform: 'darwin',
        arch: 'arm64',
        parentPid: 123,
      },
      {
        verifyBundle: options.verify ?? (async () => verified),
        createManager,
      },
    ),
  }
}

describe('installed Pi Runtime service', () => {
  it('verifies once, starts once, and exposes only a frozen typed health projection', async () => {
    const fixture = service({})
    const first = fixture.instance.initialize()
    const second = fixture.instance.initialize()
    expect(first).toBe(second)
    await expect(first).resolves.toEqual({
      state: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(fixture.createManager).toHaveBeenCalledWith({
      bundle: verified,
      platform: 'darwin',
      parentPid: 123,
    })
    expect(fixture.runtimeManager.start).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).not.toHaveProperty('pid')
    expect(Object.isFrozen(fixture.instance.health())).toBe(true)
  })

  it('fails closed when the installed bundle is absent or Runtime startup fails', async () => {
    const missing = service({
      verify: async () => {
        throw new Error('/private/bundle/path')
      },
    })
    await expect(missing.instance.initialize()).resolves.toMatchObject({
      state: 'unavailable',
      diagnosticCode: 'runtime_bundle_unavailable',
    })
    expect(missing.createManager).not.toHaveBeenCalled()

    const failedManager = manager({
      start: vi.fn(async () => {
        throw new Error('private token and endpoint')
      }),
    })
    const failed = service({ runtimeManager: failedManager })
    await expect(failed.instance.initialize()).resolves.toMatchObject({
      state: 'crashed',
      diagnosticCode: 'runtime_start_failed',
    })
    expect(JSON.stringify(failed.instance.health())).not.toContain('private')
  })

  it('shuts down the owned manager after initialization and remains stopped', async () => {
    const fixture = service({})
    await fixture.instance.initialize()
    await fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).toMatchObject({ state: 'stopped' })
    await fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()

    const neverStarted = service({})
    await neverStarted.instance.shutdown()
    expect(neverStarted.instance.health()).toMatchObject({ state: 'stopped' })

    const failingManager = manager({
      shutdown: vi.fn(async () => {
        throw new Error('private shutdown detail')
      }),
    })
    const failing = service({ runtimeManager: failingManager })
    await failing.instance.initialize()
    await failing.instance.shutdown()
    expect(failing.instance.health()).toMatchObject({
      state: 'crashed',
      diagnosticCode: 'runtime_shutdown_failed',
    })
  })

  it('waits for in-flight verification before shutting down during app exit', async () => {
    let resolveVerification!: (bundle: VerifiedPiRuntimeBundle) => void
    const fixture = service({
      verify: () =>
        new Promise<VerifiedPiRuntimeBundle>((resolve) => {
          resolveVerification = resolve
        }),
    })
    void fixture.instance.initialize()
    const shutdown = fixture.instance.shutdown()
    expect(fixture.runtimeManager.shutdown).not.toHaveBeenCalled()
    resolveVerification(verified)
    await shutdown
    expect(fixture.runtimeManager.shutdown).toHaveBeenCalledOnce()
    expect(fixture.instance.health()).toMatchObject({ state: 'stopped' })
  })
})
