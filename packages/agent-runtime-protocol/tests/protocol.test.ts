import { describe, expect, it } from 'vitest'
import {
  ArtifactRefSchema,
  CredentialBrokerRequestSchema,
  CredentialManagementRequestSchema,
  EventEnvelopeSchema,
  MAX_FRAME_BYTES,
  ModelCatalogProjectionSchema,
  McpCatalogProjectionSchema,
  ModelManagementRequestSchema,
  ResourceCatalogProjectionSchema,
  PackageCatalogProjectionSchema,
  ResourceManagementRequestSchema,
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
  parseCredentialBrokerGetResult,
  parseCredentialBrokerDeleteReceipt,
  parseCredentialBrokerMetadata,
  parseCredentialBrokerRequest,
  parseCredentialBrokerStatus,
  parseCredentialProviderId,
  parseCredentialManagementRequest,
  parseProviderCredentialStatus,
  parseAgentSessionCommand,
  parseAgentSessionConnectReceipt,
  parseAgentSessionConnectRequest,
  parseEventEnvelope,
  parseModelCatalogProjection,
  parseMcpCatalogProjection,
  parseModelManagementRequest,
  parseResourceCatalogProjection,
  parsePackageCatalogProjection,
  parseResourceManagementRequest,
  parseOpenAICompatibleProviderConfiguration,
  parseOAuthOperationProjection,
  parseOfficeToolInvocation,
  parseOfficeToolReceipt,
  parseProtocolFrame,
  parseRuntimeBundleManifest,
  parseRuntimeHealthProjection,
  parseSessionConnectionReceipt,
  parseSessionAbortReceipt,
  parseSessionForkReceipt,
  parseSessionNavigateReceipt,
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
      projectRoot: '/trusted/project',
    },
  }

  it('exports JSON schemas and accepts a frozen request vector', () => {
    expect(RequestEnvelopeSchema.anyOf).toHaveLength(46)
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
      'session.fork',
      {
        operationId: '44444444-4444-4444-8444-444444444444',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      },
    ],
    [
      'session.navigate',
      {
        operationId: '55555555-5555-4555-8555-555555555555',
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        targetEntryId: 'entry-1',
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

    for (const code of ['session_in_use', 'session_lease_invalid', 'session_lease_lost']) {
      expect(
        parseProtocolFrame(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            kind: 'response',
            id: `request-${code}`,
            correlationId: `correlation-${code}`,
            error: {
              code,
              message: code,
              retryable: false,
              correlationId: `correlation-${code}`,
            },
          }),
        ),
      ).toMatchObject({ kind: 'response', error: { code } })
    }

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

  it('validates fork and navigate receipts with branch snapshots', () => {
    const branch = {
      activeLeafId: 'entry-2',
      nodes: [
        { entryId: 'entry-1', parentEntryId: null, kind: 'message' },
        { entryId: 'entry-2', parentEntryId: 'entry-1', kind: 'custom' },
      ],
    }
    const parentSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const branchSnapshot = {
      sessionId,
      documentId,
      messages: [],
      branch,
      lastSequence: 2,
      cursor: 'c2',
    }
    expect(
      parseSessionForkReceipt({
        sessionId,
        parentSessionId,
        documentId,
        snapshot: {
          ...branchSnapshot,
          branch: { ...branch, parentSessionId },
        },
        cursor: 'c2',
      }),
    ).toMatchObject({ sessionId, snapshot: { branch } })
    expect(
      parseSessionNavigateReceipt({
        sessionId,
        documentId,
        activeLeafId: 'entry-2',
        snapshot: branchSnapshot,
        cursor: 'c2',
      }),
    ).toMatchObject({ activeLeafId: 'entry-2' })
    expect(() =>
      parseSessionForkReceipt({
        sessionId,
        parentSessionId: documentId,
        documentId,
        snapshot: { ...branchSnapshot, branch: { ...branch, secret: true } },
        cursor: 'c2',
      }),
    ).toThrowError('session_fork_receipt_invalid')
    expect(() =>
      parseSessionNavigateReceipt({
        sessionId,
        documentId,
        activeLeafId: 'other-entry',
        snapshot: branchSnapshot,
        cursor: 'c2',
      }),
    ).toThrowError('session_navigate_receipt_invalid')
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

describe('Runtime to Electron credential broker contract', () => {
  const metadata = {
    credentialId: '11111111-1111-4111-8111-111111111111',
    slot: 'model/openai/default',
    providerId: 'openai',
    kind: 'api_key',
    generation: 1,
    status: 'available',
  } as const

  const requests = [
    {
      method: 'credential.put',
      params: {
        slot: metadata.slot,
        providerId: metadata.providerId,
        kind: metadata.kind,
        expectedGeneration: 0,
        secretPayload: '{"type":"api_key","key":"trusted-socket-canary"}',
      },
    },
    { method: 'credential.get', params: { slot: metadata.slot } },
    { method: 'credential.status', params: { slot: metadata.slot } },
    {
      method: 'credential.rotate',
      params: {
        slot: metadata.slot,
        providerId: metadata.providerId,
        kind: 'oauth',
        expectedGeneration: 1,
        secretPayload: '{"type":"oauth","access":"a","refresh":"r","expires":1}',
      },
    },
    {
      method: 'credential.delete',
      params: { slot: metadata.slot, expectedGeneration: 1 },
    },
  ] as const

  it('accepts only the five exact trusted credential methods and parses secret-bearing results', () => {
    expect(CredentialBrokerRequestSchema.anyOf).toHaveLength(5)
    for (const [index, request] of requests.entries()) {
      const frame = {
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: `credential-${index}`,
        correlationId: `credential-correlation-${index}`,
        ...request,
      }
      expect(parseCredentialBrokerRequest(frame)).toEqual(frame)
      expect(parseProtocolFrame(JSON.stringify(frame))).toEqual(frame)
    }
    expect(parseCredentialBrokerMetadata(metadata)).toEqual(metadata)
    expect(
      parseCredentialBrokerGetResult({
        metadata,
        secretPayload: '{"type":"api_key","key":"trusted-socket-canary"}',
      }),
    ).toMatchObject({ metadata })
    expect(parseCredentialBrokerGetResult(null)).toBeUndefined()
    expect(parseCredentialBrokerStatus(metadata)).toEqual(metadata)
    expect(parseCredentialBrokerStatus({ slot: metadata.slot, status: 'missing' })).toEqual({
      slot: metadata.slot,
      status: 'missing',
    })
    expect(
      parseCredentialBrokerDeleteReceipt({
        slot: metadata.slot,
        generation: 1,
        status: 'deleted',
      }),
    ).toEqual({ slot: metadata.slot, generation: 1, status: 'deleted' })
  })

  it.each([
    ['unknown method', { ...requests[1], method: 'credential.list' }],
    ['unknown param', { ...requests[1], params: { ...requests[1].params, secret: true } }],
    [
      'provider-slot mismatch',
      { ...requests[0], params: { ...requests[0].params, providerId: '../escape' } },
    ],
    [
      'missing generation',
      { ...requests[3], params: { ...requests[3].params, expectedGeneration: undefined } },
    ],
  ])('rejects %s with a stable credential request error', (_label, request) => {
    expect(() =>
      parseCredentialBrokerRequest({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'request',
        id: 'credential-invalid',
        correlationId: 'credential-invalid-correlation',
        ...request,
      }),
    ).toThrowError('credential_broker_request_invalid')
  })

  it('rejects secret-bearing result shape drift without echoing its contents', () => {
    expect(() =>
      parseCredentialBrokerGetResult({ metadata, secretPayload: 'canary', extra: true }),
    ).toThrowError('credential_broker_get_result_invalid')
    expect(() =>
      parseCredentialBrokerMetadata({ ...metadata, secretPayload: 'canary' }),
    ).toThrowError('credential_broker_metadata_invalid')
    expect(() =>
      parseCredentialBrokerStatus({ slot: metadata.slot, status: 'plaintext' }),
    ).toThrowError('credential_broker_status_invalid')
    expect(() =>
      parseCredentialBrokerDeleteReceipt({ slot: metadata.slot, status: 'deleted' }),
    ).toThrowError('credential_broker_delete_receipt_invalid')
  })
})

describe('Electron to Runtime credential management contract', () => {
  const requestBase = {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id: 'credential-management-1',
    correlationId: 'credential-management-correlation-1',
  } as const

  const requests = [
    {
      ...requestBase,
      method: 'credential.put',
      params: {
        providerId: 'openai',
        persistence: 'persistent',
        secretPayload: '{"type":"api_key","key":"trusted-management-canary"}',
      },
    },
    {
      ...requestBase,
      id: 'credential-management-2',
      method: 'credential.status',
      params: { providerId: 'openai' },
    },
    {
      ...requestBase,
      id: 'credential-management-3',
      method: 'credential.delete',
      params: { providerId: 'openai' },
    },
  ] as const

  it('uses only the existing credential methods with direction-specific exact params', () => {
    expect(CredentialManagementRequestSchema.anyOf).toHaveLength(3)
    for (const request of requests) {
      expect(parseCredentialManagementRequest(request)).toEqual(request)
      expect(parseProtocolFrame(JSON.stringify(request))).toEqual(request)
      expect(() => parseCredentialBrokerRequest(request)).toThrowError(
        'credential_broker_request_invalid',
      )
    }
  })

  it('accepts only redacted provider status projections', () => {
    const available = {
      providerId: 'openai',
      status: 'available',
      persistence: 'memory_only',
      kind: 'api_key',
    } as const
    expect(parseProviderCredentialStatus(available)).toEqual(available)
    expect(
      parseProviderCredentialStatus({
        providerId: 'openai',
        status: 'secure_storage_unavailable',
        persistence: 'persistent',
      }),
    ).toMatchObject({ status: 'secure_storage_unavailable' })
    expect(() =>
      parseProviderCredentialStatus({ ...available, secretPayload: 'must-not-cross' }),
    ).toThrowError('provider_credential_status_invalid')
    expect(parseCredentialProviderId('openai')).toBe('openai')
    expect(() => parseCredentialProviderId('../other-client')).toThrowError('provider_id_invalid')
  })

  it.each([
    ['unknown field', { ...requests[1], params: { providerId: 'openai', slot: 'secret' } }],
    ['unsafe provider id', { ...requests[1], params: { providerId: '../other-client' } }],
    [
      'implicit persistence fallback',
      {
        ...requests[0],
        params: {
          providerId: 'openai',
          secretPayload: requests[0].params.secretPayload,
        },
      },
    ],
  ])('rejects %s', (_label, request) => {
    expect(() => parseCredentialManagementRequest(request)).toThrowError(
      'credential_management_request_invalid',
    )
  })
})

describe('renderer-safe model catalog projection', () => {
  const catalog = {
    providers: [
      {
        providerId: 'openai-codex',
        name: 'OpenAI Codex',
        state: 'ready',
        authMethods: ['oauth'],
        models: [
          {
            providerId: 'openai-codex',
            modelId: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: ['text-input', 'image-input', 'tool-use', 'reasoning'],
          },
        ],
      },
      {
        providerId: 'local-openai',
        name: 'Local OpenAI-compatible',
        state: 'needs_credentials',
        authMethods: ['api_key'],
        models: [],
        errorCode: 'provider_auth_required',
      },
    ],
    selections: {
      conversation: {
        providerId: 'openai-codex',
        modelId: 'gpt-5.4',
        capabilities: ['text-input', 'image-input', 'tool-use', 'reasoning'],
      },
    },
  } as const

  it('accepts only provider/model/capability/health metadata', () => {
    expect(parseModelCatalogProjection(catalog)).toEqual(catalog)
    expect(ModelCatalogProjectionSchema).toBeDefined()
    expect(JSON.stringify(catalog)).not.toContain('secret-model-canary')
  })

  it.each([
    ['secret', { ...catalog, apiKey: 'secret-model-canary' }],
    [
      'endpoint',
      {
        ...catalog,
        providers: [{ ...catalog.providers[0], baseUrl: 'https://private.invalid/v1' }],
      },
    ],
    [
      'unknown capability',
      {
        ...catalog,
        providers: [
          {
            ...catalog.providers[0],
            models: [{ ...catalog.providers[0].models[0], capabilities: ['shell-execution'] }],
          },
        ],
      },
    ],
    [
      'raw provider error',
      {
        ...catalog,
        providers: [{ ...catalog.providers[1], error: 'upstream response body' }],
      },
    ],
  ])('rejects %s fields before they cross into a renderer', (_label, value) => {
    expect(() => parseModelCatalogProjection(value)).toThrowError('model_catalog_invalid')
  })

  it('accepts only redacted OAuth operation state', () => {
    const projection = {
      operationId,
      providerId: 'openai-codex',
      state: 'waiting_for_user',
      interaction: {
        type: 'auth_url',
        url: 'https://auth.openai.com/oauth/authorize?client_id=public&state=opaque',
        messageKey: 'model_auth_open_browser',
      },
    } as const
    expect(parseOAuthOperationProjection(projection)).toEqual(projection)
    expect(() =>
      parseOAuthOperationProjection({ ...projection, accessToken: 'secret-model-canary' }),
    ).toThrowError('oauth_operation_projection_invalid')
    expect(() =>
      parseOAuthOperationProjection({
        ...projection,
        interaction: { ...projection.interaction, message: 'private provider text' },
      }),
    ).toThrowError('oauth_operation_projection_invalid')
  })
})

describe('renderer-safe resource catalog projection', () => {
  const catalog = {
    catalogId: 'a'.repeat(64),
    projectState: 'untrusted',
    resources: [
      {
        resourceKey: 'skill:global/example',
        resourceId: 'example',
        namespace: 'global',
        kind: 'skill',
        source: 'global:skills/example',
        state: 'eligible',
        contentSha256: 'b'.repeat(64),
        action: 'none',
      },
      {
        resourceKey: 'skill:project/project-example',
        resourceId: 'project-example',
        namespace: 'project',
        kind: 'skill',
        source: 'project:skills/project-example',
        state: 'restricted',
        reason: 'project_untrusted',
        action: 'trust_project',
      },
    ],
  } as const

  it('accepts source, hash, state, and repair action without filesystem fields', () => {
    expect(parseResourceCatalogProjection(catalog)).toEqual(catalog)
    expect(ResourceCatalogProjectionSchema).toBeDefined()
  })

  it.each([
    ['path', { ...catalog, resources: [{ ...catalog.resources[0], path: '/private/project' }] }],
    ['body', { ...catalog, resources: [{ ...catalog.resources[0], body: 'secret body' }] }],
    ['secret', { ...catalog, credential: 'secret-resource-canary' }],
    [
      'unknown action',
      { ...catalog, resources: [{ ...catalog.resources[0], action: 'open_arbitrary_path' }] },
    ],
  ])('rejects %s before it crosses into a renderer', (_label, value) => {
    expect(() => parseResourceCatalogProjection(value)).toThrowError('resource_catalog_invalid')
  })

  it('accepts the three authenticated catalog and trust operations', () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id: 'resource-request',
      correlationId: 'resource-correlation',
    } as const
    const requests = [
      { ...base, method: 'resource.catalog', params: {} },
      {
        ...base,
        method: 'project.trust.grant',
        params: { operationId, projectRoot: '/selected/project' },
      },
      {
        ...base,
        method: 'project.trust.revoke',
        params: { operationId, projectRoot: '/selected/project' },
      },
    ]
    expect(ResourceManagementRequestSchema.anyOf).toHaveLength(18)
    for (const request of requests) expect(parseResourceManagementRequest(request)).toEqual(request)
    expect(() =>
      parseResourceManagementRequest({
        ...requests[0],
        params: { projectRoot: '/selected/project', rendererPath: '/forbidden' },
      }),
    ).toThrowError('resource_management_request_invalid')
  })
})

describe('renderer-safe MCP management contract', () => {
  const catalog = {
    projectState: 'trusted',
    servers: [
      {
        namespace: 'global',
        serverId: 'fixture',
        contentSha256: 'a'.repeat(64),
        state: 'ready',
        tools: [
          {
            canonicalToolId: 'mcp:fixture:read_fixture',
            toolName: 'read_fixture',
            modelAlias: 'read_fixture',
            enabled: true,
          },
        ],
        action: 'disable',
      },
    ],
  } as const

  it('accepts only path-free and secret-free server and tool state', () => {
    expect(parseMcpCatalogProjection(catalog)).toEqual(catalog)
    expect(McpCatalogProjectionSchema).toBeDefined()
    for (const unsafe of [
      { command: process.execPath },
      { args: ['server.mjs'] },
      { credentialRef: { slot: 'model/mcp/default' } },
      { environment: { TOKEN: 'canary' } },
      { pid: 1234 },
    ]) {
      expect(() =>
        parseMcpCatalogProjection({
          ...catalog,
          servers: [{ ...catalog.servers[0], ...unsafe }],
        }),
      ).toThrowError('mcp_catalog_invalid')
    }
  })

  it('accepts exact catalog, lifecycle and tool toggle operations', () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id: 'mcp-request',
      correlationId: 'mcp-correlation',
    } as const
    const mutation = {
      operationId,
      namespace: 'project',
      projectRoot: '/selected/project',
      serverId: 'fixture',
    } as const
    const requests = [
      { ...base, method: 'mcp.catalog', params: { projectRoot: '/selected/project' } },
      ...(['mcp.activate', 'mcp.enable', 'mcp.disable', 'mcp.retry'] as const).map((method) => ({
        ...base,
        method,
        params: mutation,
      })),
      ...(['mcp.tool.enable', 'mcp.tool.disable'] as const).map((method) => ({
        ...base,
        method,
        params: { ...mutation, toolName: 'read_fixture' },
      })),
    ]
    for (const request of requests) expect(parseResourceManagementRequest(request)).toEqual(request)
    expect(() =>
      parseResourceManagementRequest({
        ...requests[0],
        params: { projectRoot: '/selected/project', command: '/bin/secret' },
      }),
    ).toThrowError('resource_management_request_invalid')
  })
})

