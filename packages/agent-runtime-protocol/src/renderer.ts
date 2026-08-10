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

export const OpenAICompatibleProviderConfigurationSchema = Type.Object(
  {
    providerId: CredentialProviderIdSchema,
    name: Type.String({ minLength: 1, maxLength: 256 }),
    baseUrl: Type.String({ minLength: 1, maxLength: 4096 }),
    models: Type.Array(
      Type.Object(
        {
          modelId: Type.String({ minLength: 1, maxLength: 256 }),
          name: Type.String({ minLength: 1, maxLength: 256 }),
          capabilities: Type.Array(ModelCapabilitySchema, {
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
          }),
          contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
          maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 256 },
    ),
  },
  { additionalProperties: false },
)

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

export const ResourceCatalogProjectionSchema = Type.Object(
  {
    catalogId: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    projectState: Type.Union([
      Type.Literal('none'),
      Type.Literal('invalid'),
      Type.Literal('untrusted'),
      Type.Literal('trusted'),
    ]),
    resources: Type.Array(
      Type.Object(
        {
          resourceKey: Type.String({ minLength: 1, maxLength: 1024 }),
          resourceId: Type.String({ minLength: 1, maxLength: 256 }),
          namespace: Type.Union([
            Type.Literal('builtin'),
            Type.Literal('global'),
            Type.Literal('project'),
          ]),
          kind: Type.Union([
            Type.Literal('skill'),
            Type.Literal('prompt'),
            Type.Literal('extension'),
          ]),
          source: Type.String({ minLength: 1, maxLength: 1024 }),
          state: Type.Union([
            Type.Literal('invalid'),
            Type.Literal('restricted'),
            Type.Literal('eligible'),
          ]),
          reason: Type.Optional(
            Type.Union([
              Type.Literal('project_untrusted'),
              Type.Literal('activation_required'),
              Type.Literal('resource_collision'),
              Type.Literal('reserved_resource_id'),
              Type.Literal('resource_shape_invalid'),
              Type.Literal('resource_symlink_forbidden'),
              Type.Literal('resource_integrity_invalid'),
            ]),
          ),
          contentSha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
          action: Type.Union([
            Type.Literal('none'),
            Type.Literal('trust_project'),
            Type.Literal('activate_resource'),
            Type.Literal('rename_resource'),
            Type.Literal('fix_resource'),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16_384 },
    ),
  },
  { additionalProperties: false },
)

const PackageProjectionSchema = Type.Object(
  {
    namespace: Type.Union([Type.Literal('global'), Type.Literal('project')]),
    packageId: Type.String({
      pattern: '^(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]{0,127}$',
    }),
    source: Type.String({ minLength: 1, maxLength: 4096 }),
    contentSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    license: Type.String({ minLength: 1, maxLength: 256 }),
    capabilities: Type.Array(Type.Union([Type.Literal('executable'), Type.Literal('network')]), {
      maxItems: 2,
      uniqueItems: true,
    }),
    enabled: Type.Boolean(),
    status: Type.Union([
      Type.Literal('disabled'),
      Type.Literal('source_unavailable'),
      Type.Literal('integrity_invalid'),
      Type.Literal('activation_required'),
      Type.Literal('eligible'),
      Type.Literal('tool_alias_collision'),
    ]),
    resourceCount: Type.Integer({ minimum: 1, maximum: 256 }),
  },
  { additionalProperties: false },
)

export const PackageCatalogProjectionSchema = Type.Object(
  {
    globalGeneration: Type.Integer({ minimum: 1 }),
    projectGeneration: Type.Optional(Type.Integer({ minimum: 1 })),
    packages: Type.Array(PackageProjectionSchema, { maxItems: 4096 }),
  },
  { additionalProperties: false },
)

const McpToolProjectionSchema = Type.Object(
  {
    canonicalToolId: Type.String({
      pattern: '^mcp:[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$',
    }),
    toolName: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' }),
    modelAlias: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' }),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
)

const McpServerProjectionSchema = Type.Object(
  {
    namespace: Type.Union([Type.Literal('global'), Type.Literal('project')]),
    serverId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
    contentSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    state: Type.Union([
      Type.Literal('disabled'),
      Type.Literal('activation_required'),
      Type.Literal('connecting'),
      Type.Literal('ready'),
      Type.Literal('degraded'),
      Type.Literal('failed'),
      Type.Literal('needs_credentials'),
      Type.Literal('auth_required'),
      Type.Literal('server_id_collision'),
      Type.Literal('tool_alias_collision'),
    ]),
    tools: Type.Array(McpToolProjectionSchema, { maxItems: 512 }),
    action: Type.Union([
      Type.Literal('none'),
      Type.Literal('activate'),
      Type.Literal('enable'),
      Type.Literal('disable'),
      Type.Literal('retry'),
      Type.Literal('configure_credentials'),
      Type.Literal('login'),
      Type.Literal('fix_collision'),
    ]),
  },
  { additionalProperties: false },
)

export const McpCatalogProjectionSchema = Type.Object(
  {
    projectState: Type.Union([
      Type.Literal('none'),
      Type.Literal('untrusted'),
      Type.Literal('trusted'),
      Type.Literal('invalid'),
    ]),
    servers: Type.Array(McpServerProjectionSchema, { maxItems: 512 }),
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
export type OpenAICompatibleProviderConfiguration = Static<
  typeof OpenAICompatibleProviderConfigurationSchema
>
export type ModelProviderState = Static<typeof ModelProviderStateSchema>
export type ModelDescriptor = Static<typeof ModelDescriptorSchema>
export type ModelProviderProjection = Static<typeof ModelProviderProjectionSchema>
export type ModelCatalogProjection = Static<typeof ModelCatalogProjectionSchema>
export type ResourceCatalogProjection = Static<typeof ResourceCatalogProjectionSchema>
export type PackageCatalogProjection = Static<typeof PackageCatalogProjectionSchema>
export type McpCatalogProjection = Static<typeof McpCatalogProjectionSchema>
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

export function parseResourceCatalogProjection(value: unknown): ResourceCatalogProjection {
  if (Value.Check(ResourceCatalogProjectionSchema, value)) return value
  throw new Error('resource_catalog_invalid')
}

export function parsePackageCatalogProjection(value: unknown): PackageCatalogProjection {
  if (Value.Check(PackageCatalogProjectionSchema, value)) return value
  throw new Error('package_catalog_invalid')
}

export function parseMcpCatalogProjection(value: unknown): McpCatalogProjection {
  if (Value.Check(McpCatalogProjectionSchema, value)) return value
  throw new Error('mcp_catalog_invalid')
}

export function parseOpenAICompatibleProviderConfiguration(
  value: unknown,
): OpenAICompatibleProviderConfiguration {
  if (Value.Check(OpenAICompatibleProviderConfigurationSchema, value)) return value
  throw new Error('model_provider_configuration_invalid')
}

export function parseOAuthOperationProjection(value: unknown): OAuthOperationProjection {
  if (Value.Check(OAuthOperationProjectionSchema, value)) return value
  throw new Error('oauth_operation_projection_invalid')
}
