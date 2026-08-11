import { describe, expect, it, vi } from 'vitest'
import {
  isSlidesOfficeToolRequest,
  isSlidesOfficeToolResponse,
  type SlidesOfficeToolRequest,
} from '../src/shared/slides-office-tools'
import { SlidesOfficeToolRendererClient } from '../src/main/agent-tools/renderer-client'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('Slides Office Tool narrow transport', () => {
  it('accepts exact request shapes and rejects ambient image capabilities', () => {
    const requests: SlidesOfficeToolRequest[] = [
      { requestId: 'context', kind: 'context', documentId },
      { requestId: 'snapshot', kind: 'capture_snapshot', documentId },
      { requestId: 'abort', kind: 'abort', operationId: 'operation-1', documentId },
      { requestId: 'restore', kind: 'restore_snapshot', documentId, snapshot: { token } },
      {
        requestId: 'execute',
        kind: 'execute',
        operationId: 'operation-2',
        documentId,
        toolId: 'office:slides:insert_image',
        input: { artifactId: '11111111-1111-4111-8111-111111111111' },
        contextVersion: 'slides-edit-1',
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
    requests.forEach((request) => expect(isSlidesOfficeToolRequest(request)).toBe(true))
    for (const invalid of [
      null,
      { requestId: '', kind: 'context', documentId },
      { requestId: 'x', kind: 'context', documentId, extra: true },
      { requestId: 'x', kind: 'abort', operationId: 1, documentId },
      { requestId: 'x', kind: 'restore_snapshot', documentId, snapshot: { token: '/tmp/x' } },
      { ...requests.at(-1), url: 'https://example.test/image.png' },
      { ...requests.at(-1), contextVersion: 7 },
      { ...requests.at(-1), snapshot: { token: 'bad' } },
      { ...requests.at(-1), images: Array.from({ length: 21 }, () => requests.at(-1)) },
      {
        ...requests.at(-1),
        images: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            bytes: new Uint8Array(),
            mediaType: 'image/jpeg',
            width: 0,
            height: 20_000,
            sha256: 'bad',
          },
        ],
      },
    ]) {
      expect(isSlidesOfficeToolRequest(invalid)).toBe(false)
    }
  })

  it('accepts exact response variants and rejects malformed results', () => {
    const valid = [
      {
        requestId: 'context',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'slides-edit-1',
            modelContent: 'deck',
            details: { slideCount: 2, currentSlide: 0, selectedIds: ['shape-1'] },
          },
        },
      },
      { requestId: 'snapshot', ok: true, result: { kind: 'snapshot', snapshot: { token } } },
      { requestId: 'restore', ok: true, result: { kind: 'restored', contextVersion: 'v2' } },
      { requestId: 'abort', ok: true, result: { kind: 'aborted', aborted: true } },
      {
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'done',
          contextVersionAfter: 'v2',
          mutationOutcome: 'committed',
        },
      },
      { requestId: 'error', ok: false, errorCode: 'artifact_invalid' },
      { requestId: 'error', ok: false, errorCode: 'tool_failed', mutationOutcome: 'unknown' },
    ]
    valid.forEach((response) => expect(isSlidesOfficeToolResponse(response)).toBe(true))
    for (const invalid of [
      null,
      { requestId: '', ok: false, errorCode: 'tool_failed' },
      { requestId: 'x', ok: false, errorCode: 'private' },
      { requestId: 'x', ok: false, errorCode: 'tool_failed', mutationOutcome: 'committed' },
      { requestId: 'x', ok: 'yes', result: {} },
      { requestId: 'x', ok: true, result: null },
      {
        requestId: 'x',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'v',
            modelContent: '',
            details: { slideCount: '2', currentSlide: 0, selectedIds: [] },
          },
        },
      },
      { requestId: 'x', ok: true, result: { kind: 'snapshot', snapshot: { token: 'bad' } } },
      { requestId: 'x', ok: true, result: { kind: 'restored', contextVersion: 1 } },
      { requestId: 'x', ok: true, result: { kind: 'aborted', aborted: 'yes' } },
      {
        requestId: 'x',
        ok: true,
        result: { kind: 'executed', output: 1, contextVersionAfter: 'v' },
      },
    ]) {
      expect(isSlidesOfficeToolResponse(invalid)).toBe(false)
    }
  })

  it('correlates webContents and closes or times out pending requests', async () => {
    const send = vi.fn<(request: SlidesOfficeToolRequest) => void>()
    const client = new SlidesOfficeToolRendererClient({
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
    const destroyed = new SlidesOfficeToolRendererClient({
      webContentsId: 1,
      isDestroyed: () => true,
      send,
    })
    await expect(destroyed.request({ kind: 'context', documentId })).rejects.toThrow(
      'executor_unavailable',
    )

    vi.useFakeTimers()
    try {
      const timed = new SlidesOfficeToolRendererClient({
        webContentsId: 2,
        isDestroyed: () => false,
        send: vi.fn(),
        timeoutMs: 5,
      })
      const timeout = timed.request({ kind: 'context', documentId })
      const rejected = expect(timeout).rejects.toThrow('executor_unavailable')
      await vi.advanceTimersByTimeAsync(5)
      await rejected
      const defaults = new SlidesOfficeToolRendererClient({
        webContentsId: 3,
        isDestroyed: () => false,
        send: vi.fn(),
      })
      const defaultTimeout = defaults.request({ kind: 'context', documentId })
      const defaultRejected = expect(defaultTimeout).rejects.toThrow('executor_unavailable')
      await vi.advanceTimersByTimeAsync(30_000)
      await defaultRejected
    } finally {
      vi.useRealTimers()
    }
  })
})
