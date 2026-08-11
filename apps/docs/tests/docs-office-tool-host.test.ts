import { describe, expect, it, vi } from 'vitest'
import type { OfficeToolInvocation } from '@genoffice/agent-runtime-protocol'
import { DocsOfficeToolHost } from '../src/main/agent-tools/docs-office-tool-host'
import type { DocsOfficeToolRequest, DocsOfficeToolResponse } from '../src/shared/docs-office-tools'

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
  const request = vi.fn(async (input: DocsOfficeToolRequest): Promise<DocsOfficeToolResponse> => {
    if (input.kind === 'capture_snapshot') {
      return {
        requestId: 'snapshot-response',
        ok: true as const,
        result: {
          kind: 'snapshot' as const,
          snapshot: { doc: { type: 'doc' }, selection: { from: 1, to: 1 } },
        },
      }
    }
    if (input.kind === 'restore_snapshot') {
      return {
        requestId: 'restore-response',
        ok: true as const,
        result: { kind: 'restored' as const, contextVersion: 'docs-edit-9' },
      }
    }
    if (input.kind === 'context') {
      return {
        requestId: 'context-response',
        ok: true as const,
        result: {
          kind: 'context' as const,
          snapshot: {
            documentId,
            contextVersion: 'docs-edit-8',
            modelContent: 'Blocks: 2\nSelection: 1-1',
            details: { blockCount: 2, selection: { from: 1, to: 1 } },
          },
        },
      }
    }
    if (input.kind === 'abort') {
      return {
        requestId: 'abort-response',
        ok: true as const,
        result: { kind: 'aborted' as const, aborted: true },
      }
    }
    return {
      requestId: 'execute-response',
      ok: true as const,
      result: {
        kind: 'executed' as const,
        output: `${input.toolId} complete`,
        details: { renderer: 'passive' },
        contextVersionAfter: 'docs-edit-8',
        ...(input.toolId.endsWith('insert_image') ? { mutationOutcome: 'committed' as const } : {}),
      },
    }
  })
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
  const host = new DocsOfficeToolHost({
    resolveRenderer: () => ({ request }),
    validateBinding: async () => true,
    validatePermissionSnapshot: async () => true,
    authorizeMutationGrant: async () => true,
    openImage,
  })
  return { host, openImage, request }
}

