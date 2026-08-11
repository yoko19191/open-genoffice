import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  type RuntimeHealthProjection,
  type ModelCatalogProjection,
  type McpCatalogProjection,
  type OAuthOperationProjection,
  type PackageCatalogProjection,
  type ResourceCatalogProjection,
  type EventEnvelope,
  type SessionConnectionReceipt,
  type SessionAbortReceipt,
  type SessionForkReceipt,
  type SessionNavigateReceipt,
  type SessionPromptReceipt,
  type SessionSubagentResumeReceipt,
  type SessionMutationGrantReceipt,
  type SessionUserActionReceipt,
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
  SessionSubagentResumeRequest,
  SessionMutationGrantIssueRequest,
  SessionMutationGrantDenyRequest,
  SessionMutationGrantRevokeRequest,
  SessionMutationGrantRevokeDocumentRequest,
  SessionUserActionAnswerRequest,
  SessionSubscribeRequest,
  ProviderCredentialPutRequest,
  ProviderCredentialProviderRequest,
  ModelSelectRequest,
  ModelProviderConfigureRequest,
  ModelOAuthStartRequest,
  ModelOAuthOperationRequest,
  ModelOAuthRespondRequest,
  ModelProviderRequest,
  ResourceCatalogRequest,
  ProjectTrustRequest,
  PackageCatalogRequest,
  PackageInstallGitRequest,
  PackageInstallLocalRequest,
  PackageInstallNpmRequest,
  PackageMutationRequest,
  McpCatalogRequest,
  McpMutationRequest,
  McpToolMutationRequest,
  McpOAuthStartRequest,
  McpOAuthCompleteRequest,
  McpOAuthOperationRequest,
  McpOAuthStartProjection,
} from './pi-runtime-manager'

export type PiRuntimeServiceOptions = {
  bundleRoot: string
  platform: NodeJS.Platform
  arch: 'arm64' | 'x64'
  parentPid: number
  resourceHome?: string
  beforeStart?: () => Promise<void>
  credentialBroker?: PiRuntimeManagerOptions['credentialBroker']
  officeToolHost?: PiRuntimeManagerOptions['officeToolHost']
  mediaPreparationHost?: PiRuntimeManagerOptions['mediaPreparationHost']
}

