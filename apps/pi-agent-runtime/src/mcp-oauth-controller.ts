import { randomBytes } from 'node:crypto'
import type { CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import {
  auth,
  type AuthOptions,
  type AuthResult,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client'

export type McpOAuthErrorCode =
  | 'mcp_oauth_callback_invalid'
  | 'mcp_oauth_failed'
  | 'mcp_oauth_in_progress'
  | 'mcp_oauth_issuer_mismatch'
  | 'mcp_oauth_operation_mismatch'
  | 'mcp_oauth_redirect_invalid'
  | 'mcp_oauth_state_invalid'
  | 'mcp_oauth_token_invalid'

export class McpOAuthError extends Error {
  constructor(readonly code: McpOAuthErrorCode) {
    super(code)
    this.name = 'McpOAuthError'
  }
}

export type McpOAuthStartResult = {
  operationId: string
  authorizationUrl: string
  expiresAt: number
}

export type McpOAuthControllerOptions = {
  serverId: string
  serverUrl: string
  credentialProviderId: string
  credentials: Pick<CredentialStore, 'read' | 'modify' | 'delete'>
  fetch?: FetchLike
  authorize?: (provider: OAuthClientProvider, options: AuthOptions) => Promise<AuthResult>
  now?: () => number
  randomState?: () => string
}

type PendingOAuth = {
  operationId: string
  redirectUrl: string
  state: string
  expiresAt: number
  consumed: boolean
  codeVerifier?: string
  authorizationUrl?: string
  discovery?: OAuthDiscoveryState
  expectedIssuer?: string
}

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_VALUE = /^[\u0021-\u007e]+$/

function exactQueryKeys(url: URL, allowed: readonly string[]): boolean {
  const keys = [...url.searchParams.keys()]
  return keys.length === new Set(keys).size && keys.every((key) => allowed.includes(key))
}

function normalizeBoundUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid')
  return url.toString()
}

function assertLoopbackRedirect(value: string): string {
  if (value.length > 2048 || /[\r\n]/.test(value)) {
    throw new McpOAuthError('mcp_oauth_redirect_invalid')
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith('/mcp/oauth/callback/')
    ) {
      throw new Error('invalid')
    }
    return url.toString()
  } catch {
    throw new McpOAuthError('mcp_oauth_redirect_invalid')
  }
}

function safeAuthorizationUrl(value: URL, expectedState: string): string {
  if (
    value.toString().length > 4096 ||
    /[\r\n]/.test(value.toString()) ||
    (value.protocol !== 'https:' &&
      !(
        value.protocol === 'http:' &&
        (value.hostname === '127.0.0.1' || value.hostname === '[::1]')
      )) ||
    value.username ||
    value.password ||
    value.hash ||
    value.searchParams.get('state') !== expectedState
  ) {
    throw new McpOAuthError('mcp_oauth_failed')
  }
  return value.toString()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : undefined
}

export class McpOAuthController implements OAuthClientProvider {
  private readonly serverUrl: string
  private readonly now: () => number
  private readonly authorize: (
    provider: OAuthClientProvider,
    options: AuthOptions,
  ) => Promise<AuthResult>
  private pending?: PendingOAuth

  constructor(private readonly options: McpOAuthControllerOptions) {
    try {
      this.serverUrl = normalizeBoundUrl(options.serverUrl)
    } catch {
      throw new McpOAuthError('mcp_oauth_redirect_invalid')
    }
    this.now = options.now ?? Date.now
    this.authorize = options.authorize ?? auth
  }

