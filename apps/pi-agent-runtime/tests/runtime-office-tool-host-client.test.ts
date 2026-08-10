import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  type OfficeToolInvocation,
  type ResponseEnvelope,
} from '@genoffice/agent-runtime-protocol'
import {
  RuntimeOfficeToolHostClient,
  RuntimeOfficeToolHostClientError,
} from '../src/runtime-office-tool-host-client'

const invocation: OfficeToolInvocation = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  documentId: '33333333-3333-4333-8333-333333333333',
  runId: 'run-1',
  toolCallId: 'tool-call-1',
  toolId: 'office:pdf:read_pages',
  toolOrder: 0,
  actor: {
    type: 'parent',
    actorId: '22222222-2222-4222-8222-222222222222',
    sessionId: '22222222-2222-4222-8222-222222222222',
  },
  permissionSnapshot: {
    snapshotId: 'snapshot-1',
    createdForRunId: 'run-1',
    permissionVersion: 'permission-1',
    toolIds: ['office:pdf:read_pages'],
  },
  input: { start: 1 },
}

function harness() {
  const sent: unknown[] = []
  let sequence = 0
  const client = new RuntimeOfficeToolHostClient({
    send: (frame) => sent.push(frame),
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  })
  return { client, sent }
}

function response(
  request: { id: string; correlationId: string },
  result: unknown,
): ResponseEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'response',
    id: request.id,
    correlationId: request.correlationId,
    result,
  }
}

describe('RuntimeOfficeToolHostClient', () => {
  it('correlates one exact Office invocation and parses its receipt', async () => {
    const { client, sent } = harness()
    const pending = client.invoke(invocation)
    const request = sent[0] as { id: string; correlationId: string }
    expect(request).toMatchObject({
      method: 'office.tool.invoke',
      params: invocation,
    })
    expect(
      client.handleResponse(
        response(request, {
          operationId: invocation.operationId,
          toolCallId: invocation.toolCallId,
          toolId: invocation.toolId,
          status: 'completed',
          output: '[Page 1]\nhello',
          details: { contextVersion: 'context-1' },
          provenance: {
            actorId: invocation.actor.actorId,
            runId: invocation.runId,
            documentId: invocation.documentId,
          },
        }),
      ),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({
      status: 'completed',
      output: expect.any(String),
    })
  })

  it('forwards AbortSignal as a correlated operation abort while preserving the final receipt', async () => {
    const { client, sent } = harness()
    const controller = new AbortController()
    const pending = client.invoke(invocation, controller.signal)
    controller.abort()
    const invokeRequest = sent[0] as { id: string; correlationId: string }
    const abortRequest = sent[1] as {
      id: string
      correlationId: string
      method: string
      params: unknown
    }
    expect(abortRequest).toMatchObject({
      method: 'office.tool.abort',
      params: { operationId: invocation.operationId, documentId: invocation.documentId },
    })
    expect(client.handleResponse(response(abortRequest, { aborted: true }))).toBe(true)
    expect(
      client.handleResponse(
        response(invokeRequest, {
          operationId: invocation.operationId,
          toolCallId: invocation.toolCallId,
          toolId: invocation.toolId,
          status: 'failed',
          output: '',
          errorCode: 'tool_failed',
          provenance: {
            actorId: invocation.actor.actorId,
            runId: invocation.runId,
            documentId: invocation.documentId,
          },
        }),
      ),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('fails a malformed already-aborted acknowledgement closed without losing the tool receipt', async () => {
    const { client, sent } = harness()
    const controller = new AbortController()
    controller.abort()
    const pending = client.invoke(invocation, controller.signal)
    const invokeRequest = sent[0] as { id: string; correlationId: string }
    const abortRequest = sent[1] as { id: string; correlationId: string }
    expect(client.handleResponse(response(abortRequest, { aborted: 'yes' }))).toBe(true)
    expect(
      client.handleResponse(
        response(invokeRequest, {
          operationId: invocation.operationId,
          toolCallId: invocation.toolCallId,
          toolId: invocation.toolId,
          status: 'failed',
          output: '',
          errorCode: 'tool_failed',
          provenance: {
            actorId: invocation.actor.actorId,
            runId: invocation.runId,
            documentId: invocation.documentId,
          },
        }),
      ),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'failed' })
  })

  it('fails closed on errors, correlation drift, malformed receipts, invalid requests and close', async () => {
    const { client, sent } = harness()
    const failed = client.invoke(invocation)
    const failedRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'response',
      id: failedRequest.id,
      correlationId: failedRequest.correlationId,
      error: {
        code: 'executor_unavailable',
        message: 'private renderer error',
        retryable: false,
        correlationId: failedRequest.correlationId,
      },
    })
    await expect(failed).rejects.toEqual(
      new RuntimeOfficeToolHostClientError('executor_unavailable'),
    )

    const drifted = client.invoke({
      ...invocation,
      operationId: '44444444-4444-4444-8444-444444444444',
    })
    const driftedRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(response({ ...driftedRequest, correlationId: 'wrong-correlation' }, null))
    await expect(drifted).rejects.toEqual(
      new RuntimeOfficeToolHostClientError('office_tool_response_invalid'),
    )

    const malformed = client.invoke({
      ...invocation,
      operationId: '55555555-5555-4555-8555-555555555555',
    })
    const malformedRequest = sent.at(-1) as { id: string; correlationId: string }
    client.handleResponse(
      response(malformedRequest, { status: 'completed', output: 'missing ids' }),
    )
    await expect(malformed).rejects.toEqual(
      new RuntimeOfficeToolHostClientError('office_tool_response_invalid'),
    )

    const closing = client.invoke({
      ...invocation,
      operationId: '66666666-6666-4666-8666-666666666666',
    })
    client.close('runtime_connection_closed')
    await expect(closing).rejects.toEqual(
      new RuntimeOfficeToolHostClientError('runtime_connection_closed'),
    )
    expect(client.handleResponse(response({ id: 'unknown', correlationId: 'unknown' }, null))).toBe(
      false,
    )

    await expect(client.invoke({ ...invocation, toolId: 'not-canonical' })).rejects.toEqual(
      new RuntimeOfficeToolHostClientError('office_tool_request_invalid'),
    )
  })
})
