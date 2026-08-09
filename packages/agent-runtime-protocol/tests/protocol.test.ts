import { describe, expect, it } from 'vitest'
import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  MAX_FRAME_BYTES,
  NODE_VERSION,
  PI_VERSION,
  PROTOCOL_VERSION,
  ProtocolEnvelopeSchema,
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  createNdjsonFrameDecoder,
  parseBootstrapLine,
  parseProtocolFrame,
  parseRuntimeBundleManifest,
  parseRuntimeHealthProjection,
} from '../src'

const token = 'a'.repeat(64)

describe('runtime bootstrap contract', () => {
  it('accepts the frozen inherited-stdin bootstrap record', () => {
    expect(
      parseBootstrapLine(
        JSON.stringify({
          kind: 'bootstrap',
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          schemaVersion: SCHEMA_VERSION,
          parentPid: 4242,
          endpoint: '/tmp/open-genoffice/runtime.sock',
          token,
        }),
      ),
    ).toEqual({
      kind: 'bootstrap',
      protocolVersion: '1',
      runtimeVersion: '1.0.0',
      schemaVersion: '1',
      parentPid: 4242,
      endpoint: '/tmp/open-genoffice/runtime.sock',
      token,
    })
  })

  it.each([
    ['unknown field', { extra: true }],
    ['wrong protocol', { protocolVersion: '0' }],
    ['short token', { token: 'secret' }],
    ['invalid parent pid', { parentPid: 0 }],
  ])('rejects %s without echoing the bootstrap token', (_label, override) => {
    const record = {
      kind: 'bootstrap',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
      parentPid: 4242,
      endpoint: '/tmp/open-genoffice/runtime.sock',
      token,
      ...override,
    }
    expect(() => parseBootstrapLine(JSON.stringify(record))).toThrowError('invalid_bootstrap')
    try {
      parseBootstrapLine(JSON.stringify(record))
    } catch (error) {
      expect(String(error)).not.toContain(token)
    }
  })

  it('rejects malformed JSON with the same redacted error', () => {
    expect(() => parseBootstrapLine('{"token":"top-secret"')).toThrowError('invalid_bootstrap')
  })
})

describe('runtime bundle manifest contract', () => {
  const manifest = {
    manifestVersion: 1,
    runtimeName: RUNTIME_NAME,
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: NODE_VERSION,
    piVersion: PI_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    executable: 'node/open-genoffice-pi-agent-runtime',
    entry: 'app/main.mjs',
    treeSha256: 'b'.repeat(64),
    files: [
      {
        path: 'app/main.mjs',
        sha256: 'c'.repeat(64),
        size: 128,
        mode: '0644',
      },
    ],
    noticesSha256: 'd'.repeat(64),
    generatedFromLockSha256: 'e'.repeat(64),
  }

  it('accepts the frozen current-platform manifest shape', () => {
    expect(parseRuntimeBundleManifest(manifest)).toEqual(manifest)
  })

  it.each([
    ['runtime name', { runtimeName: 'node' }],
    ['Node version', { nodeVersion: '22.20.0' }],
    ['Pi version', { piVersion: '0.84.1' }],
    ['unknown field', { unexpected: true }],
  ])('rejects a mismatched %s', (_label, override) => {
    expect(() => parseRuntimeBundleManifest({ ...manifest, ...override })).toThrowError(
      'runtime_bundle_invalid',
    )
  })
})

describe('renderer-safe Runtime health projection', () => {
  it('accepts only the versioned projection without process or transport details', () => {
    const health = {
      state: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: SCHEMA_VERSION,
    }
    expect(parseRuntimeHealthProjection(health)).toEqual(health)
    expect(() => parseRuntimeHealthProjection({ ...health, pid: 42 })).toThrowError(
      'runtime_health_invalid',
    )
    expect(() => parseRuntimeHealthProjection({ ...health, state: 'backoff' })).toThrowError(
      'runtime_health_invalid',
    )
    expect(
      parseRuntimeHealthProjection({
        ...health,
        state: 'unavailable',
        diagnosticCode: 'runtime_bundle_unavailable',
      }),
    ).toMatchObject({ state: 'unavailable' })
  })
})