  get redirectUrl(): string | undefined {
    return this.pending?.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Open GenOffice',
      redirect_uris: [
        this.pending?.redirectUrl ?? 'http://127.0.0.1:53682/mcp/oauth/callback/unused',
      ],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  async begin(operationId: string, redirectUrl: string): Promise<McpOAuthStartResult> {
    if (!OPERATION_ID.test(operationId)) throw new McpOAuthError('mcp_oauth_operation_mismatch')
    if (this.pending && this.pending.expiresAt > this.now()) {
      throw new McpOAuthError('mcp_oauth_in_progress')
    }
    const pending: PendingOAuth = {
      operationId,
      redirectUrl: assertLoopbackRedirect(redirectUrl),
      state: this.options.randomState?.() ?? randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 10 * 60_000,
      consumed: false,
    }
    this.pending = pending
    try {
      const result = await this.authorize(this, {
        serverUrl: this.serverUrl,
        fetchFn: this.options.fetch,
        forceReauthorization: true,
      })
      if (result !== 'REDIRECT' || !pending.authorizationUrl) {
        throw new McpOAuthError('mcp_oauth_failed')
      }
      return {
        operationId,
        authorizationUrl: pending.authorizationUrl,
        expiresAt: pending.expiresAt,
      }
    } catch (error) {
      this.pending = undefined
      if (error instanceof McpOAuthError) throw error
      throw new McpOAuthError('mcp_oauth_failed')
    }
  }

  async complete(operationId: string, callbackUrl: string): Promise<void> {
    const pending = this.requirePending(operationId)
    if (pending.consumed || pending.expiresAt <= this.now()) {
      this.pending = undefined
      throw new McpOAuthError('mcp_oauth_state_invalid')
    }
    let callback: URL
    try {
      if (callbackUrl.length > 4096 || /[\r\n]/.test(callbackUrl)) throw new Error('invalid')
      callback = new URL(callbackUrl)
      const redirect = new URL(pending.redirectUrl)
      if (
        callback.origin !== redirect.origin ||
        callback.pathname !== redirect.pathname ||
        callback.username ||
        callback.password ||
        callback.hash ||
        !exactQueryKeys(callback, ['code', 'state', 'iss'])
      ) {
        throw new Error('invalid')
      }
    } catch {
      throw new McpOAuthError('mcp_oauth_callback_invalid')
    }
    if (callback.searchParams.get('state') !== pending.state) {
      throw new McpOAuthError('mcp_oauth_state_invalid')
    }
    const code = callback.searchParams.get('code')
    const issuer = callback.searchParams.get('iss')
    if (!code || !SAFE_VALUE.test(code) || !issuer || !SAFE_VALUE.test(issuer)) {
      throw new McpOAuthError('mcp_oauth_callback_invalid')
    }
    if (!pending.expectedIssuer || issuer !== pending.expectedIssuer) {
      throw new McpOAuthError('mcp_oauth_issuer_mismatch')
    }
    pending.consumed = true
    try {
      const result = await this.authorize(this, {
        serverUrl: this.serverUrl,
        authorizationCode: code,
        iss: issuer,
        fetchFn: this.options.fetch,
      })
      if (result !== 'AUTHORIZED') throw new McpOAuthError('mcp_oauth_failed')
      this.pending = undefined
    } catch (error) {
      this.pending = undefined
      if (error instanceof McpOAuthError) throw error
      throw new McpOAuthError('mcp_oauth_failed')
    }
  }

  cancel(operationId: string): void {
    this.requirePending(operationId)
    this.pending = undefined
  }

  state(): string {
    return this.requirePending().state
  }

  clientInformation(): StoredOAuthClientInformation {
    return { client_id: 'open-genoffice' }
  }

  async tokens(ctx?: { issuer: string }): Promise<StoredOAuthTokens | undefined> {
    const credential = await this.options.credentials.read(this.options.credentialProviderId)
    if (credential?.type !== 'oauth') return undefined
    const stored = credential as OAuthCredential & Record<string, unknown>
    const issuer = optionalString(stored.mcpIssuer)
    const serverUrl = optionalString(stored.mcpServerUrl)
    const tokenType = optionalString(stored.mcpTokenType)
    if (!issuer || serverUrl !== this.serverUrl || !tokenType || (ctx && ctx.issuer !== issuer)) {
      return undefined
    }
    return {
      access_token: credential.access,
      token_type: tokenType,
      expires_in: Math.max(0, Math.floor((credential.expires - this.now()) / 1_000)),
      ...(credential.refresh ? { refresh_token: credential.refresh } : {}),
      ...(optionalString(stored.mcpScope) ? { scope: stored.mcpScope as string } : {}),
      ...(optionalString(stored.mcpIdToken) ? { id_token: stored.mcpIdToken as string } : {}),
      issuer,
    }
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: { issuer: string }): Promise<void> {
    const pending = this.pending
    const issuer = ctx?.issuer ?? tokens.issuer
    if (
      !pending ||
      !issuer ||
      issuer !== pending.expectedIssuer ||
      !tokens.access_token ||
      !tokens.token_type
    ) {
      throw new McpOAuthError('mcp_oauth_token_invalid')
    }
    await this.options.credentials.modify(this.options.credentialProviderId, async () => ({
      type: 'oauth',
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? '',
      expires: this.now() + (tokens.expires_in ?? 3_600) * 1_000,
      mcpIssuer: issuer,
      mcpServerUrl: this.serverUrl,
      mcpTokenType: tokens.token_type,
      ...(tokens.scope ? { mcpScope: tokens.scope } : {}),
      ...(tokens.id_token ? { mcpIdToken: tokens.id_token } : {}),
    }))
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const pending = this.requirePending()
    pending.authorizationUrl = safeAuthorizationUrl(authorizationUrl, pending.state)
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (codeVerifier.length < 43 || codeVerifier.length > 128 || !SAFE_VALUE.test(codeVerifier)) {
      throw new McpOAuthError('mcp_oauth_failed')
    }
    this.requirePending().codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    const verifier = this.requirePending().codeVerifier
    if (!verifier) throw new McpOAuthError('mcp_oauth_failed')
    return verifier
  }

  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    if (resource === undefined) return new URL(this.serverUrl)
    try {
      if (normalizeBoundUrl(resource) !== this.serverUrl) throw new Error('invalid')
      return new URL(this.serverUrl)
    } catch {
      throw new McpOAuthError('mcp_oauth_issuer_mismatch')
    }
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    const pending = this.requirePending()
    const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl
    if (!issuer || !SAFE_VALUE.test(issuer)) throw new McpOAuthError('mcp_oauth_issuer_mismatch')
    pending.discovery = discovery
    pending.expectedIssuer = issuer
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.pending?.discovery
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      await this.options.credentials.delete(this.options.credentialProviderId)
    }
    if (scope === 'all' || scope === 'verifier') {
      if (this.pending) this.pending.codeVerifier = undefined
    }
    if (scope === 'all' || scope === 'discovery') {
      if (this.pending) {
        this.pending.discovery = undefined
        this.pending.expectedIssuer = undefined
      }
    }
  }

  private requirePending(operationId?: string): PendingOAuth {
    const pending = this.pending
    if (!pending || (operationId !== undefined && pending.operationId !== operationId)) {
      throw new McpOAuthError('mcp_oauth_operation_mismatch')
    }
    return pending
  }
}
