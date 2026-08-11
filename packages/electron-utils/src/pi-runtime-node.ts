import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  PiRuntimeManager,
  PiRuntimeManagerError,
  createPrivateRuntimeEndpoint,
  type PiRuntimeChild,
  type PiRuntimeManagerDependencies,
  type PiRuntimeManagerOptions,
  type PiRuntimeSocket,
} from './pi-runtime-manager'
import { PiRuntimeSupervisor } from './pi-runtime-supervisor'

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function connectOnce(endpoint: string): Promise<PiRuntimeSocket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

export async function connectRuntimeEndpoint(
  endpoint: string,
  timeoutMs = 5_000,
  retryDelayMs = 25,
): Promise<PiRuntimeSocket> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return await connectOnce(endpoint)
    } catch {
      if (Date.now() >= deadline) {
        throw new PiRuntimeManagerError('runtime_connection_failed')
      }
      await delay(retryDelayMs)
    }
  }
}

function spawnRuntimeChild(
  executable: string,
  args: readonly string[],
  options: {
    stdio: ['pipe', 'pipe', 'pipe']
    detached: boolean
    windowsHide: true
    env?: NodeJS.ProcessEnv
  },
): PiRuntimeChild {
  return spawn(executable, [...args], options) as PiRuntimeChild
}

export function createNodePiRuntimeDependencies(
  startupTimeoutMs = 5_000,
): PiRuntimeManagerDependencies {
  return {
    spawn: spawnRuntimeChild,
    createEndpoint: (platform) => createPrivateRuntimeEndpoint(platform, randomBytes),
    connect: (endpoint) => connectRuntimeEndpoint(endpoint, startupTimeoutMs),
    randomBytes,
    randomUUID,
  }
}

export function createPiRuntimeManager(
  options: PiRuntimeManagerOptions & { startupTimeoutMs?: number | undefined },
): PiRuntimeManager {
  const { startupTimeoutMs, ...managerOptions } = options
  return new PiRuntimeManager(managerOptions, createNodePiRuntimeDependencies(startupTimeoutMs))
}

export function createPiRuntimeSupervisor(
  options: PiRuntimeManagerOptions & { startupTimeoutMs?: number | undefined },
): PiRuntimeSupervisor {
  const { startupTimeoutMs, ...managerOptions } = options
  return new PiRuntimeSupervisor({
    createManager: (onCrash) =>
      new PiRuntimeManager(
        { ...managerOptions, onCrash },
        createNodePiRuntimeDependencies(startupTimeoutMs),
      ),
  })
}
