import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ModelCatalogError,
  ModelCatalogService,
  normalizeModelProviderError,
  shouldRetryAfterAuthRefresh,
} from '../src'

const model = {
  id: 'gpt-test',
  name: 'GPT Test',
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as const

function fakeRuntime() {
  const providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      auth: { apiKey: {} },
      getModels: () => [model],
    },
    {
      id: 'openai-codex',
      name: 'OpenAI Codex',
      auth: { oauth: {} },
      getModels: () => [{ ...model, provider: 'openai-codex' }],
    },
  ]
  return {
    getProviders: vi.fn(() => providers),
    getProvider: vi.fn((providerId: string) => providers.find((item) => item.id === providerId)),
    getModel: vi.fn((providerId: string, modelId: string) =>
      providers
        .find((item) => item.id === providerId)
        ?.getModels()
        .find((item) => item.id === modelId),
    ),
    checkAuth: vi.fn(async (providerId: string) =>
      providerId === 'openai'
        ? { type: 'api_key' as const, source: 'stored credential' }
        : undefined,
    ),
    registerProvider: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(async () => undefined),
  }
}

describe('ModelCatalogService', () => {
  it('projects only the enabled cloud/Codex providers with explicit capabilities and auth state', async () => {
    const runtime = fakeRuntime()
    const service = new ModelCatalogService(runtime as never, {
      selections: { conversation: { providerId: 'openai', modelId: 'gpt-test' } },
    })

    await expect(service.catalog()).resolves.toEqual({
      providers: [
        {
          providerId: 'openai',
          name: 'OpenAI',
          state: 'ready',
          authMethods: ['api_key'],
          models: [
            {
              providerId: 'openai',
              modelId: 'gpt-test',
              name: 'GPT Test',
              capabilities: ['image-input', 'reasoning', 'text-input', 'tool-use'],
            },
          ],
        },
        {
          providerId: 'openai-codex',
          name: 'OpenAI Codex',
          state: 'needs_credentials',
          authMethods: ['oauth'],
          models: [
            {
              providerId: 'openai-codex',
              modelId: 'gpt-test',
              name: 'GPT Test',
              capabilities: ['image-input', 'reasoning', 'text-input', 'tool-use'],
            },
          ],
          errorCode: 'provider_auth_required',
        },
      ],
      selections: {
        conversation: {
          providerId: 'openai',
          modelId: 'gpt-test',
          capabilities: ['image-input', 'reasoning', 'text-input', 'tool-use'],
        },
      },
    })
    expect(JSON.stringify(await service.catalog())).not.toContain('baseUrl')
  })

  it('registers a validated local OpenAI-compatible provider without embedding a credential', async () => {
    const runtime = fakeRuntime()
    new ModelCatalogService(runtime as never, {
      customProviders: [
        {
          providerId: 'local-openai',
          name: 'Local fixture',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            {
              modelId: 'qwen-test',
              name: 'Qwen Test',
              capabilities: ['text-input', 'tool-use'],
            },
          ],
        },
      ],
    })

    expect(runtime.registerProvider).toHaveBeenCalledWith('local-openai', {
      name: 'Local fixture',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      authHeader: true,
      models: [
        {
          id: 'qwen-test',
          name: 'Qwen Test',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    })
    expect(JSON.stringify(runtime.registerProvider.mock.calls)).not.toContain('secret')
  })

  it('reconfigures an existing custom provider without duplicating its catalog entry', async () => {
    const runtime = fakeRuntime()
    const service = new ModelCatalogService(runtime as never, {
      customProviders: [
        {
          providerId: 'local-openai',
          name: 'Local fixture',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ modelId: 'old', name: 'Old', capabilities: ['text-input'] }],
        },
      ],
    })
    service.configureProvider({
      providerId: 'local-openai',
      name: 'Local fixture',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ modelId: 'new', name: 'New', capabilities: ['text-input', 'reasoning'] }],
    })
    expect(runtime.registerProvider).toHaveBeenCalledTimes(2)
    expect(runtime.registerProvider).toHaveBeenLastCalledWith(
      'local-openai',
      expect.objectContaining({
        models: [expect.objectContaining({ id: 'new', reasoning: true })],
      }),
    )
  })

  it.each([
    ['built-in override', { providerId: 'openai', baseUrl: 'https://example.com/v1' }],
    ['invalid provider id', { providerId: '-remote', baseUrl: 'https://example.com/v1' }],
    ['remote cleartext', { providerId: 'remote', baseUrl: 'http://example.com/v1' }],
    ['URL credential', { providerId: 'remote', baseUrl: 'https://user:secret@example.com/v1' }],
    ['URL query', { providerId: 'remote', baseUrl: 'https://example.com/v1?key=secret' }],
    ['URL fragment', { providerId: 'remote', baseUrl: 'https://example.com/v1#secret' }],
    ['invalid URL', { providerId: 'remote', baseUrl: 'not a URL' }],
    ['interpolation', { providerId: 'remote', baseUrl: 'https://${HOST}/v1' }],
  ])('rejects unsafe custom provider config: %s', (_label, patch) => {
    const runtime = fakeRuntime()
    expect(
      () =>
        new ModelCatalogService(runtime as never, {
          customProviders: [
            {
              providerId: patch.providerId,
              name: 'Unsafe',
              baseUrl: patch.baseUrl,
              models: [
                {
                  modelId: 'model',
                  name: 'Model',
                  capabilities: ['text-input'],
                },
              ],
            },
          ],
        }),
    ).toThrowError(ModelCatalogError)
    expect(runtime.registerProvider).not.toHaveBeenCalled()
  })

  it.each([
    ['empty provider name', { name: '' }],
    ['long provider name', { name: 'p'.repeat(257) }],
    ['empty model list', { models: [] }],
    [
      'oversized model list',
      {
        models: Array.from({ length: 257 }, (_, index) => ({
          modelId: `model-${index}`,
          name: `Model ${index}`,
          capabilities: ['text-input'],
        })),
      },
    ],
    ['empty model id', { models: [{ modelId: '', name: 'Model', capabilities: ['text-input'] }] }],
    [
      'long model id',
      { models: [{ modelId: 'm'.repeat(257), name: 'Model', capabilities: ['text-input'] }] },
    ],
    [
      'empty model name',
      { models: [{ modelId: 'model', name: '', capabilities: ['text-input'] }] },
    ],
    [
      'long model name',
      { models: [{ modelId: 'model', name: 'm'.repeat(257), capabilities: ['text-input'] }] },
    ],
    ['empty capabilities', { models: [{ modelId: 'model', name: 'Model', capabilities: [] }] }],
    [
      'unknown capability',
      { models: [{ modelId: 'model', name: 'Model', capabilities: ['secret-read'] }] },
    ],
    [
      'duplicate model id',
      {
        models: [
          { modelId: 'model', name: 'One', capabilities: ['text-input'] },
          { modelId: 'model', name: 'Two', capabilities: ['text-input'] },
        ],
      },
    ],
  ])('rejects malformed provider metadata: %s', (_label, patch) => {
    const runtime = fakeRuntime()
    const config = {
      providerId: 'remote',
      name: 'Remote',
      baseUrl: 'https://example.com/v1',
      models: [{ modelId: 'model', name: 'Model', capabilities: ['text-input'] }],
      ...patch,
    }
    expect(
      () => new ModelCatalogService(runtime as never, { customProviders: [config as never] }),
    ).toThrowError('model_provider_invalid')
    expect(runtime.registerProvider).not.toHaveBeenCalled()
  })

  it('preserves explicit capabilities and custom token limits', async () => {
    const runtime = fakeRuntime()
    const service = new ModelCatalogService(runtime as never, {
      customProviders: [
        {
          providerId: 'local-rich',
          name: 'Local rich model',
          baseUrl: 'http://[::1]:11434/v1/',
          models: [
            {
              modelId: 'vision-reasoning',
              name: 'Vision reasoning',
              capabilities: ['reasoning', 'image-input', 'text-input', 'reasoning'],
              contextWindow: 32_000,
              maxTokens: 4_096,
            },
          ],
        },
      ],
    })

    expect(runtime.registerProvider).toHaveBeenCalledWith(
      'local-rich',
      expect.objectContaining({
        baseUrl: 'http://[::1]:11434/v1',
        models: [
          expect.objectContaining({
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 32_000,
            maxTokens: 4_096,
          }),
        ],
      }),
    )
    const registered = runtime.registerProvider.mock.calls[0]?.[1]
    runtime.getProvider.mockImplementation(((providerId: string) =>
      providerId === 'local-rich'
        ? {
            id: providerId,
            name: registered.name,
            auth: { apiKey: {}, oauth: {} },
            getModels: () => [
              {
                ...model,
                provider: providerId,
                id: 'vision-reasoning',
                name: 'Vision reasoning',
              },
            ],
          }
        : fakeRuntime().getProvider(providerId)) as never)
    expect((await service.catalog()).providers.at(-1)).toMatchObject({
      authMethods: ['api_key', 'oauth'],
      models: [
        {
          capabilities: ['image-input', 'reasoning', 'text-input'],
        },
      ],
    })
  })

  it('validates selections and applies redacted health transitions without changing model identity', async () => {
    const runtime = fakeRuntime()
    const service = new ModelCatalogService(runtime as never)
    expect(() => service.select('conversation', 'openai', 'missing')).toThrowError(
      'model_not_found',
    )
    service.select('conversation', 'openai', 'gpt-test')
    service.beginCheck('openai')
    expect((await service.catalog()).providers[0]?.state).toBe('checking')
    service.recordProviderFailure(
      'openai',
      Object.assign(new Error('secret body'), { status: 429 }),
    )
    const failed = (await service.catalog()).providers[0]
    expect(failed).toMatchObject({
      state: 'unavailable',
      errorCode: 'provider_rate_limited',
    })
    expect(JSON.stringify(failed)).not.toContain('secret body')
    service.recordProviderReady('openai')
    expect((await service.catalog()).providers[0]).toMatchObject({ state: 'ready' })
    expect(service.selectedModel('conversation')).toMatchObject({ id: 'gpt-test' })
  })

  it('omits unavailable providers and stale selections and rejects unknown providers', async () => {
    const runtime = fakeRuntime()
    const service = new ModelCatalogService(runtime as never, {
      selections: { conversation: { providerId: 'openai', modelId: 'gpt-test' } },
      disabledProviders: ['openai-codex'],
    })
    expect((await service.catalog()).providers[1]).toMatchObject({
      providerId: 'openai-codex',
      state: 'disabled',
    })
    expect((await service.catalog()).providers[1]).not.toHaveProperty('errorCode')
    runtime.getProvider.mockImplementation((providerId: string) =>
      providerId === 'openai-codex' ? undefined : fakeRuntime().getProvider(providerId),
    )
    expect((await service.catalog()).providers).toHaveLength(1)
    runtime.getModel.mockReturnValue(undefined)
    expect((await service.catalog()).selections).toEqual({})
    expect(() => service.selectedModel('conversation')).toThrowError('model_not_found')
    expect(() =>
      new ModelCatalogService(fakeRuntime() as never).selectedModel('image'),
    ).toThrowError('model_not_selected')
    expect(() => service.beginCheck('missing')).toThrowError('model_provider_not_found')
    await expect(service.logout('missing')).rejects.toThrowError('model_provider_not_found')
  })

  it('marks provider contract failures as incompatible', async () => {
    const service = new ModelCatalogService(fakeRuntime() as never)
    service.recordProviderFailure('openai', Object.assign(new Error('schema'), { status: 422 }))
    expect((await service.catalog()).providers[0]).toMatchObject({
      state: 'incompatible',
      errorCode: 'provider_contract_incompatible',
    })
  })

  it('runs Codex OAuth through a cancellable, renderer-safe interaction without exposing credentials', async () => {
    const runtime = fakeRuntime()
    runtime.login.mockImplementation(async (_providerId, _type, interaction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/device',
        intervalSeconds: 5,
        expiresInSeconds: 600,
      })
      const code = await interaction.prompt({ type: 'manual_code', message: 'paste secret code' })
      return { type: 'oauth', access: `access-${code}`, refresh: 'refresh-secret', expires: 42 }
    })
    const service = new ModelCatalogService(runtime as never)
    service.startOAuth('55555555-5555-4555-8555-555555555555', 'openai-codex')
    await vi.waitFor(() =>
      expect(service.oauthStatus('55555555-5555-4555-8555-555555555555')).toMatchObject({
        state: 'waiting_for_user',
        interaction: { type: 'prompt', promptType: 'manual_code' },
      }),
    )
    expect(
      JSON.stringify(service.oauthStatus('55555555-5555-4555-8555-555555555555')),
    ).not.toContain('paste secret code')
    service.respondOAuth('55555555-5555-4555-8555-555555555555', 'one-time-secret')
    await vi.waitFor(() =>
      expect(service.oauthStatus('55555555-5555-4555-8555-555555555555').state).toBe('ready'),
    )
    expect(
      JSON.stringify(service.oauthStatus('55555555-5555-4555-8555-555555555555')),
    ).not.toContain('one-time-secret')
    await service.logout('openai-codex')
    expect(runtime.logout).toHaveBeenCalledWith('openai-codex')
  })

  it('allows query-bearing HTTPS OAuth URLs and projects progress without exposing provider text', async () => {
    const runtime = fakeRuntime()
    let releaseLogin!: () => void
    runtime.login.mockImplementation(async (_providerId, _type, interaction) => {
      interaction.notify({ type: 'info', message: 'provider private progress' })
      interaction.notify({
        type: 'auth_url',
        url: 'https://auth.openai.com/oauth/authorize?client_id=public&state=opaque',
      })
      await new Promise<void>((resolve) => {
        releaseLogin = resolve
      })
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: 42 }
    })
    const service = new ModelCatalogService(runtime as never)
    const operationId = '88888888-8888-4888-8888-888888888888'
    service.startOAuth(operationId, 'openai-codex')
    await vi.waitFor(() =>
      expect(service.oauthStatus(operationId)).toMatchObject({
        state: 'waiting_for_user',
        interaction: {
          type: 'auth_url',
          url: 'https://auth.openai.com/oauth/authorize?client_id=public&state=opaque',
        },
      }),
    )
    expect(JSON.stringify(service.oauthStatus(operationId))).not.toContain(
      'provider private progress',
    )
    releaseLogin()
    await vi.waitFor(() => expect(service.oauthStatus(operationId).state).toBe('ready'))
  })

  it('projects optional OAuth fields and validates prompt responses', async () => {
    const runtime = fakeRuntime()
    runtime.login.mockImplementation(async (_providerId, _type, interaction) => {
      interaction.notify({
        type: 'device_code',
        userCode: 'CODE',
        verificationUri: 'https://auth.openai.com/device',
      })
      return interaction.prompt({
        type: 'text',
        message: 'private prompt',
        placeholder: 'p'.repeat(300),
      })
    })
    const service = new ModelCatalogService(runtime as never)
    const operationId = '99999999-9999-4999-8999-999999999999'
    service.startOAuth(operationId, 'openai-codex')
    await vi.waitFor(() => expect(service.oauthStatus(operationId).state).toBe('waiting_for_user'))
    expect(service.oauthStatus(operationId)).toMatchObject({
      interaction: { type: 'prompt', placeholder: 'p'.repeat(256) },
    })
    expect(() => service.respondOAuth(operationId, '')).toThrowError('oauth_response_invalid')
    expect(() => service.respondOAuth(operationId, 'x'.repeat(16_385))).toThrowError(
      'oauth_response_invalid',
    )
    service.respondOAuth(operationId, 'ok')
    await vi.waitFor(() => expect(service.oauthStatus(operationId).state).toBe('ready'))
  })

  it('projects failed OAuth and handles cancellation before a prompt exists', async () => {
    const failedRuntime = fakeRuntime()
    failedRuntime.login.mockRejectedValue(Object.assign(new Error('private'), { status: 403 }))
    const failed = new ModelCatalogService(failedRuntime as never)
    failed.startOAuth('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'openai-codex')
    await vi.waitFor(() =>
      expect(failed.oauthStatus('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toMatchObject({
        state: 'failed',
        errorCode: 'provider_auth_required',
      }),
    )

    const pendingRuntime = fakeRuntime()
    let continueLogin!: () => void
    pendingRuntime.login.mockImplementation(async (_providerId, _type, interaction) => {
      await new Promise<void>((resolve) => {
        continueLogin = resolve
      })
      await interaction.prompt({ type: 'text', message: 'too late' })
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: 42 }
    })
    const pending = new ModelCatalogService(pendingRuntime as never)
    const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    pending.startOAuth(operationId, 'openai-codex')
    pending.cancelOAuth(operationId)
    continueLogin()
    await vi.waitFor(() => expect(pending.oauthStatus(operationId).state).toBe('cancelled'))
  })

  it('cancels pending OAuth, rejects duplicate/unknown operations, and normalizes failures', async () => {
    const runtime = fakeRuntime()
    runtime.login.mockImplementation(async (_providerId, _type, interaction) => {
      await interaction.prompt({ type: 'text', message: 'wait' })
      return { type: 'oauth', access: 'access', refresh: 'refresh', expires: 42 }
    })
    const service = new ModelCatalogService(runtime as never)
    const operationId = '66666666-6666-4666-8666-666666666666'
    service.startOAuth(operationId, 'openai-codex')
    expect(() => service.startOAuth(operationId, 'openai-codex')).toThrowError(
      'oauth_operation_exists',
    )
    expect(() => service.startOAuth('77777777-7777-4777-8777-777777777777', 'openai')).toThrowError(
      'oauth_provider_unsupported',
    )
    await vi.waitFor(() => expect(service.oauthStatus(operationId).state).toBe('waiting_for_user'))
    service.cancelOAuth(operationId)
    await vi.waitFor(() => expect(service.oauthStatus(operationId).state).toBe('cancelled'))
    expect(() => service.respondOAuth(operationId, 'late')).toThrowError('oauth_not_waiting')
    expect(() => service.oauthStatus('missing')).toThrowError('oauth_operation_not_found')
    expect(() => service.cancelOAuth('missing')).toThrowError('oauth_operation_not_found')
  })
})

