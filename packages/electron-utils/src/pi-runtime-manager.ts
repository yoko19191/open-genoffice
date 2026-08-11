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
  parseModelCatalogProjection,
  parseMcpCatalogProjection,
  parseMediaPreparationRequest,
  parseOAuthOperationProjection,
  parseOfficeToolInvocation,
  parseOfficeToolReceipt,
  parsePreparedMediaReceipt,
  parsePackageCatalogProjection,
  parseProviderCredentialStatus,
  parseResourceCatalogProjection,
  parseSessionAbortReceipt,
  parseSessionConnectionReceipt,
  parseSessionForkReceipt,
  parseSessionNavigateReceipt,
  parseSessionPromptReceipt,
  parseSessionSubagentResumeReceipt,
  parseSessionMutationGrantReceipt,
  parseSessionUserActionReceipt,
  parseSessionSnapshot,
  parseSessionSubscriptionReceipt,
  type BootstrapRecord,
  type ArtifactRef,
  type CredentialManagementRequest,
  type EventEnvelope,
  type ModelCatalogProjection,
  type McpCatalogProjection,
  type MediaPreparationAbortRequest,
  type MediaPreparationRequest,
  type ModelManagementRequest,
  type MutationGrantManagementRequest,
  type UserActionManagementRequest,
  type OfficeToolCatalogBinding,
  type ModelSelectionRole,
  type OAuthOperationProjection,
  type OfficeToolAbortRequest,
  type OfficeToolInvocation,
  type OfficeToolReceipt,
  type PackageCatalogProjection,
  type PreparedMediaReceipt,
  type ProtocolEnvelope,
  type ResourceCatalogProjection,
  type ResourceManagementRequest,
  type RequestEnvelope,
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
  officeToolHost?: {
    invoke(input: OfficeToolInvocation): Promise<OfficeToolReceipt>
    abort?(input: OfficeToolAbortRequest): Promise<boolean>
  }
  mediaPreparationHost?: {
    prepare(input: MediaPreparationRequest, signal: AbortSignal): Promise<PreparedMediaReceipt>
    abort(input: MediaPreparationAbortRequest): Promise<boolean>
  }
}

export type SessionCreateRequest = {
  operationId: string
  documentId: string
  officeToolCatalog?: OfficeToolCatalogBinding
}
export type SessionOpenRequest = SessionCreateRequest & { sessionId: string }
type SessionOperationRequest = Omit<SessionOpenRequest, 'officeToolCatalog'>
export type SessionPromptRequest = SessionOperationRequest & {
  text: string
  projectRoot?: string
  artifacts?: ArtifactRef[]
}
export type SessionAbortRequest = SessionOperationRequest & { runId: string }
export type SessionSubagentResumeRequest = SessionOperationRequest & { runId: string }
export type SessionMutationGrantIssueRequest = Extract<
  MutationGrantManagementRequest,
  { method: 'session.mutation-grant.issue' }
>['params']
export type SessionMutationGrantDenyRequest = Extract<
  MutationGrantManagementRequest,
  { method: 'session.mutation-grant.deny' }
>['params']
export type SessionMutationGrantRevokeRequest = Extract<
  MutationGrantManagementRequest,
  { method: 'session.mutation-grant.revoke' }
>['params']
export type SessionMutationGrantRevokeDocumentRequest = Extract<
  MutationGrantManagementRequest,
  { method: 'session.mutation-grant.revoke-document' }
>['params']
export type SessionUserActionAnswerRequest = UserActionManagementRequest['params']
export type SessionForkRequest = SessionOperationRequest
export type SessionNavigateRequest = SessionOperationRequest & { targetEntryId: string }
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
export type ModelSelectRequest = {
  role: ModelSelectionRole
  providerId: string
  modelId: string
}
export type ModelOAuthStartRequest = { operationId: string; providerId: string }
export type ModelOAuthOperationRequest = { operationId: string }
export type ModelOAuthRespondRequest = ModelOAuthOperationRequest & { value: string }
export type ModelProviderRequest = { providerId: string }
export type ModelProviderConfigureRequest = Extract<
  ModelManagementRequest,
  { method: 'model.provider.configure' }
