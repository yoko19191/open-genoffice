import type { Readable, Writable } from 'node:stream'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  createNdjsonFrameDecoder,
  parseCredentialBrokerRequest,
  parseProviderCredentialStatus,
  parseSessionAbortReceipt,
  parseSessionConnectionReceipt,
  parseSessionForkReceipt,
  parseSessionNavigateReceipt,
  parseSessionPromptReceipt,
  parseSessionSnapshot,
  parseSessionSubscriptionReceipt,
  type BootstrapRecord,
  type CredentialManagementRequest,
  type EventEnvelope,
  type ProtocolEnvelope,
  type RequestEnvelope,
  type SessionConnectionReceipt,
  type SessionAbortReceipt,
  type SessionForkReceipt,
  type SessionNavigateReceipt,
  type SessionPromptReceipt,
  type SessionSnapshot,
  type SessionSubscriptionReceipt,
} from '@genoffice/agent-runtime-protocol'
import type { VerifiedPiRuntimeBundle } from '@genoffice/pi-runtime-bundle'
import type { SecureStorageBroker } from './secure-storage-broker'

export type PiRuntimeManagerState = 'stopped' | 'starting' | 'ready' | 'stopping' | 'crashed'

export type PiRuntimeHealth = {
  state: 'ready'
  pid: number
  instanceId: string
  runtimeVersion: typeof RUNTIME_VERSION
}

export type PrivateRuntimeEndpoint = {
  endpoint: string
  cleanup: () => Promise<void>
}