describe('renderer-safe Package management contract', () => {
  const catalog = {
    globalGeneration: 4,
    projectGeneration: 2,
    packages: [
      {
        namespace: 'global',
        packageId: 'safe-extension',
        source: 'npm:safe-extension@1.2.3',
        contentSha256: 'a'.repeat(64),
        license: 'MIT',
        capabilities: ['executable'],
        enabled: true,
        status: 'eligible',
        resourceCount: 1,
      },
      {
        namespace: 'project',
        packageId: 'colliding-extension',
        source: `git:https://example.com/owner/repo.git#${'b'.repeat(40)}`,
        contentSha256: 'c'.repeat(64),
        license: 'Apache-2.0',
        capabilities: ['executable', 'network'],
        enabled: true,
        status: 'tool_alias_collision',
        resourceCount: 2,
      },
    ],
  } as const

  it('accepts immutable Package metadata without paths or executable bodies', () => {
    expect(parsePackageCatalogProjection(catalog)).toEqual(catalog)
    expect(PackageCatalogProjectionSchema).toBeDefined()
    expect(() =>
      parsePackageCatalogProjection({
        ...catalog,
        packages: [{ ...catalog.packages[0], path: '/private/package-source' }],
      }),
    ).toThrowError('package_catalog_invalid')
    expect(() =>
      parsePackageCatalogProjection({
        ...catalog,
        packages: [{ ...catalog.packages[0], body: 'export default secret' }],
      }),
    ).toThrowError('package_catalog_invalid')
  })

  it('accepts only exact authenticated Package operations', () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'request',
      id: 'package-request',
      correlationId: 'package-correlation',
    } as const
    const scope = { namespace: 'project', projectRoot: '/selected/project' } as const
    const requests = [
      { ...base, method: 'package.catalog', params: scope },
      {
        ...base,
        method: 'package.install.local',
        params: {
          ...scope,
          operationId,
          packageId: 'local-extension',
          localPath: '/selected/package',
        },
      },
      {
        ...base,
        method: 'package.install.npm',
        params: {
          namespace: 'global',
          operationId,
          packageId: 'npm-extension',
          name: '@scope/npm-extension',
          version: '1.2.3',
          expectedPreviousContentSha256: 'a'.repeat(64),
        },
      },
      {
        ...base,
        method: 'package.install.git',
        params: {
          namespace: 'global',
          operationId,
          packageId: 'git-extension',
          url: 'ssh://git@example.com/owner/repo.git',
          commit: 'b'.repeat(40),
        },
      },
      ...(['activate', 'enable', 'disable', 'uninstall'] as const).map((operation) => ({
        ...base,
        method: `package.${operation}`,
        params: { namespace: 'global', operationId, packageId: 'safe-extension' },
      })),
    ]
    expect(ResourceManagementRequestSchema.anyOf).toHaveLength(18)
    for (const request of requests) expect(parseResourceManagementRequest(request)).toEqual(request)
    for (const request of [
      { ...requests[2], params: { ...requests[2]!.params, version: '^1.2.3' } },
      { ...requests[3], params: { ...requests[3]!.params, commit: 'main' } },
      { ...requests[1], params: { ...requests[1]!.params, rendererPath: '/forbidden' } },
    ]) {
      expect(() => parseResourceManagementRequest(request)).toThrowError(
        'resource_management_request_invalid',
      )
    }
  })

  it('accepts stable Package errors without exposing source details', () => {
    const value = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: 'package-response',
      correlationId: 'package-correlation',
      error: {
        code: 'package_integrity_invalid',
        message: 'package_integrity_invalid',
        retryable: false,
        correlationId: 'package-correlation',
      },
    }
    expect(parseProtocolFrame(JSON.stringify(value))).toEqual(value)
    expect(() =>
      parseProtocolFrame(
        JSON.stringify({
          ...value,
          error: { ...value.error, localPath: '/private/package-source' },
        }),
      ),
    ).toThrowError('protocol_frame_invalid')
  })
})

