import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
  ModelCapability,
  ModelCatalogProjection,
  ModelProviderProjection,
} from '@genoffice/agent-runtime-protocol'

export type ModelProviderErrorCode = NonNullable<ModelProviderProjection['errorCode']>
export type ModelSelectionRole = 'conversation' | 'image' | 'ocr'

export type OpenAICompatibleModelConfig = {
  modelId: string
  name: string
  capabilities: readonly ModelCapability[]
  contextWindow?: number
  maxTokens?: number
}

export type OpenAICompatibleProviderConfig = {
  providerId: string
  name: string
  baseUrl: string
  models: readonly OpenAICompatibleModelConfig[]
}

export type ModelCatalogServiceOptions = {
  customProviders?: readonly OpenAICompatibleProviderConfig[]
  selections?: Partial<Record<ModelSelectionRole, { providerId: string; modelId: string }>>
  disabledProviders?: readonly string[]
}

type ModelRuntimePort = Pick<
  ModelRuntime,
  | 'getProviders'
  | 'getProvider'
  | 'getModel'
  | 'checkAuth'
  | 'registerProvider'
  | 'login'
  | 'logout'
>

type OAuthInteractionProjection =
  | { type: 'progress'; messageKey: 'model_auth_progress' }
  | { type: 'auth_url'; url: string; messageKey: 'model_auth_open_browser' }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      type: 'prompt'
      promptType: AuthPrompt['type']
      messageKey: 'model_auth_prompt'
      placeholder?: string
    }

export type OAuthOperationProjection = {
  operationId: string
  providerId: string
  state: 'running' | 'waiting_for_user' | 'ready' | 'failed' | 'cancelled'
  interaction?: OAuthInteractionProjection
  errorCode?: ModelProviderErrorCode
}

type OAuthOperation = {
  projection: OAuthOperationProjection
  controller: AbortController
  resolvePrompt?: (value: string) => void
  rejectPrompt?: (error: Error) => void
}

const builtInProviders = ['openai', 'openai-codex'] as const
const builtInProviderSet = new Set<string>(builtInProviders)
const capabilitySet = new Set<ModelCapability>([
  'text-input',
  'image-input',
  'audio-input',
  'video-input',
  'tool-use',
  'reasoning',
])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export class ModelCatalogError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ModelCatalogError'
  }
}

function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function normalizeModelProviderError(error: unknown): ModelProviderErrorCode {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
    return 'provider_request_aborted'
  const status = providerErrorStatus(error)
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (status === 401 || status === 403) return 'provider_auth_required'
  if (status === 429 && code === 'insufficient_quota') return 'provider_quota_exceeded'
  if (status === 429) return 'provider_rate_limited'
  if (status === 404) return 'model_not_found'
  if (status === 400 || status === 422) return 'provider_contract_incompatible'
  return 'provider_unavailable'
}

export function shouldRetryAfterAuthRefresh(
  error: unknown,
  evidence: {
    refreshAttempts: number
    hasOutput: boolean
    hasToolCall: boolean
    hasUsage: boolean
  },
): boolean {
  return (
    providerErrorStatus(error) === 401 &&
    evidence.refreshAttempts === 0 &&
    !evidence.hasOutput &&
    !evidence.hasToolCall &&
    !evidence.hasUsage
  )
}

