import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export const PROTOCOL_VERSION = '1' as const
export const RUNTIME_VERSION = '1.0.0' as const
export const SCHEMA_VERSION = '1' as const
export const RUNTIME_NAME = 'open-genoffice-pi-agent-runtime' as const
export const NODE_VERSION = '22.19.0' as const
export const PI_VERSION = '0.84.0' as const
export const MAX_FRAME_BYTES = 1024 * 1024

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })

const RuntimeMethodSchema = Type.Union([
  Type.Literal('runtime.status'),
  Type.Literal('runtime.shutdown'),
  Type.Literal('session.create'),
  Type.Literal('session.open'),
  Type.Literal('session.close'),
  Type.Literal('session.prompt'),
  Type.Literal('session.steer'),
  Type.Literal('session.followUp'),
  Type.Literal('session.abort'),
  Type.Literal('session.compact'),
  Type.Literal('session.fork'),
  Type.Literal('session.navigate'),
  Type.Literal('session.snapshot'),
  Type.Literal('session.subscribe'),
])

const ElectronMethodSchema = Type.Union([
  Type.Literal('office.tool.invoke'),
  Type.Literal('office.tool.abort'),
  Type.Literal('office.context.read'),
  Type.Literal('permission.request'),
])

const SessionEventTypeSchema = Type.Union([
  Type.Literal('session.opened'),
  Type.Literal('session.closed'),
  Type.Literal('session.snapshot.updated'),
  Type.Literal('run.queued'),
  Type.Literal('run.started'),
  Type.Literal('run.cancelling'),
  Type.Literal('run.completed'),
  Type.Literal('run.failed'),
  Type.Literal('run.aborted'),
  Type.Literal('run.interrupted'),
  Type.Literal('message.started'),
  Type.Literal('message.delta'),
  Type.Literal('message.completed'),
  Type.Literal('thinking.started'),
  Type.Literal('thinking.delta'),
  Type.Literal('thinking.completed'),
  Type.Literal('tool.requested'),
  Type.Literal('tool.started'),
  Type.Literal('tool.progress'),
  Type.Literal('tool.completed'),
  Type.Literal('tool.failed'),
  Type.Literal('tool.aborted'),
  Type.Literal('compaction.started'),
  Type.Literal('compaction.completed'),
  Type.Literal('compaction.failed'),
  Type.Literal('branch.created'),
  Type.Literal('branch.navigated'),
  Type.Literal('permission.requested'),
  Type.Literal('permission.resolved'),
  Type.Literal('runtime.degraded'),
  Type.Literal('diagnostic.available'),
])

const RuntimeErrorCodeSchema = Type.Union([
  Type.Literal('invalid_json'),
  Type.Literal('schema'),
  Type.Literal('invalid_request'),
  Type.Literal('hello_required'),
  Type.Literal('unauthorized'),
  Type.Literal('protocol_mismatch'),
  Type.Literal('runtime_mismatch'),
  Type.Literal('schema_mismatch'),
  Type.Literal('method_not_found'),
  Type.Literal('session_not_found'),
  Type.Literal('document_mismatch'),
  Type.Literal('invalid_state'),
  Type.Literal('duplicate_operation_mismatch'),
  Type.Literal('cursor_expired'),
  Type.Literal('permission_denied'),
  Type.Literal('provider_auth'),
  Type.Literal('rate_limit'),
  Type.Literal('unavailable'),
  Type.Literal('tool_failed'),
  Type.Literal('tool_timeout'),
  Type.Literal('abort_incomplete'),
  Type.Literal('artifact_invalid'),
  Type.Literal('runtime_unavailable'),
  Type.Literal('internal_error'),
])

export const ArtifactRefSchema = Type.Object(
  {
    artifactId: Type.String({ minLength: 1 }),
    mediaType: Type.String({ minLength: 1 }),
    byteLength: Type.Integer({ minimum: 0 }),
    sha256: Sha256Schema,
    displayName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

const ProtocolErrorSchema = Type.Object(
  {
    code: RuntimeErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
    correlationId: Type.String({ minLength: 1 }),
    details: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
    ),
  },
  { additionalProperties: false },
)

const GenericRequestEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Union([RuntimeMethodSchema, ElectronMethodSchema]),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Unknown(),
  },
  { additionalProperties: false },
)

const HelloRequestEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Literal('runtime.hello'),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Object(
      {
        protocolVersion: Type.Literal(PROTOCOL_VERSION),
        runtimeVersion: Type.Literal(RUNTIME_VERSION),
        schemaVersion: Type.Literal(SCHEMA_VERSION),
        token: Sha256Schema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const ArtifactRegisterRequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('request'),
    id: Type.String({ minLength: 1 }),
    method: Type.Literal('artifact.register'),
    correlationId: Type.String({ minLength: 1 }),
    params: Type.Object(
      {
        sessionId: Type.String({ minLength: 1 }),
        documentId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        artifact: ArtifactRefSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const RequestEnvelopeSchema = Type.Union([
  GenericRequestEnvelopeSchema,
  HelloRequestEnvelopeSchema,
  ArtifactRegisterRequestSchema,
])

const ResponseResultEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('response'),
    id: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 }),
    result: Type.Unknown(),
  },
  { additionalProperties: false },
)

const ResponseErrorEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('response'),
    id: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 }),
    error: ProtocolErrorSchema,
  },
  { additionalProperties: false },
)

export const ResponseEnvelopeSchema = Type.Union([
  ResponseResultEnvelopeSchema,
  ResponseErrorEnvelopeSchema,
])

export const EventEnvelopeSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_VERSION),
    kind: Type.Literal('event'),
    eventId: Type.String({ minLength: 1 }),
    instanceId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    documentId: Type.String({ minLength: 1 }),
    runId: Type.Optional(Type.String({ minLength: 1 })),
    sequence: Type.Integer({ minimum: 1 }),
    cursor: Type.String({ minLength: 1 }),
    occurredAt: Type.String({ minLength: 1 }),
    type: SessionEventTypeSchema,
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

export const ProtocolEnvelopeSchema = Type.Union([
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
])

export const OfficeToolCatalogSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sourceBaselineCommit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
    entries: Type.Array(
      Type.Object(
        {
          app: Type.Union([
            Type.Literal('docs'),
            Type.Literal('pdf'),
            Type.Literal('sheets'),
            Type.Literal('slides'),
          ]),
          legacyAlias: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }),
          targetId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
          effect: Type.Union([
            Type.Literal('read'),
            Type.Literal('mutation'),
            Type.Literal('external'),
          ]),
          disposition: Type.Union([
            Type.Literal('office-executor'),
            Type.Literal('platform'),
            Type.Literal('skill'),
            Type.Literal('resource'),
            Type.Literal('retired'),
          ]),
          sourceFile: Type.String({ pattern: '^apps/(pdf|docs|sheets|slides)/src/.+\\.ts$' }),
        },
        { additionalProperties: false },
      ),
      { minItems: 63, maxItems: 63 },
    ),
  },
  { additionalProperties: false },
)

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
export type ArtifactRef = Static<typeof ArtifactRefSchema>
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>
export type EventEnvelope = Static<typeof EventEnvelopeSchema>
export type ProtocolEnvelope = Static<typeof ProtocolEnvelopeSchema>
export type OfficeToolCatalog = Static<typeof OfficeToolCatalogSchema>

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

export function parseOfficeToolCatalog(value: unknown): OfficeToolCatalog {
  if (Value.Check(OfficeToolCatalogSchema, value)) return value
  throw new Error('office_tool_catalog_invalid')
}

export function canonicalizeOfficeToolCatalog(catalog: OfficeToolCatalog): string {
  const entries = [...catalog.entries]
    .sort(
      (left, right) =>
        left.app.localeCompare(right.app) || left.legacyAlias.localeCompare(right.legacyAlias),
    )
    .map((entry) => ({
      app: entry.app,
      legacyAlias: entry.legacyAlias,
      targetId: entry.targetId,
      effect: entry.effect,
      disposition: entry.disposition,
      sourceFile: entry.sourceFile,
    }))
  return `${JSON.stringify(
    {
      schemaVersion: catalog.schemaVersion,
      sourceBaselineCommit: catalog.sourceBaselineCommit,
      entries,
    },
    null,
    2,
  )}\n`
}

export function parseProtocolFrame(frame: string): ProtocolEnvelope {
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame_too_large')
  if (/"[^"\\]*(?:base64|dataUri)[^"\\]*"\s*:/i.test(frame)) {
    throw new Error('inline_binary_forbidden')
  }

  try {
    const value: unknown = JSON.parse(frame)
    if (Value.Check(ProtocolEnvelopeSchema, value)) return value
  } catch {
    // Frame errors never include the untrusted payload.
  }
  throw new Error('protocol_frame_invalid')
}

export function createNdjsonFrameDecoder() {
  const textDecoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''

  function decode(chunk?: Uint8Array): string {
    try {
      return textDecoder.decode(chunk, { stream: chunk !== undefined })
    } catch {
      throw new Error('invalid_utf8')
    }
  }

  return {
    push(chunk: string | Uint8Array): ProtocolEnvelope[] {
      pending += typeof chunk === 'string' ? chunk : decode(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()!
      if (Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame_too_large')
      return lines.filter((line) => line.trim() !== '').map(parseProtocolFrame)
    },
    end(): ProtocolEnvelope[] {
      pending += decode()
      if (pending.trim() !== '') throw new Error('unterminated_frame')
      pending = ''
      return []
    },
  }
}
