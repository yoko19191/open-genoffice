import { describe, expect, it, vi } from 'vitest'
import { createDocsOfficeToolRendererHandler } from '../src/renderer/ai/office-tool-renderer-adapter'
import type { DocsOfficeEditSnapshot } from '../src/shared/docs-office-tools'
import type { ToolExecution } from '../src/renderer/ai/tools'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const snapshot: DocsOfficeEditSnapshot = {
  doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  selection: { from: 1, to: 1 },
}

function harness() {
  let version = 4
  const captureSnapshot = vi.fn(() => snapshot)
  const restoreSnapshot = vi.fn()
  const execute = vi.fn(
    async (
      modelAlias: string,
      _input: Record<string, unknown>,
      _signal: AbortSignal,
      _image?: unknown,
    ): Promise<ToolExecution> => ({
      output: `${modelAlias} completed`,
      summary: modelAlias,
      mutated: modelAlias !== 'get_document_context' && modelAlias !== 'read_blocks',
    }),
  )
  const handler = createDocsOfficeToolRendererHandler({
    contextVersion: () => `docs-edit-${version}`,
    advanceContextVersion: () => `docs-edit-${++version}`,
    contextContent: () => 'Blocks: 1\nSelection: 1-1',
    contextDetails: () => ({ blockCount: 1, selection: { from: 1, to: 1 } }),
    captureSnapshot,
    restoreSnapshot,
    execute,
  })
  return { captureSnapshot, execute, handler, restoreSnapshot }
}

describe('Docs passive Office Tool renderer adapter', () => {
  it('returns live model context and a serializable edit snapshot', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({ requestId: 'context-1', kind: 'context', documentId }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'context',
        snapshot: {
          documentId,
          contextVersion: 'docs-edit-4',
          modelContent: 'Blocks: 1\nSelection: 1-1',
          details: { blockCount: 1, selection: { from: 1, to: 1 } },
        },
      },
    })
    await expect(
      fixture.handler({ requestId: 'snapshot-1', kind: 'capture_snapshot', documentId }),
    ).resolves.toEqual({
      requestId: 'snapshot-1',
      ok: true,
      result: { kind: 'snapshot', snapshot },
    })
  })

  it('executes reads and passes trusted binary image payloads to a fresh mutation', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'read-1',
        kind: 'execute',
        operationId: 'operation-read',
        documentId,
        toolId: 'office:docs:read_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 0 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { kind: 'executed', contextVersionAfter: 'docs-edit-4' },
    })

    const image = {
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
      sha256: 'a'.repeat(64),
    }
    await expect(
      fixture.handler({
        requestId: 'image-1',
        kind: 'execute',
        operationId: 'operation-image',
        documentId,
        toolId: 'office:docs:insert_image',
        input: { artifactId: '11111111-1111-4111-8111-111111111111' },
        contextVersion: 'docs-edit-4',
        image,
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { mutationOutcome: 'committed', contextVersionAfter: 'docs-edit-5' },
    })
    expect(fixture.execute).toHaveBeenNthCalledWith(
      2,
      'insert_image',
      { artifactId: '11111111-1111-4111-8111-111111111111' },
      expect.any(AbortSignal),
      image,
    )
  })

  it('rejects stale mutation, unknown tools and missing trusted image bytes before execution', async () => {
    const fixture = harness()
    for (const request of [
      {
        requestId: 'stale-1',
        kind: 'execute' as const,
        operationId: 'operation-stale',
        documentId,
        toolId: 'office:docs:insert_content',
        input: { html: '<p>new</p>' },
        contextVersion: 'docs-edit-3',
      },
      {
        requestId: 'image-missing',
        kind: 'execute' as const,
        operationId: 'operation-image-missing',
        documentId,
        toolId: 'office:docs:insert_image',
        input: { artifactId: '11111111-1111-4111-8111-111111111111' },
        contextVersion: 'docs-edit-4',
      },
    ]) {
      await expect(fixture.handler(request)).resolves.toMatchObject({
        ok: false,
        mutationOutcome: 'not_started',
      })
    }
    await expect(
      fixture.handler({
        requestId: 'unknown-1',
        kind: 'execute',
        operationId: 'operation-unknown',
        documentId,
        toolId: 'office:docs:unknown',
        input: {},
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_office_feature' })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('restores a run snapshot, aborts an active read and marks lost mutation results unknown', async () => {
    const fixture = harness()
    await expect(
      fixture.handler({
        requestId: 'restore-1',
        kind: 'restore_snapshot',
        documentId,
        snapshot,
      }),
    ).resolves.toMatchObject({ result: { kind: 'restored', contextVersion: 'docs-edit-5' } })
    expect(fixture.restoreSnapshot).toHaveBeenCalledWith(snapshot)

    fixture.execute.mockImplementationOnce(
      (_alias, _input, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ output: 'late', summary: 'late', mutated: false }),
            { once: true },
          )
        }),
    )
    const pending = fixture.handler({
      requestId: 'active-read',
      kind: 'execute',
      operationId: 'operation-active',
      documentId,
      toolId: 'office:docs:get_document_context',
      input: {},
    })
    await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledOnce())
    await expect(
      fixture.handler({
        requestId: 'abort-1',
        kind: 'abort',
        operationId: 'operation-active',
        documentId,
      }),
    ).resolves.toMatchObject({ result: { kind: 'aborted', aborted: true } })
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'tool_failed' })

    fixture.execute.mockRejectedValueOnce(new Error('renderer response lost'))
    await expect(
      fixture.handler({
        requestId: 'unknown-mutation',
        kind: 'execute',
        operationId: 'operation-lost',
        documentId,
        toolId: 'office:docs:insert_content',
        input: { html: '<p>new</p>' },
        contextVersion: 'docs-edit-5',
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'unknown' })
  })

  it('distinguishes rejected reads from mutations that fail before writing', async () => {
    const fixture = harness()
    fixture.execute.mockResolvedValueOnce({
      output: 'invalid',
      summary: 'insert_content',
      isError: true,
      mutated: false,
    })
    await expect(
      fixture.handler({
        requestId: 'failed-mutation',
        kind: 'execute',
        operationId: 'operation-failed-mutation',
        documentId,
        toolId: 'office:docs:insert_content',
        input: { html: '<p>new</p>' },
        contextVersion: 'docs-edit-4',
      }),
    ).resolves.toMatchObject({ ok: false, mutationOutcome: 'not_started' })

    fixture.execute.mockRejectedValueOnce(new Error('read failed'))
    await expect(
      fixture.handler({
        requestId: 'failed-read',
        kind: 'execute',
        operationId: 'operation-failed-read',
        documentId,
        toolId: 'office:docs:read_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 0 },
      }),
    ).resolves.toEqual({ requestId: 'failed-read', ok: false, errorCode: 'tool_failed' })
  })
})
