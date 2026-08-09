import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  parseCredentialProviderId,
  parseModelCatalogProjection,
  parseOpenAICompatibleProviderConfiguration,
  parseOAuthOperationProjection,
  parseProviderCredentialStatus as parseProtocolProviderCredentialStatus,
  parseRuntimeHealthProjection,
  type ProviderCredentialStatus,
  type RuntimeHealthProjection,
  type ModelCatalogProjection,
  type ModelSelectionRole,
  type OAuthOperationProjection,
  type OpenAICompatibleProviderConfiguration,
} from '@genoffice/agent-runtime-protocol/renderer'

export const PI_RUNTIME_CHANNELS = {
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
} as const

export type ProviderCredentialInput = {
  providerId: string
  persistence: 'persistent' | 'memory_only'
  apiKey: string
}

export type ModelSelectInput = {
  role: ModelSelectionRole
  providerId: string
  modelId: string
}
export type ModelOAuthStartInput = { operationId: string; providerId: string }
export type ModelOAuthOperationInput = { operationId: string }
export type ModelOAuthResponseInput = ModelOAuthOperationInput & { value: string }
export type ModelProviderConfigurationInput = OpenAICompatibleProviderConfiguration

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

export function asModelCatalog(value: unknown): Readonly<ModelCatalogProjection> {
  return Object.freeze(parseModelCatalogProjection(value))
}

export function asOAuthOperation(value: unknown): Readonly<OAuthOperationProjection> {
  return Object.freeze(parseOAuthOperationProjection(value))
}

export function asModelSelectInput(value: unknown): Readonly<ModelSelectInput> {
  if (
    !isExactRecord(value, ['role', 'providerId', 'modelId']) ||
    (value.role !== 'conversation' && value.role !== 'image' && value.role !== 'ocr') ||
    !isProviderId(value.providerId) ||
    typeof value.modelId !== 'string' ||
    value.modelId.length === 0 ||
    value.modelId.length > 256
  ) {
    throw new Error('model_select_input_invalid')
  }
  return Object.freeze({
    role: value.role,
    providerId: value.providerId,
    modelId: value.modelId,
  })
}

export function asModelProviderConfigurationInput(
  value: unknown,
): Readonly<ModelProviderConfigurationInput> {
  return Object.freeze(parseOpenAICompatibleProviderConfiguration(value))
}

export function asModelOAuthStartInput(value: unknown): Readonly<ModelOAuthStartInput> {
  if (
    !isExactRecord(value, ['operationId', 'providerId']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId) ||
    !isProviderId(value.providerId)
  ) {
    throw new Error('model_oauth_start_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId, providerId: value.providerId })
}

export function asModelOAuthOperationInput(value: unknown): Readonly<ModelOAuthOperationInput> {
  if (
    !isExactRecord(value, ['operationId']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId)
  ) {
    throw new Error('model_oauth_operation_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId })
}

export function asModelOAuthResponseInput(value: unknown): Readonly<ModelOAuthResponseInput> {
  if (
    !isExactRecord(value, ['operationId', 'value']) ||
    typeof value.operationId !== 'string' ||
    !operationIdPattern.test(value.operationId) ||
    typeof value.value !== 'string' ||
    value.value.length === 0 ||
    value.value.length > 16_384
  ) {
    throw new Error('model_oauth_response_input_invalid')
  }
  return Object.freeze({ operationId: value.operationId, value: value.value })
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
  modelCatalog(): Promise<Readonly<ModelCatalogProjection>>
  selectModel(input: ModelSelectInput): Promise<Readonly<ModelCatalogProjection>>
  configureModelProvider(
    input: ModelProviderConfigurationInput,
  ): Promise<Readonly<ModelCatalogProjection>>
  startModelOAuth(input: ModelOAuthStartInput): Promise<Readonly<OAuthOperationProjection>>
  modelOAuthStatus(input: ModelOAuthOperationInput): Promise<Readonly<OAuthOperationProjection>>
  respondModelOAuth(input: ModelOAuthResponseInput): Promise<Readonly<OAuthOperationProjection>>
  cancelModelOAuth(input: ModelOAuthOperationInput): Promise<Readonly<OAuthOperationProjection>>
  logoutModel(providerId: string): Promise<Readonly<ModelCatalogProjection>>
}
