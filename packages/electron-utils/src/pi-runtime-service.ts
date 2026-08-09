import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type RuntimeHealthProjection,
  type ModelCatalogProjection,
  type OAuthOperationProjection,
  type EventEnvelope,
  type SessionConnectionReceipt,
  type SessionAbortReceipt,
  type SessionForkReceipt,
  type SessionNavigateReceipt,
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
  SessionForkRequest,
  SessionNavigateRequest,
  SessionCreateRequest,
  SessionOpenRequest,
  SessionPromptRequest,
  SessionSubscribeRequest,
  ProviderCredentialPutRequest,
  ProviderCredentialProviderRequest,
  ModelSelectRequest,
  ModelOAuthStartRequest,
  ModelOAuthOperationRequest,
  ModelOAuthRespondRequest,
  ModelProviderRequest,
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
  | 'forkSession'
  | 'navigateSession'
  | 'snapshotSession'
  | 'subscribeSession'
  | 'onSessionEvent'
  | 'putCredential'
  | 'credentialStatus'
  | 'deleteCredential'
  | 'modelCatalog'
  | 'selectModel'
  | 'startModelOAuth'
  | 'modelOAuthStatus'
  | 'respondModelOAuth'
  | 'cancelModelOAuth'
  | 'logoutModel'
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

  async forkSession(input: SessionForkRequest): Promise<SessionForkReceipt> {
    return (await this.readyManager()).forkSession(input)
  }

  async navigateSession(input: SessionNavigateRequest): Promise<SessionNavigateReceipt> {
    return (await this.readyManager()).navigateSession(input)
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

  async putCredential(input: ProviderCredentialPutRequest) {
    return (await this.readyManager()).putCredential(input)
  }

  async credentialStatus(input: ProviderCredentialProviderRequest) {
    return (await this.readyManager()).credentialStatus(input)
  }

  async deleteCredential(input: ProviderCredentialProviderRequest) {
    return (await this.readyManager()).deleteCredential(input)
  }

  async modelCatalog(): Promise<ModelCatalogProjection> {
    return (await this.readyManager()).modelCatalog()
  }

  async selectModel(input: ModelSelectRequest): Promise<ModelCatalogProjection> {
    return (await this.readyManager()).selectModel(input)
  }

  async startModelOAuth(input: ModelOAuthStartRequest): Promise<OAuthOperationProjection> {
    return (await this.readyManager()).startModelOAuth(input)
  }

  async modelOAuthStatus(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection> {
    return (await this.readyManager()).modelOAuthStatus(input)
  }

  async respondModelOAuth(input: ModelOAuthRespondRequest): Promise<OAuthOperationProjection> {
    return (await this.readyManager()).respondModelOAuth(input)
  }

  async cancelModelOAuth(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection> {
    return (await this.readyManager()).cancelModelOAuth(input)
  }

  async logoutModel(input: ModelProviderRequest): Promise<ModelCatalogProjection> {
    return (await this.readyManager()).logoutModel(input)
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
      createPiRuntimeSupervisor({
        bundle: managerOptions.bundle,
        platform: managerOptions.platform,
        parentPid: managerOptions.parentPid,
        ...(managerOptions.resourceHome === undefined
          ? {}
          : { resourceHome: managerOptions.resourceHome }),
        ...(managerOptions.credentialBroker === undefined
          ? {}
          : { credentialBroker: managerOptions.credentialBroker }),
        ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
      }),
  })
}
