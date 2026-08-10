import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  atomicWriteJson,
  ProjectTrustStore,
  ResourceActivationStore,
  resolveProjectIdentity,
  type ResourceActivationDescriptor,
} from '@genoffice/agent-resource'

const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const CREDENTIAL_SLOT = /^model\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/default$/
const INTERPOLATION = /\$\{|\$\(|`|{{|}}/
const SECRET_ARGUMENT = /(?:^|[-_])(authorization|api[-_]?key|password|secret|token)(?:$|[=_-])/i

export type McpCredentialReference = {
  slot: string
  kind: 'api_key' | 'oauth'
}

export type McpCredentialEnvironment = {
  name: string
  credentialRef: McpCredentialReference
}

export type McpServerState = 'eligible' | 'activation_required' | 'disabled' | 'server_id_collision'

type ResolvedMcpServerBase = {
  namespace: 'global' | 'project'
  serverId: string
  enabledToolIds: readonly string[]
  timeoutMs: number
  enabled: boolean
  contentSha256: string
  activation: ResourceActivationDescriptor
  state: McpServerState
}

export type ResolvedMcpServer = ResolvedMcpServerBase &
  (
    | {
        transport: 'stdio'
        command: string
        args: readonly string[]
        inheritedEnv: readonly string[]
        credentialEnvironment: readonly McpCredentialEnvironment[]
      }
    | {
        transport: 'streamable-http' | 'legacy-sse'
        endpoint: string
        credentialRef?: McpCredentialReference
      }
  )

type StoredMcpServerBase = {
  serverId: string
  enabledToolIds: string[]
  timeoutMs: number
  enabled: boolean
}

type StoredMcpServer = StoredMcpServerBase &
  (
    | {
        transport: 'stdio'
        command: string
        args: string[]
        environment: {
          inherit: string[]
          credentials: McpCredentialEnvironment[]
        }
      }
    | {
        transport: 'streamable-http' | 'legacy-sse'
        endpoint: string
        credentialRef?: McpCredentialReference
      }
  )

type StoredStdioMcpServer = StoredMcpServerBase & {
  transport: 'stdio'
  command: string
  args: string[]
  environment: {
    inherit: string[]
    credentials: McpCredentialEnvironment[]
  }
}

export class McpConfigError extends Error {
  constructor(
    readonly code:
      'mcp_config_invalid' | 'mcp_server_not_found' | 'mcp_scope_invalid' | 'mcp_project_untrusted',
  ) {
    super(code)
    this.name = 'McpConfigError'
  }
}

export type OpenGenOfficeMcpConfigResolverOptions = {
  resourceHome: string
  deviceId: string
}

export type McpConfigScope = {
  namespace: 'global' | 'project'
  projectRoot?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function parseCredentialReference(value: unknown): McpCredentialReference {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['slot', 'kind']) ||
    typeof value.slot !== 'string' ||
    !CREDENTIAL_SLOT.test(value.slot) ||
    (value.kind !== 'api_key' && value.kind !== 'oauth')
  ) {
    throw new McpConfigError('mcp_config_invalid')
  }
  return { slot: value.slot, kind: value.kind }
}

function parseCredentialEnvironment(value: unknown): McpCredentialEnvironment[] {
  if (!Array.isArray(value) || value.length > 128) throw new McpConfigError('mcp_config_invalid')
  const parsed = value.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ['name', 'credentialRef'])) {
      throw new McpConfigError('mcp_config_invalid')
    }
    if (
      typeof entry.name !== 'string' ||
      !ENVIRONMENT_NAME.test(entry.name) ||
      entry.credentialRef === undefined
    ) {
      throw new McpConfigError('mcp_config_invalid')
    }
    return {
      name: entry.name,
      credentialRef: parseCredentialReference(entry.credentialRef),
    }
  })
  if (!unique(parsed.map(({ name }) => name))) throw new McpConfigError('mcp_config_invalid')
  return parsed
}

function parseCommonServer(value: Record<string, unknown>): StoredMcpServerBase {
  if (
    typeof value.serverId !== 'string' ||
    !SERVER_ID.test(value.serverId) ||
    !Array.isArray(value.enabledToolIds) ||
    value.enabledToolIds.length > 512 ||
    value.enabledToolIds.some((id) => typeof id !== 'string' || !TOOL_ID.test(id)) ||
    !unique(value.enabledToolIds as string[]) ||
    !Number.isInteger(value.timeoutMs) ||
    (value.timeoutMs as number) < 100 ||
    (value.timeoutMs as number) > 300_000 ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new McpConfigError('mcp_config_invalid')
  }
  return {
    serverId: value.serverId,
    enabledToolIds: value.enabledToolIds as string[],
    timeoutMs: value.timeoutMs as number,
    enabled: value.enabled,
  }
}

function parseStdioServer(value: Record<string, unknown>): StoredStdioMcpServer {
  if (
    !exactKeys(value, [
      'serverId',
      'transport',
      'command',
      'args',
      'environment',
      'enabledToolIds',
      'timeoutMs',
      'enabled',
    ]) ||
    typeof value.command !== 'string' ||
    !isAbsolute(value.command) ||
    INTERPOLATION.test(value.command) ||
    !Array.isArray(value.args) ||
    value.args.length > 128 ||
    value.args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length > 4096 ||
        INTERPOLATION.test(argument) ||
        SECRET_ARGUMENT.test(argument),
    ) ||
    !isRecord(value.environment) ||
    !exactKeys(value.environment, ['inherit', 'credentials']) ||
    !Array.isArray(value.environment.inherit) ||
    value.environment.inherit.length > 128 ||
    value.environment.inherit.some(
      (name) => typeof name !== 'string' || !ENVIRONMENT_NAME.test(name),
    ) ||
    !unique(value.environment.inherit as string[])
  ) {
    throw new McpConfigError('mcp_config_invalid')
  }
  const common = parseCommonServer(value)
  const credentials = parseCredentialEnvironment(value.environment.credentials)
  const inherited = value.environment.inherit as string[]
  if (!unique([...inherited, ...credentials.map(({ name }) => name)])) {
    throw new McpConfigError('mcp_config_invalid')
  }
  return {
    ...common,
    transport: 'stdio',
    command: value.command,
    args: value.args as string[],
    environment: { inherit: inherited, credentials },
  }
}

function parseHttpEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || INTERPOLATION.test(value)) {
    throw new McpConfigError('mcp_config_invalid')
  }
  try {
    const url = new URL(value)
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname === '/'
    ) {
      throw new Error('invalid')
    }
    return url.toString()
  } catch {
    throw new McpConfigError('mcp_config_invalid')
  }
}

function parseHttpServer(value: Record<string, unknown>): StoredMcpServer {
  if (
    !exactKeys(value, [
      'serverId',
      'transport',
      'endpoint',
      'credentialRef',
      'enabledToolIds',
      'timeoutMs',
      'enabled',
    ]) ||
    (value.transport !== 'streamable-http' && value.transport !== 'legacy-sse')
  ) {
    throw new McpConfigError('mcp_config_invalid')
  }
  const common = parseCommonServer(value)
  return {
    ...common,
    transport: value.transport,
    endpoint: parseHttpEndpoint(value.endpoint),
    ...(value.credentialRef === undefined
      ? {}
      : { credentialRef: parseCredentialReference(value.credentialRef) }),
  }
}

function parseServer(value: unknown): StoredMcpServer {
  if (!isRecord(value)) throw new McpConfigError('mcp_config_invalid')
  if (value.transport === 'stdio') return parseStdioServer(value)
  return parseHttpServer(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function readConfig(path: string): Promise<StoredMcpServer[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new McpConfigError('mcp_config_invalid')
  }
  try {
    const value: unknown = JSON.parse(content)
    if (
      !isRecord(value) ||
      !exactKeys(value, ['schemaVersion', 'servers']) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.servers) ||
      value.servers.length > 256
    ) {
      throw new Error('invalid')
    }
    const servers = value.servers.map(parseServer)
    if (!unique(servers.map(({ serverId }) => serverId))) throw new Error('invalid')
    return servers
  } catch (error) {
    if (error instanceof McpConfigError) throw error
    throw new McpConfigError('mcp_config_invalid')
  }
}

export class OpenGenOfficeMcpConfigResolver {
  private readonly trust: ProjectTrustStore
  private readonly activation: ResourceActivationStore

  constructor(private readonly options: OpenGenOfficeMcpConfigResolverOptions) {
    this.trust = new ProjectTrustStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
    })
    this.activation = new ResourceActivationStore({
      rootDirectory: options.resourceHome,
      deviceId: options.deviceId,
    })
  }

  async resolve(projectRoot?: string): Promise<ResolvedMcpServer[]> {
    const sources: Array<{
      namespace: 'global' | 'project'
      servers: StoredMcpServer[]
    }> = [
      {
        namespace: 'global',
        servers: await readConfig(join(this.options.resourceHome, 'mcp', 'servers.json')),
      },
    ]
    if (projectRoot) {
      try {
        const identity = await resolveProjectIdentity(projectRoot, this.options.deviceId)
        if (await this.trust.isTrusted(identity)) {
          sources.push({
            namespace: 'project',
            servers: await readConfig(join(projectRoot, '.open-genoffice', 'mcp', 'servers.json')),
          })
        }
      } catch (error) {
        if (error instanceof McpConfigError) throw error
        // Invalid and untrusted projects contribute no executable configuration.
      }
    }

    const resolved = await Promise.all(
      sources.flatMap(({ namespace, servers }) =>
        servers.map(async (server): Promise<ResolvedMcpServer> => {
          const contentSha256 = createHash('sha256').update(canonicalJson(server)).digest('hex')
          const activation: ResourceActivationDescriptor = {
            namespace,
            resourceId: `mcp/${server.serverId}`,
            source: `${namespace}:mcp/${server.serverId}`,
            contentSha256,
            capabilities: [server.transport === 'stdio' ? 'executable' : 'network'],
          }
          const active = server.enabled && (await this.activation.isActive(activation))
          const state: McpServerState = !server.enabled
            ? 'disabled'
            : active
              ? 'eligible'
              : 'activation_required'
          const common = {
            namespace,
            serverId: server.serverId,
            enabledToolIds: Object.freeze([...server.enabledToolIds]),
            timeoutMs: server.timeoutMs,
            enabled: server.enabled,
            contentSha256,
            activation,
            state,
          }
          return Object.freeze(
            server.transport === 'stdio'
              ? {
                  ...common,
                  transport: 'stdio' as const,
                  command: server.command,
                  args: Object.freeze([...server.args]),
                  inheritedEnv: Object.freeze([...server.environment.inherit]),
                  credentialEnvironment: Object.freeze(
                    server.environment.credentials.map((entry) => Object.freeze(entry)),
                  ),
                }
              : {
                  ...common,
                  transport: server.transport,
                  endpoint: server.endpoint,
                  ...(server.credentialRef
                    ? { credentialRef: Object.freeze(server.credentialRef) }
                    : {}),
                },
          )
        }),
      ),
    )
    const counts = new Map<string, number>()
    for (const server of resolved)
      counts.set(server.serverId, (counts.get(server.serverId) ?? 0) + 1)
    return resolved
      .map((server) =>
        counts.get(server.serverId)! > 1
          ? Object.freeze({ ...server, state: 'server_id_collision' as const })
          : server,
      )
      .sort((left, right) =>
        left.serverId === right.serverId
          ? left.namespace.localeCompare(right.namespace)
          : left.serverId.localeCompare(right.serverId),
      )
  }

  async activate(scope: McpConfigScope, serverId: string): Promise<void> {
    const server = await this.requireServer(scope, serverId)
    await this.activation.activate(server.activation)
  }

  async setServerEnabled(scope: McpConfigScope, serverId: string, enabled: boolean): Promise<void> {
    await this.mutate(scope, serverId, (server) => ({ ...server, enabled }))
  }

  async setToolEnabled(
    scope: McpConfigScope,
    serverId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<void> {
    if (!TOOL_ID.test(toolName)) throw new McpConfigError('mcp_config_invalid')
    await this.mutate(scope, serverId, (server) => {
      const tools = new Set(server.enabledToolIds)
      if (enabled) tools.add(toolName)
      else tools.delete(toolName)
      return { ...server, enabledToolIds: [...tools].sort() }
    })
  }

  private async mutate(
    scope: McpConfigScope,
    serverId: string,
    update: (server: StoredMcpServer) => StoredMcpServer,
  ): Promise<void> {
    const path = await this.configPath(scope)
    const servers = await readConfig(path)
    const index = servers.findIndex((server) => server.serverId === serverId)
    if (index < 0) throw new McpConfigError('mcp_server_not_found')
    servers[index] = parseServer(update(servers[index]!))
    await atomicWriteJson(path, { schemaVersion: 1, servers })
  }

  private async requireServer(scope: McpConfigScope, serverId: string): Promise<ResolvedMcpServer> {
    await this.configPath(scope)
    const servers = await this.resolve(
      scope.namespace === 'project' ? scope.projectRoot : undefined,
    )
    const server = servers.find(
      (candidate) => candidate.namespace === scope.namespace && candidate.serverId === serverId,
    )
    if (!server) throw new McpConfigError('mcp_server_not_found')
    return server
  }

  private async configPath(scope: McpConfigScope): Promise<string> {
    if (scope.namespace === 'global') {
      if (scope.projectRoot !== undefined) throw new McpConfigError('mcp_scope_invalid')
      return join(this.options.resourceHome, 'mcp', 'servers.json')
    }
    if (!scope.projectRoot) throw new McpConfigError('mcp_scope_invalid')
    try {
      const identity = await resolveProjectIdentity(scope.projectRoot, this.options.deviceId)
      if (!(await this.trust.isTrusted(identity))) {
        throw new McpConfigError('mcp_project_untrusted')
      }
    } catch (error) {
      if (error instanceof McpConfigError) throw error
      throw new McpConfigError('mcp_project_untrusted')
    }
    return join(scope.projectRoot, '.open-genoffice', 'mcp', 'servers.json')
  }
}
