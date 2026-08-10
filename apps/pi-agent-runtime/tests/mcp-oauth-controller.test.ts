import { describe, expect, it, vi } from 'vitest'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import type {
  AuthOptions,
  AuthResult,
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/client'
import { McpOAuthController, McpOAuthError } from '../src/mcp-oauth-controller'

const operationId = '11111111-1111-4111-8111-111111111111'
const redirectUrl = `http://127.0.0.1:43210/mcp/oauth/callback/${operationId}`
const issuer = 'https://issuer.example.test/'
const serverUrl = 'https://mcp.example.test/v1'

function credentials(initial?: Credential) {
  let value = initial
  const store: Pick<CredentialStore, 'read' | 'modify' | 'delete'> = {
    read: vi.fn(async () => value),
    modify: vi.fn(async (_providerId, update) => {
      const next = await update(value)
      if (next !== undefined) value = next
      return value
    }),
    delete: vi.fn(async () => {
      value = undefined
    }),
  }
  return { store, value: () => value }
}

function discovery(): OAuthDiscoveryState {
  return {
    authorizationServerUrl: issuer,
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: `${issuer}authorize`,
      token_endpoint: `${issuer}token`,
      response_types_supported: ['code'],
    },
    resourceMetadata: {
      resource: serverUrl,
      authorization_servers: [issuer],
    },
  }
}

function authorizationDriver() {
  return vi.fn(async (provider: OAuthClientProvider, options: AuthOptions): Promise<AuthResult> => {
    if (!options.authorizationCode) {
      await provider.saveDiscoveryState?.(discovery())
      const state = await provider.state?.()
      await provider.saveCodeVerifier('v'.repeat(64))
      await provider.redirectToAuthorization(
        new URL(`${issuer}authorize?state=${state}&redirect_uri=${provider.redirectUrl}`),
      )
      return 'REDIRECT'
    }
    await provider.saveTokens(
      {
        access_token: 'oauth-access-canary',
        refresh_token: 'oauth-refresh-canary',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp.read',
        issuer: options.iss,
      },
      options.iss ? { issuer: options.iss } : undefined,
    )
    return 'AUTHORIZED'
  })
}

function controller(overrides: Partial<ConstructorParameters<typeof McpOAuthController>[0]> = {}) {
  const stored = credentials()
  const authorize = authorizationDriver()
  return {
    stored,
    authorize,
    controller: new McpOAuthController({
      serverId: 'fixture',
      serverUrl,
      credentialProviderId: 'mcp-fixture',
      credentials: stored.store,
      authorize,
      randomState: () => 'state-canary',
      now: () => 1_000_000,
      ...overrides,
    }),
  }
}

