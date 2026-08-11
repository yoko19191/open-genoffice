import { describe, expect, it, vi } from 'vitest'
import type { OfficeToolInvocation } from '@genoffice/agent-runtime-protocol'
import { PdfOfficeToolHost } from '../src/main/agent-tools/pdf-office-tool-host'
import type { PdfOfficeToolRendererClient } from '../src/main/agent-tools/renderer-client'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function invocation(
  operationId: string,
  toolId: string,
  input: unknown,
  overrides: Partial<OfficeToolInvocation> = {},
): OfficeToolInvocation {
  return {
    operationId,
    sessionId,
    documentId,
    runId: 'run-1',
    toolCallId: `call-${operationId}`,
    toolId,
    toolOrder: 0,
    actor: { type: 'parent', actorId: sessionId, sessionId },
    permissionSnapshot: {
      snapshotId: 'permission-snapshot-1',
      createdForRunId: 'run-1',
      permissionVersion: 'permission-1',
      toolIds: [toolId],
    },
    input,
    ...overrides,
  }
}

function harness() {
  const request = vi.fn(async (input) => {
    if (input.kind === 'capture_snapshot') {
      return {
        requestId: 'renderer-snapshot-response',
        ok: true as const,
        result: {
          kind: 'snapshot' as const,
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
    }
    if (input.kind === 'restore_snapshot') {
      return {
        requestId: 'renderer-restore-response',
        ok: true as const,
        result: { kind: 'restored' as const, contextVersion: 'pdf-edit-9' },
      }
    }
    if (input.kind === 'context') {
      return {
        requestId: 'renderer-context-response',
        ok: true as const,
        result: {
          kind: 'context' as const,
          snapshot: {
            documentId,
            contextVersion: 'pdf-edit-8',
            modelContent: 'PDF: contract.pdf\nOriginal pages: 3\nCurrent original page: 2',
            details: {
              fileName: 'contract.pdf',
              originalPageCount: 3,
              currentOriginalPage: 2,
              readOnly: false,
              hasOutline: true,
              deletionGeneration: 0,
            },
          },
        },
      }
    }
    if (input.kind === 'abort') {
      return {
        requestId: 'renderer-abort-response',
        ok: true as const,
        result: { kind: 'aborted' as const, aborted: true },
      }
    }
    return {
      requestId: 'renderer-execute-response',
      ok: true as const,
      result: {
        kind: 'executed' as const,
        output: `${input.toolId} complete`,
        details: { renderer: 'passive' },
        contextVersionAfter: 'pdf-edit-8',
        ...(input.toolId.endsWith('delete_page') ? { mutationOutcome: 'committed' as const } : {}),
      },
    }
  })
  const renderer = { request } as unknown as Pick<PdfOfficeToolRendererClient, 'request'>
  const validateBinding = vi.fn(async () => true)
  const validatePermissionSnapshot = vi.fn(async () => true)
  const authorizeMutationGrant = vi.fn(async () => true)
  const host = new PdfOfficeToolHost({
    resolveRenderer: () => renderer,
    validateBinding,
    validatePermissionSnapshot,
    authorizeMutationGrant,
  })
  return {
    authorizeMutationGrant,
    host,
    renderer,
    request,
    validateBinding,
    validatePermissionSnapshot,
  }
}

describe('PDF main Office Tool host', () => {
  it('maps a renderer read into a provenance receipt with freshness', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(invocation('read-1', 'office:pdf:read_pages', { start: 1, end: 2 })),
    ).resolves.toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/PDF: contract\.pdf[\s\S]*office:pdf:read_pages complete/),
      details: {
        renderer: 'passive',
        context: { originalPageCount: 3, currentOriginalPage: 2 },
      },
      contextVersionAfter: 'pdf-edit-8',
      provenance: { actorId: sessionId, runId: 'run-1', documentId },
    })
    expect(fixture.request).toHaveBeenCalledWith({
      kind: 'execute',
      operationId: 'read-1',
      documentId,
      toolId: 'office:pdf:read_pages',
      input: { start: 1, end: 2 },
    })
    expect(fixture.request).toHaveBeenCalledWith({ kind: 'context', documentId })
  })

  it('rejects invalid input before snapshot capture or renderer execution', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation(
          'bad-delete',
          'office:pdf:delete_page',
          { page: 0 },
          {
            mutationGrantId: 'grant-invalid-input',
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      output: '',
      mutationOutcome: 'not_started',
      errorCode: 'invalid_tool_arguments',
      provenance: { mutationGrantId: 'grant-invalid-input' },
    })
    await expect(
      fixture.host.invoke(invocation('bad-read', 'office:pdf:read_pages', { start: 0 })),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid_tool_arguments',
    })
    expect(fixture.request).not.toHaveBeenCalled()
  })

  it('rejects an unknown catalog tool through the broker boundary', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(invocation('unknown', 'office:pdf:unknown', {})),
    ).rejects.toThrowError('tool_not_in_snapshot')
  })

  it('normalizes missing renderer and snapshot capture failures before mutation execution', async () => {
    const unavailable = new PdfOfficeToolHost({
      resolveRenderer: () => undefined,
      validateBinding: async () => true,
      validatePermissionSnapshot: async () => true,
      authorizeMutationGrant: async () => true,
    })
    await expect(
      unavailable.invoke(invocation('unavailable-read', 'office:pdf:read_pages', { start: 1 })),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const fixture = harness()
    fixture.request.mockResolvedValueOnce({
      requestId: 'snapshot-failed',
      ok: false,
      errorCode: 'tool_failed',
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'snapshot-failed',
          'office:pdf:delete_page',
          { page: 1 },
          {
            contextVersion: 'pdf-edit-7',
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'not_started',
      errorCode: 'tool_failed',
    })
  })

  it('aborts before mutation dispatch without creating a rollback point', async () => {
    const fixture = harness()
    const request = invocation(
      'abort-before-dispatch',
      'office:pdf:delete_page',
      { page: 1 },
      {
        contextVersion: 'pdf-edit-7',
      },
    )
    await expect(
      fixture.host.abort({ operationId: request.operationId, documentId }),
    ).resolves.toBe(true)
    await expect(fixture.host.invoke(request)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'tool_failed',
      mutationOutcome: 'not_started',
    })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
    expect(fixture.request.mock.calls.filter(([input]) => input.kind === 'execute')).toHaveLength(0)
  })

  it('captures one pre-commit snapshot and restores the whole parent run', async () => {
    const fixture = harness()
    const first = invocation(
      'delete-1',
      'office:pdf:delete_page',
      { page: 3 },
      {
        contextVersion: 'pdf-edit-7',
      },
    )
    const second = invocation(
      'delete-2',
      'office:pdf:delete_page',
      { page: 2 },
      {
        contextVersion: 'pdf-edit-8',
      },
    )
    await expect(fixture.host.invoke(first)).resolves.toMatchObject({
      status: 'completed',
      mutationOutcome: 'committed',
    })
    await expect(fixture.host.invoke(second)).resolves.toMatchObject({
      status: 'completed',
      mutationOutcome: 'committed',
    })
    expect(
      fixture.request.mock.calls.filter(([input]) => input.kind === 'capture_snapshot'),
    ).toHaveLength(1)

    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
    expect(fixture.request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'restore_snapshot', documentId }),
    )
  })

  it('uses the parent run rollback point for an exact granted Subagent mutation', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation(
          'child-delete',
          'office:pdf:delete_page',
          { page: 2 },
          {
            runId: 'child-run-1',
            contextVersion: 'pdf-edit-7',
            mutationGrantId: 'grant-child-delete',
            actor: {
              type: 'subagent',
              actorId: 'child-1',
              subagentRunId: 'child-run-1',
              parentRunId: 'run-1',
            },
            permissionSnapshot: {
              snapshotId: 'child-snapshot',
              createdForRunId: 'child-run-1',
              permissionVersion: 'permission-1',
              toolIds: ['office:pdf:read_pages'],
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
    expect(fixture.authorizeMutationGrant).toHaveBeenCalledOnce()
  })

  it('preserves stable renderer failures and does not register an empty rollback point', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
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
      }
      return {
        requestId: 'stale',
        ok: false as const,
        errorCode: 'stale_context' as const,
        mutationOutcome: 'not_started' as const,
      }
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'stale-delete',
          'office:pdf:delete_page',
          { page: 2 },
          {
            contextVersion: 'pdf-edit-old',
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
  })

  it('marks a renderer reload during mutation unknown and blocks every later mutation', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'reload-snapshot',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
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
      }
      throw new Error('renderer reloaded')
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'reload-unknown',
          'office:pdf:delete_page',
          { page: 2 },
          {
            contextVersion: 'pdf-edit-7',
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'unknown',
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'reload-blocked',
          'office:pdf:delete_page',
          { page: 1 },
          {
            contextVersion: 'pdf-edit-7',
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'not_started',
    })
    expect(fixture.request).toHaveBeenCalledTimes(2)
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
  })

  it('normalizes readonly response failures, wrong result kinds, and absent details', async () => {
    const fixture = harness()
    fixture.request
      .mockResolvedValueOnce({ requestId: 'read-failed', ok: false, errorCode: 'tool_failed' })
      .mockResolvedValueOnce({
        requestId: 'wrong-kind',
        ok: true,
        result: {
          kind: 'context',
          snapshot: {
            documentId,
            contextVersion: 'pdf-edit-1',
            modelContent: 'context',
            details: {
              fileName: 'file.pdf',
              originalPageCount: 1,
              currentOriginalPage: 1,
              readOnly: false,
              hasOutline: false,
              deletionGeneration: 0,
            },
          },
        },
      })
      .mockResolvedValueOnce({
        requestId: 'no-details',
        ok: true,
        result: {
          kind: 'executed',
          output: 'plain output',
          contextVersionAfter: 'pdf-edit-2',
        },
      })

    await expect(
      fixture.host.invoke(invocation('read-failed', 'office:pdf:read_pages', { start: 1 })),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    await expect(
      fixture.host.invoke(invocation('wrong-kind', 'office:pdf:read_pages', { start: 1 })),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    await expect(
      fixture.host.invoke(invocation('no-details', 'office:pdf:read_pages', { start: 1 })),
    ).resolves.toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/PDF: contract\.pdf[\s\S]*plain output/),
      contextVersionAfter: 'pdf-edit-8',
      details: { context: { fileName: 'contract.pdf' } },
    })
  })

  it('drops a non-committed snapshot and fails a malformed restore response closed', async () => {
    const rolledBack = harness()
    rolledBack.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
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
      }
      return {
        requestId: 'rolled-back',
        ok: true as const,
        result: {
          kind: 'executed' as const,
          output: '',
          contextVersionAfter: 'pdf-edit-8',
          mutationOutcome: 'rolled_back' as const,
        },
      }
    })
    await expect(
      rolledBack.host.invoke(
        invocation(
          'rolled-back',
          'office:pdf:delete_page',
          { page: 2 },
          {
            contextVersion: 'pdf-edit-7',
          },
        ),
      ),
    ).resolves.toMatchObject({ status: 'completed', mutationOutcome: 'rolled_back' })
    await expect(rolledBack.host.rollback(documentId, 'run-1')).resolves.toBe(false)

    const restoreFailure = harness()
    await restoreFailure.host.invoke(
      invocation(
        'restore-failure',
        'office:pdf:delete_page',
        { page: 2 },
        {
          contextVersion: 'pdf-edit-7',
        },
      ),
    )
    restoreFailure.request.mockResolvedValueOnce({
      requestId: 'restore-failed',
      ok: false,
      errorCode: 'tool_failed',
    })
    await expect(restoreFailure.host.rollback(documentId, 'run-1')).rejects.toThrowError(
      'executor_unavailable',
    )
  })

  it('fails closed on forged internal rollback boundaries', async () => {
    const fixture = harness()
    const restoreSnapshot = (
      fixture.host as unknown as {
        restoreSnapshot(input: {
          documentId: string
          parentRunId: string
          boundary: { kind: 'atomic' } | { kind: 'snapshot'; snapshotId: string }
        }): Promise<void>
      }
    ).restoreSnapshot.bind(fixture.host)
    await expect(
      restoreSnapshot({ documentId, parentRunId: 'run-1', boundary: { kind: 'atomic' } }),
    ).rejects.toThrowError('unsupported_office_feature')
    await expect(
      restoreSnapshot({
        documentId,
        parentRunId: 'run-1',
        boundary: { kind: 'snapshot', snapshotId: 'missing-snapshot' },
      }),
    ).rejects.toThrowError('executor_unavailable')
  })

  it('denies view effects to readonly Subagents before renderer dispatch', async () => {
    const fixture = harness()
    const request = invocation(
      'child-view',
      'office:pdf:goto_page',
      { page: 2 },
      {
        runId: 'child-run-1',
        contextVersion: 'pdf-edit-7',
        actor: {
          type: 'subagent',
          actorId: 'child-1',
          subagentRunId: 'child-run-1',
          parentRunId: 'run-1',
        },
        permissionSnapshot: {
          snapshotId: 'child-snapshot',
          createdForRunId: 'child-run-1',
          permissionVersion: 'permission-1',
          toolIds: ['office:pdf:goto_page'],
        },
      },
    )
    await expect(fixture.host.invoke(request)).rejects.toThrowError('permission_denied')
    expect(fixture.request).not.toHaveBeenCalled()
  })
})
