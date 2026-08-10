import { describe, expect, it, vi } from 'vitest'
import { createPdfOfficeToolRendererHandler } from '../src/renderer/ai/office-tool-renderer-adapter'
import type { PdfOfficeEditSnapshot } from '../src/shared/ipc'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const emptySnapshot: PdfOfficeEditSnapshot = {
  markups: [],
  drawings: [],
  stampCfg: null,
  formEdits: [],
  rotations: [],
  deleted: [],
  order: null,
  metadata: null,
}

function harness() {
  let version = 4
  const captureSnapshot = vi.fn(() => emptySnapshot)
  const restoreSnapshot = vi.fn()
  const contextDetails = vi.fn(() => ({
    fileName: 'contract.pdf',
    originalPageCount: 3,
    currentOriginalPage: 2,
    readOnly: false,
    hasOutline: true,
    deletionGeneration: 1,
  }))
  const execute = vi.fn(
    async (modelAlias: string, _input: Record<string, unknown>, _signal: AbortSignal) => ({
      output: `${modelAlias} completed`,
      summary: modelAlias,
      ...(modelAlias === 'delete_page' ? { mutated: true } : {}),
    }),
  )
  const handler = createPdfOfficeToolRendererHandler({
    contextVersion: () => `pdf-edit-${version}`,
    advanceContextVersion: () => `pdf-edit-${++version}`,
    contextDetails,
    captureSnapshot,
    restoreSnapshot,
    execute,
  })
  return { captureSnapshot, contextDetails, execute, handler, restoreSnapshot }
}