type OwnedPiRuntimeManager = Pick<
  PiRuntimeManager,
  | 'start'
  | 'shutdown'
  | 'createSession'
  | 'openSession'
  | 'promptSession'
  | 'abortSession'
  | 'resumeSubagent'
  | 'issueMutationGrant'
  | 'denyMutationGrant'
  | 'revokeMutationGrant'
  | 'revokeDocumentMutationGrants'
  | 'answerUserAction'
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
  | 'configureModelProvider'
  | 'startModelOAuth'
  | 'modelOAuthStatus'
  | 'respondModelOAuth'
  | 'cancelModelOAuth'
  | 'logoutModel'
  | 'resourceCatalog'
  | 'grantProjectTrust'
  | 'revokeProjectTrust'
  | 'packageCatalog'
  | 'installLocalPackage'
  | 'installNpmPackage'
  | 'installGitPackage'
  | 'activatePackage'
  | 'enablePackage'
  | 'disablePackage'
  | 'uninstallPackage'
  | 'mcpCatalog'
  | 'activateMcp'
  | 'enableMcp'
  | 'disableMcp'
  | 'retryMcp'
  | 'startMcpOAuth'
  | 'completeMcpOAuth'
  | 'cancelMcpOAuth'
  | 'enableMcpTool'
  | 'disableMcpTool'
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
    officeToolHost?: PiRuntimeManagerOptions['officeToolHost']
    mediaPreparationHost?: PiRuntimeManagerOptions['mediaPreparationHost']
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

  async resumeSubagent(input: SessionSubagentResumeRequest): Promise<SessionSubagentResumeReceipt> {
    return (await this.readyManager()).resumeSubagent(input)
  }

  async issueMutationGrant(
    input: SessionMutationGrantIssueRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return (await this.readyManager()).issueMutationGrant(input)
  }

  async denyMutationGrant(
    input: SessionMutationGrantDenyRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return (await this.readyManager()).denyMutationGrant(input)
  }

  async revokeMutationGrant(
    input: SessionMutationGrantRevokeRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return (await this.readyManager()).revokeMutationGrant(input)
  }

  async revokeDocumentMutationGrants(
    input: SessionMutationGrantRevokeDocumentRequest,
  ): Promise<{ revoked: true }> {
    return (await this.readyManager()).revokeDocumentMutationGrants(input)
  }

  async answerUserAction(input: SessionUserActionAnswerRequest): Promise<SessionUserActionReceipt> {
    return (await this.readyManager()).answerUserAction(input)
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

  async configureModelProvider(
    input: ModelProviderConfigureRequest,
  ): Promise<ModelCatalogProjection> {
    return (await this.readyManager()).configureModelProvider(input)
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

  async resourceCatalog(input: ResourceCatalogRequest = {}): Promise<ResourceCatalogProjection> {
    return (await this.readyManager()).resourceCatalog(input)
  }

  async grantProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection> {
    return (await this.readyManager()).grantProjectTrust(input)
  }

  async revokeProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection> {
    return (await this.readyManager()).revokeProjectTrust(input)
  }

  async packageCatalog(input: PackageCatalogRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).packageCatalog(input)
  }

  async installLocalPackage(input: PackageInstallLocalRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).installLocalPackage(input)
  }

  async installNpmPackage(input: PackageInstallNpmRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).installNpmPackage(input)
  }

  async installGitPackage(input: PackageInstallGitRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).installGitPackage(input)
  }

  async activatePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).activatePackage(input)
  }

  async enablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).enablePackage(input)
  }

  async disablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).disablePackage(input)
  }

  async uninstallPackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return (await this.readyManager()).uninstallPackage(input)
  }

  async mcpCatalog(input: McpCatalogRequest = {}): Promise<McpCatalogProjection> {
    return (await this.readyManager()).mcpCatalog(input)
  }

  async activateMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).activateMcp(input)
  }

  async enableMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).enableMcp(input)
  }

  async disableMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).disableMcp(input)
  }

  async retryMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).retryMcp(input)
  }

  async startMcpOAuth(input: McpOAuthStartRequest): Promise<McpOAuthStartProjection> {
    return (await this.readyManager()).startMcpOAuth(input)
  }

  async completeMcpOAuth(input: McpOAuthCompleteRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).completeMcpOAuth(input)
  }

  async cancelMcpOAuth(input: McpOAuthOperationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).cancelMcpOAuth(input)
  }

  async enableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).enableMcpTool(input)
  }

  async disableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection> {
    return (await this.readyManager()).disableMcpTool(input)
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

    try {
      await this.options.beforeStart?.()
    } catch {
      this.currentHealth = projection('crashed', 'runtime_start_failed')
      return this.currentHealth
    }

    this.manager = this.dependencies.createManager({
      bundle,
      platform: this.options.platform,
      parentPid: this.options.parentPid,
      ...(this.options.resourceHome ? { resourceHome: this.options.resourceHome } : {}),
      ...(this.options.credentialBroker ? { credentialBroker: this.options.credentialBroker } : {}),
      ...(this.options.officeToolHost ? { officeToolHost: this.options.officeToolHost } : {}),
      ...(this.options.mediaPreparationHost
        ? { mediaPreparationHost: this.options.mediaPreparationHost }
        : {}),
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
        ...(managerOptions.officeToolHost === undefined
          ? {}
          : { officeToolHost: managerOptions.officeToolHost }),
        ...(managerOptions.mediaPreparationHost === undefined
          ? {}
          : { mediaPreparationHost: managerOptions.mediaPreparationHost }),
        ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
      }),
  })
}