describe('McpOAuthController', () => {
  it('binds PKCE, state, issuer and resource before storing tokens only in CredentialStore', async () => {
    const fixture = controller()
    const started = await fixture.controller.begin(operationId, redirectUrl)
    expect(started).toEqual({
      operationId,
      authorizationUrl: expect.stringContaining('state=state-canary'),
      expiresAt: 1_600_000,
    })
    expect(fixture.controller.redirectUrl).toBe(redirectUrl)
    expect(fixture.controller.codeVerifier()).toBe('v'.repeat(64))
    await expect(fixture.controller.validateResourceURL(serverUrl, serverUrl)).resolves.toEqual(
      new URL(serverUrl),
    )
    await expect(
      fixture.controller.validateResourceURL(serverUrl, 'https://attacker.example.test/v1'),
    ).rejects.toMatchObject({ code: 'mcp_oauth_issuer_mismatch' })

    const callback = `${redirectUrl}?code=authorization-code&state=state-canary&iss=${encodeURIComponent(issuer)}`
    await fixture.controller.complete(operationId, callback)
    expect(fixture.stored.value()).toMatchObject({
      type: 'oauth',
      access: 'oauth-access-canary',
      refresh: 'oauth-refresh-canary',
      expires: 4_600_000,
      mcpIssuer: issuer,
      mcpServerUrl: serverUrl,
      mcpTokenType: 'Bearer',
      mcpScope: 'mcp.read',
    })
    await expect(fixture.controller.tokens({ issuer })).resolves.toMatchObject({
      access_token: 'oauth-access-canary',
      refresh_token: 'oauth-refresh-canary',
      issuer,
    })
    await expect(fixture.controller.complete(operationId, callback)).rejects.toMatchObject({
      code: 'mcp_oauth_operation_mismatch',
    })
  })

  it('rejects redirect, callback, state, issuer, replay and header-injection attacks', async () => {
    const fixture = controller()
    await expect(
      controller().controller.begin(
        operationId,
        `http://[::1]:43210/mcp/oauth/callback/${operationId}`,
      ),
    ).resolves.toBeDefined()
    for (const invalid of [
      'https://127.0.0.1:43210/mcp/oauth/callback/x',
      'http://localhost:43210/mcp/oauth/callback/x',
      'http://127.0.0.1/mcp/oauth/callback/x',
      'http://127.0.0.1:43210/wrong',
      'http://user:secret@127.0.0.1:43210/mcp/oauth/callback/x',
    ]) {
      await expect(fixture.controller.begin(operationId, invalid)).rejects.toMatchObject({
        code: 'mcp_oauth_redirect_invalid',
      })
    }

    const callbackCases = [
      [
        `${redirectUrl}?code=x&state=wrong&iss=${encodeURIComponent(issuer)}`,
        'mcp_oauth_state_invalid',
      ],
      [
        `${redirectUrl}?code=x&state=state-canary&iss=${encodeURIComponent('https://evil.test/')}`,
        'mcp_oauth_issuer_mismatch',
      ],
      [
        `http://127.0.0.1:43211/mcp/oauth/callback/${operationId}?code=x&state=state-canary&iss=${encodeURIComponent(issuer)}`,
        'mcp_oauth_callback_invalid',
      ],
      [
        `${redirectUrl}?code=x&state=state-canary&iss=${encodeURIComponent(issuer)}&error_description=secret`,
        'mcp_oauth_callback_invalid',
      ],
      [
        `${redirectUrl}?code=x%0d%0aInjected&state=state-canary&iss=${encodeURIComponent(issuer)}`,
        'mcp_oauth_callback_invalid',
      ],
    ] as const
    for (const [callback, code] of callbackCases) {
      const current = controller()
      await current.controller.begin(operationId, redirectUrl)
      await expect(current.controller.complete(operationId, callback)).rejects.toMatchObject({
        code,
      })
    }

    const consumed = controller()
    await consumed.controller.begin(operationId, redirectUrl)
    consumed.authorize.mockRejectedValueOnce(new Error('token endpoint unavailable'))
    const callback = `${redirectUrl}?code=x&state=state-canary&iss=${encodeURIComponent(issuer)}`
    await expect(consumed.controller.complete(operationId, callback)).rejects.toMatchObject({
      code: 'mcp_oauth_failed',
    })
    await expect(consumed.controller.complete(operationId, callback)).rejects.toMatchObject({
      code: 'mcp_oauth_operation_mismatch',
    })
  })

  it('fails closed for token binding mismatches and supports cancel/invalidation', async () => {
    const stored = credentials({
      type: 'oauth',
      access: 'access',
      refresh: '',
      expires: 2_000_000,
      mcpIssuer: issuer,
      mcpServerUrl: 'https://different.example.test/v1',
      mcpTokenType: 'Bearer',
    })
    const fixture = controller({ credentials: stored.store })
    await expect(fixture.controller.tokens({ issuer })).resolves.toBeUndefined()
    await fixture.controller.begin(operationId, redirectUrl)
    expect(() => fixture.controller.cancel('22222222-2222-4222-8222-222222222222')).toThrowError(
      McpOAuthError,
    )
    fixture.controller.cancel(operationId)
    await expect(fixture.controller.begin(operationId, redirectUrl)).resolves.toBeDefined()
    await fixture.controller.invalidateCredentials('tokens')
    expect(stored.store.delete).toHaveBeenCalledWith('mcp-fixture')
    await fixture.controller.invalidateCredentials('verifier')
    await fixture.controller.invalidateCredentials('discovery')
    await fixture.controller.invalidateCredentials('all')
  })

  it('rejects invalid construction, oversized input, duplicate operations and expired state', async () => {
    expect(
      () =>
        new McpOAuthController({
          serverId: 'fixture',
          serverUrl: 'https://user:secret@mcp.example.test/v1',
          credentialProviderId: 'mcp-fixture',
          credentials: credentials().store,
        }),
    ).toThrowError(McpOAuthError)
    const metadata = controller().controller.clientMetadata
    expect(metadata.redirect_uris).toEqual(['http://127.0.0.1:53682/mcp/oauth/callback/unused'])
    await expect(controller().controller.begin('invalid', redirectUrl)).rejects.toMatchObject({
      code: 'mcp_oauth_operation_mismatch',
    })
    await expect(
      controller().controller.begin(operationId, `http://127.0.0.1:43210/${'x'.repeat(2_100)}`),
    ).rejects.toMatchObject({ code: 'mcp_oauth_redirect_invalid' })

    const active = controller()
    await active.controller.begin(operationId, redirectUrl)
    await expect(active.controller.begin(operationId, redirectUrl)).rejects.toMatchObject({
      code: 'mcp_oauth_in_progress',
    })

    let now = 1_000_000
    const expired = controller({ now: () => now })
    await expired.controller.begin(operationId, redirectUrl)
    now = 1_600_001
    await expect(
      expired.controller.complete(
        operationId,
        `${redirectUrl}?code=x&state=state-canary&iss=${encodeURIComponent(issuer)}`,
      ),
    ).rejects.toMatchObject({ code: 'mcp_oauth_state_invalid' })

    const replaced = controller({ now: () => now, randomState: undefined })
    await replaced.controller.begin(operationId, redirectUrl)
    now += 600_001
    await expect(replaced.controller.begin(operationId, redirectUrl)).resolves.toBeDefined()
    expect(replaced.controller.state()).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('fails closed when authorization omits redirect, verifier, discovery or terminal authorization', async () => {
    const missingRedirect = controller({
      authorize: vi.fn(async (): Promise<AuthResult> => 'REDIRECT'),
    })
    await expect(missingRedirect.controller.begin(operationId, redirectUrl)).rejects.toMatchObject({
      code: 'mcp_oauth_failed',
    })

    const unsafeRedirect = controller({
      authorize: vi.fn(async (provider: OAuthClientProvider): Promise<AuthResult> => {
        await provider.redirectToAuthorization(
          new URL('http://attacker.example.test/authorize?state=state-canary'),
        )
        return 'REDIRECT'
      }),
    })
    await expect(unsafeRedirect.controller.begin(operationId, redirectUrl)).rejects.toMatchObject({
      code: 'mcp_oauth_failed',
    })

    const sparseDiscovery: OAuthDiscoveryState = {
      authorizationServerUrl: issuer,
      resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
    }
    const incomplete = controller({
      authorize: vi.fn(
        async (provider: OAuthClientProvider, options: AuthOptions): Promise<AuthResult> => {
          if (!options.authorizationCode) {
            await provider.saveDiscoveryState?.(sparseDiscovery)
            await provider.redirectToAuthorization(
              new URL(`${issuer}authorize?state=${await provider.state?.()}`),
            )
            return 'REDIRECT'
          }
          return 'REDIRECT'
        },
      ),
    })
    await incomplete.controller.begin(operationId, redirectUrl)
    expect(() => incomplete.controller.codeVerifier()).toThrowError(McpOAuthError)
    expect(() => incomplete.controller.saveCodeVerifier('short')).toThrowError(McpOAuthError)
    await expect(incomplete.controller.validateResourceURL(serverUrl)).resolves.toEqual(
      new URL(serverUrl),
    )
    await expect(
      incomplete.controller.complete(
        operationId,
        `${redirectUrl}?code=x&state=state-canary&iss=${encodeURIComponent(issuer)}`,
      ),
    ).rejects.toMatchObject({ code: 'mcp_oauth_failed' })

    const invalidDiscovery = controller({
      authorize: vi.fn(async (provider: OAuthClientProvider): Promise<AuthResult> => {
        await provider.saveDiscoveryState?.({ authorizationServerUrl: 'bad\nissuer' })
        return 'REDIRECT'
      }),
    })
    await expect(invalidDiscovery.controller.begin(operationId, redirectUrl)).rejects.toMatchObject(
      {
        code: 'mcp_oauth_issuer_mismatch',
      },
    )
  })

  it('handles minimal and extended token shapes without accepting unbound tokens', async () => {
    const stored = credentials()
    const fixture = controller({ credentials: stored.store })
    await expect(
      fixture.controller.saveTokens({ access_token: 'x', token_type: 'Bearer', issuer }),
    ).rejects.toMatchObject({ code: 'mcp_oauth_token_invalid' })
    await fixture.controller.begin(operationId, redirectUrl)
    await fixture.controller.saveTokens({
      access_token: 'minimal-access',
      token_type: 'Bearer',
      issuer,
      id_token: 'id-token',
    })
    expect(stored.value()).toMatchObject({
      access: 'minimal-access',
      refresh: '',
      expires: 4_600_000,
      mcpIdToken: 'id-token',
    })
    await expect(fixture.controller.tokens()).resolves.toEqual({
      access_token: 'minimal-access',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: 'id-token',
      issuer,
    })

    fixture.controller.cancel(operationId)
    await fixture.controller.invalidateCredentials('verifier')
    await fixture.controller.invalidateCredentials('discovery')
    await expect(fixture.controller.discoveryState()).toBeUndefined()
  })
})
