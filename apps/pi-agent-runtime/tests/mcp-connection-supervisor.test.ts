import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialStore } from '@earendil-works/pi-ai'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  McpConnectionSupervisor,
  McpExecutionError,
  type ActiveHttpMcpServer,
  type ActiveStdioMcpServer,
  type McpConnectionSupervisorOptions,
} from '../src/mcp-connection-supervisor'

const fixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

function server(overrides: Partial<ActiveStdioMcpServer> = {}): ActiveStdioMcpServer {
  return {
    namespace: 'global',
    serverId: 'stdio-fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    inheritedEnv: ['LANG'],
    credentialEnvironment: [
      {
        name: 'MCP_SECRET_CANARY',
        credentialRef: { slot: 'model/mcp-fixture/default', kind: 'api_key' },
      },
    ],
    enabledToolIds: ['read_fixture', 'sleep_fixture', 'unsafe_fixture'],
    timeoutMs: 2_000,
    contentSha256: 'a'.repeat(64),
    ...overrides,
  }
}

function credentials(secret = 'mcp-secret-canary'): CredentialStore {
  return {
    read: vi.fn(async () => ({ type: 'api_key' as const, key: secret })),
    list: vi.fn(async () => []),
    modify: vi.fn(),
    delete: vi.fn(),
  }
}

function httpServer(overrides: Partial<ActiveHttpMcpServer> = {}): ActiveHttpMcpServer {
  return {
    namespace: 'global',
    serverId: 'http-fixture',
    transport: 'streamable-http',
    endpoint: 'https://mcp.example.test/v1',
    credentialRef: { slot: 'model/mcp-http/default', kind: 'api_key' },
    enabledToolIds: ['read_fixture'],
    timeoutMs: 2_000,
    contentSha256: 'b'.repeat(64),
    ...overrides,
  }
}

async function eventuallyGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      return
    }
  }
  throw new Error(`process_still_alive:${pid}`)
}

