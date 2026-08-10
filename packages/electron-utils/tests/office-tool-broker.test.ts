import { describe, expect, it, vi } from 'vitest'
import {
  OfficeToolBroker,
  OfficeToolBrokerError,
  type OfficeMutationBoundary,
  type OfficeMutationOutcome,
  type OfficeToolDescriptor,
  type OfficeToolInvocation,
} from '../src'

const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const otherDocumentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

function invocation(
  operationId: string,
  overrides: Partial<OfficeToolInvocation> = {},
): OfficeToolInvocation {
  const sessionId = overrides.sessionId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const runId = overrides.runId ?? 'run-1'
  return {
    operationId,
    sessionId,
    documentId,
    runId,
    toolCallId: `call-${operationId}`,
    toolId: 'office:docs:write',
    toolOrder: 0,
    actor: { type: 'parent', actorId: 'parent-1', sessionId },
    permissionSnapshot: {
      snapshotId: `snapshot-${operationId}`,
      createdForRunId: runId,
      permissionVersion: 'permission-1',
      toolIds: ['office:docs:write', 'office:docs:read'],
    },
    input: { value: operationId },
    ...overrides,
  }
}

function harness() {
  const descriptors = new Map([
    [
      'office:docs:write',
      {
        id: 'office:docs:write',
        effect: 'mutation' as const,
        mutationBoundary: 'snapshot' as const,
      },
    ],
    [
      'office:docs:atomic',
      {
        id: 'office:docs:atomic',
        effect: 'mutation' as const,
        mutationBoundary: 'atomic' as const,
      },
    ],
    [
      'office:docs:read',
      { id: 'office:docs:read', effect: 'read' as const, mutationBoundary: 'none' as const },
    ],
  ])
  const validateBinding = vi.fn(async () => true)
  const validatePermissionSnapshot = vi.fn(async () => true)
  const authorizeActor = vi.fn(async () => true)
  const authorizeMutationGrant = vi.fn(async () => true)
  const captureSnapshot = vi.fn(async (request: OfficeToolInvocation) => ({
    kind: 'snapshot' as const,
    snapshotId: `rollback-${request.runId}`,
  }))
  const execute = vi.fn(
    async (
      request: OfficeToolInvocation,
      _descriptor: OfficeToolDescriptor,
      _boundary?: OfficeMutationBoundary,
    ): Promise<{ output: string; mutationOutcome?: OfficeMutationOutcome }> => ({
      output: request.toolCallId,
      mutationOutcome: 'committed',
    }),
  )
  const broker = new OfficeToolBroker({
    resolveDescriptor: (toolId) => descriptors.get(toolId),
    validateBinding,
    validatePermissionSnapshot,
    authorizeActor,
    authorizeMutationGrant,
    captureSnapshot,
    execute,
  })
  return {
    authorizeActor,
    authorizeMutationGrant,
    broker,
    captureSnapshot,
    execute,
    validateBinding,
    validatePermissionSnapshot,
  }
}

