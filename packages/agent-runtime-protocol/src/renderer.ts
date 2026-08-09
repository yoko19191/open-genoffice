import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const PROTOCOL_VERSION = '1' as const
export const RUNTIME_VERSION = '1.0.0' as const
export const SCHEMA_VERSION = '1' as const
export const RUNTIME_NAME = 'open-genoffice-pi-agent-runtime' as const
export const NODE_VERSION = '22.19.0' as const
export const PI_VERSION = '0.84.0' as const
export const MAX_FRAME_BYTES = 1024 * 1024

export const CredentialProviderIdSchema = Type.String({
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
})
export const CredentialKindSchema = Type.Union([Type.Literal('api_key'), Type.Literal('oauth')])
export const CredentialPersistenceSchema = Type.Union([
  Type.Literal('persistent'),
  Type.Literal('memory_only'),
])

export const ProviderCredentialStatusSchema = Type.Object(
  {
    providerId: CredentialProviderIdSchema,
    status: Type.Union([
      Type.Literal('available'),
      Type.Literal('missing'),
      Type.Literal('secure_storage_unavailable'),
    ]),
    persistence: CredentialPersistenceSchema,
    kind: Type.Optional(CredentialKindSchema),
  },
  { additionalProperties: false },
)

export const ModelCapabilitySchema = Type.Union([
  Type.Literal('text-input'),
  Type.Literal('image-input'),
  Type.Literal('audio-input'),
  Type.Literal('video-input'),
  Type.Literal('tool-use'),
  Type.Literal('reasoning'),
])

export const ModelProviderStateSchema = Type.Union([
  Type.Literal('disabled'),
  Type.Literal('needs_credentials'),
  Type.Literal('checking'),
  Type.Literal('ready'),
  Type.Literal('incompatible'),
  Type.Literal('unavailable'),
  Type.Literal('refreshing'),
])

export const ModelSelectionRoleSchema = Type.Union([
  Type.Literal('conversation'),
  Type.Literal('image'),
  Type.Literal('ocr'),
])

export const ModelProviderErrorCodeSchema = Type.Union([
  Type.Literal('provider_auth_required'),
  Type.Literal('provider_rate_limited'),
  Type.Literal('provider_quota_exceeded'),
  Type.Literal('model_not_found'),
  Type.Literal('provider_contract_incompatible'),
  Type.Literal('provider_unavailable'),
  Type.Literal('provider_request_aborted'),
])

export const ModelDescriptorSchema = Type.Object(
  {
    providerId: CredentialProviderIdSchema,
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    capabilities: Type.Array(ModelCapabilitySchema, { maxItems: 6, uniqueItems: true }),
  },
  { additionalProperties: false },
)

export const ModelProviderProjectionSchema = Type.Object(
  {
    providerId: CredentialProviderIdSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    state: ModelProviderStateSchema,
    authMethods: Type.Array(CredentialKindSchema, { maxItems: 2, uniqueItems: true }),
    models: Type.Array(ModelDescriptorSchema, { maxItems: 1024 }),
    errorCode: Type.Optional(ModelProviderErrorCodeSchema),
  },
  { additionalProperties: false },
)

const ModelSelectionProjectionSchema = Type.Object(
  {
    providerId: CredentialProviderIdSchema,
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    capabilities: Type.Array(ModelCapabilitySchema, { maxItems: 6, uniqueItems: true }),
  },
  { additionalProperties: false },
)