>['params']
export type ResourceCatalogRequest = { projectRoot?: string }
export type ProjectTrustRequest = { operationId: string; projectRoot: string }
export type PackageCatalogRequest = Extract<
  ResourceManagementRequest,
  { method: 'package.catalog' }
>['params']
export type PackageInstallLocalRequest = Extract<
  ResourceManagementRequest,
  { method: 'package.install.local' }
>['params']
export type PackageInstallNpmRequest = Extract<
  ResourceManagementRequest,
  { method: 'package.install.npm' }
>['params']
export type PackageInstallGitRequest = Extract<
  ResourceManagementRequest,
  { method: 'package.install.git' }
>['params']
export type PackageMutationRequest = Extract<
  ResourceManagementRequest,
  {
    method: 'package.activate' | 'package.enable' | 'package.disable' | 'package.uninstall'
  }
>['params']
export type McpCatalogRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.catalog' }
>['params']
export type McpMutationRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.activate' | 'mcp.enable' | 'mcp.disable' | 'mcp.retry' }
>['params']
export type McpToolMutationRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.tool.enable' | 'mcp.tool.disable' }
>['params']
export type McpOAuthStartRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.oauth.start' }
>['params']
export type McpOAuthCompleteRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.oauth.complete' }
>['params']
export type McpOAuthOperationRequest = Extract<
  ResourceManagementRequest,
  { method: 'mcp.oauth.cancel' }
>['params']
export type McpOAuthStartProjection = {
  operationId: string
  authorizationUrl: string
  expiresAt: number
}

type ClientRuntimeMethod =
  | 'runtime.hello'
  | 'runtime.status'
  | 'runtime.shutdown'
  | 'session.create'
  | 'session.open'
  | 'session.prompt'
  | 'session.abort'
  | 'session.subagent.resume'
  | 'session.mutation-grant.issue'
  | 'session.mutation-grant.deny'
  | 'session.mutation-grant.revoke'
  | 'session.mutation-grant.revoke-document'
  | 'session.user-action.answer'
  | 'session.fork'
  | 'session.navigate'
  | 'session.snapshot'
  | 'session.subscribe'
  | 'credential.put'
  | 'credential.status'
  | 'credential.delete'
  | 'model.catalog'
  | 'model.select'
  | 'model.provider.configure'
  | 'model.oauth.start'
  | 'model.oauth.status'
  | 'model.oauth.respond'
  | 'model.oauth.cancel'
  | 'model.logout'
  | 'resource.catalog'
  | 'project.trust.grant'
  | 'project.trust.revoke'
  | 'package.catalog'
  | 'package.install.local'
  | 'package.install.npm'
  | 'package.install.git'
  | 'package.activate'
  | 'package.enable'
  | 'package.disable'
  | 'package.uninstall'
  | 'mcp.catalog'
  | 'mcp.activate'
  | 'mcp.enable'
  | 'mcp.disable'
  | 'mcp.retry'
  | 'mcp.oauth.start'
  | 'mcp.oauth.complete'
  | 'mcp.oauth.cancel'
  | 'mcp.tool.enable'
  | 'mcp.tool.disable'

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

function parseMcpOAuthStartProjection(value: unknown): McpOAuthStartProjection {
  const record = asRecord(value)
  if (
    !record ||
    Object.keys(record).some(
      (key) => !['operationId', 'authorizationUrl', 'expiresAt'].includes(key),
    ) ||
    typeof record.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.operationId,
    ) ||
    typeof record.authorizationUrl !== 'string' ||
    record.authorizationUrl.length > 4096 ||
    /[\r\n]/.test(record.authorizationUrl) ||
    typeof record.expiresAt !== 'number' ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= 0
  ) {
    throw new PiRuntimeManagerError('mcp_oauth_start_invalid')
  }
  try {
    const url = new URL(record.authorizationUrl)
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.hash ||
      !url.searchParams.get('state')
    ) {
      throw new Error('invalid')
    }
  } catch {
    throw new PiRuntimeManagerError('mcp_oauth_start_invalid')
  }
  return {
    operationId: record.operationId,
    authorizationUrl: record.authorizationUrl,
    expiresAt: record.expiresAt,
  }
}