describe('model management Runtime contract', () => {
  const envelope = (method: string, params: unknown) => ({
    protocolVersion: PROTOCOL_VERSION,
    kind: 'request',
    id: `request-${method}`,
    method,
    correlationId: `correlation-${method}`,
    params,
  })

  const requests = [
    envelope('model.catalog', {}),
    envelope('model.select', {
      role: 'conversation',
      providerId: 'openai',
      modelId: 'gpt-5.4',
    }),
    envelope('model.provider.configure', {
      providerId: 'local-openai',
      name: 'Local OpenAI',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'Qwen Test',
          capabilities: ['text-input', 'tool-use'],
          contextWindow: 32_768,
          maxTokens: 4_096,
        },
      ],
    }),
    envelope('model.oauth.start', { operationId, providerId: 'openai-codex' }),
    envelope('model.oauth.status', { operationId }),
    envelope('model.oauth.respond', { operationId, value: 'write-only-response' }),
    envelope('model.oauth.cancel', { operationId }),
    envelope('model.logout', { providerId: 'openai-codex' }),
  ]

  it('validates the renderer-safe Provider configuration independently', () => {
    const configuration = requests[2]!.params
    expect(parseOpenAICompatibleProviderConfiguration(configuration)).toEqual(configuration)
    expect(() =>
      parseOpenAICompatibleProviderConfiguration({
        ...(configuration as object),
        apiKey: 'secret-model-canary',
      }),
    ).toThrowError('model_provider_configuration_invalid')
  })

  it('accepts eight exact model methods without a secret-reading operation', () => {
    expect(ModelManagementRequestSchema.anyOf).toHaveLength(8)
    for (const request of requests) {
      expect(parseModelManagementRequest(request)).toEqual(request)
      expect(parseProtocolFrame(JSON.stringify(request))).toEqual(request)
    }
    expect(JSON.stringify(ModelManagementRequestSchema)).not.toContain('credential.get')
  })

  it.each([
    ['unknown field', { ...requests[0], params: { secret: true } }],
    [
      'unknown role',
      { ...requests[1], params: { ...(requests[1]!.params as object), role: 'fallback' } },
    ],
    [
      'provider secret',
      {
        ...requests[2],
        params: { ...(requests[2]!.params as object), apiKey: 'secret-model-canary' },
      },
    ],
    [
      'empty provider capability',
      {
        ...requests[2],
        params: {
          ...(requests[2]!.params as { models: object[] }),
          models: [
            {
              ...(requests[2]!.params as { models: object[] }).models[0],
              capabilities: [],
            },
          ],
        },
      },
    ],
    ['invalid provider', { ...requests[3], params: { operationId, providerId: '../escape' } }],
    ['missing response', { ...requests[5], params: { operationId } }],
    ['oversized response', { ...requests[5], params: { operationId, value: 'x'.repeat(16_385) } }],
    ['secret read method', envelope('model.credential.get', { providerId: 'openai' })],
  ])('rejects %s', (_label, request) => {
    expect(() => parseModelManagementRequest(request)).toThrowError(
      'model_management_request_invalid',
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

describe('Runtime to Electron Office Tool contract', () => {
  const invocation = {
    operationId,
    sessionId,
    documentId,
    runId: 'run-1',
    toolCallId: 'tool-call-1',
    toolId: 'office:docs:insert_content',
    toolOrder: 2,
    actor: { type: 'parent', actorId: 'parent-1', sessionId },
    permissionSnapshot: {
      snapshotId: 'snapshot-1',
      createdForRunId: 'run-1',
      permissionVersion: 'permission-1',
      toolIds: ['office:docs:insert_content'],
    },
    input: { text: 'safe input' },
  }

  it('accepts an exact invoke request and renderer-free receipt', () => {
    expect(parseOfficeToolInvocation(invocation)).toEqual(invocation)
    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: 'office-request-1',
          method: 'office.tool.invoke',
          correlationId: 'office-correlation-1',
          params: invocation,
        }),
      ),
    ).toMatchObject({ method: 'office.tool.invoke', params: { toolOrder: 2 } })
    expect(
      parseOfficeToolReceipt({
        operationId,
        toolCallId: 'tool-call-1',
        toolId: 'office:docs:insert_content',
        status: 'completed',
        output: 'inserted',
        mutationOutcome: 'committed',
        provenance: { actorId: 'parent-1', runId: 'run-1', documentId },
      }),
    ).toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
  })

  it.each([
    ['unknown invocation field', { ...invocation, endpoint: '/tmp/runtime.sock' }],
    ['negative order', { ...invocation, toolOrder: -1 }],
    [
      'mismatched actor shape',
      { ...invocation, actor: { type: 'subagent', actorId: 'subagent-1' } },
    ],
    [
      'unknown snapshot field',
      {
        ...invocation,
        permissionSnapshot: { ...invocation.permissionSnapshot, token: 'secret' },
      },
    ],
  ])('rejects %s before Electron dispatch', (_label, value) => {
    expect(() => parseOfficeToolInvocation(value)).toThrowError('office_tool_invocation_invalid')
  })

  it('rejects malformed receipts without echoing executor data', () => {
    expect(() =>
      parseOfficeToolReceipt({
        operationId,
        toolCallId: 'tool-call-1',
        toolId: 'office:docs:insert_content',
        status: 'completed',
        output: 'inserted',
        mutationOutcome: 'maybe',
        provenance: { actorId: 'parent-1', runId: 'run-1', documentId },
      }),
    ).toThrowError('office_tool_receipt_invalid')
  })
})
