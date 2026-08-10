import type { CredentialStore } from '@earendil-works/pi-ai'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type FetchLike,
  type OAuthClientProvider,
  type Transport,
} from '@modelcontextprotocol/client'
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/client/stdio'
import type { McpCredentialEnvironment } from './mcp-config-resolver'

type ActiveMcpServerBase = {
  namespace: 'global' | 'project'
  serverId: string
  enabledToolIds: readonly string[]
  timeoutMs: number
  contentSha256: string
}

export type ActiveStdioMcpServer = ActiveMcpServerBase & {
  transport: 'stdio'
  command: string
  args: readonly string[]
  inheritedEnv: readonly string[]
  credentialEnvironment: readonly McpCredentialEnvironment[]
}

export type ActiveHttpMcpServer = ActiveMcpServerBase & {
  transport: 'streamable-http' | 'legacy-sse'
  endpoint: string
  credentialRef?: { slot: string; kind: 'api_key' | 'oauth' }
}

export type ActiveMcpServer = ActiveStdioMcpServer | ActiveHttpMcpServer

export type McpToolDescriptor = {
  canonicalToolId: string
  modelAlias: string
  serverId: string
  toolName: string
  description: string
  inputSchema: unknown
  effect: 'read'
}

export type McpExecutionContext = {
  actorId: string
  documentId: string
  runId: string
  signal: AbortSignal
}

export type McpToolResult = {
  content: readonly { type: 'text'; text: string }[]
  details: {
    provenance: {
      toolId: string
      serverId: string
      toolName: string
      actorId: string
      documentId: string
      runId: string
    }
    artifacts?: readonly {
      artifactId: string
      displayName: string
      mediaType: string
      byteLength: number
    }[]
  }
}

type McpClient = Pick<Client, 'connect' | 'listTools' | 'callTool' | 'close' | 'onclose'>
type McpTransport = Transport & Partial<Pick<StdioClientTransport, 'pid' | 'stderr'>>

export type McpConnectionSupervisorOptions = {
  server: ActiveMcpServer
  credentials: Pick<CredentialStore, 'read'>
  environment?: Readonly<Record<string, string | undefined>>
  oauthProvider?: OAuthClientProvider
  fetch?: FetchLike
  authorize: (input: {
    actorId: string
    documentId: string
    runId: string
    serverId: string
    toolName: string
    canonicalToolId: string
    effect: 'read'
    arguments: unknown
  }) => Promise<boolean>
  stderrLimitBytes?: number
  artifactBroker?: {
    registerMcpContent(input: {
      serverId: string
      toolName: string
      documentId: string
      runId: string
      content: unknown
    }): Promise<{
      artifactId: string
      displayName: string
      mediaType: string
      byteLength: number
    }>
  }
  createConnection?: (input: {
    server: ActiveMcpServer
    env?: Record<string, string>
    authProvider?: AuthProvider | OAuthClientProvider
  }) => {
    client: McpClient
    transport: McpTransport
  }
}

export type McpExecutionErrorCode =
  | 'capability_revoked'
  | 'tool_not_in_snapshot'
  | 'tool_aborted'
  | 'tool_timeout'
  | 'mcp_result_unknown'
  | 'artifact_invalid'
  | 'mcp_unavailable'
  | 'mcp_credential_missing'
  | 'mcp_oauth_required'

export class McpExecutionError extends Error {
  constructor(readonly code: McpExecutionErrorCode) {
    super(code)
    this.name = 'McpExecutionError'
  }
}

type SupervisorState =
  'disabled' | 'connecting' | 'auth_required' | 'ready' | 'degraded' | 'failed' | 'stopping'

function providerIdFromSlot(slot: string): string {
  return slot.slice('model/'.length, -'/default'.length)
}