const CREDENTIAL_BROKER_ERROR_CODES = new Set([
  'secure_storage_unavailable',
  'credential_generation_conflict',
  'credential_index_invalid',
  'credential_persist_failed',
  'credential_decrypt_failed',
])

const OFFICE_TOOL_HOST_ERROR_CODES = new Set([
  'document_mismatch',
  'tool_not_in_snapshot',
  'permission_denied',
  'duplicate_operation_mismatch',
  'invalid_tool_arguments',
  'stale_context',
  'mutation_grant_required',
  'read_only_document',
  'executor_unavailable',
  'mutation_outcome_unknown',
  'tool_timeout',
  'unsupported_office_feature',
])

const MEDIA_PREPARATION_ERROR_CODES = new Set([
  'artifact_invalid',
  'media_aborted',
  'media_malformed',
  'media_oversize',
  'media_strategy_unsupported',
  'media_frame_extractor_unavailable',
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
        !hello.capabilities.includes('session.subagent.resume') ||
        !hello.capabilities.includes('session.mutation-grant.issue') ||
        !hello.capabilities.includes('session.mutation-grant.deny') ||
        !hello.capabilities.includes('session.mutation-grant.revoke') ||
        !hello.capabilities.includes('session.mutation-grant.revoke-document') ||
        !hello.capabilities.includes('session.user-action.answer') ||
        !hello.capabilities.includes('session.fork') ||
        !hello.capabilities.includes('session.navigate') ||
        !hello.capabilities.includes('session.snapshot') ||
        !hello.capabilities.includes('session.subscribe') ||
        !hello.capabilities.includes('credential.put') ||
        !hello.capabilities.includes('credential.status') ||
        !hello.capabilities.includes('credential.delete') ||
        !hello.capabilities.includes('model.catalog') ||
        !hello.capabilities.includes('model.select') ||
        !hello.capabilities.includes('model.provider.configure') ||
        !hello.capabilities.includes('model.oauth.start') ||
        !hello.capabilities.includes('model.oauth.status') ||
        !hello.capabilities.includes('model.oauth.respond') ||
        !hello.capabilities.includes('model.oauth.cancel') ||
        !hello.capabilities.includes('model.logout') ||
        !hello.capabilities.includes('resource.catalog') ||
        !hello.capabilities.includes('project.trust.grant') ||
        !hello.capabilities.includes('project.trust.revoke') ||
        !hello.capabilities.includes('package.catalog') ||
        !hello.capabilities.includes('package.install.local') ||
        !hello.capabilities.includes('package.install.npm') ||
        !hello.capabilities.includes('package.install.git') ||
        !hello.capabilities.includes('package.activate') ||
        !hello.capabilities.includes('package.enable') ||
        !hello.capabilities.includes('package.disable') ||
        !hello.capabilities.includes('package.uninstall') ||
        !hello.capabilities.includes('mcp.catalog') ||
        !hello.capabilities.includes('mcp.activate') ||
        !hello.capabilities.includes('mcp.enable') ||
        !hello.capabilities.includes('mcp.disable') ||
        !hello.capabilities.includes('mcp.retry') ||
        !hello.capabilities.includes('mcp.oauth.start') ||
        !hello.capabilities.includes('mcp.oauth.complete') ||
        !hello.capabilities.includes('mcp.oauth.cancel') ||
        !hello.capabilities.includes('mcp.tool.enable') ||
        !hello.capabilities.includes('mcp.tool.disable')
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
          void this.handleHostRequest(socket, frame)
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

  private async handleHostRequest(socket: PiRuntimeSocket, frame: RequestEnvelope) {
    if (frame.method === 'office.tool.invoke') {
      await this.handleOfficeToolRequest(socket, frame)
      return
    }
    if (frame.method === 'office.tool.abort') {
      await this.handleOfficeToolAbortRequest(socket, frame)
      return
    }
    if (frame.method === 'media.prepare') {
      await this.handleMediaPreparationRequest(socket, frame)
      return
    }
    if (frame.method === 'media.prepare.abort') {
      await this.handleMediaPreparationAbortRequest(socket, frame)
      return
    }
    await this.handleCredentialRequest(socket, frame)
  }

  private async handleMediaPreparationRequest(
    socket: PiRuntimeSocket,
    frame: Extract<RequestEnvelope, { method: 'media.prepare' }>,
  ) {
    const host = this.options.mediaPreparationHost
    if (!host) {
      socket.write(hostErrorResponse(frame, 'executor_unavailable'))
      return
    }
    let input: MediaPreparationRequest
    try {
      input = parseMediaPreparationRequest(frame.params)
    } catch {
      socket.write(hostErrorResponse(frame, 'invalid_request'))
      return
    }
    const controller = new AbortController()
    try {
      socket.write(
        hostResponse(
          frame,
          parsePreparedMediaReceipt(await host.prepare(input, controller.signal)),
        ),
      )
    } catch (error) {
      const code = (error as { code?: unknown }).code
      socket.write(
        hostErrorResponse(
          frame,
          typeof code === 'string' && MEDIA_PREPARATION_ERROR_CODES.has(code)
            ? code
            : 'internal_error',
        ),
      )
    }
  }

  private async handleMediaPreparationAbortRequest(
    socket: PiRuntimeSocket,
    frame: Extract<RequestEnvelope, { method: 'media.prepare.abort' }>,
  ) {
    const host = this.options.mediaPreparationHost
    if (!host) {
      socket.write(hostErrorResponse(frame, 'executor_unavailable'))
      return
    }
    try {
      socket.write(hostResponse(frame, { aborted: await host.abort(frame.params) }))
    } catch {
      socket.write(hostErrorResponse(frame, 'internal_error'))
    }
  }

  private async handleOfficeToolAbortRequest(
    socket: PiRuntimeSocket,
    frame: Extract<RequestEnvelope, { method: 'office.tool.abort' }>,
  ) {
    const abort = this.options.officeToolHost?.abort
    if (!abort) {
      socket.write(hostErrorResponse(frame, 'executor_unavailable'))
      return
    }
    try {
      socket.write(hostResponse(frame, { aborted: await abort(frame.params) }))
    } catch {
      socket.write(hostErrorResponse(frame, 'internal_error'))
    }
  }

  private async handleOfficeToolRequest(socket: PiRuntimeSocket, frame: RequestEnvelope) {
    let invocation: OfficeToolInvocation
    try {
      invocation = parseOfficeToolInvocation(frame.params)
    } catch {
      socket.write(hostErrorResponse(frame, 'invalid_request'))
      return
    }
    const host = this.options.officeToolHost
    if (!host) {
      socket.write(hostErrorResponse(frame, 'executor_unavailable'))
      return
    }
    try {
      socket.write(hostResponse(frame, parseOfficeToolReceipt(await host.invoke(invocation))))
    } catch (error) {
      const code = (error as { code?: unknown }).code
      socket.write(
        hostErrorResponse(
          frame,
          typeof code === 'string' && OFFICE_TOOL_HOST_ERROR_CODES.has(code)
            ? code
            : 'internal_error',
        ),
      )
    }
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

  async modelCatalog(): Promise<ModelCatalogProjection> {
    this.assertReady()
    try {
      return parseModelCatalogProjection(await this.request('model.catalog', {}))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('model_catalog_invalid')
    }
  }

  async selectModel(input: ModelSelectRequest): Promise<ModelCatalogProjection> {
    this.assertReady()
    try {
      return parseModelCatalogProjection(await this.request('model.select', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('model_catalog_invalid')
    }
  }

  async configureModelProvider(
    input: ModelProviderConfigureRequest,
  ): Promise<ModelCatalogProjection> {
    this.assertReady()
    try {
      return parseModelCatalogProjection(await this.request('model.provider.configure', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('model_catalog_invalid')
    }
  }

  async startModelOAuth(input: ModelOAuthStartRequest): Promise<OAuthOperationProjection> {
    return this.modelOAuthRequest('model.oauth.start', input)
  }

  async modelOAuthStatus(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection> {
    return this.modelOAuthRequest('model.oauth.status', input)
  }

  async respondModelOAuth(input: ModelOAuthRespondRequest): Promise<OAuthOperationProjection> {
    return this.modelOAuthRequest('model.oauth.respond', input)
  }

  async cancelModelOAuth(input: ModelOAuthOperationRequest): Promise<OAuthOperationProjection> {
    return this.modelOAuthRequest('model.oauth.cancel', input)
  }

  async logoutModel(input: ModelProviderRequest): Promise<ModelCatalogProjection> {
    this.assertReady()
    try {
      return parseModelCatalogProjection(await this.request('model.logout', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('model_catalog_invalid')
    }
  }

  async resourceCatalog(input: ResourceCatalogRequest = {}): Promise<ResourceCatalogProjection> {
    return this.resourceManagementRequest('resource.catalog', input)
  }

  async grantProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection> {
    return this.resourceManagementRequest('project.trust.grant', input)
  }

  async revokeProjectTrust(input: ProjectTrustRequest): Promise<ResourceCatalogProjection> {
    return this.resourceManagementRequest('project.trust.revoke', input)
  }

  async packageCatalog(input: PackageCatalogRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.catalog', input)
  }

  async installLocalPackage(input: PackageInstallLocalRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.install.local', input)
  }

  async installNpmPackage(input: PackageInstallNpmRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.install.npm', input)
  }

  async installGitPackage(input: PackageInstallGitRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.install.git', input)
  }

  async activatePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.activate', input)
  }

  async enablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.enable', input)
  }

  async disablePackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.disable', input)
  }

  async uninstallPackage(input: PackageMutationRequest): Promise<PackageCatalogProjection> {
    return this.packageManagementRequest('package.uninstall', input)
  }

  async mcpCatalog(input: McpCatalogRequest = {}): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.catalog', input)
  }

  async activateMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.activate', input)
  }

  async enableMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.enable', input)
  }

  async disableMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.disable', input)
  }

  async retryMcp(input: McpMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.retry', input)
  }

  async startMcpOAuth(input: McpOAuthStartRequest): Promise<McpOAuthStartProjection> {
    this.assertReady()
    return parseMcpOAuthStartProjection(await this.request('mcp.oauth.start', input))
  }

  async completeMcpOAuth(input: McpOAuthCompleteRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.oauth.complete', input)
  }

  async cancelMcpOAuth(input: McpOAuthOperationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.oauth.cancel', input)
  }

  async enableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.tool.enable', input)
  }

  async disableMcpTool(input: McpToolMutationRequest): Promise<McpCatalogProjection> {
    return this.mcpManagementRequest('mcp.tool.disable', input)
  }

  private async resourceManagementRequest(
    method: 'resource.catalog' | 'project.trust.grant' | 'project.trust.revoke',
    input: ResourceCatalogRequest | ProjectTrustRequest,
  ): Promise<ResourceCatalogProjection> {
    this.assertReady()
    try {
      return parseResourceCatalogProjection(await this.request(method, input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('resource_catalog_invalid')
    }
  }

  private async packageManagementRequest(
    method:
      | 'package.catalog'
      | 'package.install.local'
      | 'package.install.npm'
      | 'package.install.git'
      | 'package.activate'
      | 'package.enable'
      | 'package.disable'
      | 'package.uninstall',
    input:
      | PackageCatalogRequest
      | PackageInstallLocalRequest
      | PackageInstallNpmRequest
      | PackageInstallGitRequest
      | PackageMutationRequest,
  ): Promise<PackageCatalogProjection> {
    this.assertReady()
    try {
      return parsePackageCatalogProjection(await this.request(method, input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('package_catalog_invalid')
    }
  }

  private async mcpManagementRequest(
    method:
      | 'mcp.catalog'
      | 'mcp.activate'
      | 'mcp.enable'
      | 'mcp.disable'
      | 'mcp.retry'
      | 'mcp.oauth.complete'
      | 'mcp.oauth.cancel'
      | 'mcp.tool.enable'
      | 'mcp.tool.disable',
    input:
      | McpCatalogRequest
      | McpMutationRequest
      | McpToolMutationRequest
      | McpOAuthCompleteRequest
      | McpOAuthOperationRequest,
  ): Promise<McpCatalogProjection> {
    this.assertReady()
    try {
      return parseMcpCatalogProjection(await this.request(method, input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('mcp_catalog_invalid')
    }
  }

  private async modelOAuthRequest(
    method:
      'model.oauth.start' | 'model.oauth.status' | 'model.oauth.respond' | 'model.oauth.cancel',
    input: ModelOAuthStartRequest | ModelOAuthOperationRequest | ModelOAuthRespondRequest,
  ): Promise<OAuthOperationProjection> {
    this.assertReady()
    try {
      return parseOAuthOperationProjection(await this.request(method, input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('oauth_operation_projection_invalid')
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

  async resumeSubagent(input: SessionSubagentResumeRequest): Promise<SessionSubagentResumeReceipt> {
    this.assertReady()
    try {
      return parseSessionSubagentResumeReceipt(await this.request('session.subagent.resume', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_subagent_resume_receipt_invalid')
    }
  }

  async issueMutationGrant(
    input: SessionMutationGrantIssueRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return this.mutationGrantRequest('session.mutation-grant.issue', input)
  }

  async denyMutationGrant(
    input: SessionMutationGrantDenyRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return this.mutationGrantRequest('session.mutation-grant.deny', input)
  }

  async revokeMutationGrant(
    input: SessionMutationGrantRevokeRequest,
  ): Promise<SessionMutationGrantReceipt> {
    return this.mutationGrantRequest('session.mutation-grant.revoke', input)
  }

  async revokeDocumentMutationGrants(
    input: SessionMutationGrantRevokeDocumentRequest,
  ): Promise<{ revoked: true }> {
    this.assertReady()
    const value = asRecord(await this.request('session.mutation-grant.revoke-document', input))
    if (value?.revoked !== true) {
      throw new PiRuntimeManagerError('session_mutation_grant_receipt_invalid')
    }
    return { revoked: true }
  }

  async answerUserAction(input: SessionUserActionAnswerRequest): Promise<SessionUserActionReceipt> {
    this.assertReady()
    try {
      return parseSessionUserActionReceipt(await this.request('session.user-action.answer', input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_user_action_receipt_invalid')
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

  private async mutationGrantRequest(
    method:
      | 'session.mutation-grant.issue'
      | 'session.mutation-grant.deny'
      | 'session.mutation-grant.revoke',
    input:
      | SessionMutationGrantIssueRequest
      | SessionMutationGrantDenyRequest
      | SessionMutationGrantRevokeRequest,
  ): Promise<SessionMutationGrantReceipt> {
    this.assertReady()
    try {
      return parseSessionMutationGrantReceipt(await this.request(method, input))
    } catch (error) {
      if (error instanceof PiRuntimeManagerError) throw error
      throw new PiRuntimeManagerError('session_mutation_grant_receipt_invalid')
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
