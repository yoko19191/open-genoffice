import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type RuntimeHealthProjection,
  type EventEnvelope,
  type SessionConnectionReceipt,
  type SessionAbortReceipt,
  type SessionPromptReceipt,
  type SessionSnapshot,
  type SessionSubscriptionReceipt,
} from '@genoffice/agent-runtime-protocol'
import { verifyPiRuntimeBundle, type VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import { createPiRuntimeSupervisor } from './pi-runtime-node'
import type {
  PiRuntimeManager,
  PiRuntimeManagerOptions,
  SessionBoundRequest,
  SessionAbortRequest,
  SessionCreateRequest,
  SessionOpenRequest,
  SessionPromptRequest,
  SessionSubscribeRequest,
} from './pi-runtime-manager'

export type PiRuntimeServiceOptions = {
  bundleRoot: string
  platform: NodeJS.Platform
  arch: 'arm64' | 'x64'
  parentPid: number
  resourceHome?: string
  credentialBroker?: PiRuntimeManagerOptions['credentialBroker']
}

type OwnedPiRuntimeManager = Pick<
  PiRuntimeManager,
  | 'start'
  | 'shutdown'
  | 'createSession'
  | 'openSession'
  | 'promptSession'
  | 'abortSession'
  | 'snapshotSession'
  | 'subscribeSession'
  | 'onSessionEvent'
>

export type PiRuntimeServiceDependencies = {
  verifyBundle: (
    root: string,
    target: { platform: 'darwin' | 'win32' | 'linux'; arch: 'arm64' | 'x64' },
  ) => Promise<VerifiedPiRuntimeBundle>
  createManager: (options: {
    bundle: VerifiedPiRuntimeBundle
    platform: NodeJS.Platform
    parentPid: number
    resourceHome?: string
    credentialBroker?: PiRuntimeManagerOptions['credentialBroker']
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

  async createSession(input: SessionCreateRequest): Promise<SessionConnectionReceipt> {
    return (await this.readyManager()).createSession(input)
  }

  async openSession(input: SessionOpenRequest): Promise<SessionConnectionReceipt> {
    return (await this.readyManager()).openSession(input)
  }

  async promptSession(input: SessionPromptRequest): Promise<SessionPromptReceipt> {
    return (await this.readyManager()).promptSession(input)
  }

  async abortSession(input: SessionAbortRequest): Promise<SessionAbortReceipt> {
    return (await this.readyManager()).abortSession(input)
  }

  async snapshotSession(input: SessionBoundRequest): Promise<SessionSnapshot> {
    return (await this.readyManager()).snapshotSession(input)
  }

  async subscribeSession(input: SessionSubscribeRequest): Promise<SessionSubscriptionReceipt> {
    return (await this.readyManager()).subscribeSession(input)
  }

  async onSessionEvent(listener: (event: EventEnvelope) => void): Promise<() => void> {
    return (await this.readyManager()).onSessionEvent(listener)
  }

  private async readyManager(): Promise<OwnedPiRuntimeManager> {
    await this.initialize()
    if (this.currentHealth.state !== 'ready' || !this.manager)
      throw new Error('runtime_unavailable')
    return this.manager
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
      ...(this.options.resourceHome ? { resourceHome: this.options.resourceHome } : {}),
      ...(this.options.credentialBroker ? { credentialBroker: this.options.credentialBroker } : {}),
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
  options: PiRuntimeServiceOptions & { startupTimeoutMs?: number | undefined },
): PiRuntimeService {
  const { startupTimeoutMs, ...serviceOptions } = options
  return new PiRuntimeService(serviceOptions, {
    verifyBundle: verifyPiRuntimeBundle,
    createManager: (managerOptions) =>
      createPiRuntimeSupervisor({ ...managerOptions, startupTimeoutMs }),
  })
}