describe('model provider error/retry policy', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    [Object.assign(new Error('auth'), { status: 401 }), 'provider_auth_required'],
    [Object.assign(new Error('forbidden'), { status: 403 }), 'provider_auth_required'],
    [Object.assign(new Error('rate'), { status: 429 }), 'provider_rate_limited'],
    [
      Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' }),
      'provider_quota_exceeded',
    ],
    [Object.assign(new Error('missing'), { status: 404 }), 'model_not_found'],
    [Object.assign(new Error('schema'), { status: 400 }), 'provider_contract_incompatible'],
    [Object.assign(new Error('schema'), { status: 422 }), 'provider_contract_incompatible'],
    [Object.assign(new Error('abort'), { name: 'AbortError' }), 'provider_request_aborted'],
    [new Error('private upstream body'), 'provider_unavailable'],
    ['private upstream body', 'provider_unavailable'],
    [null, 'provider_unavailable'],
  ] as const)('maps provider failure case %# without retaining the message', (error, code) => {
    expect(normalizeModelProviderError(error)).toBe(code)
  })

  it('permits exactly one auth refresh retry only before any observable/billable output', () => {
    const authError = Object.assign(new Error('auth'), { status: 401 })
    expect(
      shouldRetryAfterAuthRefresh(authError, {
        refreshAttempts: 0,
        hasOutput: false,
        hasToolCall: false,
        hasUsage: false,
      }),
    ).toBe(true)
    for (const evidence of [
      { refreshAttempts: 1, hasOutput: false, hasToolCall: false, hasUsage: false },
      { refreshAttempts: 0, hasOutput: true, hasToolCall: false, hasUsage: false },
      { refreshAttempts: 0, hasOutput: false, hasToolCall: true, hasUsage: false },
      { refreshAttempts: 0, hasOutput: false, hasToolCall: false, hasUsage: true },
    ]) {
      expect(shouldRetryAfterAuthRefresh(authError, evidence)).toBe(false)
    }
    expect(
      shouldRetryAfterAuthRefresh(Object.assign(new Error('rate'), { status: 429 }), {
        refreshAttempts: 0,
        hasOutput: false,
        hasToolCall: false,
        hasUsage: false,
      }),
    ).toBe(false)
  })

  it('creates a Pi ModelRuntime without reading external agent homes or refreshing the network', async () => {
    const credentials = new InMemoryCredentialStore()
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const service = new ModelCatalogService(runtime, {
      customProviders: [
        {
          providerId: 'local-fixture',
          name: 'Local fixture',
          baseUrl: 'http://localhost:12345/v1',
          models: [{ modelId: 'fixture-model', name: 'Fixture', capabilities: ['text-input'] }],
        },
      ],
    })
    expect(runtime.getModel('local-fixture', 'fixture-model')).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'http://localhost:12345/v1',
    })
    expect((await service.catalog()).providers.map((provider) => provider.providerId)).toEqual([
      'openai',
      'openai-codex',
      'local-fixture',
    ])
  })
})
