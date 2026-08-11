import { describe, expect, it, vi } from 'vitest'
import type { OfficeToolInvocation } from '@genoffice/agent-runtime-protocol'
import { SheetsOfficeToolHost } from '../src/main/agent-tools/sheets-office-tool-host'
import type {
  SheetsOfficeToolRequest,
  SheetsOfficeToolResponse,
} from '../src/shared/sheets-office-tools'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const snapshotToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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
  const request = vi.fn(
    async (input: SheetsOfficeToolRequest): Promise<SheetsOfficeToolResponse> => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true,
          result: { kind: 'snapshot', snapshot: { token: snapshotToken } },
        }
      }
      if (input.kind === 'restore_snapshot') {
        return {
          requestId: 'restore-response',
          ok: true,
          result: { kind: 'restored', contextVersion: 'sheets-edit-9' },
        }
      }
      if (input.kind === 'context') {
        return {
          requestId: 'context-response',
          ok: true,
          result: {
            kind: 'context',
            snapshot: {
              documentId,
              contextVersion: 'sheets-edit-8',
              modelContent: 'Active sheet: Sheet1',
              details: { mode: 'demo', sheetId: 'sheet-1', sheetName: 'Sheet1' },
            },
          },
        }
      }
      if (input.kind === 'abort') {
        return {
          requestId: 'abort-response',
          ok: true,
          result: { kind: 'aborted', aborted: true },
        }
      }
      return {
        requestId: 'execute-response',
        ok: true,
        result: {
          kind: 'executed',
          output: `${input.toolId} complete`,
          details: { renderer: true },
          contextVersionAfter: 'sheets-edit-8',
          ...(input.toolId.endsWith('propose_operations')
            ? { mutationOutcome: 'committed' as const }
            : {}),
        },
      }
    },
  )
  const openImage = vi.fn(async () => ({
    artifact: {
      artifactId: '11111111-1111-4111-8111-111111111111',
      mediaType: 'image/png' as const,
      byteLength: 4,
      sha256: 'a'.repeat(64),
    },
    bytes: Buffer.from([137, 80, 78, 71]),
    width: 1,
    height: 1,
  }))
  const resolveRenderer = vi.fn(() => ({ request }) as { request: typeof request } | undefined)
  const validateBinding = vi.fn(async () => true)
  const validatePermissionSnapshot = vi.fn(async () => true)
  const authorizeMutationGrant = vi.fn(async () => true)
  const host = new SheetsOfficeToolHost({
    resolveRenderer,
    validateBinding,
    validatePermissionSnapshot,
    authorizeMutationGrant,
    openImage,
  })
  return {
    host,
    openImage,
    request,
    resolveRenderer,
    validateBinding,
    validatePermissionSnapshot,
    authorizeMutationGrant,
  }
}

const mutationInput = {
  summary: 'Write a value',
  operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 'hello' }],
}

