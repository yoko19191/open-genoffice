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
  parseAgentSessionCommand,
  parseAgentSessionConnectReceipt,
  parseAgentSessionConnectRequest,
  parseEventEnvelope,
  parseProtocolFrame,
  parseRuntimeBundleManifest,
  parseRuntimeHealthProjection,
  parseSessionConnectionReceipt,
  parseSessionAbortReceipt,
  parseSessionPromptReceipt,
  parseSessionSnapshot,
  parseSessionSubscriptionReceipt,
} from '../src'

const token = 'a'.repeat(64)
const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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
    params: {
      operationId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'synthetic prompt',
    },
  }

  it('exports JSON schemas and accepts a frozen request vector', () => {
    expect(RequestEnvelopeSchema.anyOf).toHaveLength(9)
    expect(ResponseEnvelopeSchema.anyOf).toHaveLength(2)
    expect(EventEnvelopeSchema.type).toBe('object')
    expect(ProtocolEnvelopeSchema.anyOf).toHaveLength(3)
    expect(ArtifactRefSchema.additionalProperties).toBe(false)
    expect(parseProtocolFrame(JSON.stringify(request))).toEqual(request)
  })

  it.each([
    [
      'session.create',
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      },
    ],
    [
      'session.open',
      {
        operationId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      },
    ],
    [
      'session.abort',
      {
        operationId: '33333333-3333-4333-8333-333333333333',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        runId: 'run-1',
      },
    ],
    [
      'session.snapshot',
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      },
    ],
    [
      'session.subscribe',
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        afterCursor: 'cursor-1',
      },
    ],
  ])('accepts the exact %s request shape', (method, params) => {
    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: `request-${method}`,
          method,
          correlationId: `correlation-${method}`,
          params,
        }),
      ),
    ).toMatchObject({ method, params })
  })

  it.each([
    ['missing operation id', { ...request, params: { ...request.params, operationId: undefined } }],
    [
      'invalid operation id',
      { ...request, params: { ...request.params, operationId: 'operation-1' } },
    ],
    [
      'missing document binding',
      { ...request, params: { ...request.params, documentId: undefined } },
    ],
    ['unknown session param', { ...request, params: { ...request.params, unexpected: true } }],
    [
      'inline artifact path',
      {
        ...request,
        params: {
          ...request.params,
          artifacts: [
            {
              artifactId: 'artifact-1',
              mediaType: 'image/png',
              byteLength: 10,
              sha256: 'a'.repeat(64),
              path: '/private/image.png',
            },
          ],
        },
      },
    ],
  ])('rejects %s for a session command', (_label, value) => {
    expect(() => parseProtocolFrame(JSON.stringify(value))).toThrowError('protocol_frame_invalid')
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
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
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

describe('renderer-safe Session receipts', () => {
  const snapshot = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    messages: [
      { id: 'message-1', role: 'user', text: 'hello' },
      {
        id: 'message-2',
        role: 'toolResult',
        text: 'done',
        toolCallId: 'tool-call-1',
        toolName: 'contract_probe',
        isError: false,
      },
    ],
    activeRun: { runId: 'run-1', state: 'running' },
    lastSequence: 2,
    cursor: 'cursor-2',
  }

  it('parses exact connection, prompt, abort, snapshot, and subscription receipts', () => {
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot)
    expect(
      parseSessionConnectionReceipt({
        sessionId: snapshot.sessionId,
        documentId: snapshot.documentId,
        snapshot,
        cursor: snapshot.cursor,
      }),
    ).toMatchObject({ sessionId: snapshot.sessionId })
    expect(parseSessionPromptReceipt({ runId: 'run-1', acceptedCursor: 'cursor-2' })).toEqual({
      runId: 'run-1',
      acceptedCursor: 'cursor-2',
    })
    expect(
      parseSessionAbortReceipt({
        runId: 'run-1',
        state: 'cancelling',
        acceptedCursor: 'cursor-3',
      }),
    ).toEqual({ runId: 'run-1', state: 'cancelling', acceptedCursor: 'cursor-3' })
    expect(
      parseSessionSubscriptionReceipt({ resetRequired: false, snapshot, events: [] }),
    ).toMatchObject({ resetRequired: false })
  })

  it.each([
    ['snapshot', () => parseSessionSnapshot({ ...snapshot, secret: 'no' })],
    [
      'connection',
      () =>
        parseSessionConnectionReceipt({
          sessionId: 'not-a-uuid',
          documentId: snapshot.documentId,
          snapshot,
          cursor: snapshot.cursor,
        }),
    ],
    ['prompt', () => parseSessionPromptReceipt({ runId: '', acceptedCursor: 'cursor-2' })],
    [
      'abort',
      () =>
        parseSessionAbortReceipt({
          runId: 'run-1',
          state: 'stopped',
          acceptedCursor: 'cursor-3',
        }),
    ],
    ['subscription', () => parseSessionSubscriptionReceipt({ resetRequired: false, snapshot })],
  ])('rejects an invalid %s receipt with a stable error', (_label, parse) => {
    expect(parse).toThrowError(/_invalid$/)
  })
})