function secretFromCredential(
  credential: Awaited<ReturnType<CredentialStore['read']>>,
  kind: 'api_key' | 'oauth',
): string | undefined {
  if (kind === 'api_key' && credential?.type === 'api_key') return credential.key
  if (kind === 'oauth' && credential?.type === 'oauth') return credential.access
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsUnsafeRendererText(text: string): boolean {
  return /(?:https?:\/\/|file:\/\/|<\/?[a-z][^>]*>|(?:^|\s)(?:\/{2}|\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\))/i.test(
    text,
  )
}

export class McpConnectionSupervisor {
  private state: SupervisorState = 'disabled'
  private client: McpClient | undefined
  private transport: McpTransport | undefined
  private tools = new Map<string, McpToolDescriptor>()
  private discoveredTools: McpToolDescriptor[] = []
  private stderrTail = ''
  private stderrBytes = 0
  private secrets: string[] = []
  private readonly stderrLimitBytes: number

  constructor(private readonly options: McpConnectionSupervisorOptions) {
    this.stderrLimitBytes = options.stderrLimitBytes ?? 8_192
    if (this.stderrLimitBytes < 1 || this.stderrLimitBytes > 65_536) {
      throw new McpExecutionError('mcp_unavailable')
    }
  }

  get pid(): number | null {
    return this.transport?.pid ?? null
  }

  catalogTools(): readonly McpToolDescriptor[] {
    return this.discoveredTools.map((tool) => ({ ...tool }))
  }

  async connect(): Promise<readonly McpToolDescriptor[]> {
    if (this.state === 'ready') return [...this.tools.values()]
    if (this.state === 'connecting' || this.state === 'stopping') {
      throw new McpExecutionError('mcp_unavailable')
    }
    this.state = 'connecting'
    try {
      await this.closeConnection()
      const env =
        this.options.server.transport === 'stdio' ? await this.resolveEnvironment() : undefined
      const authProvider = await this.resolveHttpAuthProvider()
      const connection =
        this.options.createConnection?.({
          server: this.options.server,
          env,
          authProvider,
        }) ?? this.createConnection(env, authProvider)
      this.client = connection.client
      this.transport = connection.transport
      connection.client.onclose = () => {
        if (this.state !== 'stopping' && this.state !== 'disabled') this.state = 'degraded'
      }
      connection.transport.stderr?.on('data', (chunk: Buffer | string) => {
        this.captureStderr(Buffer.from(chunk).toString('utf8'))
      })
      await connection.client.connect(connection.transport)
      const listed = await connection.client.listTools(undefined, {
        timeout: this.options.server.timeoutMs,
      })
      const enabled = new Set(this.options.server.enabledToolIds)
      const discoveredTools = listed.tools
        .filter(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(tool.name),
        )
        .map((tool): McpToolDescriptor => ({
          canonicalToolId: `mcp:${this.options.server.serverId}:${tool.name}`,
          modelAlias: tool.name,
          serverId: this.options.server.serverId,
          toolName: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema,
          effect: 'read',
        }))
        .sort((left, right) => left.canonicalToolId.localeCompare(right.canonicalToolId))
      this.discoveredTools = discoveredTools
      const tools = discoveredTools.filter((tool) => enabled.has(tool.toolName))
      this.tools = new Map(tools.map((tool) => [tool.toolName, tool]))
      this.state = 'ready'
      return tools
    } catch (error) {
      this.state =
        error instanceof UnauthorizedError ||
        (error instanceof McpExecutionError && error.code === 'mcp_oauth_required')
          ? 'auth_required'
          : 'failed'
      await this.closeConnection()
      if (error instanceof McpExecutionError) throw error
      if (error instanceof UnauthorizedError) throw new McpExecutionError('mcp_oauth_required')
      throw new McpExecutionError('mcp_unavailable')
    }
  }

  async callTool(
    toolName: string,
    argumentsValue: unknown,
    context: McpExecutionContext,
  ): Promise<McpToolResult> {
    if (this.state !== 'ready' || !this.client) throw new McpExecutionError('mcp_unavailable')
    const tool = this.tools.get(toolName)
    if (!tool) throw new McpExecutionError('tool_not_in_snapshot')
    if (
      !(await this.options.authorize({
        actorId: context.actorId,
        documentId: context.documentId,
        runId: context.runId,
        serverId: this.options.server.serverId,
        toolName,
        canonicalToolId: tool.canonicalToolId,
        effect: 'read',
        arguments: argumentsValue,
      }))
    ) {
      throw new McpExecutionError('capability_revoked')
    }
    try {
      if (context.signal.aborted) throw new McpExecutionError('tool_aborted')
      const result = await this.client.callTool(
        {
          name: toolName,
          arguments: isRecord(argumentsValue) ? argumentsValue : {},
        },
        { signal: context.signal, timeout: this.options.server.timeoutMs },
      )
      if (result.isError) throw new McpExecutionError('mcp_result_unknown')
      const content: { type: 'text'; text: string }[] = []
      const artifacts: Array<{
        artifactId: string
        displayName: string
        mediaType: string
        byteLength: number
      }> = []
      for (const block of result.content) {
        if (block.type === 'text') {
          if (containsUnsafeRendererText(block.text)) {
            throw new McpExecutionError('artifact_invalid')
          }
          content.push({ type: 'text', text: block.text })
          continue
        }
        if (!this.options.artifactBroker) throw new McpExecutionError('artifact_invalid')
        const artifact = await this.options.artifactBroker.registerMcpContent({
          serverId: this.options.server.serverId,
          toolName,
          documentId: context.documentId,
          runId: context.runId,
          content: block,
        })
        artifacts.push(artifact)
        content.push({ type: 'text', text: `[artifact:${artifact.artifactId}]` })
      }
      return {
        content,
        details: {
          provenance: {
            toolId: tool.canonicalToolId,
            serverId: this.options.server.serverId,
            toolName,
            actorId: context.actorId,
            documentId: context.documentId,
            runId: context.runId,
          },
          ...(artifacts.length > 0 ? { artifacts } : {}),
        },
      }
    } catch (error) {
      if (error instanceof McpExecutionError) throw error
      if (context.signal.aborted) throw new McpExecutionError('tool_aborted')
      if (this.state !== 'ready') throw new McpExecutionError('mcp_result_unknown')
      if (error instanceof Error && /timeout/i.test(error.message)) {
        throw new McpExecutionError('tool_timeout')
      }
      throw new McpExecutionError('mcp_result_unknown')
    }
  }

  diagnostics(): { state: SupervisorState; stderrBytes: number; stderrTail: string } {
    return { state: this.state, stderrBytes: this.stderrBytes, stderrTail: this.stderrTail }
  }

  async close(): Promise<void> {
    if (this.state === 'disabled') return
    this.state = 'stopping'
    await this.closeConnection()
    this.state = 'disabled'
    this.tools.clear()
    this.discoveredTools = []
    this.secrets = []
  }

  private async resolveEnvironment(): Promise<Record<string, string>> {
    if (this.options.server.transport !== 'stdio') return {}
    // The official transport always merges a small ambient baseline. Override every
    // non-whitelisted baseline name with an empty value so no host value reaches MCP.
    const env: Record<string, string> = Object.fromEntries(
      DEFAULT_INHERITED_ENV_VARS.map((name) => [name, '']),
    )
    for (const name of this.options.server.inheritedEnv) {
      const value = this.options.environment?.[name] ?? process.env[name]
      if (value !== undefined) env[name] = value
    }
    const secrets: string[] = []
    for (const item of this.options.server.credentialEnvironment) {
      const credential = await this.options.credentials.read(
        providerIdFromSlot(item.credentialRef.slot),
      )
      const secret = secretFromCredential(credential, item.credentialRef.kind)
      if (!secret) throw new McpExecutionError('mcp_credential_missing')
      env[item.name] = secret
      secrets.push(secret)
    }
    this.secrets = secrets
    return env
  }

  private async resolveHttpAuthProvider(): Promise<AuthProvider | OAuthClientProvider | undefined> {
    if (this.options.server.transport === 'stdio' || !this.options.server.credentialRef) {
      return undefined
    }
    if (this.options.server.credentialRef.kind === 'oauth') {
      if (!this.options.oauthProvider) throw new McpExecutionError('mcp_oauth_required')
      return this.options.oauthProvider
    }
    const providerId = providerIdFromSlot(this.options.server.credentialRef.slot)
    const credential = await this.options.credentials.read(providerId)
    if (credential?.type !== 'api_key' || !credential.key) {
      throw new McpExecutionError('mcp_credential_missing')
    }
    this.secrets = [credential.key]
    return { token: async () => credential.key }
  }

  private createConnection(
    env: Record<string, string> | undefined,
    authProvider: AuthProvider | OAuthClientProvider | undefined,
  ): { client: McpClient; transport: McpTransport } {
    const client = new Client({ name: 'open-genoffice', version: '0.1.0' })
    if (this.options.server.transport === 'stdio') {
      return {
        client,
        transport: new StdioClientTransport({
          command: this.options.server.command,
          args: [...this.options.server.args],
          env: env ?? {},
          stderr: 'pipe',
          maxBufferSize: 1024 * 1024,
        }),
      }
    }
    const url = new URL(this.options.server.endpoint)
    if (this.options.server.transport === 'legacy-sse') {
      return {
        client,
        transport: new SSEClientTransport(url, {
          authProvider,
          fetch: this.options.fetch,
        }),
      }
    }
    return {
      client,
      transport: new StreamableHTTPClientTransport(url, {
        authProvider,
        fetch: this.options.fetch,
        reconnectionOptions: {
          initialReconnectionDelay: 100,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 2,
          maxRetries: 2,
        },
      }),
    }
  }

  private captureStderr(value: string): void {
    this.stderrBytes += Buffer.byteLength(value)
    let redacted = value
    for (const secret of this.secrets) redacted = redacted.split(secret).join('[REDACTED]')
    redacted = redacted
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
      .replace(/(?:sk|token|secret)[-_=: ]+[A-Za-z0-9._~+/-]{8,}/gi, '[REDACTED]')
    this.stderrTail = `${this.stderrTail}${redacted}`.slice(-this.stderrLimitBytes)
  }

  private async closeConnection(): Promise<void> {
    const client = this.client
    const transport = this.transport
    this.client = undefined
    this.transport = undefined
    await Promise.allSettled([client?.close(), transport?.close()])
  }
}
