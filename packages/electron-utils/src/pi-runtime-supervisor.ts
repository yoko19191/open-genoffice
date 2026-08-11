import type {
  EventEnvelope,
  SessionAbortReceipt,
  SessionForkReceipt,
  SessionNavigateReceipt,
  SessionConnectionReceipt,
  SessionPromptReceipt,
  SessionSubagentResumeReceipt,
  SessionMutationGrantReceipt,
  SessionUserActionReceipt,
  SessionSnapshot,
  SessionSubscriptionReceipt,
  ProviderCredentialStatus,
  ModelCatalogProjection,
  McpCatalogProjection,
  OAuthOperationProjection,
  PackageCatalogProjection,
  ResourceCatalogProjection,
} from '@genoffice/agent-runtime-protocol'
import type {
  PiRuntimeHealth,
  SessionAbortRequest,
  SessionForkRequest,
  SessionNavigateRequest,
  SessionBoundRequest,
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

export type SupervisedPiRuntimeManager = {
  start(): Promise<PiRuntimeHealth>
  shutdown(): Promise<void>
  createSession(input: SessionCreateRequest): Promise<SessionConnectionReceipt>
  openSession(input: SessionOpenRequest): Promise<SessionConnectionReceipt>
  promptSession(input: SessionPromptRequest): Promise<SessionPromptReceipt>
  abortSession(input: SessionAbortRequest): Promise<SessionAbortReceipt>
  resumeSubagent(input: SessionSubagentResumeRequest): Promise<SessionSubagentResumeReceipt>
  issueMutationGrant(input: SessionMutationGrantIssueRequest): Promise<SessionMutationGrantReceipt>
  denyMutationGrant(input: SessionMutationGrantDenyRequest): Promise<SessionMutationGrantReceipt>
  revokeMutationGrant(
    input: SessionMutationGrantRevokeRequest,
  ): Promise<SessionMutationGrantReceipt>
  revokeDocumentMutationGrants(
    input: SessionMutationGrantRevokeDocumentRequest,
  ): Promise<{ revoked: true }>
  answerUserAction(input: SessionUserActionAnswerRequest): Promise<SessionUserActionReceipt>
  forkSession(input: SessionForkRequest): Promise<SessionForkReceipt>
  navigateSession(input: SessionNavigateRequest): Promise<SessionNavigateReceipt>
  snapshotSession(input: SessionBoundRequest): Promise<SessionSnapshot>
  subscribeSession(input: SessionSubscribeRequest): Promise<SessionSubscriptionReceipt>
  onSessionEvent(listener: (event: EventEnvelope) => void): () => void
  putCredential(input: ProviderCredentialPutRequest): Promise<ProviderCredentialStatus>
  credentialStatus(input: ProviderCredentialProviderRequest): Promise<ProviderCredentialStatus>
  deleteCredential(input: ProviderCredentialProviderRequest): Promise<ProviderCredentialStatus>
  modelCatalog(): Promise<ModelCatalogProjection>
  selectModel(input: ModelSelectRequest): Promise<ModelCatalogProjection>
  configureModelProvider(input: ModelProviderConfigureRequest): Promise<ModelCatalogProjection>
  startModelOAuth(input: ModelOAuthStartRequest): Promise<OAuthOperationProjection>
  modelOAuthStatus(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection>
  respondModelOAuth(input: ModelOAuthRespondRequest): Promise<OAuthOperationProjection>
  cancelModelOAuth(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection>
  logoutModel(input: ModelProviderRequest): Promise<ModelCatalogProjection>
  resourceCatalog(input?: ResourceCatalogRequest): Promise<ResourceCatalogProjection>
  grantProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection>
  revokeProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection>
  packageCatalog(input: PackageCatalogRequest): Promise<PackageCatalogProjection>
  installLocalPackage(input: PackageInstallLocalRequest): Promise<PackageCatalogProjection>
  installNpmPackage(input: PackageInstallNpmRequest): Promise<PackageCatalogProjection>
  installGitPackage(input: PackageInstallGitRequest): Promise<PackageCatalogProjection>
  activatePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection>
  enablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection>
  disablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection>
  uninstallPackage(input: PackageMutationRequest): Promise<PackageCatalogProjection>
  mcpCatalog(input?: McpCatalogRequest): Promise<McpCatalogProjection>
  activateMcp(input: McpMutationRequest): Promise<McpCatalogProjection>
  enableMcp(input: McpMutationRequest): Promise<McpCatalogProjection>
  disableMcp(input: McpMutationRequest): Promise<McpCatalogProjection>
  retryMcp(input: McpMutationRequest): Promise<McpCatalogProjection>
  startMcpOAuth(input: McpOAuthStartRequest): Promise<McpOAuthStartProjection>
  completeMcpOAuth(input: McpOAuthCompleteRequest): Promise<McpCatalogProjection>
  cancelMcpOAuth(input: McpOAuthOperationRequest): Promise<McpCatalogProjection>
  enableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection>
  disableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection>
}

export type PiRuntimeSupervisorState =
  'stopped' | 'starting' | 'ready' | 'crashed' | 'backoff' | 'circuit_open' | 'stopping'

export type PiRuntimeSupervisorDependencies = {
  createManager(onCrash: () => void): SupervisedPiRuntimeManager
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [250, 1_000, 4_000] as const

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class PiRuntimeSupervisor implements SupervisedPiRuntimeManager {
  state: PiRuntimeSupervisorState = 'stopped'
  private readonly now: () => number
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly listeners = new Set<(event: EventEnvelope) => void>()
  private manager: SupervisedPiRuntimeManager | undefined
  private managerUnsubscribe: (() => void) | undefined
  private health: PiRuntimeHealth | undefined
  private startPromise: Promise<PiRuntimeHealth> | undefined
  private recoveryPromise: Promise<PiRuntimeHealth> | undefined
  private crashTimes: number[] = []
  private generation = 0
  private shuttingDown = false

  constructor(
    private readonly dependencies: PiRuntimeSupervisorDependencies,
    private readonly onStateChange?: (state: PiRuntimeSupervisorState) => void,
  ) {
    this.now = dependencies.now ?? Date.now
    this.delay = dependencies.delay ?? defaultDelay
  }

  start(): Promise<PiRuntimeHealth> {
    if (this.health && this.state === 'ready') return Promise.resolve(this.health)
    if (this.startPromise) return this.startPromise
    if (this.state === 'circuit_open') return Promise.reject(new Error('runtime_circuit_open'))
    this.shuttingDown = false
    this.transition('starting')
    this.startPromise = this.startManager().finally(() => {
      this.startPromise = undefined
    })
    return this.startPromise
  }

  waitUntilReady(): Promise<PiRuntimeHealth> {
    if (this.health && this.state === 'ready') return Promise.resolve(this.health)
    if (this.state === 'circuit_open') return Promise.reject(new Error('runtime_circuit_open'))
    return this.recoveryPromise ?? this.startPromise ?? this.start()
  }

  private async startManager(): Promise<PiRuntimeHealth> {
    const generation = ++this.generation
    const manager = this.dependencies.createManager(() => this.handleCrash(generation))
    this.manager = manager
    this.managerUnsubscribe = manager.onSessionEvent((event) => {
      for (const listener of this.listeners) listener(event)
    })
    try {
      const health = await manager.start()
      if (generation !== this.generation || this.shuttingDown) {
        throw new Error('runtime_start_superseded')
      }
      this.health = health
      this.transition('ready')
      return health
    } catch (error) {
      this.managerUnsubscribe?.()
      this.managerUnsubscribe = undefined
      if (this.manager === manager) this.manager = undefined
      this.health = undefined
      if (!this.shuttingDown) this.transition('crashed')
      throw error
    }
  }

  private handleCrash(generation: number): void {
    if (generation !== this.generation || this.shuttingDown || this.state !== 'ready') return
    this.health = undefined
    this.managerUnsubscribe?.()
    this.managerUnsubscribe = undefined
    this.transition('crashed')
    this.recoveryPromise = this.recover(generation).finally(() => {
      this.recoveryPromise = undefined
    })
    void this.recoveryPromise.catch(() => {})
  }

  private async recover(generation: number): Promise<PiRuntimeHealth> {
    const now = this.now()
    this.crashTimes = this.crashTimes.filter((time) => now - time < RESTART_WINDOW_MS)
    this.crashTimes.push(now)
    if (this.crashTimes.length > RESTART_BACKOFF_MS.length) {
      this.transition('circuit_open')
      throw new Error('runtime_circuit_open')
    }
    this.transition('backoff')
    await this.delay(RESTART_BACKOFF_MS[this.crashTimes.length - 1]!)
    if (generation !== this.generation || this.shuttingDown) throw new Error('runtime_stopped')
    this.transition('starting')
    return this.startManager()
  }

  onSessionEvent(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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

  async putCredential(input: ProviderCredentialPutRequest): Promise<ProviderCredentialStatus> {
    return (await this.readyManager()).putCredential(input)
  }

  async credentialStatus(
    input: ProviderCredentialProviderRequest,
  ): Promise<ProviderCredentialStatus> {
    return (await this.readyManager()).credentialStatus(input)
  }

  async deleteCredential(
    input: ProviderCredentialProviderRequest,
  ): Promise<ProviderCredentialStatus> {
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

  private async readyManager(): Promise<SupervisedPiRuntimeManager> {
    await this.waitUntilReady()
    if (!this.manager || this.state !== 'ready') throw new Error('runtime_unavailable')
    return this.manager
  }

  async shutdown(): Promise<void> {
    if (this.state === 'stopped') return
    this.shuttingDown = true
    this.generation += 1
    this.transition('stopping')
    const manager = this.manager
    this.manager = undefined
    this.health = undefined
    this.managerUnsubscribe?.()
    this.managerUnsubscribe = undefined
    if (manager) await manager.shutdown()
    this.crashTimes = []
    this.recoveryPromise = undefined
    this.startPromise = undefined
    this.shuttingDown = false
    this.transition('stopped')
  }

  private transition(state: PiRuntimeSupervisorState): void {
    this.state = state
    this.onStateChange?.(state)
  }
}
