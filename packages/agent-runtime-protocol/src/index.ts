import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const PROTOCOL_VERSION = '1' as const
export const RUNTIME_VERSION = '1.0.0' as const
export const SCHEMA_VERSION = '1' as const
export const RUNTIME_NAME = 'open-genoffice-pi-agent-runtime' as const
export const NODE_VERSION = '22.19.0' as const
export const PI_VERSION = '0.84.0' as const

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })

const BootstrapSchema = Type.Object(
  {
    kind: Type.Literal('bootstrap'),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    runtimeVersion: Type.Literal(RUNTIME_VERSION),
    schemaVersion: Type.Literal(SCHEMA_VERSION),
    parentPid: Type.Integer({ minimum: 1 }),
    endpoint: Type.String({ minLength: 1 }),
    token: Sha256Schema,
  },
  { additionalProperties: false },
)

const RuntimeBundleManifestSchema = Type.Object(
  {
    manifestVersion: Type.Literal(1),
    runtimeName: Type.Literal(RUNTIME_NAME),
    runtimeVersion: Type.Literal(RUNTIME_VERSION),
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    nodeVersion: Type.Literal(NODE_VERSION),
    piVersion: Type.Literal(PI_VERSION),
    platform: Type.Union([Type.Literal('darwin'), Type.Literal('win32'), Type.Literal('linux')]),
    arch: Type.Union([Type.Literal('arm64'), Type.Literal('x64')]),
    libc: Type.Optional(Type.Literal('glibc')),
    executable: Type.String({ minLength: 1 }),
    entry: Type.String({ minLength: 1 }),
    treeSha256: Sha256Schema,
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          sha256: Sha256Schema,
          size: Type.Integer({ minimum: 0 }),
          mode: Type.Optional(Type.String({ pattern: '^0[0-7]{3}$' })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    noticesSha256: Sha256Schema,
    generatedFromLockSha256: Sha256Schema,
  },
  { additionalProperties: false },
)

export type BootstrapRecord = Static<typeof BootstrapSchema>
export type RuntimeBundleManifest = Static<typeof RuntimeBundleManifestSchema>

export function parseBootstrapLine(line: string): BootstrapRecord {
  try {
    const value: unknown = JSON.parse(line)
    if (Value.Check(BootstrapSchema, value)) return value
  } catch {
    // All bootstrap parse failures intentionally share a secret-free error.
  }
  throw new Error('invalid_bootstrap')
}

export function parseRuntimeBundleManifest(value: unknown): RuntimeBundleManifest {
  if (Value.Check(RuntimeBundleManifestSchema, value)) return value
  throw new Error('runtime_bundle_invalid')
}
