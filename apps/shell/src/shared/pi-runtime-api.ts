import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  parseCredentialProviderId,
  parseProviderCredentialStatus as parseProtocolProviderCredentialStatus,
  parseRuntimeHealthProjection,
  type ProviderCredentialStatus,
  type RuntimeHealthProjection,
} from '@genoffice/agent-runtime-protocol/renderer'

export const PI_RUNTIME_CHANNELS = {
  health: 'pi-runtime:health',
  saveProviderApiKey: 'pi-runtime:provider-credential-save',
  providerCredentialStatus: 'pi-runtime:provider-credential-status',
  logoutProvider: 'pi-runtime:provider-credential-logout',
} as const

export type ProviderCredentialInput = {
  providerId: string
  persistence: 'persistent' | 'memory_only'
  apiKey: string
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isProviderId(value: unknown): value is string {
  try {
    parseCredentialProviderId(value)
    return true
  } catch {
    return false
  }
}

export function asProviderId(value: unknown): string {
  return parseCredentialProviderId(value)
}

export function asProviderCredentialInput(value: unknown): Readonly<ProviderCredentialInput> {
  if (
    !isExactRecord(value, ['providerId', 'persistence', 'apiKey']) ||
    !isProviderId(value.providerId) ||
    (value.persistence !== 'persistent' && value.persistence !== 'memory_only') ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length === 0 ||
    value.apiKey.length > 262_144
  ) {
    throw new Error('provider_credential_input_invalid')
  }
  return Object.freeze({
    providerId: value.providerId,
    persistence: value.persistence,
    apiKey: value.apiKey,
  })
}

export function asProviderCredentialStatus(value: unknown): Readonly<ProviderCredentialStatus> {
  return Object.freeze(parseProtocolProviderCredentialStatus(value))
}

const UNAVAILABLE_HEALTH: RuntimeHealthProjection = Object.freeze({
  state: 'unavailable',
  protocolVersion: PROTOCOL_VERSION,
  runtimeVersion: RUNTIME_VERSION,
  schemaVersion: SCHEMA_VERSION,
  diagnosticCode: 'runtime_bundle_unavailable',
})

export function asPiRuntimeHealth(value: unknown): RuntimeHealthProjection {
  try {
    return Object.freeze(parseRuntimeHealthProjection(value))
  } catch {
    return UNAVAILABLE_HEALTH
  }
}

export interface PiRuntimeApi {
  health(): Promise<RuntimeHealthProjection>
  saveProviderApiKey(input: ProviderCredentialInput): Promise<Readonly<ProviderCredentialStatus>>
  providerCredentialStatus(providerId: string): Promise<Readonly<ProviderCredentialStatus>>
  logoutProvider(providerId: string): Promise<Readonly<ProviderCredentialStatus>>
}
