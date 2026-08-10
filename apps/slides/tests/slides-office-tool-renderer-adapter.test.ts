import { describe, expect, it, vi } from 'vitest'
import { createSlidesOfficeToolRendererHandler } from '../src/renderer/ai/office-tool-renderer-adapter'
import type { SlidesNativeToolResult } from '../src/renderer/ai/slides-skill'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function harness() {
  let version = 1
  let snapshotId = 40
  const execute = vi.fn(
    async (
      modelAlias: string,
      _input: Record<string, unknown>,
      _signal: AbortSignal,
      _artifacts: ReadonlyMap<string, unknown>,
    ): Promise<SlidesNativeToolResult> => ({
      output: `${modelAlias} complete`,
      summary: modelAlias,
      mutated: !['get_deck_context', 'read_slide'].includes(modelAlias),
    }),
  )
  const beginHistoryBatch = vi.fn(async () => true)
  const endHistoryBatch = vi.fn(async (): Promise<number | null> => ++snapshotId)
  const restoreHistorySnapshot = vi.fn(async () => true)
  const handler = createSlidesOfficeToolRendererHandler({
    contextVersion: () => `slides-edit-${version}`,
    advanceContextVersion: () => `slides-edit-${++version}`,
    contextContent: () => 'Deck outline',
    contextDetails: () => ({ slideCount: 3, currentSlide: 1, selectedIds: ['shape-1'] }),
    beginHistoryBatch,
    endHistoryBatch,
    restoreHistorySnapshot,
    execute,
    randomUUID: () => token,
  })
  return {
    handler,
    execute,
    beginHistoryBatch,
    endHistoryBatch,
    restoreHistorySnapshot,
    setVersion: (next: number) => (version = next),
  }
}

async function snapshot(handler: ReturnType<typeof createSlidesOfficeToolRendererHandler>) {
  const response = await handler({ requestId: 'snapshot', kind: 'capture_snapshot', documentId })
  if (!response.ok || response.result.kind !== 'snapshot') throw new Error('missing snapshot')
  return response.result.snapshot
}

