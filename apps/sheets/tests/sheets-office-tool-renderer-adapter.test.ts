import { describe, expect, it, vi } from 'vitest'
import { createSheetsOfficeToolRendererHandler } from '../src/renderer/ai/office-tool-renderer-adapter'
import type { ToolExecution } from '../src/renderer/ai/tools'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const snapshotToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function harness() {
  let version = 1
  const execute = vi.fn(
    async (
      modelAlias: string,
      _input: Record<string, unknown>,
      _signal: AbortSignal,
      _images: ReadonlyMap<string, unknown>,
    ): Promise<ToolExecution> => ({
      output: `${modelAlias} complete`,
      summary: modelAlias,
      mutated: modelAlias === 'propose_operations',
    }),
  )
  const undoMutations = vi.fn(async () => undefined)
  const handler = createSheetsOfficeToolRendererHandler({
    contextVersion: () => `sheets-edit-${version}`,
    advanceContextVersion: () => `sheets-edit-${++version}`,
    contextContent: () => 'Active sheet: Sheet1',
    contextDetails: () => ({
      mode: 'demo',
      sheetId: 'sheet-1',
      sheetName: 'Sheet1',
      selection: 'A1',
    }),
    undoMutations,
    execute,
    randomUUID: () => snapshotToken,
  })
  return {
    execute,
    handler,
    undoMutations,
    getVersion: () => version,
    setVersion: (v: number) => (version = v),
  }
}

async function snapshot(handler: ReturnType<typeof createSheetsOfficeToolRendererHandler>) {
  const response = await handler({
    requestId: 'snapshot',
    kind: 'capture_snapshot',
    documentId,
  })
  if (!response.ok || response.result.kind !== 'snapshot') throw new Error('missing snapshot')
  return response.result.snapshot
}

