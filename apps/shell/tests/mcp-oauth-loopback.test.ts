import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpOAuthLoopback } from '../src/main/mcp-oauth-loopback'

const operationId = '55555555-5555-4555-8555-555555555555'
const scope = { namespace: 'global' as const, serverId: 'oauth-http' }
const brokers: McpOAuthLoopback[] = []

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.shutdown()))
})

function harness() {
  let redirectUrl = ''
  const catalog = {
    projectState: 'none' as const,
    servers: [],
  }
  const service = {
    startMcpOAuth: vi.fn(async (input: { operationId: string; redirectUrl: string }) => {
      redirectUrl = input.redirectUrl
      return {
        operationId: input.operationId,
        authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
        expiresAt: Date.now() + 60_000,
      }
    }),
    completeMcpOAuth: vi.fn(async () => catalog),
    cancelMcpOAuth: vi.fn(async () => catalog),
    mcpCatalog: vi.fn(async () => catalog),
  }
  const openAuthorizationUrl = vi.fn(async () => undefined)
  const broker = new McpOAuthLoopback({
    service: service as never,
    openAuthorizationUrl,
    randomUUID: () => operationId,
  })
  brokers.push(broker)
  return { broker, service, openAuthorizationUrl, redirectUrl: () => redirectUrl }
}

describe('MCP OAuth loopback broker', () => {
  it('keeps authorization and callback data in main while completing one exact callback', async () => {
    const fixture = harness()
    await expect(fixture.broker.start(scope)).resolves.toEqual({
      projectState: 'none',
      servers: [],
    })
    expect(fixture.openAuthorizationUrl).toHaveBeenCalledWith(
      'https://issuer.example.test/authorize?state=opaque-state',
    )
    expect(fixture.redirectUrl()).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:[0-9]+/mcp/oauth/callback/${operationId}$`),
    )

    const rejected = await fetch(
      `${fixture.redirectUrl()}?code=code&state=one&state=two&iss=https%3A%2F%2Fissuer.example.test`,
    )
    expect(rejected.status).toBe(400)
    expect(fixture.service.completeMcpOAuth).not.toHaveBeenCalled()

    const callbackUrl = `${fixture.redirectUrl()}?code=code&state=opaque-state&iss=https%3A%2F%2Fissuer.example.test`
    const accepted = await fetch(callbackUrl)
    expect(accepted.status).toBe(200)
    expect(fixture.service.completeMcpOAuth).toHaveBeenCalledWith({
      ...scope,
      operationId,
      callbackUrl,
    })
    expect(JSON.stringify(await fixture.broker.cancel(scope))).not.toContain('code')
  })

  it('cancels the exact Runtime operation and rejects unsafe authorization URLs', async () => {
    const fixture = harness()
    await fixture.broker.start(scope)
    await fixture.broker.cancel(scope)
    expect(fixture.service.cancelMcpOAuth).toHaveBeenCalledWith({ ...scope, operationId })

    const unsafe = harness()
    unsafe.service.startMcpOAuth.mockResolvedValueOnce({
      operationId,
      authorizationUrl: 'http://attacker.example.test/authorize?state=opaque-state',
      expiresAt: Date.now() + 60_000,
    })
    await expect(unsafe.broker.start(scope)).rejects.toThrowError(
      'mcp_oauth_authorization_url_invalid',
    )
    expect(unsafe.openAuthorizationUrl).not.toHaveBeenCalled()
  })

  it('rejects duplicate and malformed callbacks, then reports a failed token exchange safely', async () => {
    const fixture = harness()
    await fixture.broker.start(scope)
    await expect(fixture.broker.start(scope)).rejects.toThrowError('mcp_oauth_in_progress')
    const rejectedMethod = await fetch(fixture.redirectUrl(), { method: 'POST' })
    expect(rejectedMethod.status).toBe(400)
    const longPath = `${fixture.redirectUrl()}${'x'.repeat(4_100)}`
    const rejectedPath = await fetch(longPath)
    expect(rejectedPath.status).toBe(400)
    fixture.service.completeMcpOAuth.mockRejectedValueOnce(new Error('token_exchange_failed'))
    const failed = await fetch(
      `${fixture.redirectUrl()}?code=code&state=opaque-state&iss=https%3A%2F%2Fissuer.example.test`,
    )
    expect(failed.status).toBe(400)
    expect(await failed.text()).not.toContain('token_exchange_failed')
  })

  it('cleans up mismatched, expired, failed-open and timed-out starts', async () => {
    const mismatch = harness()
    mismatch.service.startMcpOAuth.mockResolvedValueOnce({
      operationId: '66666666-6666-4666-8666-666666666666',
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
      expiresAt: Date.now() + 60_000,
    })
    await expect(mismatch.broker.start(scope)).rejects.toThrowError('mcp_oauth_operation_mismatch')

    const expired = harness()
    expired.service.startMcpOAuth.mockResolvedValueOnce({
      operationId,
      authorizationUrl: 'https://issuer.example.test/authorize?state=opaque-state',
      expiresAt: 1,
    })
    await expect(expired.broker.start(scope)).rejects.toThrowError('mcp_oauth_expired')

    const failedOpen = harness()
    failedOpen.openAuthorizationUrl.mockRejectedValueOnce(new Error('open_failed'))
    failedOpen.service.cancelMcpOAuth.mockRejectedValueOnce(new Error('cancel_failed'))
    await expect(failedOpen.broker.start(scope)).rejects.toThrowError('open_failed')
    expect(failedOpen.service.cancelMcpOAuth).toHaveBeenCalled()

    const timed = harness()
    const short = new McpOAuthLoopback({
      service: timed.service as never,
      openAuthorizationUrl: timed.openAuthorizationUrl,
      randomUUID: () => operationId,
      timeoutMs: 5,
    })
    brokers.push(short)
    await short.start(scope)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(timed.service.cancelMcpOAuth).toHaveBeenCalled()
  })

  it('uses a host-owned UUID and keeps project scope across start and no-op cancel', async () => {
    const fixture = harness()
    const broker = new McpOAuthLoopback({
      service: fixture.service as never,
      openAuthorizationUrl: fixture.openAuthorizationUrl,
    })
    brokers.push(broker)
    const project = {
      namespace: 'project' as const,
      projectRoot: '/selected/project',
      serverId: 'oauth-http',
    }
    await broker.start(project)
    expect(fixture.service.startMcpOAuth.mock.calls.at(-1)?.[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    )
    await broker.cancel(project)
    await broker.cancel(project)
    expect(fixture.service.mcpCatalog).toHaveBeenCalledWith({ projectRoot: '/selected/project' })
    await (
      broker as unknown as { closeFlow(key: string, cancel: boolean): Promise<void> }
    ).closeFlow('missing', false)
  })
})