describe('Slides Office Tool renderer adapter', () => {
  it('projects live context and executes reads without history metadata', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({ requestId: 'context', kind: 'context', documentId }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        snapshot: {
          contextVersion: 'slides-edit-1',
          modelContent: 'Deck outline',
          details: { slideCount: 3, selectedIds: ['shape-1'] },
        },
      },
    })
    await expect(
      fixture.handler({
        requestId: 'read',
        kind: 'execute',
        operationId: 'read-1',
        documentId,
        toolId: 'office:slides:read_slide',
        input: { slideIndex: 0 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: 'executed', contextVersionAfter: 'slides-edit-1' },
    })
    expect(fixture.beginHistoryBatch).not.toHaveBeenCalled()
  })

  it('captures the first committed main-process snapshot for whole-run rollback', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await expect(
      fixture.handler({
        requestId: 'write-1',
        kind: 'execute',
        operationId: 'write-1',
        documentId,
        toolId: 'office:slides:set_element_fill',
        input: { slideIndex: 0, sourceId: 'shape-1', fill: '#FFFFFF' },
        contextVersion: 'slides-edit-1',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { mutationOutcome: 'committed', contextVersionAfter: 'slides-edit-2' },
    })
    await fixture.handler({
      requestId: 'write-2',
      kind: 'execute',
      operationId: 'write-2',
      documentId,
      toolId: 'office:slides:delete_element',
      input: { slideIndex: 0, sourceId: 'shape-2' },
      contextVersion: 'slides-edit-2',
      snapshot: boundary,
    })
    await expect(
      fixture.handler({
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: 'restored', contextVersion: 'slides-edit-4' },
    })
    expect(fixture.restoreHistorySnapshot).toHaveBeenCalledWith(41)
    expect(fixture.beginHistoryBatch).toHaveBeenCalledTimes(2)
  })

  it('enforces current request and snapshot freshness before mutation', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await expect(
      fixture.handler({
        requestId: 'stale',
        kind: 'execute',
        operationId: 'stale',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-0',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
    fixture.setVersion(2)
    await expect(
      fixture.handler({
        requestId: 'stale-boundary',
        kind: 'execute',
        operationId: 'stale-boundary',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-2',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'stale_context' })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('converts only main-validated PNG bytes into the renderer artifact map', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await fixture.handler({
      requestId: 'image',
      kind: 'execute',
      operationId: 'image',
      documentId,
      toolId: 'office:slides:insert_image',
      input: {},
      contextVersion: 'slides-edit-1',
      snapshot: boundary,
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
    })
    expect(fixture.execute.mock.calls[0]?.[3].get('11111111-1111-4111-8111-111111111111')).toEqual({
      base64: 'iVBORw==',
      ext: 'png',
      mediaType: 'image/png',
    })
  })

  it('rejects unsupported tools, missing boundaries and rollback without a commit', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'unknown',
        kind: 'execute',
        operationId: 'unknown',
        documentId,
        toolId: 'office:slides:execute_layout_script',
        input: {},
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_office_feature' })
    await expect(
      fixture.handler({
        requestId: 'no-boundary',
        kind: 'execute',
        operationId: 'no-boundary',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-1',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'executor_unavailable' })
    await expect(
      fixture.handler({
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: { token },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'executor_unavailable' })
  })

  it('reports execution failures and always closes a started history batch', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    fixture.execute.mockResolvedValueOnce({
      output: 'no',
      summary: 'no',
      mutated: false,
      isError: true,
    })
    fixture.endHistoryBatch.mockResolvedValueOnce(null)
    await expect(
      fixture.handler({
        requestId: 'failed',
        kind: 'execute',
        operationId: 'failed',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-1',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'tool_failed',
      mutationOutcome: 'not_started',
    })
    expect(fixture.endHistoryBatch).toHaveBeenCalledOnce()

    const thrown = harness()
    const thrownBoundary = await snapshot(thrown.handler)
    thrown.execute.mockRejectedValueOnce(new Error('renderer disconnected'))
    await expect(
      thrown.handler({
        requestId: 'thrown',
        kind: 'execute',
        operationId: 'thrown',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-1',
        snapshot: thrownBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'unknown' })
    expect(thrown.endHistoryBatch).toHaveBeenCalledOnce()

    const partial = harness()
    const partialBoundary = await snapshot(partial.handler)
    partial.execute.mockResolvedValueOnce({
      output: 'partial',
      summary: 'partial',
      mutated: false,
      isError: true,
    })
    await expect(
      partial.handler({
        requestId: 'partial',
        kind: 'execute',
        operationId: 'partial',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-1',
        snapshot: partialBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'unknown' })
    await expect(
      partial.handler({
        requestId: 'partial-restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: partialBoundary,
      }),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'restored' } })

    const failedRead = harness()
    failedRead.execute.mockResolvedValueOnce({
      output: 'no',
      summary: 'no',
      mutated: false,
      isError: true,
    })
    const failedReadResponse = await failedRead.handler({
      requestId: 'failed-read',
      kind: 'execute',
      operationId: 'failed-read',
      documentId,
      toolId: 'office:slides:get_deck_context',
      input: {},
    })
    expect(failedReadResponse).toMatchObject({ ok: false, errorCode: 'tool_failed' })
    expect(failedReadResponse).not.toHaveProperty('mutationOutcome')
  })

  it('forwards abort state and handles history/restore failures', async () => {
    let resolveExecution: ((result: SlidesNativeToolResult) => void) | undefined
    const fixture = harness()
    fixture.execute.mockImplementationOnce(
      () => new Promise((resolve) => (resolveExecution = resolve)),
    )
    const reading = fixture.handler({
      requestId: 'read',
      kind: 'execute',
      operationId: 'active',
      documentId,
      toolId: 'office:slides:get_deck_context',
      input: {},
    })
    await expect(
      fixture.handler({ requestId: 'abort', kind: 'abort', operationId: 'active', documentId }),
    ).resolves.toMatchObject({ ok: true, result: { aborted: true } })
    expect(fixture.execute.mock.calls[0]?.[2].aborted).toBe(true)
    resolveExecution?.({ output: 'done', summary: 'done', mutated: false })
    await reading
    await expect(
      fixture.handler({
        requestId: 'abort-missing',
        kind: 'abort',
        operationId: 'missing',
        documentId,
      }),
    ).resolves.toMatchObject({ ok: true, result: { aborted: false } })

    const beginFailed = harness()
    const beginBoundary = await snapshot(beginFailed.handler)
    beginFailed.beginHistoryBatch.mockResolvedValueOnce(false)
    await expect(
      beginFailed.handler({
        requestId: 'begin-failed',
        kind: 'execute',
        operationId: 'begin-failed',
        documentId,
        toolId: 'office:slides:delete_slide',
        input: { slideIndex: 0 },
        contextVersion: 'slides-edit-1',
        snapshot: beginBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'not_started' })

    const restoreFailed = harness()
    const restoreBoundary = await snapshot(restoreFailed.handler)
    await restoreFailed.handler({
      requestId: 'write',
      kind: 'execute',
      operationId: 'write',
      documentId,
      toolId: 'office:slides:delete_slide',
      input: { slideIndex: 0 },
      contextVersion: 'slides-edit-1',
      snapshot: restoreBoundary,
    })
    restoreFailed.restoreHistorySnapshot.mockResolvedValueOnce(false)
    await expect(
      restoreFailed.handler({
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: restoreBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })

    const staleRestore = harness()
    const staleBoundary = await snapshot(staleRestore.handler)
    await staleRestore.handler({
      requestId: 'write',
      kind: 'execute',
      operationId: 'write',
      documentId,
      toolId: 'office:slides:delete_slide',
      input: { slideIndex: 0 },
      contextVersion: 'slides-edit-1',
      snapshot: staleBoundary,
    })
    staleRestore.setVersion(9)
    await expect(
      staleRestore.handler({
        requestId: 'stale-restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: staleBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'stale_context' })

    const thrownRestore = harness()
    const thrownRestoreBoundary = await snapshot(thrownRestore.handler)
    await thrownRestore.handler({
      requestId: 'write',
      kind: 'execute',
      operationId: 'write',
      documentId,
      toolId: 'office:slides:delete_slide',
      input: { slideIndex: 0 },
      contextVersion: 'slides-edit-1',
      snapshot: thrownRestoreBoundary,
    })
    thrownRestore.restoreHistorySnapshot.mockRejectedValueOnce(new Error('disconnected'))
    await expect(
      thrownRestore.handler({
        requestId: 'thrown-restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: thrownRestoreBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })
  })

  it('uses the platform UUID source when no deterministic source is supplied', async () => {
    const handler = createSlidesOfficeToolRendererHandler({
      contextVersion: () => 'v1',
      advanceContextVersion: () => 'v2',
      contextContent: () => '',
      contextDetails: () => ({ slideCount: 0, currentSlide: 0, selectedIds: [] }),
      beginHistoryBatch: async () => true,
      endHistoryBatch: async () => null,
      restoreHistorySnapshot: async () => true,
      execute: async () => ({ output: '', summary: '', mutated: false }),
    })
    await expect(
      handler({ requestId: 'snapshot', kind: 'capture_snapshot', documentId }),
    ).resolves.toMatchObject({ ok: true, result: { snapshot: { token: expect.any(String) } } })
  })
})
