import { describe, expect, it } from 'vitest'
import {
  PI_RUNTIME_CHANNELS,
  asPiRuntimeHealth,
  asProviderId,
  asProviderCredentialInput,
  asProviderCredentialStatus,
  asModelCatalog,
  asModelSelectInput,
  asModelProviderConfigurationInput,
  asModelOAuthStartInput,
  asModelOAuthOperationInput,
  asModelOAuthResponseInput,
  asOAuthOperation,
} from '../src/shared/pi-runtime-api'

describe('typed Pi Runtime preload health contract', () => {
  it('accepts the narrow projection and fails closed on leaked or malformed fields', () => {
    const ready = {
      state: 'ready',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      schemaVersion: '1',
    }
    expect(asPiRuntimeHealth(ready)).toEqual(ready)
    expect(asPiRuntimeHealth({ ...ready, endpoint: '/private/runtime.sock' })).toMatchObject({
      state: 'unavailable',
      diagnosticCode: 'runtime_bundle_unavailable',
    })
    expect(asPiRuntimeHealth(null)).toMatchObject({ state: 'unavailable' })
    expect(Object.isFrozen(asPiRuntimeHealth(null))).toBe(true)
    expect(PI_RUNTIME_CHANNELS.health).toBe('pi-runtime:health')
  })

  it('accepts an exact write-only API-key input and rejects shape drift', () => {
    const input = {
      providerId: 'openai',
      persistence: 'memory_only',
      apiKey: 'renderer-write-only-canary',
    } as const
    expect(asProviderCredentialInput(input)).toEqual(input)
    expect(Object.isFrozen(asProviderCredentialInput(input))).toBe(true)
    expect(() => asProviderCredentialInput({ ...input, credential: 'readable' })).toThrowError(
      'provider_credential_input_invalid',
    )
    expect(() =>
      asProviderCredentialInput({ ...input, providerId: '../other-client' }),
    ).toThrowError('provider_credential_input_invalid')
    expect(() => asProviderCredentialInput({ ...input, persistence: undefined })).toThrowError(
      'provider_credential_input_invalid',
    )
    expect(asProviderId('openai')).toBe('openai')
    expect(() => asProviderId('../other-client')).toThrowError('provider_id_invalid')
  })

  it('accepts only redacted status and exposes no raw credential channel', () => {
    const status = {
      providerId: 'openai',
      persistence: 'persistent',
      status: 'available',
      kind: 'api_key',
    } as const
    expect(asProviderCredentialStatus(status)).toEqual(status)
    expect(() => asProviderCredentialStatus({ ...status, apiKey: 'leaked-canary' })).toThrowError(
      'provider_credential_status_invalid',
    )
    expect(PI_RUNTIME_CHANNELS).toEqual({
      health: 'pi-runtime:health',
      saveProviderApiKey: 'pi-runtime:provider-credential-save',
      providerCredentialStatus: 'pi-runtime:provider-credential-status',
      logoutProvider: 'pi-runtime:provider-credential-logout',
      modelCatalog: 'pi-runtime:model-catalog',
      selectModel: 'pi-runtime:model-select',
      configureModelProvider: 'pi-runtime:model-provider-configure',
      startModelOAuth: 'pi-runtime:model-oauth-start',
      modelOAuthStatus: 'pi-runtime:model-oauth-status',
      respondModelOAuth: 'pi-runtime:model-oauth-respond',
      cancelModelOAuth: 'pi-runtime:model-oauth-cancel',
      logoutModel: 'pi-runtime:model-logout',
    })
    expect(JSON.stringify(PI_RUNTIME_CHANNELS)).not.toContain('credential-get')
  })

  it('validates exact model selection and write-only OAuth inputs', () => {
    const operationId = '55555555-5555-4555-8555-555555555555'
    expect(
      asModelSelectInput({ role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' }),
    ).toEqual({ role: 'conversation', providerId: 'openai', modelId: 'gpt-5.4' })
    expect(asModelOAuthStartInput({ operationId, providerId: 'openai-codex' })).toEqual({
      operationId,
      providerId: 'openai-codex',
    })
    expect(asModelOAuthOperationInput({ operationId })).toEqual({ operationId })
    expect(asModelOAuthResponseInput({ operationId, value: 'write-only-response' })).toEqual({
      operationId,
      value: 'write-only-response',
    })
    expect(() =>
      asModelSelectInput({
        role: 'fallback',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
    ).toThrowError('model_select_input_invalid')
    expect(() =>
      asModelOAuthResponseInput({ operationId, value: '', secret: 'readable' }),
    ).toThrowError('model_oauth_response_input_invalid')
    expect(() =>
      asModelOAuthStartInput({ operationId: 'invalid', providerId: 'openai-codex' }),
    ).toThrowError('model_oauth_start_input_invalid')
    expect(() => asModelOAuthOperationInput({ operationId: 'invalid' })).toThrowError(
      'model_oauth_operation_input_invalid',
    )
  })

  it('accepts only explicit secret-free OpenAI-compatible Provider configuration', () => {
    const configuration = {
      providerId: 'local-openai',
      name: 'Local OpenAI',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'Qwen Test',
          capabilities: ['text-input', 'tool-use'],
        },
      ],
    }
    expect(asModelProviderConfigurationInput(configuration)).toEqual(configuration)
    expect(() =>
      asModelProviderConfigurationInput({ ...configuration, apiKey: 'secret-canary' }),
    ).toThrowError('model_provider_configuration_invalid')
    expect(() =>
      asModelProviderConfigurationInput({
        ...configuration,
        models: [{ ...configuration.models[0], capabilities: [] }],
      }),
    ).toThrowError('model_provider_configuration_invalid')
  })

  it('revalidates renderer-safe catalog and OAuth projections', () => {
    const catalog = { providers: [], selections: {} }
    const operation = {
      operationId: '55555555-5555-4555-8555-555555555555',
      providerId: 'openai-codex',
      state: 'running',
    }
    expect(asModelCatalog(catalog)).toEqual(catalog)
    expect(asOAuthOperation(operation)).toEqual(operation)
    expect(() => asModelCatalog({ ...catalog, apiKey: 'leaked' })).toThrowError(
      'model_catalog_invalid',
    )
    expect(() => asOAuthOperation({ ...operation, accessToken: 'leaked' })).toThrowError(
      'oauth_operation_projection_invalid',
    )
  })
})
