import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type ResponseEnvelope } from '@genoffice/agent-runtime-protocol'
import {
  RuntimeCredentialBrokerClient,
  RuntimeCredentialBrokerClientError,
} from '../src/runtime-credential-broker-client'

const metadata = {
  credentialId: '11111111-1111-4111-8111-111111111111',
  slot: 'model/openai/default',
  providerId: 'openai',
  kind: 'api_key' as const,
  generation: 1,
  status: 'available' as const,
}

function harness() {
  const sent: unknown[] = []
  let sequence = 0
  const client = new RuntimeCredentialBrokerClient({
    send: (frame) => sent.push(frame),
    randomUUID: () => {
      sequence += 1
      return `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`
    },
  })
  return { client, sent }
}

function reply(request: { id: string; correlationId: string }, result: unknown): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    result,
  }
}

describe('RuntimeCredentialBrokerClient', () => {
  it('round-trips all five exact methods over Runtime-initiated requests', async () => {
    const { client, sent } = harness()
    const secretPayload = '{"type":"api_key","key":"socket-secret-canary"}'
    const put = client.put({
      slot: metadata.slot,
      providerId: metadata.providerId,
      kind: metadata.kind,
      expectedGeneration: 0,
      secretPayload,
    })
    const putRequest = sent.at(-1) as { id: string; correlationId: string; params: unknown }
    expect(putRequest).toMatchObject({ method: 'credential.put', params: { secretPayload } })
    expect(client.handleResponse(reply(putRequest, metadata))).toBe(true)
    await expect(put).resolves.toEqual(metadata)

    const get = client.get(metadata.slot)
    const getRequest = sent.at(-1) as { id: string; correlationId: string; params: unknown }
    expect(getRequest).toMatchObject({ method: 'credential.get', params: { slot: metadata.slot } })
    client.handleResponse(reply(getRequest, { metadata, secretPayload }))
    await expect(get).resolves.toEqual({ metadata, secretPayload })

    const status = client.status(metadata.slot)
    const statusRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(reply(statusRequest, metadata))
    await expect(status).resolves.toEqual(metadata)

    const rotate = client.rotate({
      slot: metadata.slot,
      providerId: metadata.providerId,
      kind: 'oauth',
      expectedGeneration: 1,
      secretPayload: '{"type":"oauth","access":"a","refresh":"r","expires":1}',
    })
    const rotateRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(reply(rotateRequest, { ...metadata, kind: 'oauth', generation: 2 }))
    await expect(rotate).resolves.toMatchObject({ kind: 'oauth', generation: 2 })

    const remove = client.delete(metadata.slot, 2)
    const deleteRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(
      reply(deleteRequest, { slot: metadata.slot, generation: 2, status: 'deleted' }),
    )
    await expect(remove).resolves.toBeUndefined()
    expect(sent.map((frame) => (frame as { method: string }).method)).toEqual([
      'credential.put',
      'credential.get',
      'credential.status',
      'credential.rotate',
      'credential.delete',
    ])
  })

  it('rejects broker errors, correlation mismatch, malformed results, and closure without secrets', async () => {
    const { client, sent } = harness()
    const status = client.status(metadata.slot)
    const statusRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: statusRequest.id,
      correlationId: statusRequest.correlationId,
      error: {
        code: 'secure_storage_unavailable',
        message: 'must-not-propagate-secret-canary',
        retryable: false,
        correlationId: statusRequest.correlationId,
      },
    })
    await expect(status).rejects.toEqual(
      new RuntimeCredentialBrokerClientError('secure_storage_unavailable'),
    )

    const get = client.get(metadata.slot)
    const getRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(reply({ ...getRequest, correlationId: 'wrong-correlation' }, null))
    await expect(get).rejects.toEqual(
      new RuntimeCredentialBrokerClientError('credential_response_invalid'),
    )

    const put = client.put({
      slot: metadata.slot,
      providerId: metadata.providerId,
      kind: 'api_key',
      expectedGeneration: 0,
      secretPayload: '{"type":"api_key","key":"socket-secret-canary"}',
    })
    const putRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(reply(putRequest, { ...metadata, secretPayload: 'leak' }))
    await expect(put).rejects.toEqual(
      new RuntimeCredentialBrokerClientError('credential_response_invalid'),
    )

    const pending = client.get(metadata.slot)
    client.close('runtime_connection_closed')
    await expect(pending).rejects.toEqual(
      new RuntimeCredentialBrokerClientError('runtime_connection_closed'),
    )
    expect(client.handleResponse(reply({ id: 'unknown', correlationId: 'unknown' }, null))).toBe(
      false,
    )

    const defaultIds = new RuntimeCredentialBrokerClient({ send: () => undefined })
    await expect(defaultIds.get('../invalid-slot')).rejects.toEqual(
      new RuntimeCredentialBrokerClientError('credential_request_invalid'),
    )
  })
})