describe('protocol TypeBox source of truth', () => {
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id: 'request-1',
    method: 'session.prompt',
    correlationId: 'correlation-1',
    params: { operationId: 'operation-1', text: 'synthetic prompt' },
  }

  it('exports JSON schemas and accepts a frozen request vector', () => {
    expect(RequestEnvelopeSchema.anyOf).toHaveLength(3)
    expect(ResponseEnvelopeSchema.anyOf).toHaveLength(2)
    expect(EventEnvelopeSchema.type).toBe('object')
    expect(ProtocolEnvelopeSchema.anyOf).toHaveLength(3)
    expect(ArtifactRefSchema.additionalProperties).toBe(false)
    expect(parseProtocolFrame(JSON.stringify(request))).toEqual(request)
  })

  it('accepts exactly one response outcome and a sequenced event', () => {
    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: 'request-1',
          correlationId: 'correlation-1',
          result: { accepted: true },
        }),
      ),
    ).toMatchObject({ kind: 'response', result: { accepted: true } })

    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          id: 'request-2',
          correlationId: 'correlation-2',
          error: {
            code: 'cursor_expired',
            message: 'cursor is outside the replay window',
            retryable: true,
            correlationId: 'correlation-2',
            details: { resetRequired: true },
          },
        }),
      ),
    ).toMatchObject({ kind: 'response', error: { code: 'cursor_expired' } })

    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'event',
          eventId: 'event-1',
          instanceId: 'instance-1',
          sessionId: 'session-1',
          documentId: 'document-1',
          runId: 'run-1',
          sequence: 1,
          cursor: 'opaque-cursor-1',
          occurredAt: '2026-08-09T00:00:00.000Z',
          type: 'message.delta',
          payload: { text: 'synthetic delta' },
        }),
      ),
    ).toMatchObject({ kind: 'event', sequence: 1 })
  })

  it.each([
    ['unknown envelope field', { ...request, secret: 'must-not-echo' }],
    ['unknown method', { ...request, method: 'runtime.eval' }],
    ['wrong protocol version', { ...request, protocolVersion: '0' }],
    [
      'both response outcomes',
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: 'request-1',
        correlationId: 'correlation-1',
        result: {},
        error: {
          code: 'internal_error',
          message: 'redacted',
          retryable: false,
          correlationId: 'correlation-1',
        },
      },
    ],
    [
      'invalid artifact ref',
      {
        ...request,
        method: 'artifact.register',
        params: {
          artifactId: 'artifact-1',
          mediaType: 'image/png',
          byteLength: 10,
          sha256: 'short',
          path: '/private/user-file.png',
        },
      },
    ],
  ])('rejects %s with a stable redacted error', (_label, value) => {
    expect(() => parseProtocolFrame(JSON.stringify(value))).toThrowError('protocol_frame_invalid')
  })

  it('rejects inline base64 and oversized frames without echoing content', () => {
    const inline = JSON.stringify({
      ...request,
      params: { imageBase64: 'private-image-content' },
    })
    expect(() => parseProtocolFrame(inline)).toThrowError('inline_binary_forbidden')
    expect(() => parseProtocolFrame('x'.repeat(MAX_FRAME_BYTES + 1))).toThrowError(
      'frame_too_large',
    )
  })
})

describe('NDJSON framing', () => {
  const frame = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id: 'request-1',
    method: 'runtime.status',
    correlationId: 'correlation-1',
    params: {},
  })

  it('accepts split chunks, merged frames, and empty lines', () => {
    const decoder = createNdjsonFrameDecoder()
    expect(decoder.push(frame.slice(0, 17))).toEqual([])
    expect(decoder.push(new TextEncoder().encode(`${frame.slice(17)}\n\n${frame}\n`))).toHaveLength(
      2,
    )
    expect(decoder.end()).toEqual([])
  })

  it('rejects an unterminated tail and a pending oversized frame', () => {
    const unterminated = createNdjsonFrameDecoder()
    unterminated.push(frame)
    expect(() => unterminated.end()).toThrowError('unterminated_frame')

    const oversized = createNdjsonFrameDecoder()
    expect(() => oversized.push('x'.repeat(MAX_FRAME_BYTES + 1))).toThrowError('frame_too_large')
  })

  it('rejects invalid and incomplete UTF-8 without echoing bytes', () => {
    expect(() => createNdjsonFrameDecoder().push(Uint8Array.of(0xff))).toThrowError('invalid_utf8')

    const incomplete = createNdjsonFrameDecoder()
    expect(incomplete.push(Uint8Array.of(0xe2))).toEqual([])
    expect(() => incomplete.end()).toThrowError('invalid_utf8')
  })
})

describe('runtime hello authentication envelope', () => {
  it('accepts only the exact token and three-version shape', () => {
    const hello = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id: 'hello-1',
      method: 'runtime.hello',
      correlationId: 'hello-correlation-1',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        runtimeVersion: RUNTIME_VERSION,
        schemaVersion: SCHEMA_VERSION,
        token,
      },
    }
    expect(parseProtocolFrame(JSON.stringify(hello))).toEqual(hello)
    expect(() =>
      parseProtocolFrame(JSON.stringify({ ...hello, params: { ...hello.params, extra: true } })),
    ).toThrowError('protocol_frame_invalid')
    expect(() =>
      parseProtocolFrame(
        JSON.stringify({ ...hello, params: { ...hello.params, runtimeVersion: '1.0.1' } }),
      ),
    ).toThrowError('protocol_frame_invalid')
  })
})