export const ModelCatalogProjectionSchema = Type.Object(
  {
    providers: Type.Array(ModelProviderProjectionSchema, { maxItems: 256 }),
    selections: Type.Object(
      {
        conversation: Type.Optional(ModelSelectionProjectionSchema),
        image: Type.Optional(ModelSelectionProjectionSchema),
        ocr: Type.Optional(ModelSelectionProjectionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const OAuthOperationIdSchema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
})
const OAuthHttpsUrlSchema = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: '^https:\\/\\/',
})

export const OAuthInteractionProjectionSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('progress'),
      messageKey: Type.Literal('model_auth_progress'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('auth_url'),
      url: OAuthHttpsUrlSchema,
      messageKey: Type.Literal('model_auth_open_browser'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('device_code'),
      userCode: Type.String({ minLength: 1, maxLength: 256 }),
      verificationUri: OAuthHttpsUrlSchema,
      intervalSeconds: Type.Optional(Type.Number({ minimum: 0 })),
      expiresInSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('prompt'),
      promptType: Type.Union([
        Type.Literal('text'),
        Type.Literal('secret'),
        Type.Literal('select'),
        Type.Literal('manual_code'),
      ]),
      messageKey: Type.Literal('model_auth_prompt'),
      placeholder: Type.Optional(Type.String({ maxLength: 256 })),
    },
    { additionalProperties: false },
  ),
])

export const OAuthOperationProjectionSchema = Type.Object(
  {
    operationId: OAuthOperationIdSchema,
    providerId: CredentialProviderIdSchema,
    state: Type.Union([
      Type.Literal('running'),
      Type.Literal('waiting_for_user'),
      Type.Literal('ready'),
      Type.Literal('failed'),
      Type.Literal('cancelled'),
    ]),
    interaction: Type.Optional(OAuthInteractionProjectionSchema),
    errorCode: Type.Optional(ModelProviderErrorCodeSchema),
  },
  { additionalProperties: false },
)

export const RuntimeHealthProjectionSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal('stopped'),
      Type.Literal('starting'),
      Type.Literal('ready'),
      Type.Literal('crashed'),
      Type.Literal('unavailable'),
    ]),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    runtimeVersion: Type.Literal(RUNTIME_VERSION),
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    diagnosticCode: Type.Optional(
      Type.Union([
        Type.Literal('runtime_bundle_unavailable'),
        Type.Literal('runtime_start_failed'),
        Type.Literal('runtime_shutdown_failed'),
      ]),
    ),
  },
  { additionalProperties: false },
)

export type ProviderCredentialStatus = Static<typeof ProviderCredentialStatusSchema>
export type RuntimeHealthProjection = Static<typeof RuntimeHealthProjectionSchema>
export type ModelCapability = Static<typeof ModelCapabilitySchema>
export type ModelProviderState = Static<typeof ModelProviderStateSchema>
export type ModelDescriptor = Static<typeof ModelDescriptorSchema>
export type ModelProviderProjection = Static<typeof ModelProviderProjectionSchema>
export type ModelCatalogProjection = Static<typeof ModelCatalogProjectionSchema>
export type ModelSelectionRole = Static<typeof ModelSelectionRoleSchema>
export type ModelProviderErrorCode = Static<typeof ModelProviderErrorCodeSchema>
export type OAuthInteractionProjection = Static<typeof OAuthInteractionProjectionSchema>
export type OAuthOperationProjection = Static<typeof OAuthOperationProjectionSchema>

export function parseCredentialProviderId(value: unknown): string {
  if (Value.Check(CredentialProviderIdSchema, value)) return value
  throw new Error('provider_id_invalid')
}

export function parseProviderCredentialStatus(value: unknown): ProviderCredentialStatus {
  if (Value.Check(ProviderCredentialStatusSchema, value)) return value
  throw new Error('provider_credential_status_invalid')
}

export function parseRuntimeHealthProjection(value: unknown): RuntimeHealthProjection {
  if (Value.Check(RuntimeHealthProjectionSchema, value)) return value
  throw new Error('runtime_health_invalid')
}

export function parseModelCatalogProjection(value: unknown): ModelCatalogProjection {
  if (Value.Check(ModelCatalogProjectionSchema, value)) return value
  throw new Error('model_catalog_invalid')
}

export function parseOAuthOperationProjection(value: unknown): OAuthOperationProjection {
  if (Value.Check(OAuthOperationProjectionSchema, value)) return value
  throw new Error('oauth_operation_projection_invalid')
}