describe('narrow renderer Agent Session bridge', () => {
  const snapshot = {
    sessionId,
    documentId,
    messages: [],
    activeRun: { runId: 'run-1', state: 'running' },
    lastSequence: 4,
    cursor: 'cursor-4',
  }

  it('accepts only typed connect, prompt/abort commands, and reconnect receipt vectors', () => {
    expect(
      parseAgentSessionConnectRequest({ documentId, sessionId, afterCursor: 'cursor-3' }),
    ).toMatchObject({ documentId, sessionId })
    expect(
      parseAgentSessionCommand({ type: 'prompt', operationId, sessionId, documentId, text: 'go' }),
    ).toMatchObject({ type: 'prompt', operationId })
    expect(
      parseAgentSessionCommand({
        type: 'abort',
        operationId,
        sessionId,
        documentId,
        runId: 'run-1',
      }),
    ).toMatchObject({ type: 'abort', runId: 'run-1' })
    expect(
      parseAgentSessionConnectReceipt({
        connectionId: operationId,
        sessionId,
        documentId,
        resetRequired: true,
        snapshot,
        events: [],
      }),
    ).toMatchObject({ connectionId: operationId, resetRequired: true })
    expect(
      parseEventEnvelope({
        protocolVersion: '1',
        kind: 'event',
        eventId: 'event-5',
        instanceId: 'instance-1',
        sessionId,
        documentId,
        sequence: 5,
        cursor: 'cursor-5',
        occurredAt: '2026-08-09T13:00:00.000Z',
        type: 'run.completed',
        payload: {},
      }),
    ).toMatchObject({ kind: 'event', sequence: 5 })
  })

  it.each([
    ['connect raw method', () => parseAgentSessionConnectRequest({ documentId, method: 'invoke' })],
    [
      'command raw method',
      () =>
        parseAgentSessionCommand({
          type: 'invoke',
          operationId,
          sessionId,
          documentId,
          text: 'go',
        }),
    ],
    [
      'command extra field',
      () =>
        parseAgentSessionCommand({
          type: 'prompt',
          operationId,
          sessionId,
          documentId,
          text: 'go',
          socket: '/tmp/runtime.sock',
        }),
    ],
    [
      'receipt binding',
      () =>
        parseAgentSessionConnectReceipt({
          connectionId: operationId,
          sessionId,
          documentId: 'other',
          resetRequired: false,
          snapshot,
          events: [],
        }),
    ],
    ['event secret field', () => parseEventEnvelope({ kind: 'event', token: 'secret' })],
  ])('rejects %s with a redacted stable error', (_label, parse) => {
    expect(parse).toThrowError(/(?:agent_session_.*|event_envelope)_invalid/)
  })
})
