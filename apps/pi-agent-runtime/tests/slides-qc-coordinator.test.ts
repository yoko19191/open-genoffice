import { describe, expect, it, vi } from 'vitest'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import type { OfficeToolInvocation, OfficeToolReceipt } from '@genoffice/agent-runtime-protocol'
import {
  SlidesQcCoordinator,
  SlidesQcCoordinatorError,
  SLIDES_QC_MUTATION_TOOL_ID,
  SLIDES_QC_READ_TOOL_ID,
} from '../src/slides-qc-coordinator'

const parentRunId = '11111111-1111-4111-8111-111111111111'
const parentSessionId = '22222222-2222-4222-8222-222222222222'
const documentId = '33333333-3333-4333-8333-333333333333'
const qcRunId = '44444444-4444-4444-8444-444444444444'

function parentSnapshot(): CapabilitySnapshot {
  return {
    snapshotId: 'a'.repeat(64),
    createdForRunId: parentRunId,
    model: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      capabilities: ['text-input', 'tool-use'],
    },
    resourceHashes: {},
    toolIds: [SLIDES_QC_READ_TOOL_ID, SLIDES_QC_MUTATION_TOOL_ID],
    permissionVersion: 'permission-v1',
  }
}

function readReceipt(request: OfficeToolInvocation, issues: string[]): OfficeToolReceipt {
  return {
    operationId: request.operationId,
    toolCallId: request.toolCallId,
    toolId: request.toolId,
    status: 'completed',
    output: `slide ${String((request.input as { slideIndex: number }).slideIndex)}`,
    details: { auditIssues: issues },
    contextVersionAfter: `context-${String((request.input as { slideIndex: number }).slideIndex)}-${issues.length}`,
    provenance: {
      actorId: qcRunId,
      runId: qcRunId,
      documentId,
    },
  }
}

function fixture(options: { plans?: Record<number, string[]>; audits?: string[][] } = {}) {
  const audits = [...(options.audits ?? [['overlap'], []])]
  const invocations: OfficeToolInvocation[] = []
  const beginNamed = vi.fn(async () => ({
    run: {
      runId: qcRunId,
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'Slides QC',
      depth: 1,
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      status: 'waiting' as const,
      attempt: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 },
      capabilitySnapshotId: 'b'.repeat(64),
      createdAt: '2026-08-10T00:00:00.000Z',
    },
    permissionSnapshot: {
      snapshotId: 'b'.repeat(64),
      createdForRunId: qcRunId,
      permissionVersion: 'permission-v1',
      toolIds: [SLIDES_QC_READ_TOOL_ID],
    },
  }))
  const completeNamed = vi.fn(async () => undefined)
  const failNamed = vi.fn(async () => undefined)
  const authorizeTool = vi.fn(() => ({
    actorId: qcRunId,
    runId: qcRunId,
    documentId,
    toolId: SLIDES_QC_READ_TOOL_ID,
  }))
  const requestMutationGrant = vi.fn(async () => ({
    requestId: 'grant-request-1',
    subagentRunId: qcRunId,
    role: 'Slides QC',
    exactToolIds: [SLIDES_QC_MUTATION_TOOL_ID],
    requestedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
    status: 'pending' as const,
  }))
  const authorizeMutationTool = vi.fn(async () => ({
    actorId: qcRunId,
    runId: qcRunId,
    documentId,
    toolId: SLIDES_QC_MUTATION_TOOL_ID,
    mutationGrantId: 'grant-1',
  }))
  const invoke = vi.fn(async (request: OfficeToolInvocation) => {
    invocations.push(structuredClone(request))
    if (request.toolId === SLIDES_QC_READ_TOOL_ID) {
      return readReceipt(request, audits.shift() ?? [])
    }
    return {
      operationId: request.operationId,
      toolCallId: request.toolCallId,
      toolId: request.toolId,
      status: 'completed' as const,
      output: 'fixed',
      mutationOutcome: 'committed' as const,
      contextVersionAfter: request.contextVersion,
      provenance: {
        actorId: qcRunId,
        runId: qcRunId,
        documentId,
        mutationGrantId: 'grant-1',
      },
    }
  })
  let next = 0
  const planRepairs = vi.fn(async ({ slideIndex }) => options.plans?.[slideIndex] ?? [])
  const coordinator = new SlidesQcCoordinator({
    subagents: {
      beginNamed,
      completeNamed,
      failNamed,
      authorizeTool,
      requestMutationGrant,
      authorizeMutationTool,
    },
    officeTools: { invoke },
    planRepairs,
    randomUUID: () => `operation-${++next}`,
  })
  return {
    coordinator,
    invocations,
    beginNamed,
    completeNamed,
    failNamed,
    requestMutationGrant,
    authorizeMutationTool,
    invoke,
    planRepairs,
  }
}

