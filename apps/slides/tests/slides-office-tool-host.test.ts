import { describe, expect, it, vi } from 'vitest'
import type { OfficeToolInvocation } from '@genoffice/agent-runtime-protocol'
import { SlidesOfficeToolHost } from '../src/main/agent-tools/slides-office-tool-host'
import type {
  SlidesOfficeToolRequest,
  SlidesOfficeToolResponse,
} from '../src/shared/slides-office-tools'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const artifactId = '11111111-1111-4111-8111-111111111111'

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
      snapshotId: 'permission-1',
      createdForRunId: 'run-1',
      permissionVersion: 'v1',
      toolIds: [toolId],
    },
    input,
    ...overrides,
  }
}

function harness() {
  const request = vi.fn(
    async (input: SlidesOfficeToolRequest): Promise<SlidesOfficeToolResponse> => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot',
          ok: true,
          result: { kind: 'snapshot', snapshot: { token } },
        }
      }
      if (input.kind === 'restore_snapshot') {
        return {
          requestId: 'restore',
          ok: true,
          result: { kind: 'restored', contextVersion: 'slides-edit-9' },
        }
      }
      if (input.kind === 'context') {
        return {
          requestId: 'context',
          ok: true,
          result: {
            kind: 'context',
            snapshot: {
              documentId,
              contextVersion: 'slides-edit-8',
              modelContent: 'Deck: three slides',
              details: { slideCount: 3, currentSlide: 0, selectedIds: [] },
            },
          },
        }
      }
      if (input.kind === 'abort') {
        return { requestId: 'abort', ok: true, result: { kind: 'aborted', aborted: true } }
      }
      const mutation =
        !input.toolId.endsWith('get_deck_context') && !input.toolId.endsWith('read_slide')
      return {
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: `${input.toolId} complete`,
          details: { renderer: true },
          contextVersionAfter: 'slides-edit-8',
          ...(mutation ? { mutationOutcome: 'committed' as const } : {}),
        },
      }
    },
  )
  const openImage = vi.fn(async () => ({
    artifact: {
      artifactId,
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
  const host = new SlidesOfficeToolHost({
    resolveRenderer,
    validateBinding,
    validatePermissionSnapshot,
    authorizeMutationGrant,
    openImage,
  })
  return {
    host,
    request,
    openImage,
    resolveRenderer,
    authorizeMutationGrant,
  }
}

const mutationInput = { slideIndex: 0, sourceId: 'shape-1', fill: '#112233' }

describe('Slides main Office Tool host', () => {
  it('maps a read into a provenance receipt with fresh deck context', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(invocation('read', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/Deck: three slides[\s\S]*get_deck_context complete/),
      contextVersionAfter: 'slides-edit-8',
      provenance: { actorId: sessionId, runId: 'run-1', documentId },
    })
  })

  it('reuses the first renderer snapshot across a run and restores it', async () => {
    const fixture = harness()
    await fixture.host.invoke(
      invocation('write-1', 'office:slides:set_element_fill', mutationInput, {
        contextVersion: 'slides-edit-7',
      }),
    )
    await fixture.host.invoke(
      invocation('write-2', 'office:slides:set_element_fill', mutationInput, {
        contextVersion: 'slides-edit-8',
      }),
    )
    expect(
      fixture.request.mock.calls.filter(([input]) => input.kind === 'capture_snapshot'),
    ).toHaveLength(1)
    expect(fixture.request.mock.calls.filter(([input]) => input.kind === 'execute')).toHaveLength(2)
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
    await expect(fixture.host.abort({ operationId: 'abort', documentId })).resolves.toBe(true)
  })

  it('opens image ArtifactRefs in the exact document and run scope', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation(
          'image',
          'office:slides:insert_image',
          { slideIndex: 0, artifactId, x: 0, y: 0, w: 100, h: 100 },
          { contextVersion: 'slides-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
    expect(fixture.openImage).toHaveBeenCalledWith({ artifactId, documentId, runId: 'run-1' })
    const execute = fixture.request.mock.calls.find(([input]) => input.kind === 'execute')?.[0]
    expect(execute).toMatchObject({ images: [{ artifactId, mediaType: 'image/png' }] })
    expect(JSON.stringify(execute)).not.toMatch(/https?:|\/Users\//i)
  })

  it('fails closed on malformed arguments and invalid scoped artifacts', async () => {
    const malformed = harness()
    await expect(
      malformed.host.invoke(
        invocation('bad', 'office:slides:set_element_fill', { ...mutationInput, path: '/tmp/x' }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid_tool_arguments',
      mutationOutcome: 'not_started',
    })
    expect(malformed.request).not.toHaveBeenCalled()
    await expect(
      malformed.host.invoke(
        invocation('bad-read', 'office:slides:read_slide', { slideIndex: 0, url: 'https://x' }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'invalid_tool_arguments' })

    const invalid = harness()
    invalid.openImage.mockRejectedValueOnce(new Error('scope mismatch'))
    await expect(
      invalid.host.invoke(
        invocation(
          'bad-image',
          'office:slides:set_slide_background',
          { slideIndex: 0, artifactId },
          { contextVersion: 'slides-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({ errorCode: 'artifact_invalid', mutationOutcome: 'not_started' })
  })

  it('blocks an unknown mutation outcome and a repeated run mutation', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) =>
      input.kind === 'capture_snapshot'
        ? { requestId: 'snapshot', ok: true, result: { kind: 'snapshot', snapshot: { token } } }
        : { requestId: 'execute', ok: false, errorCode: 'tool_failed', mutationOutcome: 'unknown' },
    )
    await expect(
      fixture.host.invoke(
        invocation('unknown', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ errorCode: 'mutation_outcome_unknown', mutationOutcome: 'unknown' })
    await expect(
      fixture.host.invoke(
        invocation('blocked', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'not_started',
    })
  })

  it('rejects unknown tools, missing renderers and malformed snapshot responses', async () => {
    const unknown = harness()
    await expect(
      unknown.host.invoke(invocation('unknown', 'office:slides:execute_layout_script', {})),
    ).rejects.toThrow('tool_not_in_snapshot')

    const unavailable = harness()
    unavailable.resolveRenderer.mockReturnValue(undefined)
    await expect(
      unavailable.host.invoke(invocation('read', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    await expect(unavailable.host.abort({ operationId: 'x', documentId })).resolves.toBe(false)

    const malformed = harness()
    malformed.request.mockResolvedValueOnce({
      requestId: 'bad',
      ok: true,
      result: { kind: 'aborted', aborted: false },
    })
    await expect(
      malformed.host.invoke(
        invocation('write', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('honors pre-abort and authorizes a subagent mutation against the parent run', async () => {
    const aborted = harness()
    aborted.resolveRenderer.mockReturnValue(undefined)
    await aborted.host.abort({ operationId: 'pre', documentId })
    aborted.resolveRenderer.mockReturnValue({ request: aborted.request })
    await expect(
      aborted.host.invoke(invocation('pre', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    expect(aborted.request).not.toHaveBeenCalled()

    const abortedMutation = harness()
    abortedMutation.resolveRenderer.mockReturnValue(undefined)
    await abortedMutation.host.abort({ operationId: 'pre-write', documentId })
    abortedMutation.resolveRenderer.mockReturnValue({ request: abortedMutation.request })
    await expect(
      abortedMutation.host.invoke(
        invocation('pre-write', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ mutationOutcome: 'not_started' })

    const subagent = harness()
    await expect(
      subagent.host.invoke(
        invocation('subagent', 'office:slides:set_element_fill', mutationInput, {
          actor: {
            type: 'subagent',
            actorId: 'subagent-1',
            subagentRunId: 'subagent-run-1',
            parentRunId: 'run-1',
          },
          mutationGrantId: 'grant-1',
          contextVersion: 'slides-edit-1',
          permissionSnapshot: {
            snapshotId: 'permission-1',
            createdForRunId: 'run-1',
            permissionVersion: 'v1',
            toolIds: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 'completed' })
    expect(subagent.authorizeMutationGrant).toHaveBeenCalledOnce()
    await expect(subagent.host.rollback(documentId, 'run-1')).resolves.toBe(true)
  })

  it('maps renderer not-started failures and malformed read context', async () => {
    const notStarted = harness()
    notStarted.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot',
          ok: true,
          result: { kind: 'snapshot', snapshot: { token } },
        }
      }
      return {
        requestId: 'execute',
        ok: false,
        errorCode: 'stale_context',
        mutationOutcome: 'not_started',
      }
    })
    await expect(
      notStarted.host.invoke(
        invocation('stale', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ errorCode: 'stale_context', mutationOutcome: 'not_started' })
    await expect(notStarted.host.rollback(documentId, 'run-1')).resolves.toBe(false)

    const badContext = harness()
    badContext.request.mockImplementation(async (input) => {
      if (input.kind === 'execute') {
        return {
          requestId: 'execute',
          ok: true,
          result: { kind: 'executed', output: 'read', details: 'plain', contextVersionAfter: 'v1' },
        }
      }
      return { requestId: 'context', ok: false, errorCode: 'tool_failed' }
    })
    await expect(
      badContext.host.invoke(invocation('read', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('fails rollback closed on renderer errors and unexpected response kinds', async () => {
    for (const restoreResponse of [
      { requestId: 'restore', ok: false, errorCode: 'tool_failed' } as const,
      { requestId: 'restore', ok: true, result: { kind: 'aborted', aborted: false } } as const,
    ]) {
      const fixture = harness()
      await fixture.host.invoke(
        invocation('write', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      )
      fixture.request.mockResolvedValueOnce(restoreResponse)
      await expect(fixture.host.rollback(documentId, 'run-1')).rejects.toThrow()
    }
  })

  it('drops an uncommitted renderer boundary and preserves optional result shapes', async () => {
    const uncommitted = harness()
    uncommitted.request
      .mockResolvedValueOnce({
        requestId: 'snapshot',
        ok: true,
        result: { kind: 'snapshot', snapshot: { token } },
      })
      .mockResolvedValueOnce({
        requestId: 'execute',
        ok: true,
        result: {
          kind: 'executed',
          output: 'no commit',
          contextVersionAfter: 'slides-edit-1',
        },
      })
    await expect(
      uncommitted.host.invoke(
        invocation('write', 'office:slides:set_element_fill', mutationInput, {
          contextVersion: 'slides-edit-1',
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed' })
    await expect(uncommitted.host.rollback(documentId, 'run-1')).resolves.toBe(false)

    const read = harness()
    read.request.mockImplementation(async (input) => {
      if (input.kind === 'context') {
        return {
          requestId: 'context',
          ok: true,
          result: {
            kind: 'context',
            snapshot: {
              documentId,
              contextVersion: 'v1',
              modelContent: 'context',
              details: { slideCount: 1, currentSlide: 0, selectedIds: [] },
            },
          },
        }
      }
      return {
        requestId: 'execute',
        ok: true,
        result: { kind: 'executed', output: 'read', contextVersionAfter: 'v1' },
      }
    })
    await expect(
      read.host.invoke(invocation('read', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({ status: 'completed', details: { context: expect.any(Object) } })
  })

  it('maps read execution failures and unexpected execute responses without mutation metadata', async () => {
    const failed = harness()
    failed.request.mockResolvedValueOnce({
      requestId: 'execute',
      ok: false,
      errorCode: 'tool_failed',
    })
    const failedReceipt = await failed.host.invoke(
      invocation('read', 'office:slides:get_deck_context', {}),
    )
    expect(failedReceipt).toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
    expect(failedReceipt).not.toHaveProperty('mutationOutcome')

    const unexpected = harness()
    unexpected.request.mockResolvedValueOnce({
      requestId: 'execute',
      ok: true,
      result: { kind: 'aborted', aborted: false },
    })
    await expect(
      unexpected.host.invoke(invocation('read', 'office:slides:get_deck_context', {})),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('fails closed when an internal rollback boundary is missing', async () => {
    const fixture = harness()
    const internal = fixture.host as unknown as {
      restoreSnapshot(input: {
        documentId: string
        parentRunId: string
        boundary: { kind: 'snapshot'; snapshotId: string }
      }): Promise<void>
    }
    await expect(
      internal.restoreSnapshot({
        documentId,
        parentRunId: 'run-1',
        boundary: { kind: 'snapshot', snapshotId: 'missing' },
      }),
    ).rejects.toThrow('executor_unavailable')
  })
})
