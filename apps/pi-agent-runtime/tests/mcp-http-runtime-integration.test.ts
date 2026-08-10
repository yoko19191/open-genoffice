import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ResourceActivationStore, initializeAgentResourceHome } from '@genoffice/agent-resource'
import { OpenGenOfficeMcpConfigResolver } from '../src/mcp-config-resolver'
import { McpExecutionError } from '../src/mcp-connection-supervisor'
import { RunResourceService } from '../src/run-resource-service'

const roots: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
const deviceId = '11111111-1111-4111-8111-111111111111'
const operationId = '33333333-3333-4333-8333-333333333333'

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    ),
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(value))
}

async function oauthMcpFixture() {
  let origin = ''
  let expectedChallenge = ''
  let toolCalls = 0
  let droppedCalls = 0
  const authorizationHeaders: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp.read'],
      })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['mcp.read'],
      })
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const params = new URLSearchParams(await body(request))
      const verifier = params.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (
        params.get('grant_type') !== 'authorization_code' ||
        params.get('code') !== 'valid-code' ||
        params.get('client_id') !== 'open-genoffice' ||
        params.get('resource') !== `${origin}/mcp` ||
        challenge !== expectedChallenge
      ) {
        json(response, 400, { error: 'invalid_grant' })
        return
      }
      json(response, 200, {
        access_token: 'oauth-access-canary',
        refresh_token: 'oauth-refresh-canary',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp.read',
      })
      return
    }
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    const authorization = request.headers.authorization ?? ''
    authorizationHeaders.push(authorization)
    if (authorization !== 'Bearer oauth-access-canary') {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      })
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      return
    }
    const message = JSON.parse(await body(request)) as {
      id?: string | number
      method: string
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> }
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }
    if (message.method === 'initialize') {
      json(
        response,
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'oauth-fixture', version: '1.0.0' },
          },
        },
        { 'mcp-session-id': 'session-oauth-fixture' },
      )
      return
    }
    if (message.method === 'tools/list') {
      json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: ['read_http', 'slow_http', 'drop_once'].map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          })),
        },
      })
      return
    }
    if (message.method === 'tools/call') {
      toolCalls += 1
      if (message.params?.name === 'drop_once') {
        droppedCalls += 1
        request.socket.destroy()
        return
      }
      if (message.params?.name === 'slow_http') {
        const timer = setTimeout(() => {
          if (!response.destroyed) {
            json(response, 200, {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: 'too-late' }] },
            })
          }
        }, 1_000)
        request.once('close', () => clearTimeout(timer))
        return
      }
      json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `http:${String(message.params?.arguments?.value)}` }],
        },
      })
      return
    }
    json(response, 404, { error: 'method_not_found' })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture_address_missing')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    recordChallenge: (value: string) => {
      expectedChallenge = value
    },
    stats: () => ({ toolCalls, droppedCalls, authorizationHeaders }),
  }
}

describe('Streamable HTTP MCP runtime integration', () => {
  it('discovers OAuth, stores tokens privately, executes, aborts and never replays an unknown result', async () => {
    const fixture = await oauthMcpFixture()
    const resourceHome = await mkdtemp(join(tmpdir(), 'genoffice-mcp-http-runtime-'))
    roots.push(resourceHome)
    await initializeAgentResourceHome({
      rootDirectory: resourceHome,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    await write(join(resourceHome, 'mcp', 'servers.json'), {
      schemaVersion: 1,
      servers: [
        {
          serverId: 'oauth-http',
          transport: 'streamable-http',
          endpoint: `${fixture.origin}/mcp`,
          credentialRef: { slot: 'model/mcp-local/default', kind: 'oauth' },
          enabledToolIds: ['read_http', 'slow_http', 'drop_once'],
          timeoutMs: 2_000,
          enabled: true,
        },
      ],
    })
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })
    const [configured] = await resolver.resolve()
    await new ResourceActivationStore({ rootDirectory: resourceHome, deviceId }).activate(
      configured!.activation,
    )
    const credentials = new InMemoryCredentialStore()
    const service = new RunResourceService({
      resourceHome,
      deviceId,
      mcpResolver: resolver,
      credentials,
    })

    await expect(service.mcpCatalog()).resolves.toMatchObject({
      servers: [{ serverId: 'oauth-http', state: 'auth_required', action: 'login' }],
    })
    expect(fixture.stats().authorizationHeaders).toEqual([])

    const redirectUrl = `http://127.0.0.1:53682/mcp/oauth/callback/${operationId}`
    const started = await service.startMcpOAuth(
      { namespace: 'global' },
      'oauth-http',
      operationId,
      redirectUrl,
    )
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.origin).toBe(fixture.origin)
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(authorization.searchParams.get('resource')).toBe(`${fixture.origin}/mcp`)
    fixture.recordChallenge(authorization.searchParams.get('code_challenge') ?? '')
    const callback = new URL(redirectUrl)
    callback.searchParams.set('code', 'valid-code')
    callback.searchParams.set('state', authorization.searchParams.get('state') ?? '')
    callback.searchParams.set('iss', fixture.origin)
    const catalog = await service.completeMcpOAuth(
      { namespace: 'global' },
      'oauth-http',
      operationId,
      callback.toString(),
    )
    expect(catalog).toMatchObject({
      servers: [{ serverId: 'oauth-http', state: 'ready', action: 'disable' }],
    })
    const stored = await credentials.read('mcp-local')
    expect(stored).toMatchObject({ type: 'oauth', access: 'oauth-access-canary' })
    expect(JSON.stringify(catalog)).not.toContain('oauth-access-canary')

    const prepared = await service.prepare({
      runId: 'run-http',
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(JSON.stringify(prepared)).not.toContain('oauth-access-canary')
    const context = {
      actorId: 'actor',
      documentId: 'document',
      runId: 'run-http',
      signal: new AbortController().signal,
    }
    await expect(
      service.callMcpTool('mcp:oauth-http:read_http', { value: 'integrated' }, context),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'http:integrated' }] })

    const abort = new AbortController()
    const slow = service.callMcpTool(
      'mcp:oauth-http:slow_http',
      {},
      { ...context, signal: abort.signal },
    )
    abort.abort()
    await expect(slow).rejects.toEqual(new McpExecutionError('tool_aborted'))

    const beforeDrop = fixture.stats().toolCalls
    await expect(service.callMcpTool('mcp:oauth-http:drop_once', {}, context)).rejects.toEqual(
      new McpExecutionError('mcp_result_unknown'),
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(fixture.stats().droppedCalls).toBe(1)
    expect(fixture.stats().toolCalls).toBe(beforeDrop + 1)
    await expect(
      service.callMcpTool('mcp:oauth-http:read_http', { value: 'recovered' }, context),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'http:recovered' }] })
    expect(
      fixture.stats().authorizationHeaders.every((value) => value === 'Bearer oauth-access-canary'),
    ).toBe(true)

    service.releaseRun('run-http')
    await service.shutdown()
  })
})
