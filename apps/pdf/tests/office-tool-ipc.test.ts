import { describe, expect, it } from 'vitest'
import {
  isPdfOfficeToolRequest,
  isPdfOfficeToolResponse,
  type PdfOfficeEditSnapshot,
} from '../src/shared/ipc'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const snapshot: PdfOfficeEditSnapshot = {
  markups: [],
  drawings: [],
  stampCfg: null,
  formEdits: [],
  rotations: [],
  deleted: [],
  order: null,
  metadata: null,
}

describe('PDF Office Tool preload schemas', () => {
  it('accepts every exact main-to-renderer request kind', () => {
    for (const request of [
      { requestId: 'context', kind: 'context', documentId },
      { requestId: 'capture', kind: 'capture_snapshot', documentId },
      { requestId: 'abort', kind: 'abort', operationId: 'operation-1', documentId },
      { requestId: 'restore', kind: 'restore_snapshot', documentId, snapshot },
      {
        requestId: 'execute',
        kind: 'execute',
        operationId: 'operation-2',
        documentId,
        toolId: 'office:pdf:read_pages',
        input: { start: 1 },
        contextVersion: 'pdf-edit-1',
      },
    ]) {
      expect(isPdfOfficeToolRequest(request)).toBe(true)
    }
  })

  it('accepts exact renderer responses and rejects nested or outer expansion fields', () => {
    const context = {
      requestId: 'context',
      ok: true,
      result: {
        kind: 'context',
        snapshot: {
          documentId,
          contextVersion: 'pdf-edit-1',
          modelContent: 'PDF context',
          details: {
            fileName: 'contract.pdf',
            originalPageCount: 2,
            currentOriginalPage: 1,
            readOnly: false,
            hasOutline: true,
            deletionGeneration: 0,
          },
        },
      },
    }
    for (const response of [
      context,
      { requestId: 'snapshot', ok: true, result: { kind: 'snapshot', snapshot } },
      {
        requestId: 'restored',
        ok: true,
        result: { kind: 'restored', contextVersion: 'pdf-edit-2' },
      },
      { requestId: 'aborted', ok: true, result: { kind: 'aborted', aborted: true } },
      {
        requestId: 'executed',
        ok: true,
        result: {
          kind: 'executed',
          output: 'done',
          contextVersionAfter: 'pdf-edit-2',
          mutationOutcome: 'committed',
        },
      },
      {
        requestId: 'failed',
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      },
    ]) {
      expect(isPdfOfficeToolResponse(response)).toBe(true)
    }
    expect(
      isPdfOfficeToolRequest({ requestId: 'x', kind: 'context', documentId, token: 'x' }),
    ).toBe(false)
    expect(
      isPdfOfficeToolResponse({
        ...context,
        result: {
          ...context.result,
          snapshot: { ...context.result.snapshot, token: 'forbidden' },
        },
      }),
    ).toBe(false)
    expect(
      isPdfOfficeToolResponse({ requestId: 'x', ok: false, errorCode: 'private_renderer_error' }),
    ).toBe(false)
  })
})
