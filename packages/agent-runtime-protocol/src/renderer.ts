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