const startInput = {
  parentRunId,
  parentSessionId,
  documentId,
  parentSnapshot: parentSnapshot(),
  slideIndexes: [0],
}

describe('SlidesQcCoordinator', () => {
  it('keeps deny deterministic and performs zero mutation', async () => {
    const test = fixture({ plans: { 0: ['moveBy("title", 0, 10)'] }, audits: [['overlap']] })
    const started = await test.coordinator.start(startInput)
    const waiting = test.coordinator.wait(qcRunId)
    expect(started).toMatchObject({ status: 'awaiting_grant', runId: qcRunId })
    expect(test.beginNamed).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'slides-qc', role: 'Slides QC' }),
    )
    expect(test.requestMutationGrant).toHaveBeenCalledWith(qcRunId, [SLIDES_QC_MUTATION_TOOL_ID])

    await expect(
      test.coordinator.handleGrantProjection({
        ...started.grantRequest!,
        status: 'denied',
      }),
    ).resolves.toMatchObject({
      status: 'denied',
      reports: [{ slideIndex: 0, issues: ['overlap'], repairRounds: 0 }],
    })
    await expect(waiting).resolves.toMatchObject({ status: 'denied' })
    expect(test.invocations.map(({ toolId }) => toolId)).toEqual([SLIDES_QC_READ_TOOL_ID])
    expect(test.completeNamed).toHaveBeenCalledWith(
      qcRunId,
      expect.stringContaining('Visual auto-fix was not authorized'),
    )
  })

  it('binds the exact QC actor and grant, then re-audits after every repair round', async () => {
    const test = fixture({
      plans: { 0: ['moveBy("title", 0, 10)', 'resizeBy("body", 0, 20)'] },
      audits: [['overlap'], ['overflow'], []],
    })
    await test.coordinator.start(startInput)
    const result = await test.coordinator.handleGrantProjection({
      requestId: 'grant-request-1',
      subagentRunId: qcRunId,
      role: 'Slides QC',
      exactToolIds: [SLIDES_QC_MUTATION_TOOL_ID],
      requestedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active',
      grantId: 'grant-1',
    })

    expect(result).toMatchObject({
      status: 'completed',
      reports: [{ slideIndex: 0, issues: [], repairRounds: 2 }],
    })
    expect(test.authorizeMutationTool).toHaveBeenCalledTimes(2)
    expect(test.invocations.map(({ toolId }) => toolId)).toEqual([
      SLIDES_QC_READ_TOOL_ID,
      SLIDES_QC_MUTATION_TOOL_ID,
      SLIDES_QC_READ_TOOL_ID,
      SLIDES_QC_MUTATION_TOOL_ID,
      SLIDES_QC_READ_TOOL_ID,
    ])
    const mutations = test.invocations.filter(({ toolId }) => toolId === SLIDES_QC_MUTATION_TOOL_ID)
    expect(mutations).toHaveLength(2)
    for (const request of mutations) {
      expect(request).toMatchObject({
        sessionId: parentSessionId,
        documentId,
        runId: qcRunId,
        actor: {
          type: 'subagent',
          actorId: qcRunId,
          subagentRunId: qcRunId,
          parentRunId,
        },
        mutationGrantId: 'grant-1',
        permissionSnapshot: {
          createdForRunId: qcRunId,
          toolIds: [SLIDES_QC_READ_TOOL_ID],
        },
      })
    }
  })

  it('fails closed when the hard gate still reports issues after two rounds', async () => {
    const test = fixture({
      plans: { 0: ['roundOne()', 'roundTwo()'] },
      audits: [['overlap'], ['overflow'], ['out-of-bounds']],
    })
    await test.coordinator.start(startInput)
    await expect(test.coordinator.apply(qcRunId, 'grant-1')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'slides_qc_hard_gate_failed',
      reports: [{ slideIndex: 0, issues: ['out-of-bounds'], repairRounds: 2 }],
    })
    expect(test.failNamed).toHaveBeenCalledWith(qcRunId, 'slides_qc_hard_gate_failed')
  })

  it('fails the hard gate when Pi proposes no repair for a deterministic issue', async () => {
    const test = fixture({ plans: { 0: [] }, audits: [['overlap']] })
    await expect(test.coordinator.start(startInput)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'slides_qc_hard_gate_failed',
      reports: [{ slideIndex: 0, issues: ['overlap'], repairRounds: 0 }],
    })
    expect(test.requestMutationGrant).not.toHaveBeenCalled()
  })

  it('completes a clean page without requesting mutation authority', async () => {
    const test = fixture({ plans: { 0: [], 1: [] }, audits: [[], []] })
    await expect(
      test.coordinator.start({ ...startInput, slideIndexes: [1, 0] }),
    ).resolves.toMatchObject({
      status: 'completed',
      reports: [
        { slideIndex: 0, issues: [], repairRounds: 0 },
        { slideIndex: 1, issues: [], repairRounds: 0 },
      ],
    })
    expect(test.completeNamed).toHaveBeenCalledWith(
      qcRunId,
      expect.stringContaining('no visual auto-fix was proposed'),
    )
    expect(test.planRepairs).not.toHaveBeenCalled()
  })

  it('rejects invalid plans, missing audits, and revoked grant projections', async () => {
    const invalid = fixture({ plans: { 0: ['roundOne()', 'roundTwo()', 'roundThree()'] } })
    await expect(invalid.coordinator.start(startInput)).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_plan_invalid'),
    )

    const missingAudit = fixture({ plans: { 0: ['roundOne()'] } })
    missingAudit.invoke.mockResolvedValueOnce({
      operationId: 'operation-1',
      toolCallId: 'operation-2',
      toolId: SLIDES_QC_READ_TOOL_ID,
      status: 'completed',
      output: 'slide 0',
      contextVersionAfter: 'context-0',
      provenance: { actorId: qcRunId, runId: qcRunId, documentId },
    })
    await expect(missingAudit.coordinator.start(startInput)).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_read_failed'),
    )

    const revoked = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    const started = await revoked.coordinator.start(startInput)
    await expect(
      revoked.coordinator.handleGrantProjection({
        ...started.grantRequest!,
        status: 'revoked',
      }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'slides_qc_grant_denied' })
    expect(revoked.invocations).toHaveLength(1)
  })

  it('ignores unrelated grant updates and rejects an active update without a grant id', async () => {
    const test = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    const started = await test.coordinator.start(startInput)
    await expect(
      test.coordinator.handleGrantProjection(started.grantRequest!),
    ).resolves.toBeUndefined()
    await expect(
      test.coordinator.handleGrantProjection({
        ...started.grantRequest!,
        requestId: 'other-request',
        status: 'denied',
      }),
    ).resolves.toBeUndefined()
    await expect(
      test.coordinator.handleGrantProjection({
        ...started.grantRequest!,
        status: 'active',
      }),
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'slides_qc_grant_denied' })
    await expect(
      test.coordinator.handleGrantProjection({
        ...started.grantRequest!,
        status: 'denied',
      }),
    ).resolves.toBeUndefined()
  })

  it('fails closed on a rejected or indeterminate Office mutation', async () => {
    const rejected = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    await rejected.coordinator.start(startInput)
    rejected.invoke.mockResolvedValueOnce({
      operationId: 'operation-3',
      toolCallId: 'operation-4',
      toolId: SLIDES_QC_MUTATION_TOOL_ID,
      status: 'failed',
      output: 'rejected',
      mutationOutcome: 'not_started',
      provenance: { actorId: qcRunId, runId: qcRunId, documentId },
    })
    await expect(rejected.coordinator.apply(qcRunId, 'grant-1')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'slides_qc_mutation_failed',
    })

    const indeterminate = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    await indeterminate.coordinator.start(startInput)
    indeterminate.invoke.mockRejectedValueOnce(new Error('office connection lost'))
    await expect(indeterminate.coordinator.apply(qcRunId, 'grant-1')).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_mutation_failed'),
    )
    expect(indeterminate.failNamed).toHaveBeenCalledWith(qcRunId, 'slides_qc_mutation_failed')
  })

  it('rejects revoked, expired, terminal and reload-lost grants before dispatching mutation', async () => {
    const test = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    await test.coordinator.start(startInput)
    test.authorizeMutationTool.mockRejectedValueOnce(new Error('mutation_grant_denied'))
    await expect(test.coordinator.apply(qcRunId, 'grant-1')).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_grant_denied'),
    )
    expect(test.invocations.filter(({ toolId }) => toolId === SLIDES_QC_MUTATION_TOOL_ID)).toEqual(
      [],
    )

    const reloaded = fixture().coordinator
    await expect(reloaded.apply(qcRunId, 'grant-1')).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_run_not_found'),
    )
  })

  it('rejects forged pages, snapshots and duplicate runs without starting a child', async () => {
    const test = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    await expect(test.coordinator.start({ ...startInput, slideIndexes: [0, 0] })).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_request_invalid'),
    )
    await expect(
      test.coordinator.start({
        ...startInput,
        parentSnapshot: { ...parentSnapshot(), toolIds: [SLIDES_QC_READ_TOOL_ID] },
      }),
    ).rejects.toEqual(new SlidesQcCoordinatorError('slides_qc_not_authorized'))
    expect(test.beginNamed).not.toHaveBeenCalled()

    await test.coordinator.start(startInput)
    await expect(test.coordinator.start(startInput)).rejects.toEqual(
      new SlidesQcCoordinatorError('slides_qc_run_active'),
    )
  })

  it('announces the named run before work and fails it when the parent signal is aborted', async () => {
    const test = fixture({ plans: { 0: ['roundOne()'] } })
    const controller = new AbortController()
    controller.abort()
    const onRunStarted = vi.fn()
    await expect(
      test.coordinator.start({
        ...startInput,
        signal: controller.signal,
        onRunStarted,
      }),
    ).rejects.toEqual(new SlidesQcCoordinatorError('slides_qc_cancelled'))
    expect(onRunStarted).toHaveBeenCalledWith(expect.objectContaining({ runId: qcRunId }))
    expect(test.failNamed).toHaveBeenCalledWith(qcRunId, 'slides_qc_cancelled')
    expect(test.invocations).toEqual([])
  })

  it('keeps the named tool pending until Grant settlement and releases it on Stop', async () => {
    const test = fixture({ plans: { 0: ['roundOne()'] }, audits: [['overlap']] })
    await test.coordinator.start(startInput)
    const waiting = test.coordinator.wait(qcRunId)
    const cancelled = test.coordinator.cancel(qcRunId)
    expect(cancelled).toMatchObject({ status: 'failed', errorCode: 'slides_qc_cancelled' })
    await expect(waiting).resolves.toEqual(cancelled)
    expect(test.coordinator.cancel(qcRunId)).toBeUndefined()
    expect(() => test.coordinator.wait(qcRunId)).toThrow('slides_qc_run_not_found')
  })
})