describe('McpConnectionSupervisor', () => {
  it('selects Streamable HTTP without implicit SSE fallback and keeps OAuth auth-required', async () => {
    const createConnection = vi.fn(
      (_input: Parameters<NonNullable<McpConnectionSupervisorOptions['createConnection']>>[0]) => ({
        client: {
          onclose: undefined as (() => void) | undefined,
          connect: vi.fn(async () => undefined),
          listTools: vi.fn(async () => ({
            tools: [
              {
                name: 'read_fixture',
                inputSchema: { type: 'object' as const },
                annotations: { readOnlyHint: true },
              },
            ],
          })),
          callTool: vi.fn(),
          close: vi.fn(async () => undefined),
        },
        transport: new StdioClientTransport({ command: process.execPath }),
      }),
    )
    const apiKey = new McpConnectionSupervisor({
      server: httpServer(),
      credentials: credentials('http-api-key'),
      authorize: async () => true,
      createConnection,
    })
    await expect(apiKey.connect()).resolves.toMatchObject([{ toolName: 'read_fixture' }])
    const input = createConnection.mock.calls[0]![0]
    expect(input).toMatchObject({
      server: { transport: 'streamable-http', endpoint: 'https://mcp.example.test/v1' },
    })
    expect(input.env).toBeUndefined()
    if (!input.authProvider || !('token' in input.authProvider)) throw new Error('missing auth')
    await expect(input.authProvider.token()).resolves.toBe('http-api-key')
    await apiKey.close()

    const oauth = new McpConnectionSupervisor({
      server: httpServer({
        credentialRef: { slot: 'model/mcp-http/default', kind: 'oauth' },
      }),
      credentials: credentials(),
      authorize: async () => true,
      createConnection,
    })
    await expect(oauth.connect()).rejects.toMatchObject({ code: 'mcp_oauth_required' })
    expect(oauth.diagnostics().state).toBe('auth_required')
    expect(createConnection).toHaveBeenCalledTimes(1)
  })
  it('uses the official stdio client to discover and call whitelisted read tools with provenance', async () => {
    await access(fixture)
    const supervisor = new McpConnectionSupervisor({
      server: server(),
      credentials: credentials(),
      environment: { LANG: 'C', HOME: '/must-not-leak', MCP_UNLISTED: 'must-not-leak' },
      authorize: vi.fn(async () => true),
    })
    const tools = await supervisor.connect()
    expect(tools.map(({ canonicalToolId }) => canonicalToolId)).toEqual([
      'mcp:stdio-fixture:read_fixture',
      'mcp:stdio-fixture:sleep_fixture',
      'mcp:stdio-fixture:unsafe_fixture',
    ])
    expect(tools[0]).toMatchObject({ modelAlias: 'read_fixture', effect: 'read' })

    const result = await supervisor.callTool(
      'read_fixture',
      { value: 'hello' },
      {
        actorId: 'session-1',
        documentId: 'document-1',
        runId: 'run-1',
        signal: new AbortController().signal,
      },
    )
    expect(result).toEqual({
      content: [{ type: 'text', text: 'mcp:hello:canary-present:env-clean' }],
      details: {
        provenance: {
          toolId: 'mcp:stdio-fixture:read_fixture',
          serverId: 'stdio-fixture',
          toolName: 'read_fixture',
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
        },
      },
    })
    const pid = supervisor.pid
    expect(pid).toBeTypeOf('number')
    await supervisor.close()
    await eventuallyGone(pid!)
  })

  it('propagates AbortSignal, bounds and redacts stderr, and never replays a lost call', async () => {
    const supervisor = new McpConnectionSupervisor({
      server: server(),
      credentials: credentials(),
      environment: { LANG: 'C' },
      authorize: async () => true,
      stderrLimitBytes: 128,
    })
    await supervisor.connect()
    const controller = new AbortController()
    const pending = supervisor.callTool(
      'sleep_fixture',
      { milliseconds: 10_000 },
      {
        actorId: 'session-1',
        documentId: 'document-1',
        runId: 'run-1',
        signal: controller.signal,
      },
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'tool_aborted' })
    expect(supervisor.diagnostics()).toEqual({
      state: 'ready',
      stderrBytes: expect.any(Number),
      stderrTail: expect.not.stringContaining('mcp-secret-canary'),
    })
    expect(supervisor.diagnostics().stderrTail.length).toBeLessThanOrEqual(128)
    await supervisor.close()
  })

  it('rechecks authorization and blocks disabled, unlisted and unsafe content', async () => {
    let authorized = true
    const supervisor = new McpConnectionSupervisor({
      server: server({ enabledToolIds: ['read_fixture', 'unsafe_fixture'] }),
      credentials: credentials(),
      environment: {},
      authorize: async () => authorized,
    })
    await supervisor.connect()
    authorized = false
    await expect(
      supervisor.callTool(
        'read_fixture',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'capability_revoked' })
    authorized = true
    await expect(
      supervisor.callTool(
        'not_enabled',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'tool_not_in_snapshot' })
    await expect(
      supervisor.callTool(
        'unsafe_fixture',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(McpExecutionError)
    await supervisor.close()
  })

  it('routes resource and link blocks through the Artifact Broker before returning safe handles', async () => {
    const registerMcpContent = vi.fn(async () => ({
      artifactId: 'artifact-1',
      displayName: 'safe-link',
      mediaType: 'application/octet-stream',
      byteLength: 12,
    }))
    const supervisor = new McpConnectionSupervisor({
      server: server({ enabledToolIds: ['unsafe_fixture'] }),
      credentials: credentials(),
      environment: {},
      authorize: async () => true,
      artifactBroker: { registerMcpContent },
    })
    await supervisor.connect()
    await expect(
      supervisor.callTool(
        'unsafe_fixture',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: '[artifact:artifact-1]' }],
      details: {
        artifacts: [
          {
            artifactId: 'artifact-1',
            displayName: 'safe-link',
            mediaType: 'application/octet-stream',
            byteLength: 12,
          },
        ],
      },
    })
    expect(registerMcpContent).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'stdio-fixture',
        toolName: 'unsafe_fixture',
        documentId: 'document-1',
        content: expect.objectContaining({ type: 'resource_link' }),
      }),
    )
    await supervisor.close()
  })

  it('marks a post-dispatch server exit unknown and reconnects only for a future discovery', async () => {
    const supervisor = new McpConnectionSupervisor({
      server: server({ enabledToolIds: ['exit_fixture', 'read_fixture'] }),
      credentials: credentials(),
      environment: {},
      authorize: async () => true,
    })
    await supervisor.connect()
    await expect(
      supervisor.callTool(
        'exit_fixture',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_result_unknown' })
    expect(supervisor.diagnostics().state).toBe('degraded')
    await expect(supervisor.connect()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: 'read_fixture' })]),
    )
    expect(supervisor.diagnostics().state).toBe('ready')
    await supervisor.close()
  })

  it('normalizes connection, credential, timeout, abort, and tool error branches', async () => {
    expect(
      () =>
        new McpConnectionSupervisor({
          server: server(),
          credentials: credentials(),
          authorize: async () => true,
          stderrLimitBytes: 0,
        }),
    ).toThrowError('mcp_unavailable')
    expect(
      () =>
        new McpConnectionSupervisor({
          server: server(),
          credentials: credentials(),
          authorize: async () => true,
          stderrLimitBytes: 65_537,
        }),
    ).toThrowError('mcp_unavailable')

    const callTool = vi.fn()
    const close = vi.fn(async () => undefined)
    const client = {
      onclose: undefined as (() => void) | undefined,
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: 'read_fixture',
            inputSchema: { type: 'object' as const },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'mutation_fixture',
            inputSchema: { type: 'object' as const },
            annotations: { readOnlyHint: false },
          },
          {
            name: '../invalid',
            inputSchema: { type: 'object' as const },
            annotations: { readOnlyHint: true },
          },
        ],
      })),
      callTool,
      close,
    }
    const transport = new StdioClientTransport({ command: process.execPath, stderr: 'pipe' })
    const supervisor = new McpConnectionSupervisor({
      server: server({
        inheritedEnv: ['GENOFFICE_MCP_MISSING_ENV'],
        credentialEnvironment: [],
        enabledToolIds: ['read_fixture'],
      }),
      credentials: credentials(),
      environment: {},
      authorize: async () => true,
      createConnection: () => ({ client, transport }),
    })
    await expect(supervisor.connect()).resolves.toMatchObject([
      { toolName: 'read_fixture', description: 'read_fixture' },
    ])
    await expect(supervisor.connect()).resolves.toHaveLength(1)
    expect(supervisor.catalogTools()).toHaveLength(1)
    await expect(
      supervisor.callTool(
        'missing',
        {},
        {
          actorId: 'actor',
          documentId: 'document',
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'tool_not_in_snapshot' })

    const context = {
      actorId: 'actor',
      documentId: 'document',
      runId: 'run',
      signal: new AbortController().signal,
    }
    callTool.mockResolvedValueOnce({ isError: true, content: [] })
    await expect(supervisor.callTool('read_fixture', null, context)).rejects.toMatchObject({
      code: 'mcp_result_unknown',
    })
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'https://example.invalid/unsafe' }],
    })
    await expect(supervisor.callTool('read_fixture', [], context)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      supervisor.callTool('read_fixture', {}, { ...context, signal: aborted.signal }),
    ).rejects.toMatchObject({ code: 'tool_aborted' })
    callTool.mockRejectedValueOnce(new Error('request timeout'))
    await expect(supervisor.callTool('read_fixture', {}, context)).rejects.toMatchObject({
      code: 'tool_timeout',
    })
    callTool.mockRejectedValueOnce(new Error('opaque failure'))
    await expect(supervisor.callTool('read_fixture', {}, context)).rejects.toMatchObject({
      code: 'mcp_result_unknown',
    })
    transport.stderr!.emit('data', 'Bearer abcdefgh token=abcdefgh sk-abcdefgh')
    expect(supervisor.diagnostics().stderrTail).not.toContain('abcdefgh')
    client.onclose?.()
    await expect(supervisor.callTool('read_fixture', {}, context)).rejects.toMatchObject({
      code: 'mcp_unavailable',
    })
    await supervisor.close()
    await supervisor.close()
    expect(close).toHaveBeenCalled()

    const missingCredential = new McpConnectionSupervisor({
      server: server(),
      credentials: { read: vi.fn(async () => undefined) },
      authorize: async () => true,
      createConnection: () => ({ client, transport }),
    })
    await expect(missingCredential.connect()).rejects.toMatchObject({
      code: 'mcp_credential_missing',
    })

    const oauth = new McpConnectionSupervisor({
      server: server({
        credentialEnvironment: [
          {
            name: 'MCP_OAUTH',
            credentialRef: { slot: 'model/mcp-fixture/default', kind: 'oauth' },
          },
        ],
      }),
      credentials: {
        read: vi.fn(async () => ({
          type: 'oauth' as const,
          access: 'oauth-access',
          refresh: 'oauth-refresh',
          expires: Date.now() + 60_000,
        })),
      },
      authorize: async () => true,
      createConnection: () => ({
        client: {
          ...client,
          connect: vi.fn(async () => {
            throw new Error('connect failed')
          }),
        },
        transport: new StdioClientTransport({ command: process.execPath }),
      }),
    })
    await expect(oauth.connect()).rejects.toMatchObject({ code: 'mcp_unavailable' })
  })

  it('rejects a second connect while the first connection is still pending', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = {
      onclose: undefined as (() => void) | undefined,
      connect: vi.fn(() => pending),
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const supervisor = new McpConnectionSupervisor({
      server: server({ credentialEnvironment: [] }),
      credentials: credentials(),
      authorize: async () => true,
      createConnection: () => ({
        client,
        transport: new StdioClientTransport({ command: process.execPath }),
      }),
    })
    const first = supervisor.connect()
    await expect(supervisor.connect()).rejects.toMatchObject({ code: 'mcp_unavailable' })
    release()
    await expect(first).resolves.toEqual([])
    await supervisor.close()
  })
})
