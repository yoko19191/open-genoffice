import type {
  EventEnvelope,
  SessionAbortReceipt,
  SessionConnectionReceipt,
  SessionPromptReceipt,
  SessionSnapshot,
  SessionSubscriptionReceipt,
  ProviderCredentialStatus,
} from '@genoffice/agent-runtime-protocol'
import type {
  PiRuntimeHealth,
  SessionAbortRequest,
  SessionBoundRequest,
  SessionCreateRequest,
  SessionOpenRequest,
  SessionPromptRequest,
  SessionSubscribeRequest,
  ProviderCredentialPutRequest,
  ProviderCredentialProviderRequest,
} from './pi-runtime-manager'

export type SupervisedPiRuntimeManager = {
  start(): Promise<PiRuntimeHealth>
  shutdown(): Promise<void>
  createSession(input: SessionCreateRequest): Promise<SessionConnectionReceipt>
  openSession(input: SessionOpenRequest): Promise<SessionConnectionReceipt>
  promptSession(input: SessionPromptRequest): Promise<SessionPromptReceipt>
  abortSession(input: SessionAbortRequest): Promise<SessionAbortReceipt>
  snapshotSession(input: SessionBoundRequest): Promise<SessionSnapshot>
  subscribeSession(input: SessionSubscribeRequest): Promise<SessionSubscriptionReceipt>
  onSessionEvent(listener: (event: EventEnvelope) => void): () => void
  putCredential(input: ProviderCredentialPutRequest): Promise<ProviderCredentialStatus>
  credentialStatus(input: ProviderCredentialProviderRequest): Promise<ProviderCredentialStatus>
  deleteCredential(input: ProviderCredentialProviderRequest): Promise<ProviderCredentialStatus>
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