function validateEndpoint(value: string): string {
  if (/\$\{|\$\(|`|^!|^env:/i.test(value)) throw new ModelCatalogError('model_provider_invalid')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ModelCatalogError('model_provider_invalid')
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ModelCatalogError('model_provider_invalid')
  }
  return url.toString().replace(/\/$/, '')
}

function validateAuthNavigationUrl(value: string): string {
  if (/\$\{|\$\(|`|^!|^env:/i.test(value)) throw new ModelCatalogError('model_provider_invalid')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ModelCatalogError('model_provider_invalid')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new ModelCatalogError('model_provider_invalid')
  }
  return url.toString()
}

function validateCustomProvider(config: OpenAICompatibleProviderConfig): void {
  if (
    !idPattern.test(config.providerId) ||
    builtInProviderSet.has(config.providerId) ||
    config.name.length === 0 ||
    config.name.length > 256 ||
    config.models.length === 0 ||
    config.models.length > 256
  ) {
    throw new ModelCatalogError('model_provider_invalid')
  }
  validateEndpoint(config.baseUrl)
  const modelIds = new Set<string>()
  for (const model of config.models) {
    if (
      model.modelId.length === 0 ||
      model.modelId.length > 256 ||
      model.name.length === 0 ||
      model.name.length > 256 ||
      model.capabilities.length === 0 ||
      model.capabilities.some((capability) => !capabilitySet.has(capability)) ||
      modelIds.has(model.modelId)
    ) {
      throw new ModelCatalogError('model_provider_invalid')
    }
    modelIds.add(model.modelId)
  }
}

function modelCapabilities(
  model: Model<Api>,
  explicit?: readonly ModelCapability[],
): ModelCapability[] {
  if (explicit) return [...new Set(explicit)].sort()
  const capabilities: ModelCapability[] = ['text-input', 'tool-use']
  if (model.input.includes('image')) capabilities.push('image-input')
  if (model.reasoning) capabilities.push('reasoning')
  return capabilities.sort()
}

function authMethods(provider: Provider): Array<'api_key' | 'oauth'> {
  return [
    ...(provider.auth.apiKey ? (['api_key'] as const) : []),
    ...(provider.auth.oauth ? (['oauth'] as const) : []),
  ]
}

function cloneOAuthProjection(projection: OAuthOperationProjection): OAuthOperationProjection {
  return {
    ...projection,
    ...(projection.interaction ? { interaction: { ...projection.interaction } } : {}),
  }
}

export class ModelCatalogService {
  private readonly providerIds: string[] = [...builtInProviders]
  private readonly explicitCapabilities = new Map<string, readonly ModelCapability[]>()
  private readonly selections = new Map<
    ModelSelectionRole,
    { providerId: string; modelId: string }
  >()
  private readonly disabledProviders: Set<string>
  private readonly providerStates = new Map<
    string,
    { state: ModelProviderProjection['state']; errorCode?: ModelProviderErrorCode }
  >()
  private readonly oauthOperations = new Map<string, OAuthOperation>()

  constructor(
    private readonly runtime: ModelRuntimePort,
    options: ModelCatalogServiceOptions = {},
  ) {
    this.disabledProviders = new Set(options.disabledProviders ?? [])
    for (const config of options.customProviders ?? []) this.registerCustomProvider(config)
    for (const [role, selection] of Object.entries(options.selections ?? {})) {
      if (selection)
        this.select(role as ModelSelectionRole, selection.providerId, selection.modelId)
    }
  }

  async catalog(): Promise<ModelCatalogProjection> {
    const providers: ModelProviderProjection[] = []
    for (const providerId of this.providerIds) {
      const provider = this.runtime.getProvider(providerId)
      if (!provider) continue
      const override = this.providerStates.get(providerId)
      const disabled = this.disabledProviders.has(providerId)
      const auth = disabled || override ? undefined : await this.runtime.checkAuth(providerId)
      const state = disabled
        ? 'disabled'
        : (override?.state ?? (auth ? 'ready' : 'needs_credentials'))
      const errorCode = disabled
        ? undefined
        : (override?.errorCode ?? (auth ? undefined : 'provider_auth_required'))
      providers.push({
        providerId,
        name: provider.name,
        state,
        authMethods: authMethods(provider),
        models: provider.getModels().map((model) => ({
          providerId,
          modelId: model.id,
          name: model.name,
          capabilities: modelCapabilities(
            model,
            this.explicitCapabilities.get(`${providerId}/${model.id}`),
          ),
        })),
        ...(errorCode ? { errorCode } : {}),
      })
    }

    const selections: ModelCatalogProjection['selections'] = {}
    for (const [role, selection] of this.selections) {
      const model = this.runtime.getModel(selection.providerId, selection.modelId)
      if (!model) continue
      selections[role] = {
        providerId: selection.providerId,
        modelId: selection.modelId,
        capabilities: modelCapabilities(
          model,
          this.explicitCapabilities.get(`${selection.providerId}/${selection.modelId}`),
        ),
      }
    }
    return { providers, selections }
  }

  select(role: ModelSelectionRole, providerId: string, modelId: string): void {
    if (!this.runtime.getModel(providerId, modelId)) throw new ModelCatalogError('model_not_found')
    this.selections.set(role, { providerId, modelId })
  }

  selectedModel(role: ModelSelectionRole): Model<Api> {
    const selection = this.selections.get(role)
    if (!selection) throw new ModelCatalogError('model_not_selected')
    const model = this.runtime.getModel(selection.providerId, selection.modelId)
    if (!model) throw new ModelCatalogError('model_not_found')
    return model
  }

  beginCheck(providerId: string): void {
    this.assertProvider(providerId)
    this.providerStates.set(providerId, { state: 'checking' })
  }

  recordProviderReady(providerId: string): void {
    this.assertProvider(providerId)
    this.providerStates.delete(providerId)
  }

  recordProviderFailure(providerId: string, error: unknown): void {
    this.assertProvider(providerId)
    const errorCode = normalizeModelProviderError(error)
    this.providerStates.set(providerId, {
      state: errorCode === 'provider_contract_incompatible' ? 'incompatible' : 'unavailable',
      errorCode,
    })
  }

  startOAuth(operationId: string, providerId: string): OAuthOperationProjection {
    if (this.oauthOperations.has(operationId)) throw new ModelCatalogError('oauth_operation_exists')
    const provider = this.runtime.getProvider(providerId)
    if (!provider?.auth.oauth || providerId !== 'openai-codex') {
      throw new ModelCatalogError('oauth_provider_unsupported')
    }
    const operation: OAuthOperation = {
      projection: { operationId, providerId, state: 'running' },
      controller: new AbortController(),
    }
    this.oauthOperations.set(operationId, operation)
    this.providerStates.set(providerId, { state: 'checking' })
    const interaction: AuthInteraction = {
      signal: operation.controller.signal,
      notify: (event) => this.receiveOAuthEvent(operation, event),
      prompt: (prompt) => this.waitForOAuthResponse(operation, prompt),
    }
    void this.runtime.login(providerId, 'oauth', interaction).then(
      () => {
        operation.resolvePrompt = undefined
        operation.rejectPrompt = undefined
        operation.projection = { operationId, providerId, state: 'ready' }
        this.providerStates.delete(providerId)
      },
      (error: unknown) => {
        operation.resolvePrompt = undefined
        operation.rejectPrompt = undefined
        if (operation.controller.signal.aborted) {
          operation.projection = { operationId, providerId, state: 'cancelled' }
          this.providerStates.set(providerId, { state: 'needs_credentials' })
          return
        }
        const errorCode = normalizeModelProviderError(error)
        operation.projection = { operationId, providerId, state: 'failed', errorCode }
        this.providerStates.set(providerId, { state: 'needs_credentials', errorCode })
      },
    )
    return cloneOAuthProjection(operation.projection)
  }

  oauthStatus(operationId: string): OAuthOperationProjection {
    return cloneOAuthProjection(this.oauthOperation(operationId).projection)
  }

  respondOAuth(operationId: string, value: string): void {
    const operation = this.oauthOperation(operationId)
    if (!operation.resolvePrompt || operation.projection.state !== 'waiting_for_user') {
      throw new ModelCatalogError('oauth_not_waiting')
    }
    if (value.length === 0 || value.length > 16_384)
      throw new ModelCatalogError('oauth_response_invalid')
    const resolve = operation.resolvePrompt
    operation.resolvePrompt = undefined
    operation.rejectPrompt = undefined
    operation.projection = {
      operationId,
      providerId: operation.projection.providerId,
      state: 'running',
    }
    resolve(value)
  }

  cancelOAuth(operationId: string): void {
    const operation = this.oauthOperation(operationId)
    operation.controller.abort()
    const error = new Error('oauth_cancelled')
    error.name = 'AbortError'
    operation.rejectPrompt?.(error)
  }

  async logout(providerId: string): Promise<void> {
    this.assertProvider(providerId)
    await this.runtime.logout(providerId)
    this.providerStates.set(providerId, { state: 'needs_credentials' })
  }

  private registerCustomProvider(config: OpenAICompatibleProviderConfig): void {
    validateCustomProvider(config)
    const baseUrl = validateEndpoint(config.baseUrl)
    this.runtime.registerProvider(config.providerId, {
      name: config.name,
      baseUrl,
      api: 'openai-completions',
      authHeader: true,
      models: config.models.map((model) => {
        this.explicitCapabilities.set(`${config.providerId}/${model.modelId}`, model.capabilities)
        return {
          id: model.modelId,
          name: model.name,
          reasoning: model.capabilities.includes('reasoning'),
          input: model.capabilities.includes('image-input') ? ['text', 'image'] : ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow ?? 128_000,
          maxTokens: model.maxTokens ?? 8_192,
        }
      }),
    })
    this.providerIds.push(config.providerId)
  }

  private assertProvider(providerId: string): void {
    if (!this.providerIds.includes(providerId) || !this.runtime.getProvider(providerId)) {
      throw new ModelCatalogError('model_provider_not_found')
    }
  }

  private oauthOperation(operationId: string): OAuthOperation {
    const operation = this.oauthOperations.get(operationId)
    if (!operation) throw new ModelCatalogError('oauth_operation_not_found')
    return operation
  }

  private receiveOAuthEvent(operation: OAuthOperation, event: AuthEvent): void {
    if (event.type === 'auth_url') {
      const url = validateAuthNavigationUrl(event.url)
      operation.projection = {
        ...operation.projection,
        state: 'waiting_for_user',
        interaction: { type: 'auth_url', url, messageKey: 'model_auth_open_browser' },
      }
      return
    }
    if (event.type === 'device_code') {
      const verificationUri = validateAuthNavigationUrl(event.verificationUri)
      operation.projection = {
        ...operation.projection,
        state: 'waiting_for_user',
        interaction: {
          type: 'device_code',
          userCode: event.userCode,
          verificationUri,
          ...(event.intervalSeconds === undefined
            ? {}
            : { intervalSeconds: event.intervalSeconds }),
          ...(event.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: event.expiresInSeconds }),
        },
      }
      return
    }
    operation.projection = {
      ...operation.projection,
      state: 'running',
      interaction: { type: 'progress', messageKey: 'model_auth_progress' },
    }
  }

  private waitForOAuthResponse(operation: OAuthOperation, prompt: AuthPrompt): Promise<string> {
    if (operation.controller.signal.aborted)
      return Promise.reject(operation.controller.signal.reason)
    operation.projection = {
      ...operation.projection,
      state: 'waiting_for_user',
      interaction: {
        type: 'prompt',
        promptType: prompt.type,
        messageKey: 'model_auth_prompt',
        ...('placeholder' in prompt && prompt.placeholder
          ? { placeholder: prompt.placeholder.slice(0, 256) }
          : {}),
      },
    }
    return new Promise<string>((resolve, reject) => {
      operation.resolvePrompt = resolve
      operation.rejectPrompt = reject
    })
  }
}