export type PiRuntimeChild = {
  pid?: number
  stdin: Writable
  stdout: Readable | null
  stderr: Readable | null
  kill: (signal?: NodeJS.Signals | number) => boolean
  once: {
    (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
  }
}

export type PiRuntimeSocket = {
  write: (data: string) => boolean
  end: () => void
  destroy: () => void
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  once: (event: 'close' | 'error', listener: (error?: Error) => void) => unknown
}

export type PiRuntimeManagerDependencies = {
  spawn: (
    executable: string,
    args: readonly string[],
    options: {
      stdio: ['pipe', 'pipe', 'pipe']
      detached: boolean
      windowsHide: true
      env?: NodeJS.ProcessEnv
    },
  ) => PiRuntimeChild
  createEndpoint: (platform: NodeJS.Platform) => Promise<PrivateRuntimeEndpoint>
  connect: (endpoint: string) => Promise<PiRuntimeSocket>
  randomBytes: (size: number) => Buffer
  randomUUID: () => string
}

export type PiRuntimeManagerOptions = {
  bundle: VerifiedPiRuntimeBundle
  platform: NodeJS.Platform
  parentPid: number
  resourceHome?: string
  diagnostic?: (code: string) => void
  onCrash?: () => void
  credentialBroker?: Pick<SecureStorageBroker, 'put' | 'rotate' | 'get' | 'status' | 'delete'>
}

export type SessionCreateRequest = { operationId: string; documentId: string }
export type SessionOpenRequest = SessionCreateRequest & { sessionId: string }
export type SessionPromptRequest = SessionOpenRequest & { text: string }
export type SessionAbortRequest = SessionOpenRequest & { runId: string }
export type SessionForkRequest = SessionOpenRequest
export type SessionNavigateRequest = SessionOpenRequest & { targetEntryId: string }
export type SessionBoundRequest = { sessionId: string; documentId: string }
export type SessionSubscribeRequest = SessionBoundRequest & { afterCursor?: string }
export type ProviderCredentialPutRequest = Extract<
  CredentialManagementRequest,
  { method: 'credential.put' }
>['params']
export type ProviderCredentialProviderRequest = Extract<
  CredentialManagementRequest,
  { method: 'credential.status' }
>['params']

type ClientRuntimeMethod =
  | 'runtime.hello'
  | 'runtime.status'
  | 'runtime.shutdown'
  | 'session.create'
  | 'session.open'
  | 'session.prompt'
  | 'session.abort'
  | 'session.fork'
  | 'session.navigate'
  | 'session.snapshot'
  | 'session.subscribe'
  | 'credential.put'
  | 'credential.status'
  | 'credential.delete'

export class PiRuntimeManagerError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'PiRuntimeManagerError'
    this.code = code
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

const CREDENTIAL_BROKER_ERROR_CODES = new Set([
  'secure_storage_unavailable',
  'credential_generation_conflict',
  'credential_index_invalid',
  'credential_persist_failed',
  'credential_decrypt_failed',
])

function hostResponse(request: RequestEnvelope, result: unknown): string {
  return `${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    result,
  })}\n`
}

function hostErrorResponse(request: RequestEnvelope, code: string): string {
  return `${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    error: {
      code,
      message: code,
      retryable: false,
      correlationId: request.correlationId,
    },
  })}\n`
}

export async function createPrivateRuntimeEndpoint(
  platform: NodeJS.Platform,
  randomBytes: (size: number) => Buffer,
  temporaryRoot = tmpdir(),
): Promise<PrivateRuntimeEndpoint> {
  if (platform === 'win32') {
    return {
      endpoint: `\\\\.\\pipe\\open-genoffice-${randomBytes(12).toString('hex')}`,
      cleanup: async () => {},
    }
  }

  const instanceDirectory = await mkdtemp(join(temporaryRoot, 'open-genoffice-runtime-'))
  await chmod(instanceDirectory, 0o700)
  return {
    endpoint: join(instanceDirectory, 'runtime.sock'),
    cleanup: async () => {
      await rm(instanceDirectory, { recursive: true, force: true })
    },
  }
}

export class PiRuntimeManager {
  state: PiRuntimeManagerState = 'stopped'
  private startPromise: Promise<PiRuntimeHealth> | undefined
  private child: PiRuntimeChild | undefined
  private socket: PiRuntimeSocket | undefined
  private endpoint: PrivateRuntimeEndpoint | undefined
  private health: PiRuntimeHealth | undefined
  private cleanupPromise: Promise<void> | undefined
  private resolveChildExit: (() => void) | undefined
  private childExit: Promise<void> | undefined
  private requestSequence = 0
  private readonly pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly eventListeners = new Set<(event: EventEnvelope) => void>()

  constructor(
    private readonly options: PiRuntimeManagerOptions,
    private readonly dependencies: PiRuntimeManagerDependencies,
  ) {}

  start(): Promise<PiRuntimeHealth> {
    if (this.health !== undefined) return Promise.resolve(this.health)
    if (this.startPromise !== undefined) return this.startPromise
    this.state = 'starting'
    this.startPromise = this.startRuntime()
    return this.startPromise
  }

  private async startRuntime(): Promise<PiRuntimeHealth> {
    try {
      this.cleanupPromise = undefined
      this.endpoint = await this.dependencies.createEndpoint(this.options.platform)
      const token = this.dependencies.randomBytes(32).toString('hex')
      const windowsJobLauncher =
        this.options.platform === 'win32' ? this.options.bundle.windowsJobLauncherPath : undefined
      if (this.options.platform === 'win32' && windowsJobLauncher === undefined) {
        throw new PiRuntimeManagerError('runtime_job_launcher_missing')
      }
      this.child = this.dependencies.spawn(
        windowsJobLauncher ?? this.options.bundle.executablePath,
        windowsJobLauncher
          ? [
              '--owner-pid',
              String(this.options.parentPid),
              '--',
              this.options.bundle.executablePath,
              this.options.bundle.entryPath,
            ]
          : [this.options.bundle.entryPath],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: this.options.platform !== 'win32',
          windowsHide: true,
          ...(this.options.resourceHome
            ? {
                env: {
                  ...process.env,
                  GENOFFICE_RESOURCE_HOME: this.options.resourceHome,
                },
              }
            : {}),
        },
      )
      const bootstrapParentPid = windowsJobLauncher ? this.child.pid : this.options.parentPid
      if (!Number.isInteger(bootstrapParentPid) || bootstrapParentPid! <= 0) {
        throw new PiRuntimeManagerError('runtime_start_failed')
      }
      const bootstrap: BootstrapRecord = {
        kind: 'bootstrap',
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: RUNTIME_VERSION,
        schemaVersion: SCHEMA_VERSION,
        parentPid: bootstrapParentPid!,
        endpoint: this.endpoint.endpoint,
        token,
      }
      this.child.stdout?.resume()
      this.child.stderr?.resume()
      this.childExit = new Promise<void>((resolve) => {
        this.resolveChildExit = resolve
      })
      let rejectStartupChildFailure!: (error: Error) => void
      const startupChildFailure = new Promise<never>((_resolve, reject) => {
        rejectStartupChildFailure = reject
      })
      this.child.once('error', () => {
        rejectStartupChildFailure(new PiRuntimeManagerError('runtime_start_failed'))
      })
      this.child.once('exit', () => {
        this.resolveChildExit?.()
        if (this.state === 'starting') {
          rejectStartupChildFailure(new PiRuntimeManagerError('runtime_start_failed'))
        }
        if (this.state === 'ready') {
          this.state = 'crashed'
          this.health = undefined
          this.startPromise = undefined
          this.rejectPending('runtime_crashed')
          this.options.diagnostic?.('runtime_crashed')
          void this.cleanup()
            .then(
              () => this.options.onCrash?.(),
              () => this.options.onCrash?.(),
            )
            .catch(() => {})
        }
      })
      this.child.stdin.write(`${JSON.stringify(bootstrap)}\n`)

      this.socket = await Promise.race([
        this.dependencies.connect(this.endpoint.endpoint),
        startupChildFailure,
      ])
      this.attachSocket(this.socket)
      const hello = asRecord(
        await this.request('runtime.hello', {
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          schemaVersion: SCHEMA_VERSION,
          token,
        }),
      )
      if (
        hello === undefined ||
        !Number.isInteger(hello.pid) ||
        (hello.pid as number) <= 0 ||
        (!windowsJobLauncher && hello.pid !== this.child.pid) ||
        typeof hello.instanceId !== 'string' ||
        hello.instanceId.length === 0 ||
        !Array.isArray(hello.capabilities) ||
        !hello.capabilities.includes('runtime.status') ||
        !hello.capabilities.includes('runtime.shutdown') ||
        !hello.capabilities.includes('session.create') ||
        !hello.capabilities.includes('session.open') ||
        !hello.capabilities.includes('session.prompt') ||
        !hello.capabilities.includes('session.abort') ||
        !hello.capabilities.includes('session.fork') ||
        !hello.capabilities.includes('session.navigate') ||
        !hello.capabilities.includes('session.snapshot') ||
        !hello.capabilities.includes('session.subscribe') ||
        !hello.capabilities.includes('credential.put') ||
        !hello.capabilities.includes('credential.status') ||
        !hello.capabilities.includes('credential.delete')
      ) {
        throw new PiRuntimeManagerError('runtime_hello_invalid')
      }
      this.health = {
        state: 'ready',
        pid: hello.pid as number,
        instanceId: hello.instanceId,
        runtimeVersion: RUNTIME_VERSION,
      }
      this.state = 'ready'
      return this.health
    } catch (error) {
      const managerError =
        error instanceof PiRuntimeManagerError
          ? error
          : new PiRuntimeManagerError('runtime_start_failed')
      this.state = 'crashed'
      this.socket?.destroy()
      this.child?.kill()
      await this.cleanup()
      this.options.diagnostic?.(managerError.code)
      throw managerError
    }
  }

  private attachSocket(socket: PiRuntimeSocket) {
    const decoder = createNdjsonFrameDecoder()
    socket.on('data', (chunk) => {
      let frames: ProtocolEnvelope[]
      try {
        frames = decoder.push(chunk)
      } catch {
        this.rejectPending('runtime_protocol_invalid')
        socket.destroy()
        return
      }
      for (const frame of frames) {
        if (frame.kind === 'request') {
          void this.handleCredentialRequest(socket, frame)
          continue
        }
        if (frame.kind === 'event') {
          for (const listener of this.eventListeners) listener(frame)
          continue
        }
        if (frame.kind !== 'response') continue
        const pending = this.pending.get(frame.id)
        if (pending === undefined) continue
        this.pending.delete(frame.id)
        if ('error' in frame) pending.reject(new PiRuntimeManagerError(frame.error.code))
        else pending.resolve(frame.result)
      }
    })
    socket.once('close', () => this.rejectPending('runtime_connection_closed'))
    socket.once('error', () => this.rejectPending('runtime_connection_error'))
  }

  private async handleCredentialRequest(socket: PiRuntimeSocket, frame: RequestEnvelope) {
    let request
    try {
      request = parseCredentialBrokerRequest(frame)
    } catch {
      socket.write(hostErrorResponse(frame, 'method_not_found'))
      return
    }
    const broker = this.options.credentialBroker
    if (!broker) {
      socket.write(hostErrorResponse(request, 'secure_storage_unavailable'))
      return
    }
    try {
      if (request.method === 'credential.put') {
        socket.write(hostResponse(request, await broker.put(request.params)))
        return
      }
      if (request.method === 'credential.rotate') {
        socket.write(hostResponse(request, await broker.rotate(request.params)))
        return
      }
      if (request.method === 'credential.get') {
        socket.write(hostResponse(request, (await broker.get(request.params.slot)) ?? null))
        return
      }
      if (request.method === 'credential.status') {
        socket.write(hostResponse(request, await broker.status(request.params.slot)))
        return
      }
      socket.write(
        hostResponse(
          request,
          await broker.delete(request.params.slot, request.params.expectedGeneration),
        ),
      )
    } catch (error) {
      const candidate = error as { code?: unknown }
      const code =
        typeof candidate.code === 'string' && CREDENTIAL_BROKER_ERROR_CODES.has(candidate.code)
          ? candidate.code
          : 'internal_error'
      socket.write(hostErrorResponse(request, code))
    }
  }

  private request(method: ClientRuntimeMethod, params: unknown) {
    const socket = this.socket!
    this.requestSequence += 1
    const id = `runtime-${this.requestSequence}-${this.dependencies.randomUUID()}`
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    socket.write(
      `${JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id,
        method,
        correlationId: this.dependencies.randomUUID(),
        params,
      })}\n`,
    )
    return response
  }

  onSessionEvent(listener: (event: EventEnvelope) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async putCredential(input: ProviderCredentialPutRequest) {
    this.assertReady()
    try {
      return parseProviderCredentialStatus(await this.request('credential.put', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('provider_credential_status_invalid')
    }
  }

  async credentialStatus(input: ProviderCredentialProviderRequest) {
    this.assertReady()
    try {
      return parseProviderCredentialStatus(await this.request('credential.status', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('provider_credential_status_invalid')
    }
  }

  async deleteCredential(input: ProviderCredentialProviderRequest) {
    this.assertReady()
    try {
      return parseProviderCredentialStatus(await this.request('credential.delete', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('provider_credential_status_invalid')
    }
  }

  async createSession(input: SessionCreateRequest): Promise<SessionConnectionReceipt> {
    this.assertReady()
    try {
      return parseSessionConnectionReceipt(await this.request('session.create', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_connection_receipt_invalid')
    }
  }

  async openSession(input: SessionOpenRequest): Promise<SessionConnectionReceipt> {
    this.assertReady()
    try {
      return parseSessionConnectionReceipt(await this.request('session.open', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_connection_receipt_invalid')
    }
  }

  async promptSession(input: SessionPromptRequest): Promise<SessionPromptReceipt> {
    this.assertReady()
    try {
      return parseSessionPromptReceipt(await this.request('session.prompt', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_prompt_receipt_invalid')
    }
  }

  async abortSession(input: SessionAbortRequest): Promise<SessionAbortReceipt> {
    this.assertReady()
    try {
      return parseSessionAbortReceipt(await this.request('session.abort', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_abort_receipt_invalid')
    }
  }

  async forkSession(input: SessionForkRequest): Promise<SessionForkReceipt> {
    this.assertReady()
    try {
      return parseSessionForkReceipt(await this.request('session.fork', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_fork_receipt_invalid')
    }
  }

  async navigateSession(input: SessionNavigateRequest): Promise<SessionNavigateReceipt> {
    this.assertReady()
    try {
      return parseSessionNavigateReceipt(await this.request('session.navigate', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_navigate_receipt_invalid')
    }
  }

  async snapshotSession(input: SessionBoundRequest): Promise<SessionSnapshot> {
    this.assertReady()
    try {
      return parseSessionSnapshot(await this.request('session.snapshot', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_snapshot_invalid')
    }
  }

  async subscribeSession(input: SessionSubscribeRequest): Promise<SessionSubscriptionReceipt> {
    this.assertReady()
    try {
      return parseSessionSubscriptionReceipt(await this.request('session.subscribe', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_subscription_receipt_invalid')
    }
  }

  private assertReady() {
    if (this.state !== 'ready') throw new PiRuntimeManagerError('runtime_unavailable')
  }

  private rejectPending(code: string) {
    for (const pending of this.pending.values()) pending.reject(new PiRuntimeManagerError(code))
    this.pending.clear()
  }

  async status(): Promise<PiRuntimeHealth> {
    this.assertReady()
    if (this.health === undefined) throw new PiRuntimeManagerError('runtime_unavailable')
    const result = asRecord(await this.request('runtime.status', {}))
    if (
      result === undefined ||
      result.pid !== this.health.pid ||
      result.instanceId !== this.health.instanceId ||
      result.runtimeVersion !== RUNTIME_VERSION
    ) {
      throw new PiRuntimeManagerError('runtime_status_invalid')
    }
    return this.health
  }

  async shutdown(): Promise<void> {
    if (this.state === 'stopped') return
    if (this.state === 'starting') await this.startPromise!
    if (this.state === 'crashed') {
      await this.cleanup()
      return
    }
    this.state = 'stopping'
    await this.request('runtime.shutdown', {})
    this.child?.stdin.end()
    this.socket?.end()
    await this.childExit
    await this.cleanup()
    this.health = undefined
    this.startPromise = undefined
    this.state = 'stopped'
  }

  private cleanup(): Promise<void> {
    if (this.cleanupPromise === undefined) {
      this.cleanupPromise = this.endpoint?.cleanup() ?? Promise.resolve()
    }
    return this.cleanupPromise
  }
}
