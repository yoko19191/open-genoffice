import { describe, expect, it, vi } from 'vitest'
import {
  isSheetsOfficeToolRequest,
  isSheetsOfficeToolResponse,
  type SheetsOfficeToolRequest,
} from '../src/shared/sheets-office-tools'
import { SheetsOfficeToolRendererClient } from '../src/main/agent-tools/renderer-client'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('Sheets Office Tool narrow transport', () => {
  it('accepts exact request shapes and rejects paths, URLs, unknown fields, and malformed images', () => {
    const requests: SheetsOfficeToolRequest[] = [
      { requestId: 'context', kind: 'context', documentId },
      { requestId: 'snapshot', kind: 'capture_snapshot', documentId },
      { requestId: 'abort', kind: 'abort', operationId: 'operation-1', documentId },
      {
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: { token },
      },
      {
        requestId: 'execute',
        kind: 'execute',
        operationId: 'operation-2',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'image', operations: [] },
        contextVersion: 'sheets-edit-1',
        snapshot: { token },
        images: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            bytes: Uint8Array.from([137, 80, 78, 71]),
            mediaType: 'image/png',
            width: 1,
            height: 1,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    ]
    requests.forEach((request) => expect(isSheetsOfficeToolRequest(request)).toBe(true))

    for (const invalid of [
      null,
      { requestId: 'x', kind: 'context', documentId, extra: true },
      { requestId: 'x', kind: 'restore_snapshot', documentId, snapshot: { token: '/tmp/x' } },
      { ...requests.at(-1), filePath: '/Users/example/image.png' },
      { ...requests.at(-1), url: 'https://example.test/image.png' },
      {
        ...requests.at(-1),
        images: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            bytes: new Uint8Array(),
            mediaType: 'image/png',
            width: 1,
            height: 1,
            sha256: 'a'.repeat(64),
          },
        ],
      },
    ]) {
      expect(isSheetsOfficeToolRequest(invalid)).toBe(false)
    }
  })

  it('accepts exact responses and rejects invalid mutation outcomes', () => {
    for (const response of [
      {
        requestId: 'context',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'sheets-edit-1',
            modelContent: 'Sheet1',
            details: { mode: 'demo', sheetId: 'sheet-1', sheetName: 'Sheet1' },
          },
        },
      },
      { requestId: 'snapshot', ok: true, result: { kind: 'snapshot', snapshot: { token } } },
      {
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'done',
          contextVersionAfter: 'sheets-edit-2',
          mutationOutcome: 'committed',
        },
      },
      { requestId: 'error', ok: false, errorCode: 'tool_failed', mutationOutcome: 'unknown' },
    ]) {
      expect(isSheetsOfficeToolResponse(response)).toBe(true)
    }
    expect(
      isSheetsOfficeToolResponse({
        requestId: 'bad',
        ok: false,
        errorCode: 'tool_failed',
        mutationOutcome: 'committed',
      }),
    ).toBe(false)

    for (const invalid of [
      null,
      { requestId: '', ok: false, errorCode: 'tool_failed' },
      { requestId: 'bad', ok: 'yes', result: {} },
      { requestId: 'bad', ok: true, result: null },
      {
        requestId: 'bad',
        ok: true,
        result: {
          kind: 'context',
          snapshot: { documentId, contextVersion: 'v', modelContent: '' },
        },
      },
      { requestId: 'bad', ok: true, result: { kind: 'snapshot', snapshot: { token: 'path' } } },
      { requestId: 'bad', ok: true, result: { kind: 'restored', contextVersion: 1 } },
      { requestId: 'bad', ok: true, result: { kind: 'aborted', aborted: 'yes' } },
      {
        requestId: 'bad',
        ok: true,
        result: { kind: 'executed', output: 1, contextVersionAfter: 'v' },
      },
    ]) {
      expect(isSheetsOfficeToolResponse(invalid)).toBe(false)
    }
  })

  it('correlates the exact webContents and closes or times out pending requests', async () => {
    const send = vi.fn<(request: SheetsOfficeToolRequest) => void>()
    const client = new SheetsOfficeToolRendererClient({
      webContentsId: 7,
      isDestroyed: () => false,
      send,
      timeoutMs: 5,
    })
    const pending = client.request({ kind: 'context', documentId })
    const request = send.mock.calls[0]![0]
    expect(client.accept(7, { requestId: 'missing', ok: false, errorCode: 'tool_failed' })).toBe(
      false,
    )
    expect(
      client.accept(8, { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }),
    ).toBe(false)
    expect(
      client.accept(7, { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false })

    const closing = client.request({ kind: 'context', documentId })
    client.close()
    await expect(closing).rejects.toThrow('executor_unavailable')
    client.close()
    await expect(client.request({ kind: 'context', documentId })).rejects.toThrow(
      'executor_unavailable',
    )

    const destroyed = new SheetsOfficeToolRendererClient({
      webContentsId: 7,
      isDestroyed: () => true,
      send,
    })
    await expect(destroyed.request({ kind: 'context', documentId })).rejects.toThrow(
      'executor_unavailable',
    )

    vi.useFakeTimers()
    try {
      const timedOut = new SheetsOfficeToolRendererClient({
        webContentsId: 1,
        isDestroyed: () => false,
        send: vi.fn(),
        timeoutMs: 5,
      })
      const timeout = timedOut.request({ kind: 'context', documentId })
      const rejected = expect(timeout).rejects.toThrow('executor_unavailable')
      await vi.advanceTimersByTimeAsync(5)
      await rejected

      const defaultTimeout = new SheetsOfficeToolRendererClient({
        webContentsId: 2,
        isDestroyed: () => false,
        send: vi.fn(),
      })
      const defaultPending = defaultTimeout.request({ kind: 'context', documentId })
      const defaultRejected = expect(defaultPending).rejects.toThrow('executor_unavailable')
      await vi.advanceTimersByTimeAsync(30_000)
      await defaultRejected
    } finally {
      vi.useRealTimers()
    }
  })
})