describe('Sheets main Office Tool host', () => {
  it('maps a renderer read into a provenance receipt with live context', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(invocation('read-1', 'office:sheets:get_workbook_context', {})),
    ).resolves.toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/Active sheet: Sheet1[\s\S]*get_workbook_context complete/),
      contextVersionAfter: 'sheets-edit-8',
      provenance: { actorId: sessionId, runId: 'run-1', documentId },
    })
  })

  it('reuses one renderer snapshot across a run and restores it', async () => {
    const fixture = harness()
    await fixture.host.invoke(
      invocation('write-1', 'office:sheets:propose_operations', mutationInput, {
        contextVersion: 'sheets-edit-7',
      }),
    )
    await fixture.host.invoke(
      invocation('write-2', 'office:sheets:propose_operations', mutationInput, {
        contextVersion: 'sheets-edit-8',
      }),
    )
    expect(
      fixture.request.mock.calls.filter(([input]) => input.kind === 'capture_snapshot'),
    ).toHaveLength(1)
    const executes = fixture.request.mock.calls.filter(([input]) => input.kind === 'execute')
    expect(executes).toHaveLength(2)
    expect(executes[0]?.[0]).toMatchObject({ snapshot: { token: snapshotToken } })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
    await expect(fixture.host.abort({ operationId: 'abort-1', documentId })).resolves.toBe(true)
  })

  it('opens every add_image ArtifactRef in the exact document and run scope', async () => {
    const fixture = harness()
    const input = {
      summary: 'Add an image',
      operations: [
        {
          op: 'add_image',
          sheetId: 'sheet-1',
          artifactId: '11111111-1111-4111-8111-111111111111',
          anchorCell: 'A1',
        },
      ],
    }
    await expect(
      fixture.host.invoke(
        invocation('image-1', 'office:sheets:propose_operations', input, {
          contextVersion: 'sheets-edit-7',
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
    expect(fixture.openImage).toHaveBeenCalledWith({
      artifactId: '11111111-1111-4111-8111-111111111111',
      documentId,
      runId: 'run-1',
    })
    const execute = fixture.request.mock.calls.find(([request]) => request.kind === 'execute')?.[0]
    expect(execute).toMatchObject({
      images: [
        {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bytes: Buffer.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      ],
    })
    expect(JSON.stringify(execute)).not.toMatch(/https?:|\/Users\/|base64/i)
  })

  it('fails closed on malformed inputs, invalid artifacts, and unknown mutation outcomes', async () => {
    const malformed = harness()
    await expect(
      malformed.host.invoke(
        invocation('bad-input', 'office:sheets:propose_operations', {
          ...mutationInput,
          extra: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid_tool_arguments',
      mutationOutcome: 'not_started',
    })
    expect(malformed.request).not.toHaveBeenCalled()

    const badArtifact = harness()
    badArtifact.openImage.mockRejectedValueOnce(new Error('artifact scope mismatch'))
    await expect(
      badArtifact.host.invoke(
        invocation(
          'bad-artifact',
          'office:sheets:propose_operations',
          {
            summary: 'Add image',
            operations: [
              {
                op: 'add_image',
                sheetId: 'sheet-1',
                artifactId: '11111111-1111-4111-8111-111111111111',
                anchorCell: 'A1',
              },
            ],
          },
          { contextVersion: 'sheets-edit-7' },
        ),
      ),
    ).resolves.toMatchObject({ errorCode: 'artifact_invalid', mutationOutcome: 'not_started' })

    const unknown = harness()
    unknown.request.mockImplementation(async (input) =>
      input.kind === 'capture_snapshot'
        ? {
            requestId: 'snapshot-response',
            ok: true,
            result: { kind: 'snapshot', snapshot: { token: snapshotToken } },
          }
        : {
            requestId: 'execute-response',
            ok: false,
            errorCode: 'tool_failed',
            mutationOutcome: 'unknown',
          },
    )
    await expect(
      unknown.host.invoke(
        invocation('unknown', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'unknown',
    })
    await expect(
      unknown.host.invoke(
        invocation('blocked', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'not_started',
    })
  })

  it('rejects unknown tools and unavailable or malformed renderer responses', async () => {
    const unsupported = harness()
    await expect(
      unsupported.host.invoke(invocation('unsupported', 'office:sheets:missing', {})),
    ).rejects.toThrow('tool_not_in_snapshot')

    const unavailable = harness()
    unavailable.resolveRenderer.mockReturnValue(undefined)
    await expect(
      unavailable.host.invoke(invocation('unavailable', 'office:sheets:get_workbook_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    await expect(unavailable.host.abort({ operationId: 'abort', documentId })).resolves.toBe(false)

    const malformed = harness()
    malformed.request.mockResolvedValueOnce({
      requestId: 'wrong',
      ok: true,
      result: { kind: 'aborted', aborted: false },
    })
    await expect(
      malformed.host.invoke(
        invocation('snapshot-malformed', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('honors an abort received before execution begins', async () => {
    const fixture = harness()
    fixture.resolveRenderer.mockReturnValue(undefined)
    await expect(fixture.host.abort({ operationId: 'pre-aborted', documentId })).resolves.toBe(
      false,
    )
    fixture.resolveRenderer.mockReturnValue({ request: fixture.request })
    await expect(
      fixture.host.invoke(invocation('pre-aborted', 'office:sheets:get_workbook_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    expect(fixture.request).not.toHaveBeenCalled()

    const mutation = harness()
    mutation.resolveRenderer.mockReturnValue(undefined)
    await mutation.host.abort({ operationId: 'pre-aborted-mutation', documentId })
    mutation.resolveRenderer.mockReturnValue({ request: mutation.request })
    await expect(
      mutation.host.invoke(
        invocation('pre-aborted-mutation', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'tool_failed',
      mutationOutcome: 'not_started',
    })
  })

  it('authorizes subagent mutation grants against the parent run snapshot', async () => {
    const fixture = harness()
    const request = invocation(
      'subagent-write',
      'office:sheets:propose_operations',
      mutationInput,
      {
        actor: {
          type: 'subagent',
          actorId: 'subagent-1',
          subagentRunId: 'subagent-run-1',
          parentRunId: 'run-1',
        },
        mutationGrantId: 'grant-1',
        contextVersion: 'sheets-edit-7',
        permissionSnapshot: {
          snapshotId: 'permission-snapshot-1',
          createdForRunId: 'run-1',
          permissionVersion: 'permission-1',
          toolIds: [],
        },
      },
    )
    await expect(fixture.host.invoke(request)).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.authorizeMutationGrant).toHaveBeenCalledOnce()
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
  })

  it('maps renderer failures and non-object details without leaking a stale boundary', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true,
          result: { kind: 'snapshot', snapshot: { token: snapshotToken } },
        }
      }
      return {
        requestId: 'execute-response',
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    })
    await expect(
      fixture.host.invoke(
        invocation('not-started', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)

    const read = harness()
    read.request.mockImplementation(async (input) => {
      if (input.kind === 'context') {
        return {
          requestId: 'context-response',
          ok: true,
          result: {
            kind: 'context',
            snapshot: {
              documentId,
              contextVersion: 'sheets-edit-8',
              modelContent: 'context',
              details: { mode: 'demo', sheetId: 'sheet-1', sheetName: 'Sheet1' },
            },
          },
        }
      }
      return {
        requestId: 'execute-response',
        ok: true,
        result: {
          kind: 'executed',
          output: 'read',
          details: 'plain details',
          contextVersionAfter: 'sheets-edit-8',
        },
      }
    })
    await expect(
      read.host.invoke(invocation('plain-details', 'office:sheets:get_workbook_context', {})),
    ).resolves.toMatchObject({ status: 'completed', details: { context: expect.any(Object) } })

    const failedRead = harness()
    failedRead.request.mockResolvedValueOnce({
      requestId: 'failed-read',
      ok: false,
      errorCode: 'tool_failed',
    })
    await expect(
      failedRead.host.invoke(invocation('failed-read', 'office:sheets:get_workbook_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const nonCommitted = harness()
    nonCommitted.request
      .mockResolvedValueOnce({
        requestId: 'snapshot',
        ok: true,
        result: { kind: 'snapshot', snapshot: { token: snapshotToken } },
      })
      .mockResolvedValueOnce({
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'not committed',
          details: 'plain details',
          contextVersionAfter: 'sheets-edit-1',
        },
      })
    await expect(
      nonCommitted.host.invoke(
        invocation('non-committed', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', mutationOutcome: 'unknown' })

    const noDetails = harness()
    noDetails.request
      .mockResolvedValueOnce({
        requestId: 'snapshot',
        ok: true,
        result: { kind: 'snapshot', snapshot: { token: snapshotToken } },
      })
      .mockResolvedValueOnce({
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'committed',
          contextVersionAfter: 'sheets-edit-2',
          mutationOutcome: 'committed',
        },
      })
    await expect(
      noDetails.host.invoke(
        invocation('no-details', 'office:sheets:propose_operations', mutationInput, {
          contextVersion: 'sheets-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
  })

  it('fails closed when execute or context response kinds do not match', async () => {
    const wrongExecute = harness()
    wrongExecute.request.mockResolvedValueOnce({
      requestId: 'wrong',
      ok: true,
      result: { kind: 'aborted', aborted: false },
    })
    await expect(
      wrongExecute.host.invoke(
        invocation('wrong-execute', 'office:sheets:get_workbook_context', {}),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const wrongContext = harness()
    wrongContext.request
      .mockResolvedValueOnce({
        requestId: 'execute',
        ok: true,
        result: { kind: 'executed', output: 'read', contextVersionAfter: 'v1' },
      })
      .mockResolvedValueOnce({
        requestId: 'context',
        ok: true,
        result: { kind: 'aborted', aborted: false },
      })
    await expect(
      wrongContext.host.invoke(
        invocation('wrong-context', 'office:sheets:get_workbook_context', {}),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('keeps rollback boundaries when renderer restoration fails', async () => {
    const wrongKind = harness()
    await wrongKind.host.invoke(
      invocation('write-before-wrong-restore', 'office:sheets:propose_operations', mutationInput, {
        contextVersion: 'sheets-edit-1',
      }),
    )
    wrongKind.request.mockResolvedValueOnce({
      requestId: 'restore',
      ok: true,
      result: { kind: 'aborted', aborted: false },
    })
    await expect(wrongKind.host.rollback(documentId, 'run-1')).rejects.toThrow(
      'executor_unavailable',
    )

    const error = harness()
    await error.host.invoke(
      invocation('write-before-error-restore', 'office:sheets:propose_operations', mutationInput, {
        contextVersion: 'sheets-edit-1',
      }),
    )
    error.request.mockResolvedValueOnce({
      requestId: 'restore',
      ok: false,
      errorCode: 'stale_context',
    })
    await expect(error.host.rollback(documentId, 'run-1')).rejects.toThrow('stale_context')
  })

  it('preserves mutation grant provenance on parser failures', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation(
          'bad-granted-input',
          'office:sheets:propose_operations',
          { ...mutationInput, extra: true },
          { mutationGrantId: 'grant-1' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'not_started',
      provenance: { mutationGrantId: 'grant-1' },
    })

    const failedRead = await fixture.host.invoke(
      invocation('bad-read-input', 'office:sheets:get_workbook_context', { extra: true }),
    )
    expect(failedRead).toMatchObject({ status: 'failed' })
    expect(failedRead).not.toHaveProperty('mutationOutcome')
  })
})
