import { describe, expect, it, vi } from 'vitest'
import { PdfOfficeToolRendererClient } from '../src/main/agent-tools/renderer-client'
import type { PdfOfficeToolRequest, PdfOfficeToolResponse } from '../src/shared/ipc'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

describe('PDF main to renderer Office Tool request client', () => {
  it('correlates concurrent responses and ignores other renderer/request identities', async () => {
    const sent: PdfOfficeToolRequest[] = []
    const client = new PdfOfficeToolRendererClient({
      webContentsId: 41,
      isDestroyed: () => false,
      send: (request) => sent.push(request),
    })
    const first = client.request({ kind: 'context', documentId })
    const second = client.request({ kind: 'capture_snapshot', documentId })
    expect(sent).toHaveLength(2)

    expect(
      client.accept(99, {
        requestId: sent[0]!.requestId,
        ok: false,
        errorCode: 'tool_failed',
      }),
    ).toBe(false)
    expect(
      client.accept(41, {
        requestId: 'unknown-request',
        ok: false,
        errorCode: 'tool_failed',
      }),
    ).toBe(false)
    const secondResponse: PdfOfficeToolResponse = {
      requestId: sent[1]!.requestId,
      ok: true,
      result: {
        kind: 'snapshot',
        snapshot: {
          markups: [],
          drawings: [],
          stampCfg: null,
          formEdits: [],
          rotations: [],
          deleted: [],
          order: null,
          metadata: null,
        },
      },
    }
    expect(client.accept(41, secondResponse)).toBe(true)
    await expect(second).resolves.toEqual(secondResponse)

    const firstResponse: PdfOfficeToolResponse = {
      requestId: sent[0]!.requestId,
      ok: true,
      result: {
        kind: 'context',
        snapshot: {
          documentId,
          contextVersion: 'pdf-edit-2',
          modelContent: 'PDF context',
          details: {
            fileName: 'file.pdf',
            originalPageCount: 2,
            currentOriginalPage: 1,
            readOnly: false,
            hasOutline: false,
            deletionGeneration: 0,
          },
        },
      },
    }
    expect(client.accept(41, firstResponse)).toBe(true)
    await expect(first).resolves.toEqual(firstResponse)
  })

  it('fails closed before send when the renderer is gone', async () => {
    const send = vi.fn()
    const client = new PdfOfficeToolRendererClient({
      webContentsId: 41,
      isDestroyed: () => true,
      send,
    })
    await expect(client.request({ kind: 'context', documentId })).rejects.toThrowError(
      'executor_unavailable',
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects pending requests on timeout or renderer close without leaking late responses', async () => {
    vi.useFakeTimers()
    try {
      const sent: PdfOfficeToolRequest[] = []
      const client = new PdfOfficeToolRendererClient({
        webContentsId: 41,
        isDestroyed: () => false,
        send: (request) => sent.push(request),
        timeoutMs: 50,
      })
      const timedOut = client.request({ kind: 'context', documentId })
      const timedOutExpectation = expect(timedOut).rejects.toThrowError('executor_unavailable')
      await vi.advanceTimersByTimeAsync(50)
      await timedOutExpectation
      expect(
        client.accept(41, {
          requestId: sent[0]!.requestId,
          ok: false,
          errorCode: 'tool_failed',
        }),
      ).toBe(false)

      const pending = client.request({ kind: 'context', documentId })
      client.close()
      client.close()
      await expect(pending).rejects.toThrowError('executor_unavailable')
      await expect(client.request({ kind: 'context', documentId })).rejects.toThrowError(
        'executor_unavailable',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed response identities without consuming the pending request', async () => {
    const sent: PdfOfficeToolRequest[] = []
    const client = new PdfOfficeToolRendererClient({
      webContentsId: 41,
      isDestroyed: () => false,
      send: (request) => sent.push(request),
    })
    const pending = client.request({ kind: 'context', documentId })
    expect(client.accept(41, { requestId: '', ok: false, errorCode: 'tool_failed' })).toBe(false)
    client.close()
    await expect(pending).rejects.toThrowError('executor_unavailable')
  })
})