describe('PDF passive Office Tool renderer adapter', () => {
  it('returns model context and serializable run snapshots without exposing Runtime identity', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({ requestId: 'context-1', kind: 'context', documentId }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'context',
        snapshot: {
          documentId,
          contextVersion: 'pdf-edit-4',
          modelContent: expect.stringContaining('contract.pdf'),
          details: { originalPageCount: 3, currentOriginalPage: 2 },
        },
      },
    })
    await expect(
      fixture.handler({ requestId: 'snapshot-1', kind: 'capture_snapshot', documentId }),
    ).resolves.toEqual({
      requestId: 'snapshot-1',
      ok: true,
      result: { kind: 'snapshot', snapshot: emptySnapshot },
    })

    fixture.contextDetails.mockReturnValueOnce({
      fileName: 'locked.pdf',
      originalPageCount: 1,
      currentOriginalPage: 1,
      readOnly: true,
      hasOutline: false,
      deletionGeneration: 0,
    })
    await expect(
      fixture.handler({ requestId: 'context-locked', kind: 'context', documentId }),
    ).resolves.toMatchObject({
      result: { snapshot: { modelContent: expect.stringContaining('Read only: yes') } },
    })
  })

  it('executes reads at the current version and commits a fresh mutation exactly once', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'read-1',
        kind: 'execute',
        operationId: 'operation-read',
        documentId,
        toolId: 'office:pdf:read_pages',
        input: { start: 1 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: 'executed', contextVersionAfter: 'pdf-edit-4' },
    })
    await expect(
      fixture.handler({
        requestId: 'write-1',
        kind: 'execute',
        operationId: 'operation-write',
        documentId,
        toolId: 'office:pdf:delete_page',
        input: { page: 3 },
        contextVersion: 'pdf-edit-4',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'executed',
        contextVersionAfter: 'pdf-edit-5',
        mutationOutcome: 'committed',
      },
    })
    expect(fixture.execute).toHaveBeenNthCalledWith(
      1,
      'read_pages',
      { start: 1 },
      expect.any(AbortSignal),
    )
    expect(fixture.execute).toHaveBeenNthCalledWith(
      2,
      'delete_page',
      { page: 3 },
      expect.any(AbortSignal),
    )
  })

  it('rejects stale view and mutation calls before touching the editor', async () => {
    const fixture = harness()
    for (const [toolId, input] of [
      ['office:pdf:goto_page', { page: 2 }],
      ['office:pdf:rotate_page', { page: 2, direction: 'left' }],
    ] as const) {
      await expect(
        fixture.handler({
          requestId: `stale-${toolId}`,
          kind: 'execute',
          operationId: `operation-${toolId}`,
          documentId,
          toolId,
          input,
          contextVersion: 'pdf-edit-3',
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      })
    }
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('rejects unknown tools and missing mutation freshness before execution', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'unknown-tool',
        kind: 'execute',
        operationId: 'operation-unknown-tool',
        documentId,
        toolId: 'office:pdf:unknown',
        input: {},
      }),
    ).resolves.toEqual({
      requestId: 'unknown-tool',
      ok: false,
      errorCode: 'unsupported_office_feature',
    })
    await expect(
      fixture.handler({
        requestId: 'missing-version',
        kind: 'execute',
        operationId: 'operation-missing-version',
        documentId,
        toolId: 'office:pdf:delete_page',
        input: { page: 1 },
      }),
    ).resolves.toMatchObject({ errorCode: 'stale_context', mutationOutcome: 'not_started' })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('aborts an active read and reports whether an operation was present', async () => {
    const fixture = harness()
    fixture.execute.mockImplementationOnce(
      (_modelAlias, _input, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ output: 'late', summary: 'late' }), {
            once: true,
          })
        }),
    )
    const pending = fixture.handler({
      requestId: 'active-read',
      kind: 'execute',
      operationId: 'operation-active-read',
      documentId,
      toolId: 'office:pdf:read_pages',
      input: { start: 1 },
    })
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())
    await expect(
      fixture.handler({
        requestId: 'abort-active-read',
        kind: 'abort',
        operationId: 'operation-active-read',
        documentId,
      }),
    ).resolves.toMatchObject({ result: { kind: 'aborted', aborted: true } })
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })
    await expect(
      fixture.handler({
        requestId: 'abort-missing-read',
        kind: 'abort',
        operationId: 'operation-missing-read',
        documentId,
      }),
    ).resolves.toMatchObject({ result: { kind: 'aborted', aborted: false } })
  })

  it('restores a snapshot, advances freshness, and reports uncertain mutation failures', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'restore-1',
        kind: 'restore_snapshot',
        documentId,
        snapshot: emptySnapshot,
      }),
    ).resolves.toEqual({
      requestId: 'restore-1',
      ok: true,
      result: { kind: 'restored', contextVersion: 'pdf-edit-5' },
    })
    expect(fixture.restoreSnapshot).toHaveBeenCalledWith(emptySnapshot)

    fixture.execute.mockRejectedValueOnce(new Error('renderer response lost'))
    await expect(
      fixture.handler({
        requestId: 'unknown-1',
        kind: 'execute',
        operationId: 'operation-unknown',
        documentId,
        toolId: 'office:pdf:delete_page',
        input: { page: 2 },
        contextVersion: 'pdf-edit-5',
      }),
    ).resolves.toEqual({
      requestId: 'unknown-1',
      ok: false,
      errorCode: 'tool_failed',
      mutationOutcome: 'unknown',
    })
  })

  it('preserves stable executor errors as not-started mutations', async () => {
    const fixture = harness()
    fixture.execute.mockResolvedValueOnce({
      output: 'read only',
      summary: 'delete',
      isError: true,
      errorCode: 'read_only_document',
    })
    await expect(
      fixture.handler({
        requestId: 'readonly-1',
        kind: 'execute',
        operationId: 'operation-readonly',
        documentId,
        toolId: 'office:pdf:delete_page',
        input: { page: 2 },
        contextVersion: 'pdf-edit-4',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'read_only_document',
      mutationOutcome: 'not_started',
    })
  })

  it('normalizes missing and thrown readonly executor errors without mutation state', async () => {
    const fixture = harness()
    fixture.execute.mockResolvedValueOnce({ output: '', summary: 'read', isError: true })
    await expect(
      fixture.handler({
        requestId: 'read-error',
        kind: 'execute',
        operationId: 'operation-read-error',
        documentId,
        toolId: 'office:pdf:read_pages',
        input: { start: 1 },
      }),
    ).resolves.toEqual({ requestId: 'read-error', ok: false, errorCode: 'tool_failed' })

    fixture.execute.mockRejectedValueOnce(new Error('private renderer error'))
    await expect(
      fixture.handler({
        requestId: 'read-thrown',
        kind: 'execute',
        operationId: 'operation-read-thrown',
        documentId,
        toolId: 'office:pdf:read_pages',
        input: { start: 1 },
      }),
    ).resolves.toEqual({ requestId: 'read-thrown', ok: false, errorCode: 'tool_failed' })
  })
})