describe('Sheets Office Tool renderer adapter', () => {
  it('projects live context and enforces freshness before mutation', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({ requestId: 'context', kind: 'context', documentId }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'context',
        snapshot: {
          contextVersion: 'sheets-edit-1',
          modelContent: 'Active sheet: Sheet1',
          details: { selection: 'A1' },
        },
      },
    })
    const boundary = await snapshot(fixture.handler)
    await expect(
      fixture.handler({
        requestId: 'stale',
        kind: 'execute',
        operationId: 'operation-stale',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-0',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('marks committed only after the executor Promise resolves and rolls back the whole run', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await expect(
      fixture.handler({
        requestId: 'write-1',
        kind: 'execute',
        operationId: 'operation-1',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-1',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { mutationOutcome: 'committed', contextVersionAfter: 'sheets-edit-2' },
    })
    await fixture.handler({
      requestId: 'write-2',
      kind: 'execute',
      operationId: 'operation-2',
      documentId,
      toolId: 'office:sheets:propose_operations',
      input: { summary: 'write', operations: [] },
      contextVersion: 'sheets-edit-2',
      snapshot: boundary,
    })
    await expect(
      fixture.handler({
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: true, result: { kind: 'restored' } })
    expect(fixture.undoMutations).toHaveBeenCalledWith(2)
  })

  it('refuses rollback after an interleaved user edit', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await fixture.handler({
      requestId: 'write',
      kind: 'execute',
      operationId: 'operation-1',
      documentId,
      toolId: 'office:sheets:propose_operations',
      input: { summary: 'write', operations: [] },
      contextVersion: 'sheets-edit-1',
      snapshot: boundary,
    })
    fixture.setVersion(7)
    await expect(
      fixture.handler({
        requestId: 'restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'stale_context' })
    expect(fixture.undoMutations).not.toHaveBeenCalled()
  })

  it('converts only main-validated PNG bytes into an artifact map', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    await fixture.handler({
      requestId: 'image',
      kind: 'execute',
      operationId: 'operation-image',
      documentId,
      toolId: 'office:sheets:propose_operations',
      input: { summary: 'image', operations: [] },
      contextVersion: 'sheets-edit-1',
      snapshot: boundary,
      images: [
        {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bytes: new Uint8Array([137, 80, 78, 71]),
          mediaType: 'image/png',
          width: 1,
          height: 1,
          sha256: 'a'.repeat(64),
        },
      ],
    })
    const images = fixture.execute.mock.calls[0]?.[3]
    expect(images?.get('11111111-1111-4111-8111-111111111111')).toMatchObject({
      dataUrl: 'data:image/png;base64,iVBORw==',
      width: 1,
      height: 1,
    })
  })

  it('reports renderer exceptions as unknown and forwards abort without guessing', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    fixture.execute.mockRejectedValueOnce(new Error('renderer disconnected'))
    await expect(
      fixture.handler({
        requestId: 'unknown',
        kind: 'execute',
        operationId: 'operation-unknown',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-1',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'unknown' })
    await expect(
      fixture.handler({
        requestId: 'abort',
        kind: 'abort',
        operationId: 'missing-operation',
        documentId,
      }),
    ).resolves.toMatchObject({ ok: true, result: { aborted: false } })
  })

  it('rejects unsupported tools and mutation requests without a current snapshot', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'unsupported',
        kind: 'execute',
        operationId: 'operation-unsupported',
        documentId,
        toolId: 'office:sheets:missing',
        input: {},
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_office_feature' })
    await expect(
      fixture.handler({
        requestId: 'missing-snapshot',
        kind: 'execute',
        operationId: 'operation-missing-snapshot',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'executor_unavailable',
      mutationOutcome: 'not_started',
    })
    await expect(
      fixture.handler({
        requestId: 'missing-restore',
        kind: 'restore_snapshot',
        documentId,
        snapshot: { token: snapshotToken },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'executor_unavailable' })
  })

  it('rejects a stale snapshot even when the request context itself is current', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    fixture.setVersion(2)
    await expect(
      fixture.handler({
        requestId: 'stale-snapshot',
        kind: 'execute',
        operationId: 'operation-stale-snapshot',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-2',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
  })

  it('reports executor failures without claiming a commit', async () => {
    const fixture = harness()
    const boundary = await snapshot(fixture.handler)
    fixture.execute.mockResolvedValueOnce({
      output: 'validation failed',
      summary: 'validation failed',
      mutated: false,
      isError: true,
      mutationOutcome: 'unknown',
    })
    await expect(
      fixture.handler({
        requestId: 'failed',
        kind: 'execute',
        operationId: 'operation-failed',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-1',
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed', mutationOutcome: 'unknown' })

    fixture.undoMutations.mockRejectedValueOnce(new Error('undo failed'))
    await expect(
      fixture.handler({
        requestId: 'undo-failed',
        kind: 'restore_snapshot',
        documentId,
        snapshot: boundary,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })

    const defaultOutcome = harness()
    const defaultBoundary = await snapshot(defaultOutcome.handler)
    defaultOutcome.execute.mockResolvedValueOnce({
      output: 'validation failed',
      summary: 'validation failed',
      mutated: false,
      isError: true,
    })
    await expect(
      defaultOutcome.handler({
        requestId: 'default-outcome',
        kind: 'execute',
        operationId: 'operation-default-outcome',
        documentId,
        toolId: 'office:sheets:propose_operations',
        input: { summary: 'write', operations: [] },
        contextVersion: 'sheets-edit-1',
        snapshot: defaultBoundary,
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'not_started' })

    const failedRead = harness()
    failedRead.execute.mockResolvedValueOnce({
      output: 'read failed',
      summary: 'read failed',
      mutated: false,
      isError: true,
    })
    const failedReadResponse = await failedRead.handler({
      requestId: 'failed-read',
      kind: 'execute',
      operationId: 'operation-failed-read',
      documentId,
      toolId: 'office:sheets:get_workbook_context',
      input: {},
    })
    expect(failedReadResponse).toMatchObject({ ok: false, errorCode: 'tool_failed' })
    expect(failedReadResponse).not.toHaveProperty('mutationOutcome')

    const thrownRead = harness()
    thrownRead.execute.mockRejectedValueOnce(new Error('read failed'))
    const thrownReadResponse = await thrownRead.handler({
      requestId: 'thrown-read',
      kind: 'execute',
      operationId: 'operation-thrown-read',
      documentId,
      toolId: 'office:sheets:get_workbook_context',
      input: {},
    })
    expect(thrownReadResponse).toMatchObject({ ok: false, errorCode: 'tool_failed' })
    expect(thrownReadResponse).not.toHaveProperty('mutationOutcome')
  })

  it('executes reads without mutation metadata and aborts an active operation', async () => {
    let resolveExecution:
      ((value: { output: string; summary: string; mutated: boolean }) => void) | undefined
    const fixture = harness()
    fixture.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExecution = resolve
        }),
    )
    const reading = fixture.handler({
      requestId: 'read',
      kind: 'execute',
      operationId: 'operation-read',
      documentId,
      toolId: 'office:sheets:get_workbook_context',
      input: {},
    })
    await expect(
      fixture.handler({
        requestId: 'abort-active',
        kind: 'abort',
        operationId: 'operation-read',
        documentId,
      }),
    ).resolves.toMatchObject({ ok: true, result: { aborted: true } })
    expect(fixture.execute.mock.calls[0]?.[2].aborted).toBe(true)
    resolveExecution?.({ output: 'context', summary: 'context', mutated: false })
    await expect(reading).resolves.toMatchObject({
      ok: true,
      result: { kind: 'executed', contextVersionAfter: 'sheets-edit-1' },
    })
  })

  it('uses the platform UUID source when no deterministic source is supplied', async () => {
    const handler = createSheetsOfficeToolRendererHandler({
      contextVersion: () => 'sheets-edit-1',
      advanceContextVersion: () => 'sheets-edit-2',
      contextContent: () => '',
      contextDetails: () => ({ mode: 'none', sheetId: '', sheetName: '' }),
      undoMutations: async () => undefined,
      execute: async () => ({ output: '', summary: '', mutated: false }),
    })
    await expect(
      handler({ requestId: 'snapshot', kind: 'capture_snapshot', documentId }),
    ).resolves.toMatchObject({ ok: true, result: { snapshot: { token: expect.any(String) } } })
  })
})
