import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type RuntimeHealthProjection,
} from '@genoffice/agent-runtime-protocol'
import { verifyPiRuntimeBundle, type VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { createPiRuntimeManager } from './pi-runtime-node'
import type { PiRuntimeManager } from './pi-runtime-manager'

export type PiRuntimeServiceOptions = {
  bundleRoot: string
  platform: NodeJS.Platform
  arch: 'arm64' | 'x64'
  parentPid: number
}

type OwnedPiRuntimeManager = Pick<PiRuntimeManager, 'start' | 'shutdown'>

export type PiRuntimeServiceDependencies = {
  verifyBundle: (
    root: string,
    target: { platform: 'darwin' | 'win32' | 'linux'; arch: 'arm64' | 'x64' },
  ) => Promise<VerifiedPiRuntimeBundle>
  createManager: (options: {
    bundle: VerifiedPiRuntimeBundle
    platform: NodeJS.Platform
    parentPid: number
  }) => OwnedPiRuntimeManager
}

function projection(
  state: RuntimeHealthProjection['state'],
  diagnosticCode?: RuntimeHealthProjection['diagnosticCode'],
): RuntimeHealthProjection {
  return Object.freeze({
    state,
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ...(diagnosticCode ? { diagnosticCode } : {}),
  })
}

export class PiRuntimeService {
  private currentHealth = projection('stopped')
  private initializePromise: Promise<RuntimeHealthProjection> | undefined
  private manager: OwnedPiRuntimeManager | undefined

  constructor(
    private readonly options: PiRuntimeServiceOptions,
    private readonly dependencies: PiRuntimeServiceDependencies,
  ) {}

  health(): RuntimeHealthProjection {
    return this.currentHealth
  }

  initialize(): Promise<RuntimeHealthProjection> {
    this.initializePromise ??= this.initializeRuntime()
    return this.initializePromise
  }

  private async initializeRuntime(): Promise<RuntimeHealthProjection> {
    this.currentHealth = projection('starting')
    let bundle: VerifiedPiRuntimeBundle
    try {
      bundle = await this.dependencies.verifyBundle(this.options.bundleRoot, {
        platform: this.options.platform as 'darwin' | 'win32' | 'linux',
        arch: this.options.arch,
      })
    } catch {
      this.currentHealth = projection('unavailable', 'runtime_bundle_unavailable')
      return this.currentHealth
    }

    this.manager = this.dependencies.createManager({
      bundle,
      platform: this.options.platform,
      parentPid: this.options.parentPid,
    })
    try {
      await this.manager.start()
      this.currentHealth = projection('ready')
    } catch {
      this.currentHealth = projection('crashed', 'runtime_start_failed')
    }
    return this.currentHealth
  }

  async shutdown(): Promise<void> {
    await this.initializePromise
    if (!this.manager || this.currentHealth.state === 'stopped') {
      this.currentHealth = projection('stopped')
      return
    }
    try {
      await this.manager.shutdown()
      this.currentHealth = projection('stopped')
    } catch {
      this.currentHealth = projection('crashed', 'runtime_shutdown_failed')
    }
  }
}

export function createInstalledPiRuntimeService(
  options: PiRuntimeServiceOptions & { startupTimeoutMs?: number },
): PiRuntimeService {
  const { startupTimeoutMs, ...serviceOptions } = options
  return new PiRuntimeService(serviceOptions, {
    verifyBundle: verifyPiRuntimeBundle,
    createManager: (managerOptions) =>
      createPiRuntimeManager({ ...managerOptions, startupTimeoutMs }),
  })
}
