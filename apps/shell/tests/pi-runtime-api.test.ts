import { describe, expect, it } from 'vitest'
import {
  PI_RUNTIME_CHANNELS,
  asPiRuntimeHealth,
  asProviderId,
  asProviderCredentialInput,
  asProviderCredentialStatus,
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
    })
    expect(JSON.stringify(PI_RUNTIME_CHANNELS)).not.toContain('credential-get')
  })
})
