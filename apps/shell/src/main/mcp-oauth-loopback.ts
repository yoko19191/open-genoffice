import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type {
  McpOAuthCompleteRequest,
  McpOAuthOperationRequest,
  McpOAuthStartRequest,
  McpOAuthStartProjection,
} from '@genoffice/electron-utils'
import type { McpCatalogProjection } from '@genoffice/agent-runtime-protocol/renderer'

export type McpOAuthScope = {
  namespace: 'global' | 'project'
  projectRoot?: string
  serverId: string
}

type McpOAuthService = {
  startMcpOAuth(input: McpOAuthStartRequest): Promise<McpOAuthStartProjection>
  completeMcpOAuth(input: McpOAuthCompleteRequest): Promise<McpCatalogProjection>
  cancelMcpOAuth(input: McpOAuthOperationRequest): Promise<McpCatalogProjection>
  mcpCatalog(input?: { projectRoot?: string }): Promise<McpCatalogProjection>
}

export type McpOAuthLoopbackOptions = {
  service: McpOAuthService
  openAuthorizationUrl: (url: string) => Promise<void>
  now?: () => number
  randomUUID?: () => string
  timeoutMs?: number
}

type Flow = {
  operationId: string
  input: McpOAuthScope
  server: Server
  redirectUrl: string
  timeout: ReturnType<typeof setTimeout>
  consumed: boolean
}

function flowKey(input: McpOAuthScope): string {
  return `${input.namespace}/${input.projectRoot ?? ''}/${input.serverId}`
}

function exactCallback(url: URL): boolean {
  const keys = [...url.searchParams.keys()]
  return (
    keys.length === 3 &&
    new Set(keys).size === keys.length &&
    keys.every((key) => ['code', 'state', 'iss'].includes(key)) &&
    [...url.searchParams.values()].every((value) => value.length > 0)
  )
}

function assertAuthorizationUrl(value: string): void {
  const url = new URL(value)
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
  if (
    value.length > 4096 ||
    /[\r\n]/.test(value) ||
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get('state')
  ) {
    throw new Error('mcp_oauth_authorization_url_invalid')
  }
}

export class McpOAuthLoopback {
  private readonly flows = new Map<string, Flow>()
  private readonly now: () => number
  private readonly createOperationId: () => string
  private readonly timeoutMs: number

  constructor(private readonly options: McpOAuthLoopbackOptions) {
    this.now = options.now ?? Date.now
    this.createOperationId = options.randomUUID ?? randomUUID
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
  }

  async start(input: McpOAuthScope): Promise<McpCatalogProjection> {
    const key = flowKey(input)
    if (this.flows.has(key)) throw new Error('mcp_oauth_in_progress')
    const operationId = this.createOperationId()
    let flow: Flow | undefined
    const server = createServer((request, response) => {
      void (async () => {
        if (!flow || flow.consumed || request.method !== 'GET' || !request.url) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('OAuth callback rejected.')
          return
        }
        let callback: URL
        try {
          if (request.url.length > 4096 || /[\r\n]/.test(request.url)) throw new Error('invalid')
          callback = new URL(request.url, flow.redirectUrl)
          const redirect = new URL(flow.redirectUrl)
          if (
            callback.origin !== redirect.origin ||
            callback.pathname !== redirect.pathname ||
            callback.hash ||
            !exactCallback(callback)
          ) {
            throw new Error('invalid')
          }
        } catch {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('OAuth callback rejected.')
          return
        }
        flow.consumed = true
        this.flows.delete(key)
        clearTimeout(flow.timeout)
        flow.server.close()
        try {
          await this.options.service.completeMcpOAuth({
            ...flow.input,
            operationId: flow.operationId,
            callbackUrl: callback.toString(),
          })
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Authorization complete. You may close this window.')
        } catch {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Authorization failed. Return to Open GenOffice and retry.')
        }
      })()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      /* v8 ignore next -- a successfully listening TCP server cannot return null or a pipe path */
      if (!address || typeof address === 'string') throw new Error('mcp_oauth_listener_failed')
      const redirectUrl = `http://127.0.0.1:${address.port}/mcp/oauth/callback/${operationId}`
      const started = await this.options.service.startMcpOAuth({
        ...input,
        operationId,
        redirectUrl,
      })
      if (started.operationId !== operationId) throw new Error('mcp_oauth_operation_mismatch')
      assertAuthorizationUrl(started.authorizationUrl)
      const remaining = Math.min(this.timeoutMs, started.expiresAt - this.now())
      if (remaining <= 0) throw new Error('mcp_oauth_expired')
      flow = {
        operationId,
        input,
        server,
        redirectUrl,
        consumed: false,
        timeout: setTimeout(() => void this.closeFlow(key, true), remaining),
      }
      flow.timeout.unref?.()
      this.flows.set(key, flow)
      await this.options.openAuthorizationUrl(started.authorizationUrl)
      return this.options.service.mcpCatalog(
        input.projectRoot ? { projectRoot: input.projectRoot } : undefined,
      )
    } catch (error) {
      if (flow) await this.closeFlow(key, true)
      else await new Promise<void>((resolve) => server.close(() => resolve()))
      throw error
    }
  }

  async cancel(input: McpOAuthScope): Promise<McpCatalogProjection> {
    const key = flowKey(input)
    const flow = this.flows.get(key)
    if (!flow) {
      return this.options.service.mcpCatalog(
        input.projectRoot ? { projectRoot: input.projectRoot } : undefined,
      )
    }
    await this.closeFlow(key, false)
    return this.options.service.cancelMcpOAuth({ ...input, operationId: flow.operationId })
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.flows.keys()].map((key) => this.closeFlow(key, true)))
  }

  private async closeFlow(key: string, cancelRuntime: boolean): Promise<void> {
    const flow = this.flows.get(key)
    if (!flow) return
    this.flows.delete(key)
    clearTimeout(flow.timeout)
    await new Promise<void>((resolve) => flow.server.close(() => resolve()))
    if (cancelRuntime && !flow.consumed) {
      await this.options.service
        .cancelMcpOAuth({ ...flow.input, operationId: flow.operationId })
        .catch(() => undefined)
    }
  }
}