describe('Electron main OfficeToolBroker', () => {
  it('serializes mutations by document across Sessions and actors while another document runs', async () => {
    const fixture = harness()
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    fixture.execute.mockImplementation(async (request) => {
      started.push(request.toolCallId)
      if (request.toolCallId === 'call-op-1') await firstBlocked
      return { output: request.toolCallId, mutationOutcome: 'committed' }
    })
    const first = fixture.broker.invoke(invocation('op-1'))
    const second = fixture.broker.invoke(
      invocation('op-2', {
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        runId: 'run-2',
        actor: {
          type: 'subagent',
          actorId: 'subagent-1',
          subagentRunId: 'subagent-run-1',
          parentRunId: 'run-1',
        },
        mutationGrantId: 'grant-1',
        permissionSnapshot: {
          snapshotId: 'snapshot-op-2',
          createdForRunId: 'run-2',
          permissionVersion: 'permission-1',
          toolIds: ['office:docs:read'],
        },
      }),
    )
    const otherDocument = fixture.broker.invoke(
      invocation('op-3', { documentId: otherDocumentId, runId: 'run-3' }),
    )

    await vi.waitFor(() => expect(started).toContain('call-op-3'))
    expect(started).not.toContain('call-op-2')
    releaseFirst()
    await expect(Promise.all([first, second, otherDocument])).resolves.toHaveLength(3)
    expect(started.indexOf('call-op-1')).toBeLessThan(started.indexOf('call-op-2'))
    expect(fixture.validateBinding).toHaveBeenCalledTimes(3)
    expect(fixture.validatePermissionSnapshot).toHaveBeenCalledTimes(3)
    expect(fixture.authorizeActor).toHaveBeenCalledTimes(3)
    expect(fixture.authorizeMutationGrant).toHaveBeenCalledOnce()
    expect(fixture.captureSnapshot).toHaveBeenCalledTimes(2)
  })

  it('runs readonly tools concurrently without entering the document mutation queue', async () => {
    const fixture = harness()
    let releaseReads!: () => void
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const started: string[] = []
    fixture.execute.mockImplementation(async (request) => {
      started.push(request.toolCallId)
      await readsBlocked
      return { output: request.toolCallId }
    })
    const first = fixture.broker.invoke(
      invocation('read-1', { toolId: 'office:docs:read', toolOrder: 1 }),
    )
    const second = fixture.broker.invoke(
      invocation('read-2', { toolId: 'office:docs:read', toolOrder: 2 }),
    )
    await vi.waitFor(() => expect(started).toHaveLength(2))
    releaseReads()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fixture.captureSnapshot).not.toHaveBeenCalled()
  })

  it('returns the original receipt for a deterministic retry and rejects payload drift', async () => {
    const fixture = harness()
    const request = invocation('same-operation')
    const first = fixture.broker.invoke(request)
    expect(fixture.broker.invoke(request)).toBe(first)
    await expect(first).resolves.toMatchObject({ mutationOutcome: 'committed' })
    expect(fixture.execute).toHaveBeenCalledOnce()
    expect(() => fixture.broker.invoke({ ...request, input: { value: 'drift' } })).toThrowError(
      'duplicate_operation_mismatch',
    )
  })

  it('blocks later mutations after an unknown outcome without replaying the executor', async () => {
    const fixture = harness()
    fixture.execute.mockResolvedValueOnce({ output: '', mutationOutcome: 'unknown' })
    await expect(fixture.broker.invoke(invocation('unknown-1'))).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'unknown',
      errorCode: 'mutation_outcome_unknown',
    })
    await expect(fixture.broker.invoke(invocation('blocked-2'))).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'not_started',
      errorCode: 'mutation_outcome_unknown',
    })
    expect(fixture.execute).toHaveBeenCalledOnce()
  })

  it('marks a thrown mutation executor as unknown and does not replay it', async () => {
    const fixture = harness()
    fixture.execute.mockRejectedValueOnce(new Error('response lost'))
    const request = invocation('lost-response')
    await expect(fixture.broker.invoke(request)).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'unknown',
      errorCode: 'mutation_outcome_unknown',
    })
    await expect(fixture.broker.invoke(request)).resolves.toMatchObject({
      mutationOutcome: 'unknown',
    })
    expect(fixture.execute).toHaveBeenCalledOnce()
  })

  it('reports snapshot and readonly executor failures without leaking implementation errors', async () => {
    const snapshotFailure = harness()
    snapshotFailure.captureSnapshot.mockRejectedValueOnce(new Error('private snapshot error'))
    await expect(
      snapshotFailure.broker.invoke(invocation('snapshot-failed')),
    ).resolves.toMatchObject({
      status: 'failed',
      mutationOutcome: 'not_started',
      errorCode: 'tool_failed',
    })
    expect(snapshotFailure.execute).not.toHaveBeenCalled()

    const readFailure = harness()
    readFailure.execute.mockRejectedValueOnce(new Error('private renderer error'))
    await expect(
      readFailure.broker.invoke(
        invocation('read-failed', { toolId: 'office:docs:read', toolOrder: 1 }),
      ),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'tool_failed' })
  })

  it('uses a snapshot or executor atomic boundary before mutation execution', async () => {
    const fixture = harness()
    await fixture.broker.invoke(invocation('snapshot-boundary'))
    await fixture.broker.invoke(
      invocation('atomic-boundary', {
        toolId: 'office:docs:atomic',
        permissionSnapshot: {
          snapshotId: 'snapshot-atomic',
          createdForRunId: 'run-1',
          permissionVersion: 'permission-1',
          toolIds: ['office:docs:atomic'],
        },
      }),
    )
    expect(fixture.captureSnapshot).toHaveBeenCalledOnce()
    expect(fixture.execute.mock.calls[0]?.[2]).toMatchObject({ kind: 'snapshot' })
    expect(fixture.execute.mock.calls[1]?.[2]).toEqual({ kind: 'atomic' })
  })

  it('requires an exact grant only for Subagent mutations and records it in provenance', async () => {
    const missing = harness()
    const child = invocation('subagent-missing', {
      actor: {
        type: 'subagent',
        actorId: 'subagent-1',
        subagentRunId: 'subagent-run-1',
        parentRunId: 'run-1',
      },
      permissionSnapshot: {
        snapshotId: 'snapshot-subagent',
        createdForRunId: 'run-1',
        permissionVersion: 'permission-1',
        toolIds: ['office:docs:read'],
      },
    })
    await expect(missing.broker.invoke(child)).rejects.toEqual(
      new OfficeToolBrokerError('permission_denied'),
    )

    const denied = harness()
    denied.authorizeMutationGrant.mockResolvedValueOnce(false)
    await expect(
      denied.broker.invoke({
        ...child,
        operationId: 'subagent-denied',
        mutationGrantId: 'grant-1',
      }),
    ).rejects.toEqual(new OfficeToolBrokerError('permission_denied'))

    const granted = harness()
    await expect(
      granted.broker.invoke({
        ...child,
        operationId: 'subagent-granted',
        mutationGrantId: 'grant-1',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      provenance: { mutationGrantId: 'grant-1' },
    })
    expect(granted.authorizeMutationGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        mutationGrantId: 'grant-1',
        toolId: 'office:docs:write',
      }),
      expect.objectContaining({ effect: 'mutation' }),
    )

    await expect(
      granted.broker.invoke(
        invocation('read-with-grant', {
          toolId: 'office:docs:read',
          mutationGrantId: 'grant-1',
        }),
      ),
    ).rejects.toEqual(new OfficeToolBrokerError('permission_denied'))
  })

  it('shares the first rollback snapshot across parent and Subagent mutations in one run', async () => {
    const fixture = harness()
    await fixture.broker.invoke(invocation('parent-first'))
    await fixture.broker.invoke(
      invocation('child-second', {
        runId: 'subagent-run-1',
        actor: {
          type: 'subagent',
          actorId: 'subagent-1',
          subagentRunId: 'subagent-run-1',
          parentRunId: 'run-1',
        },
        mutationGrantId: 'grant-1',
        permissionSnapshot: {
          snapshotId: 'snapshot-child',
          createdForRunId: 'subagent-run-1',
          permissionVersion: 'permission-1',
          toolIds: ['office:docs:read'],
        },
      }),
    )
    expect(fixture.captureSnapshot).toHaveBeenCalledOnce()
    expect(fixture.execute.mock.calls[0]?.[2]).toBe(fixture.execute.mock.calls[1]?.[2])
  })

  it.each([
    ['document_mismatch', 'validateBinding'],
    ['permission_denied', 'validatePermissionSnapshot'],
    ['permission_denied', 'authorizeActor'],
  ] as const)('fails closed with %s when %s rejects current state', async (code, dependency) => {
    const fixture = harness()
    fixture[dependency].mockResolvedValueOnce(false)
    await expect(fixture.broker.invoke(invocation(`denied-${dependency}`))).rejects.toEqual(
      new OfficeToolBrokerError(code),
    )
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('rejects missing descriptors and tools absent from the run capability snapshot', async () => {
    const fixture = harness()
    await expect(
      fixture.broker.invoke(invocation('missing-tool', { toolId: 'office:docs:missing' })),
    ).rejects.toEqual(new OfficeToolBrokerError('tool_not_in_snapshot'))
    await expect(
      fixture.broker.invoke(
        invocation('not-in-snapshot', {
          permissionSnapshot: {
            snapshotId: 'snapshot-empty',
            createdForRunId: 'run-1',
            permissionVersion: 'permission-1',
            toolIds: [],
          },
        }),
      ),
    ).rejects.toEqual(new OfficeToolBrokerError('tool_not_in_snapshot'))
  })
})
