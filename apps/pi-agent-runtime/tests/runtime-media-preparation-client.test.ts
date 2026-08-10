import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type RequestEnvelope } from '@genoffice/agent-runtime-protocol'
import {
  RuntimeMediaPreparationClient,
  RuntimeMediaPreparationClientError,
} from '../src/runtime-media-preparation-client'

const operationId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const artifact = {
  artifactId: '33333333-3333-4333-8333-333333333333',
  mediaType: 'video/mp4',
  byteLength: 24,
  sha256: 'a'.repeat(64),
}

function fixture() {
  const requests: RequestEnvelope[] = []
  let next = 0
  const client = new RuntimeMediaPreparationClient({
    send: (request) => requests.push(request),
    randomUUID: () => `${String(++next).padStart(8, '0')}-0000-4000-8000-000000000000`,
  })
  return { client, requests }
}

describe('RuntimeMediaPreparationClient', () => {
  it('correlates a valid prepared media response', async () => {
    const { client, requests } = fixture()
    const pending = client.prepare({
      operationId,
      documentId,
      runId: 'run-1',
      artifact,
      strategy: 'frames',
    })
    const request = requests[0]!
    expect(request).toMatchObject({
      method: 'media.prepare',
      params: { artifact, strategy: 'frames' },
    })
    expect(
      client.handleResponse({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: request.id,
        correlationId: request.correlationId,
        result: {
          operationId,
          inputKind: 'video',
          strategy: 'frames',
          durationMs: 2_000,
          artifacts: [{ ...artifact, mediaType: 'image/png' }],
          timestampsMs: [500],
        },
      }),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ strategy: 'frames' })
  })

  it('sends an exact abort request and accepts its boolean receipt', async () => {
    const { client, requests } = fixture()
    const controller = new AbortController()
    const pending = client.prepare(
      { operationId, documentId, runId: 'run-1', artifact, strategy: 'native' },
      controller.signal,
    )
    controller.abort()
    await Promise.resolve()
    const abort = requests[1]!
    expect(abort).toMatchObject({
      method: 'media.prepare.abort',
      params: { operationId, documentId },
    })
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: abort.id,
      correlationId: abort.correlationId,
      result: { aborted: true },
    })
    const prepare = requests[0]!
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: prepare.id,
      correlationId: prepare.correlationId,
      error: {
        code: 'media_aborted',
        message: 'media_aborted',
        retryable: false,
        correlationId: prepare.correlationId,
      },
    })
    await expect(pending).rejects.toEqual(new RuntimeMediaPreparationClientError('media_aborted'))
  })

  it('rejects invalid input, correlation, receipts, host errors and close', async () => {
    const { client, requests } = fixture()
    await expect(
      client.prepare({ operationId: 'bad', documentId, runId: 'run', artifact, strategy: 'image' }),
    ).rejects.toMatchObject({ code: 'media_preparation_request_invalid' })

    const mismatched = client.prepare({
      operationId,
      documentId,
      runId: 'run',
      artifact,
      strategy: 'native',
    })
    const first = requests.at(-1)!
    expect(
      client.handleResponse({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: first.id,
        correlationId: 'wrong',
        result: {},
      }),
    ).toBe(true)
    await expect(mismatched).rejects.toMatchObject({ code: 'media_preparation_response_invalid' })

    const malformed = client.prepare({
      operationId,
      documentId,
      runId: 'run',
      artifact,
      strategy: 'native',
    })
    const second = requests.at(-1)!
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: second.id,
      correlationId: second.correlationId,
      result: {},
    })
    await expect(malformed).rejects.toMatchObject({ code: 'media_preparation_response_invalid' })

    const closed = client.prepare({
      operationId,
      documentId,
      runId: 'run',
      artifact,
      strategy: 'native',
    })
    client.close('runtime_connection_closed')
    await expect(closed).rejects.toMatchObject({ code: 'runtime_connection_closed' })
    expect(
      client.handleResponse({
        protocolVersion: PROTOCOL_VERSION,
        kind: 'response',
        id: 'missing',
        correlationId: 'missing',
        result: {},
      }),
    ).toBe(false)
  })

  it('uses secure generated identifiers and prepares without an AbortSignal', async () => {
    const requests: RequestEnvelope[] = []
    const client = new RuntimeMediaPreparationClient({ send: (request) => requests.push(request) })
    const pending = client.prepare({
      operationId,
      documentId,
      runId: 'run',
      artifact,
      strategy: 'native',
    })
    const request = requests[0]!
    expect(request.id).toMatch(/^media-prepare-1-[0-9a-f-]{36}$/u)
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      correlationId: request.correlationId,
      result: {
        operationId,
        inputKind: 'video',
        strategy: 'native',
        durationMs: 1_000,
        artifacts: [artifact],
      },
    })
    await expect(pending).resolves.toMatchObject({ strategy: 'native' })
  })

  it('immediately requests abort for a pre-aborted signal and rejects a malformed abort receipt', async () => {
    const { client, requests } = fixture()
    const controller = new AbortController()
    controller.abort()
    const pending = client.prepare(
      { operationId, documentId, runId: 'run', artifact, strategy: 'native' },
      controller.signal,
    )
    const abort = requests[1]!
    expect(abort.method).toBe('media.prepare.abort')
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: abort.id,
      correlationId: abort.correlationId,
      result: { aborted: 'yes' },
    })
    const prepare = requests[0]!
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: prepare.id,
      correlationId: prepare.correlationId,
      error: {
        code: 'media_aborted',
        message: 'media_aborted',
        retryable: false,
        correlationId: prepare.correlationId,
      },
    })
    await expect(pending).rejects.toMatchObject({ code: 'media_aborted' })
  })

  it('rejects an error envelope whose nested correlation differs', async () => {
    const { client, requests } = fixture()
    const pending = client.prepare({
      operationId,
      documentId,
      runId: 'run',
      artifact,
      strategy: 'native',
    })
    const request = requests[0]!
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      correlationId: request.correlationId,
      error: {
        code: 'media_malformed',
        message: 'media_malformed',
        retryable: false,
        correlationId: 'wrong',
      },
    })
    await expect(pending).rejects.toMatchObject({ code: 'media_preparation_response_invalid' })
    client.close('unused')
  })
})
