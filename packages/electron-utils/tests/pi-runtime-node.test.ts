import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  type RuntimeBundleManifest,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import {
  connectRuntimeEndpoint,
  createNodePiRuntimeDependencies,
  createPiRuntimeManager,
  createPrivateRuntimeEndpoint,
  PiRuntimeManagerError,
} from '../src'

function verifiedBundle(): VerifiedPiRuntimeBundle {
  return Object.freeze({
    kind: 'verified-pi-runtime-bundle',
    root: '/installed/pi-agent-runtime',
    executablePath: '/installed/pi-agent-runtime/node/open-genoffice-pi-agent-runtime',
    entryPath: '/installed/pi-agent-runtime/app/main.mjs',
    manifest: {
      runtimeName: RUNTIME_NAME,
      runtimeVersion: RUNTIME_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    } as RuntimeBundleManifest,
    manifestSha256: 'f'.repeat(64),
  })
}

describe('Node Pi Runtime adapter', () => {
  it('retries a private endpoint until it listens, then connects without TCP', async () => {
    const endpointPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
    const privateEndpoint = await createPrivateRuntimeEndpoint(endpointPlatform, () =>
      Buffer.alloc(12, 1),
    )
    const server = createServer((socket) => socket.end())
    const connecting = connectRuntimeEndpoint(privateEndpoint.endpoint, 500, 5)
    setTimeout(() => server.listen(privateEndpoint.endpoint), 20)
    const socket = await connecting
    expect((socket as import('node:net').Socket).remoteAddress).toBeUndefined()
    socket.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await privateEndpoint.cleanup()
  })

  it('uses a stable timeout error and creates all default dependencies', async () => {
    const endpointPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
    const privateEndpoint = await createPrivateRuntimeEndpoint(endpointPlatform, () =>
      Buffer.alloc(12, 2),
    )
    const dependencies = createNodePiRuntimeDependencies(5)
    await expect(dependencies.connect(privateEndpoint.endpoint)).rejects.toEqual(
      new PiRuntimeManagerError('runtime_connection_failed'),
    )
    await privateEndpoint.cleanup()

    expect(dependencies.randomBytes(32)).toHaveLength(32)
    expect(dependencies.randomUUID()).toMatch(/^[0-9a-f-]{36}$/)
    const windowsEndpoint = await dependencies.createEndpoint('win32')
    expect(windowsEndpoint.endpoint.startsWith('\\\\.\\pipe\\open-genoffice-')).toBe(true)
    await windowsEndpoint.cleanup()

    const child = dependencies.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    })
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  })

  it('constructs the production manager from a verified descriptor', () => {
    const manager = createPiRuntimeManager({
      bundle: verifiedBundle(),
      platform: process.platform,
      parentPid: process.pid,
      startupTimeoutMs: 10,
    })
    expect(manager.state).toBe('stopped')
  })
})