describe('Docs main Office Tool host', () => {
  it('maps a renderer read into a provenance receipt with live freshness', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation('read-1', 'office:docs:read_blocks', {
          startBlockIndex: 0,
          endBlockIndex: 1,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: expect.stringMatching(/Blocks: 2[\s\S]*office:docs:read_blocks complete/),
      contextVersionAfter: 'docs-edit-8',
      provenance: { actorId: sessionId, runId: 'run-1', documentId },
    })
  })

  it('opens an ArtifactRef in the exact document/run scope and sends only trusted bytes', async () => {
    const fixture = harness()
    const result = await fixture.host.invoke(
      invocation(
        'image-1',
        'office:docs:insert_image',
        { artifactId: '11111111-1111-4111-8111-111111111111', maxWidthPx: 480 },
        { contextVersion: 'docs-edit-7' },
      ),
    )
    expect(result).toMatchObject({ status: 'completed', mutationOutcome: 'committed' })
    expect(fixture.openImage).toHaveBeenCalledWith({
      artifactId: '11111111-1111-4111-8111-111111111111',
      documentId,
      runId: 'run-1',
    })
    const execute = fixture.request.mock.calls.find(([input]) => input.kind === 'execute')?.[0]
    expect(execute).toMatchObject({
      input: { artifactId: '11111111-1111-4111-8111-111111111111', maxWidthPx: 480 },
      image: {
        bytes: Buffer.from([137, 80, 78, 71]),
        mediaType: 'image/png',
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      },
    })
    expect(JSON.stringify(execute)).not.toMatch(/https?:|\/Users\/|base64/i)
  })

  it('rejects URL-shaped input and invalid artifacts before renderer mutation', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(
        invocation(
          'bad-input',
          'office:docs:insert_image',
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            url: 'https://example.test/image.png',
          },
          { contextVersion: 'docs-edit-7' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid_tool_arguments',
      mutationOutcome: 'not_started',
    })
    expect(fixture.request).not.toHaveBeenCalled()

    fixture.openImage.mockRejectedValueOnce(new Error('artifact scope mismatch'))
    await expect(
      fixture.host.invoke(
        invocation(
          'bad-artifact',
          'office:docs:insert_image',
          { artifactId: '11111111-1111-4111-8111-111111111111' },
          { contextVersion: 'docs-edit-7' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'artifact_invalid',
      mutationOutcome: 'not_started',
    })
    expect(fixture.request.mock.calls.filter(([input]) => input.kind === 'execute')).toHaveLength(0)
  })

  it('captures one run snapshot, restores it and forwards abort', async () => {
    const fixture = harness()
    const first = invocation(
      'insert-1',
      'office:docs:insert_content',
      { html: '<p>first</p>' },
      { contextVersion: 'docs-edit-7' },
    )
    const second = invocation(
      'insert-2',
      'office:docs:insert_content',
      { html: '<p>second</p>' },
      { contextVersion: 'docs-edit-8' },
    )
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
            snapshot: { doc: { type: 'doc' }, selection: { from: 1, to: 1 } },
          },
        }
      }
      if (input.kind === 'restore_snapshot') {
        return {
          requestId: 'restore-response',
          ok: true as const,
          result: { kind: 'restored' as const, contextVersion: 'docs-edit-9' },
        }
      }
      if (input.kind === 'abort') {
        return {
          requestId: 'abort-response',
          ok: true as const,
          result: { kind: 'aborted' as const, aborted: true },
        }
      }
      return {
        requestId: 'execute-response',
        ok: true as const,
        result: {
          kind: 'executed' as const,
          output: 'inserted',
          details: { renderer: 'passive' },
          contextVersionAfter: 'docs-edit-8',
          mutationOutcome: 'committed' as const,
        },
      }
    })
    await fixture.host.invoke(first)
    await fixture.host.invoke(second)
    expect(
      fixture.request.mock.calls.filter(([input]) => input.kind === 'capture_snapshot'),
    ).toHaveLength(1)
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(true)
    await expect(fixture.host.abort({ operationId: 'abort-1', documentId })).resolves.toBe(true)
  })

  it('fails closed for unknown tools, missing renderers and a pre-aborted operation', async () => {
    const fixture = harness()
    await expect(
      fixture.host.invoke(invocation('unknown-1', 'office:docs:unknown', {})),
    ).rejects.toThrow('tool_not_in_snapshot')

    await fixture.host.abort({ operationId: 'aborted-read', documentId })
    await expect(
      fixture.host.invoke(
        invocation('aborted-read', 'office:docs:read_blocks', {
          startBlockIndex: 0,
          endBlockIndex: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const unavailable = new DocsOfficeToolHost({
      resolveRenderer: () => undefined,
      validateBinding: async () => true,
      validatePermissionSnapshot: async () => true,
      authorizeMutationGrant: async () => true,
      openImage: vi.fn(),
    })
    await expect(unavailable.abort({ operationId: 'missing', documentId })).resolves.toBe(false)
    await expect(
      unavailable.invoke(
        invocation('missing-read', 'office:docs:read_blocks', {
          startBlockIndex: 0,
          endBlockIndex: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('maps renderer failures without discarding an unknown mutation snapshot', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
            snapshot: { doc: { type: 'doc' }, selection: { from: 1, to: 1 } },
          },
        }
      }
      if (input.kind === 'restore_snapshot') {
        return {
          requestId: 'restore-response',
          ok: true as const,
          result: { kind: 'restored' as const, contextVersion: 'docs-edit-9' },
        }
      }
      return {
        requestId: 'execute-response',
        ok: false as const,
        errorCode: 'tool_failed' as const,
        mutationOutcome: 'unknown' as const,
      }
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'unknown-outcome',
          'office:docs:insert_content',
          { html: '<p>maybe</p>' },
          { contextVersion: 'docs-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'unknown',
    })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
    await expect(
      fixture.host.invoke(
        invocation(
          'blocked-after-unknown',
          'office:docs:insert_content',
          { html: '<p>blocked</p>' },
          { contextVersion: 'docs-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'not_started',
    })
  })

  it('drops a not-started mutation boundary and rejects malformed renderer responses', async () => {
    const notStarted = harness()
    notStarted.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
            snapshot: { doc: { type: 'doc' }, selection: { from: 1, to: 1 } },
          },
        }
      }
      return {
        requestId: 'execute-response',
        ok: false as const,
        errorCode: 'stale_context' as const,
        mutationOutcome: 'not_started' as const,
      }
    })
    await expect(
      notStarted.host.invoke(
        invocation(
          'stale-mutation',
          'office:docs:insert_content',
          { html: '<p>new</p>' },
          { contextVersion: 'stale' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'stale_context',
      mutationOutcome: 'not_started',
    })
    await expect(notStarted.host.rollback(documentId, 'run-1')).resolves.toBe(false)

    const malformed = harness()
    malformed.request.mockResolvedValueOnce({
      requestId: 'wrong-kind',
      ok: true as const,
      result: { kind: 'aborted' as const, aborted: false },
    })
    await expect(
      malformed.host.invoke(
        invocation(
          'bad-snapshot',
          'office:docs:insert_content',
          { html: '<p>new</p>' },
          { contextVersion: 'docs-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('uses the parent run for a granted subagent snapshot', async () => {
    const fixture = harness()
    await fixture.host.invoke(
      invocation(
        'subagent-mutation',
        'office:docs:insert_image',
        { artifactId: '11111111-1111-4111-8111-111111111111' },
        {
          runId: 'child-run',
          contextVersion: 'docs-edit-1',
          actor: {
            type: 'subagent',
            actorId: 'subagent-1',
            subagentRunId: 'child-run',
            parentRunId: 'parent-run',
          },
          mutationGrantId: 'grant-1',
          permissionSnapshot: {
            snapshotId: 'child-permission',
            createdForRunId: 'child-run',
            permissionVersion: 'permission-1',
            toolIds: [],
          },
        },
      ),
    )
    await expect(fixture.host.rollback(documentId, 'parent-run')).resolves.toBe(true)
  })

  it('fails closed across abort, read-context and rollback response variants', async () => {
    const abortFailed = harness()
    abortFailed.request.mockResolvedValueOnce({
      requestId: 'abort-failed',
      ok: false as const,
      errorCode: 'tool_failed' as const,
    })
    await expect(abortFailed.host.abort({ operationId: 'abort-failed', documentId })).resolves.toBe(
      false,
    )

    const abortNotActive = harness()
    abortNotActive.request.mockResolvedValueOnce({
      requestId: 'abort-inactive',
      ok: true as const,
      result: { kind: 'aborted' as const, aborted: false },
    })
    await expect(
      abortNotActive.host.abort({ operationId: 'abort-inactive', documentId }),
    ).resolves.toBe(false)

    const readFailed = harness()
    readFailed.request.mockResolvedValueOnce({
      requestId: 'read-failed',
      ok: false as const,
      errorCode: 'tool_failed' as const,
    })
    await expect(
      readFailed.host.invoke(
        invocation('read-failed', 'office:docs:read_blocks', {
          startBlockIndex: 0,
          endBlockIndex: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const contextFailed = harness()
    contextFailed.request
      .mockResolvedValueOnce({
        requestId: 'read-executed',
        ok: true as const,
        result: {
          kind: 'executed' as const,
          output: 'read',
          contextVersionAfter: 'docs-edit-1',
        },
      })
      .mockResolvedValueOnce({
        requestId: 'context-failed',
        ok: false as const,
        errorCode: 'tool_failed' as const,
      })
    await expect(
      contextFailed.host.invoke(
        invocation('context-failed', 'office:docs:read_blocks', {
          startBlockIndex: 0,
          endBlockIndex: 0,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })

    const rollbackFailed = harness()
    await rollbackFailed.host.invoke(
      invocation(
        'committed-image',
        'office:docs:insert_image',
        { artifactId: '11111111-1111-4111-8111-111111111111' },
        { contextVersion: 'docs-edit-1' },
      ),
    )
    rollbackFailed.request.mockResolvedValueOnce({
      requestId: 'restore-failed',
      ok: false as const,
      errorCode: 'tool_failed' as const,
    })
    await expect(rollbackFailed.host.rollback(documentId, 'run-1')).rejects.toThrow(
      'executor_unavailable',
    )
  })

  it('treats a successful mutation response without commit proof as unknown', async () => {
    const fixture = harness()
    fixture.request.mockImplementation(async (input) => {
      if (input.kind === 'capture_snapshot') {
        return {
          requestId: 'snapshot-response',
          ok: true as const,
          result: {
            kind: 'snapshot' as const,
            snapshot: { doc: { type: 'doc' }, selection: { from: 1, to: 1 } },
          },
        }
      }
      return {
        requestId: 'execute-response',
        ok: true as const,
        result: {
          kind: 'executed' as const,
          output: 'ambiguous',
          contextVersionAfter: 'docs-edit-2',
        },
      }
    })
    await expect(
      fixture.host.invoke(
        invocation(
          'missing-commit-proof',
          'office:docs:insert_content',
          { html: '<p>new</p>' },
          { contextVersion: 'docs-edit-1' },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'mutation_outcome_unknown',
      mutationOutcome: 'unknown',
    })
    await expect(fixture.host.rollback(documentId, 'run-1')).resolves.toBe(false)
  })
})
