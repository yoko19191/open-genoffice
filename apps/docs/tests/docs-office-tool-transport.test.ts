import { describe, expect, it, vi } from 'vitest'
import {
  isDocsOfficeToolRequest,
  isDocsOfficeToolResponse,
  type DocsOfficeToolRequest,
} from '../src/shared/docs-office-tools'
import { DocsOfficeToolRendererClient } from '../src/main/agent-tools/renderer-client'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

describe('Docs Office Tool narrow transport', () => {
  it('accepts every request kind and rejects unknown fields or malformed snapshots/images', () => {
    const snapshot = { doc: { type: 'doc' }, selection: { from: 1, to: 2 } }
    const requests: DocsOfficeToolRequest[] = [
      { requestId: 'context-1', kind: 'context', documentId },
      { requestId: 'snapshot-1', kind: 'capture_snapshot', documentId },
      { requestId: 'abort-1', kind: 'abort', operationId: 'operation-1', documentId },
      { requestId: 'restore-1', kind: 'restore_snapshot', documentId, snapshot },
      {
        requestId: 'execute-1',
        kind: 'execute',
        operationId: 'operation-2',
        documentId,
        toolId: 'office:docs:insert_image',
        input: { artifactId: '11111111-1111-4111-8111-111111111111' },
        contextVersion: 'docs-edit-1',
        image: {
          bytes: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
          width: 1,
          height: 1,
          sha256: 'a'.repeat(64),
        },
      },
    ]
    requests.forEach((request) => expect(isDocsOfficeToolRequest(request)).toBe(true))

    for (const invalid of [
      null,
      [],
      { requestId: '', kind: 'context', documentId },
      { requestId: 'x', kind: 'context', documentId, extra: true },
      { requestId: 'x', kind: 'abort', documentId, operationId: 1 },
      {
        requestId: 'x',
        kind: 'restore_snapshot',
        documentId,
        snapshot: { doc: {}, selection: { from: 2, to: 1 } },
      },
      {
        ...requests.at(-1),
        image: {
          bytes: new Uint8Array(),
          mediaType: 'image/png',
          width: 1,
          height: 1,
          sha256: 'a'.repeat(64),
        },
      },
      {
        ...requests.at(-1),
        image: {
          bytes: Uint8Array.of(1),
          mediaType: 'image/jpeg',
          width: 1,
          height: 1,
          sha256: 'a'.repeat(64),
        },
      },
      {
        ...requests.at(-1),
        image: {
          bytes: Uint8Array.of(1),
          mediaType: 'image/png',
          width: 20_000,
          height: 1,
          sha256: 'bad',
        },
      },
    ]) {
      expect(isDocsOfficeToolRequest(invalid), JSON.stringify(invalid)).toBe(false)
    }
  })

  it('accepts every response kind and rejects invalid outcomes, contexts and error codes', () => {
    const snapshot = { doc: { type: 'doc' }, selection: { from: 1, to: 1 } }
    for (const response of [
      {
        requestId: 'context',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'docs-edit-1',
            modelContent: 'Blocks: 1',
            details: { blockCount: 1, selection: { from: 1, to: 1 } },
          },
        },
      },
      { requestId: 'snapshot', ok: true, result: { kind: 'snapshot', snapshot } },
      {
        requestId: 'restore',
        ok: true,
        result: { kind: 'restored', contextVersion: 'docs-edit-2' },
      },
      { requestId: 'abort', ok: true, result: { kind: 'aborted', aborted: false } },
      {
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'done',
          details: { summary: 'done' },
          contextVersionAfter: 'docs-edit-2',
          mutationOutcome: 'committed',
        },
      },
      { requestId: 'error', ok: false, errorCode: 'artifact_invalid', mutationOutcome: 'unknown' },
    ]) {
      expect(isDocsOfficeToolResponse(response)).toBe(true)
    }

    for (const invalid of [
      undefined,
      { requestId: '', ok: false, errorCode: 'tool_failed' },
      { requestId: 'x', ok: false, errorCode: 'private_path_exposed' },
      { requestId: 'x', ok: false, errorCode: 'tool_failed', mutationOutcome: 'committed' },
      {
        requestId: 'x',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'v',
            modelContent: '',
            details: { blockCount: -1, selection: { from: 0, to: 0 } },
          },
        },
      },
      {
        requestId: 'x',
        ok: true,
        result: { kind: 'snapshot', snapshot: { doc: [], selection: { from: 0, to: 0 } } },
      },
      { requestId: 'x', ok: true, result: { kind: 'restored', contextVersion: 1 } },
      { requestId: 'x', ok: true, result: { kind: 'aborted', aborted: 'yes' } },
      {
        requestId: 'x',
        ok: true,
        result: { kind: 'executed', output: 1, contextVersionAfter: 'v' },
      },
      { requestId: 'x', ok: true, result: { kind: 'other' } },
    ]) {
      expect(isDocsOfficeToolResponse(invalid)).toBe(false)
    }
  })

  it('correlates responses to the exact webContents and closes pending requests', async () => {
    const send = vi.fn<(request: DocsOfficeToolRequest) => void>()
    const client = new DocsOfficeToolRendererClient({
      webContentsId: 7,
      isDestroyed: () => false,
      send,
      timeoutMs: 50,
    })
    const pending = client.request({ kind: 'context', documentId })
    const request = send.mock.calls[0]![0]
    expect(
      client.accept(8, { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }),
    ).toBe(false)
    expect(client.accept(7, { requestId: 'unknown', ok: false, errorCode: 'tool_failed' })).toBe(
      false,
    )
    expect(
      client.accept(7, { requestId: request.requestId, ok: false, errorCode: 'tool_failed' }),
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })

    const closing = client.request({ kind: 'context', documentId })
    client.close()
    client.close()
    await expect(closing).rejects.toThrow('executor_unavailable')
    await expect(client.request({ kind: 'context', documentId })).rejects.toThrow(
      'executor_unavailable',
    )
  })

  it('rejects destroyed and timed-out renderer requests', async () => {
    const destroyed = new DocsOfficeToolRendererClient({
      webContentsId: 1,
      isDestroyed: () => true,
      send: vi.fn(),
    })
    await expect(destroyed.request({ kind: 'context', documentId })).rejects.toThrow(
      'executor_unavailable',
    )

    vi.useFakeTimers()
    try {
      const timedOut = new DocsOfficeToolRendererClient({
        webContentsId: 1,
        isDestroyed: () => false,
        send: vi.fn(),
        timeoutMs: 5,
      })
      const pending = timedOut.request({ kind: 'context', documentId })
      const rejected = expect(pending).rejects.toThrow('executor_unavailable')
      await vi.advanceTimersByTimeAsync(5)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
