import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import {
  SubagentCoordinator,
  SubagentCoordinatorError,
  type SubagentEngineEvent,
  type SubagentEngineHandle,
  type SubagentEngineInput,
  type SubagentExecutionEngine,
} from '../src/subagent-coordinator'
import { SubagentRunRegistry, type SubagentRootBudget } from '../src/subagent-run-registry'

const roots: string[] = []
const parentRunId = '11111111-1111-4111-8111-111111111111'
const parentSessionId = '22222222-2222-4222-8222-222222222222'
const documentId = '33333333-3333-4333-8333-333333333333'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.useRealTimers()
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'genoffice-subagent-coordinator-'))
  roots.push(value)
  return value
}

function idFactory() {
  let next = 100
  return () => `${String(++next).padStart(8, '0')}-0000-4000-8000-000000000000`
}

function parentSnapshot(): CapabilitySnapshot {
  return {
    snapshotId: 'a'.repeat(64),
    createdForRunId: parentRunId,
    model: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      capabilities: ['text-input', 'tool-use'],
    },
    resourceHashes: {
      'global:skill/reviewer': 'b'.repeat(64),
      'global:prompt/brief': 'c'.repeat(64),
    },
    toolIds: [
      'office:pdf:read_text',
      'office:pdf:delete_page',
      'mcp:search:query',
      'platform:resource:read',
      'platform:subagent:spawn',
    ],
    permissionVersion: 'permission-v1',
  }
}

type Queue = {
  events: SubagentEngineEvent[]
  waiters: Array<() => void>
  closed: boolean
  error?: Error
}

class ControlledEngine implements SubagentExecutionEngine {
  readonly inputs: Array<Omit<SubagentEngineInput, 'signal'>> = []
  readonly cancelled: string[] = []
  readonly reconciled: string[] = []
  private readonly queues = new Map<string, Queue>()
  private readonly reconcileStates = new Map<
    string,
    Awaited<ReturnType<SubagentExecutionEngine['reconcile']>>
  >()
  private readonly reconcileErrors = new Set<string>()
  spawnError?: Error

  async spawn(input: SubagentEngineInput): Promise<SubagentEngineHandle> {
    if (this.spawnError) throw this.spawnError
    const { signal: _signal, ...stored } = input
    this.inputs.push(structuredClone(stored))
    const providerRunId = `provider-${input.runId}-${input.attempt}`
    const queue: Queue = { events: [], waiters: [], closed: false }
    this.queues.set(input.runId, queue)
    return {
      providerRunId,
      providerAttemptId: `attempt-${input.attempt}`,
      events: this.iterate(queue),
      cancel: async () => {
        this.cancelled.push(input.runId)
        this.emit(input.runId, { type: 'cancelled' })
      },
    }
  }

  async reconcile(input: { providerRunId: string }) {
    this.reconciled.push(input.providerRunId)
    if (this.reconcileErrors.has(input.providerRunId)) throw new Error('private reconcile error')
    return this.reconcileStates.get(input.providerRunId) ?? { status: 'unknown' as const }
  }

  setReconcile(
    providerRunId: string,
    value: Awaited<ReturnType<SubagentExecutionEngine['reconcile']>>,
  ) {
    this.reconcileStates.set(providerRunId, value)
  }

  setReconcileError(providerRunId: string): void {
    this.reconcileErrors.add(providerRunId)
  }

  emit(runId: string, event: SubagentEngineEvent): void {
    const queue = this.queues.get(runId)
    if (!queue) throw new Error('missing_engine_queue')
    queue.events.push(event)
    if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
      queue.closed = true
    }
    for (const wake of queue.waiters.splice(0)) wake()
  }

  closeStream(runId: string, error?: Error): void {
    const queue = this.queues.get(runId)
    if (!queue) throw new Error('missing_engine_queue')
    queue.error = error
    queue.closed = true
    for (const wake of queue.waiters.splice(0)) wake()
  }

  private async *iterate(queue: Queue): AsyncIterable<SubagentEngineEvent> {
    while (!queue.closed || queue.events.length > 0) {
      const event = queue.events.shift()
      if (event) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => queue.waiters.push(resolve))
    }
    if (queue.error) throw queue.error
  }
}

const budget: SubagentRootBudget = {
  maxDepth: 2,
  maxChildren: 8,
  maxConcurrency: 4,
  maxWallTimeMs: 10_000,
  maxTokens: 100,
  maxCostUsd: 1,
  maxToolCalls: 10,
}

async function fixture(
  options: {
    engine?: ControlledEngine
    budget?: SubagentRootBudget
    mutationGrants?: boolean
  } = {},
) {
  const rootDirectory = await root()
  const randomUUID = idFactory()
  const registry = new SubagentRunRegistry({ rootDirectory, randomUUID })
  await registry.initialize()
  const engine = options.engine ?? new ControlledEngine()
  const authorizeSnapshot = vi.fn(async () => undefined)
  const requestMutationGrant = vi.fn(async (input) => ({
    requestId: 'grant-request-1',
    subagentRunId: input.subagentRunId,
    role: 'researcher',
    exactToolIds: [...input.exactToolIds],
    requestedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
    status: 'pending' as const,
  }))
  const authorizeMutationGrant = vi.fn(async () => ({
    grantId: 'grant-1',
    subagentRunId: 'unused',
    documentId,
    exactToolIds: ['office:pdf:delete_page'],
    issuedByUserActionId: 'user-action-1',
    issuedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
    status: 'active' as const,
  }))
  const coordinator = new SubagentCoordinator({
    registry,
    engine,
    randomUUID,
    budget: options.budget ?? budget,
    authorizeSnapshot,
    ...(options.mutationGrants === false
      ? {}
      : {
          mutationGrants: {
            request: requestMutationGrant,
            authorize: authorizeMutationGrant,
          },
        }),
    resolveTool: (toolId) => {
      if (toolId === 'office:pdf:read_text') {
        return { canonicalToolId: toolId, modelAlias: 'pdf_read_text', effect: 'read' as const }
      }
      if (toolId === 'office:pdf:delete_page') {
        return {
          canonicalToolId: toolId,
          modelAlias: 'pdf_delete_page',
          effect: 'mutation' as const,
        }
      }
      if (toolId === 'office:slides:read_slide') {
        return { canonicalToolId: toolId, modelAlias: 'read_slide', effect: 'read' as const }
      }
      if (toolId === 'office:slides:execute_slide_script') {
        return {
          canonicalToolId: toolId,
          modelAlias: 'execute_slide_script',
          effect: 'mutation' as const,
        }
      }
      if (toolId === 'mcp:search:query') {
        return { canonicalToolId: toolId, modelAlias: 'search_query', effect: 'read' as const }
      }
      if (toolId === 'platform:resource:read') {
        return { canonicalToolId: toolId, modelAlias: 'resource_read', effect: 'read' as const }
      }
      if (toolId === 'platform:subagent:spawn') {
        return { canonicalToolId: toolId, modelAlias: 'subagent', effect: 'orchestration' as const }
      }
      if (toolId === 'external:unsafe') {
        return {
          canonicalToolId: toolId,
          modelAlias: 'external_unsafe',
          effect: 'external' as const,
        }
      }
      return undefined
    },
    resolveContext: vi.fn(async () => ({
      officeContext: { kind: 'pdf', revision: 'revision-1', summary: 'synthetic context' },
      resourceTexts: ['Reviewer skill', 'Brief prompt'],
    })),
  })
  return {
    coordinator,
    registry,
    engine,
    authorizeSnapshot,
    requestMutationGrant,
    authorizeMutationGrant,
  }
}

describe('SubagentCoordinator', () => {
  it('uses fixed defaults, validates every request binding, and enforces authorization branches', async () => {
    const rootDirectory = await root()
    const registry = new SubagentRunRegistry({ rootDirectory, randomUUID: idFactory() })
    await registry.initialize()
    const engine = new ControlledEngine()
    const coordinator = new SubagentCoordinator({
      registry,
      engine,
      authorizeSnapshot: vi.fn(async () => undefined),
      resolveTool: (toolId) =>
        toolId === 'external:unsafe'
          ? { canonicalToolId: toolId, modelAlias: 'external', effect: 'external' }
          : toolId === 'platform:resource:read'
            ? { canonicalToolId: toolId, modelAlias: 'read', effect: 'read' }
            : undefined,
      resolveContext: vi.fn(async () => ({ resourceTexts: [] })),
    })
    for (const request of [
      { role: 'valid', task: '   ', parentSnapshot: parentSnapshot() },
      { role: 'valid', task: 'x'.repeat(64 * 1024 + 1), parentSnapshot: parentSnapshot() },
      {
        role: 'valid',
        task: 'valid',
        parentSnapshot: { ...parentSnapshot(), createdForRunId: 'other-run' },
      },
    ]) {
      await expect(
        coordinator.spawn({
          parentRunId,
          parentSessionId,
          documentId,
          ...request,
        }),
      ).rejects.toMatchObject({ code: 'subagent_request_invalid' })
    }
    expect(() => coordinator.authorizeTool('missing-run', 'platform:resource:read')).toThrowError(
      'subagent_parent_invalid',
    )
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'valid',
      task: 'valid',
      parentSnapshot: parentSnapshot(),
    })
    expect(() => coordinator.authorizeTool(run.runId, 'external:unsafe')).toThrowError(
      'subagent_tool_not_authorized',
    )
    await registry.complete(run.runId, { result: { kind: 'text', text: 'already terminal' } })
    await coordinator.cancelTree(run.runId, 'late-cancel')
    engine.closeStream(run.runId)
    await coordinator.wait(run.runId)
    coordinator.close()
  })

  it('rechecks the current tool effect instead of trusting the frozen tool id alone', async () => {
    const rootDirectory = await root()
    const registry = new SubagentRunRegistry({ rootDirectory, randomUUID: idFactory() })
    await registry.initialize()
    const engine = new ControlledEngine()
    let resourceEffect: 'read' | 'external' = 'read'
    const coordinator = new SubagentCoordinator({
      registry,
      engine,
      authorizeSnapshot: vi.fn(async () => undefined),
      resolveTool: (toolId) =>
        toolId === 'platform:resource:read'
          ? { canonicalToolId: toolId, modelAlias: 'read', effect: resourceEffect }
          : undefined,
      resolveContext: vi.fn(async () => ({ resourceTexts: [] })),
    })
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'effect-check',
      task: 'Check.',
      parentSnapshot: parentSnapshot(),
    })
    resourceEffect = 'external'
    expect(() => coordinator.authorizeTool(run.runId, 'platform:resource:read')).toThrowError(
      'subagent_tool_not_authorized',
    )
    engine.emit(run.runId, { type: 'completed', result: { kind: 'text', text: 'done' } })
    await coordinator.wait(run.runId)
  })

  it('enforces the wall-time budget through the live execution timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'))
    const { coordinator, registry, engine } = await fixture({
      budget: { ...budget, maxWallTimeMs: 1_000 },
    })
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'deadline',
      task: 'wait',
      parentSnapshot: parentSnapshot(),
    })
    await vi.advanceTimersByTimeAsync(1_001)
    await coordinator.wait(run.runId)
    expect(engine.cancelled).toContain(run.runId)
    expect(registry.get(run.runId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'subagent_budget_wall_time',
    })
  })

  it('projects waiting, assistant and authorized tool events without raw provider bodies', async () => {
    const { coordinator, registry, engine } = await fixture()
    const events: unknown[] = []
    coordinator.onEvent((event) => events.push(event))
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'observer',
      task: 'Observe.',
      parentSnapshot: parentSnapshot(),
      projectRoot: '/trusted/project',
    })
    expect(coordinator.listForSession(parentSessionId)).toHaveLength(1)
    expect(coordinator.parentSessionIdsWithRuns()).toEqual([parentSessionId])
    engine.emit(run.runId, { type: 'waiting', raw: { secret: 'raw-wait' } })
    engine.emit(run.runId, { type: 'running' })
    engine.emit(run.runId, {
      type: 'assistant.delta',
      text: 'safe delta',
      raw: { secret: 'raw-delta' },
    })
    engine.emit(run.runId, { type: 'tool.started', toolId: 'mcp:search:query' })
    engine.emit(run.runId, { type: 'tool.completed', toolId: 'mcp:search:query' })
    engine.emit(run.runId, { type: 'completed', result: { kind: 'text', text: 'done' } })
    await coordinator.wait(run.runId)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'waiting',
          run: expect.objectContaining({ runId: run.runId }),
        }),
        expect.objectContaining({ type: 'assistant.delta', text: 'safe delta' }),
        expect.objectContaining({ type: 'tool.started', toolId: 'mcp:search:query' }),
        expect.objectContaining({ type: 'tool.completed', toolId: 'mcp:search:query' }),
      ]),
    )
    expect(JSON.stringify(events)).not.toContain('raw-')
    expect(registry.get(run.runId)?.status).toBe('completed')
    coordinator.close()
  })

  it('normalizes spawn and stream failures, including incomplete and unauthorized tool streams', async () => {
    const spawnFailure = new ControlledEngine()
    spawnFailure.spawnError = new Error('private spawn failure')
    const failedFixture = await fixture({ engine: spawnFailure })
    await expect(
      failedFixture.coordinator.spawn({
        parentRunId,
        parentSessionId,
        documentId,
        role: 'spawn-failure',
        task: 'Fail.',
        parentSnapshot: parentSnapshot(),
      }),
    ).rejects.toMatchObject({ code: 'subagent_engine_failed' })
    expect(failedFixture.registry.listForSession(parentSessionId)[0]).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_engine_failed',
    })

    const { coordinator, registry, engine } = await fixture({
      budget: { ...budget, maxConcurrency: 8 },
    })
    const runs = await Promise.all(
      ['incomplete', 'throwing', 'unauthorized'].map((role) =>
        coordinator.spawn({
          parentRunId,
          parentSessionId,
          documentId,
          role,
          task: role,
          parentSnapshot: parentSnapshot(),
        }),
      ),
    )
    engine.closeStream(runs[0]!.runId)
    engine.closeStream(runs[1]!.runId, new Error('private stream error'))
    engine.emit(runs[2]!.runId, {
      type: 'tool.started',
      toolId: 'office:pdf:delete_page',
    })
    await Promise.all(runs.map((run) => coordinator.wait(run.runId)))
    expect(registry.get(runs[0]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_incomplete',
    })
    expect(registry.get(runs[1]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })
    expect(registry.get(runs[2]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })
  })

  it('reconciles every provider outcome and a run missing its provider reference', async () => {
    const { coordinator, registry, engine } = await fixture({
      budget: { ...budget, maxChildren: 12, maxConcurrency: 12 },
    })
    const outcomes = [
      'completed-with-usage',
      'completed-without-usage',
      'cancelled',
      'failed-unsafe-code',
      'failed-default-code',
      'resumable-without-project',
      'unknown',
      'throws',
    ] as const
    const runs = await Promise.all(
      outcomes.map((role) =>
        coordinator.spawn({
          parentRunId,
          parentSessionId,
          documentId,
          role,
          task: role,
          parentSnapshot: parentSnapshot(),
        }),
      ),
    )
    const refs = runs.map((run) => registry.getInternal(run.runId)!.providerRunId!)
    engine.setReconcile(refs[0]!, {
      status: 'completed',
      result: { kind: 'text', text: 'reconciled' },
      usage: { inputTokens: 4, outputTokens: 2 },
    })
    engine.setReconcile(refs[1]!, {
      status: 'completed',
      result: { kind: 'text', text: 'no usage' },
    })
    engine.setReconcile(refs[2]!, { status: 'cancelled' })
    engine.setReconcile(refs[3]!, { status: 'failed', errorCode: 'unsafe error detail!' })
    engine.setReconcile(refs[4]!, { status: 'failed' })
    engine.setReconcile(refs[5]!, { status: 'resumable' })
    engine.setReconcile(refs[6]!, { status: 'unknown' })
    engine.setReconcileError(refs[7]!)
    await registry.create({
      rootRunId: '99999999-9999-4999-8999-999999999999',
      parentRunId: '99999999-9999-4999-8999-999999999999',
      parentSessionId,
      documentId,
      role: 'missing-provider',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget,
      capabilitySnapshot: {
        ...parentSnapshot(),
        createdForRunId: '88888888-8888-4888-8888-888888888888',
      },
    })
    coordinator.detachExecutionsAfterCrash()
    await coordinator.reconcile()
    expect(registry.get(runs[0]!.runId)).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 4, outputTokens: 2 },
    })
    expect(registry.get(runs[1]!.runId)).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(registry.get(runs[2]!.runId)?.status).toBe('cancelled')
    expect(registry.get(runs[3]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })
    expect(registry.get(runs[4]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })
    expect(registry.get(runs[5]!.runId)).toMatchObject({
      status: 'resumable',
      errorCode: 'runtime_crash',
    })
    expect(registry.get(runs[6]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_reconcile_failed',
    })
    expect(registry.get(runs[7]!.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_reconcile_failed',
    })
    expect(
      registry.listForSession(parentSessionId).find((run) => run.role === 'missing-provider'),
    ).toMatchObject({ status: 'failed', errorCode: 'subagent_reconcile_failed' })

    const resumed = await coordinator.resume(runs[5]!.runId)
    expect(resumed).toMatchObject({ status: 'running', attempt: 2 })
    expect(engine.inputs.at(-1)).not.toHaveProperty('projectRoot')
    engine.emit(resumed.runId, { type: 'completed', result: { kind: 'text', text: 'resumed' } })
    await coordinator.wait(resumed.runId)
  }, 15_000)

  it('contains stale-stream and registry-state races without overwriting terminal truth', async () => {
    const { coordinator, registry, engine } = await fixture({
      budget: { ...budget, maxConcurrency: 4 },
    })
    const stale = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'stale-stream',
      task: 'Detach.',
      parentSnapshot: parentSnapshot(),
    })
    coordinator.detachExecutionsAfterCrash()
    engine.closeStream(stale.runId, new Error('private late failure'))

    const invalidTransition = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'invalid-transition',
      task: 'Race.',
      parentSnapshot: parentSnapshot(),
    })
    engine.emit(invalidTransition.runId, { type: 'running' })
    await coordinator.wait(invalidTransition.runId)
    expect(registry.get(invalidTransition.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_state_invalid',
    })

    const terminal = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'terminal-race',
      task: 'Keep terminal truth.',
      parentSnapshot: parentSnapshot(),
    })
    await registry.complete(terminal.runId, { result: { kind: 'text', text: 'confirmed' } })
    engine.emit(terminal.runId, { type: 'usage', usage: { inputTokens: 1 } })
    await coordinator.wait(terminal.runId)
    expect(registry.get(terminal.runId)).toMatchObject({
      status: 'completed',
      result: { kind: 'text', text: 'confirmed' },
    })
  })

  it('ignores model tools and compiles an independent read-only child context from the parent snapshot', async () => {
    const { coordinator, registry, engine, authorizeSnapshot } = await fixture()
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      task: 'Inspect the synthetic document.',
      parentSnapshot: parentSnapshot(),
      requestedTools: ['office:pdf:delete_page', 'made-up-tool'],
    })
    expect(run).toMatchObject({
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      depth: 1,
      status: 'running',
    })
    expect(authorizeSnapshot).toHaveBeenCalledTimes(1)
    expect(engine.inputs).toHaveLength(1)
    expect(engine.inputs[0]).toMatchObject({
      runId: run.runId,
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      task: 'Inspect the synthetic document.',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      tools: [
        { canonicalToolId: 'mcp:search:query', modelAlias: 'search_query', effect: 'read' },
        { canonicalToolId: 'office:pdf:read_text', modelAlias: 'pdf_read_text', effect: 'read' },
        { canonicalToolId: 'platform:resource:read', modelAlias: 'resource_read', effect: 'read' },
        {
          canonicalToolId: 'platform:subagent:spawn',
          modelAlias: 'subagent',
          effect: 'orchestration',
        },
      ],
      officeContext: { kind: 'pdf', revision: 'revision-1', summary: 'synthetic context' },
      resourceTexts: ['Reviewer skill', 'Brief prompt'],
    })
    expect(JSON.stringify(engine.inputs[0])).not.toContain('delete_page')
    expect(JSON.stringify(engine.inputs[0])).not.toContain('made-up-tool')
    expect(registry.getInternal(run.runId)?.capabilitySnapshot.toolIds).toEqual([
      'mcp:search:query',
      'office:pdf:read_text',
      'platform:resource:read',
      'platform:subagent:spawn',
    ])

    engine.emit(run.runId, {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2, toolCalls: 1 },
    })
    engine.emit(run.runId, {
      type: 'completed',
      result: { kind: 'text', text: 'safe result' },
    })
    await coordinator.wait(run.runId)
    expect(registry.get(run.runId)).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2, toolCalls: 1 },
      result: { kind: 'text', text: 'safe result' },
    })
  })

  it('persists two-level lineage and rejects direct mutation authorization even if requested', async () => {
    const { coordinator, registry, engine } = await fixture()
    const child = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'planner',
      task: 'Plan.',
      parentSnapshot: parentSnapshot(),
    })
    const grandchild = await coordinator.spawn({
      parentRunId: child.runId,
      parentSessionId,
      documentId,
      role: 'critic',
      task: 'Critique.',
      parentSnapshot: registry.getInternal(child.runId)!.capabilitySnapshot,
    })
    expect(grandchild).toMatchObject({
      rootRunId: parentRunId,
      parentRunId: child.runId,
      depth: 2,
    })
    expect(registry.listChildren(child.runId).map(({ runId }) => runId)).toEqual([grandchild.runId])
    expect(() => coordinator.authorizeTool(child.runId, 'office:pdf:delete_page')).toThrowError(
      'subagent_mutation_forbidden',
    )
    expect(() => coordinator.authorizeTool(child.runId, 'missing:tool')).toThrowError(
      'subagent_tool_not_authorized',
    )
    expect(coordinator.authorizeTool(child.runId, 'mcp:search:query')).toMatchObject({
      actorId: child.runId,
      documentId,
      runId: child.runId,
      toolId: 'mcp:search:query',
    })
    engine.emit(grandchild.runId, { type: 'completed', result: { kind: 'text', text: 'critique' } })
    engine.emit(child.runId, { type: 'completed', result: { kind: 'text', text: 'plan' } })
    await Promise.all([coordinator.wait(grandchild.runId), coordinator.wait(child.runId)])
  })

  it('records grantable parent mutations and requires an exact active Grant before authorization', async () => {
    const {
      coordinator,
      registry,
      requestMutationGrant,
      authorizeMutationGrant,
      authorizeSnapshot,
      engine,
    } = await fixture()
    const child = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      task: 'Review and request one edit if needed.',
      parentSnapshot: parentSnapshot(),
    })
    expect(registry.getInternal(child.runId)?.grantableToolIds).toEqual(['office:pdf:delete_page'])

    await expect(
      coordinator.requestMutationGrant(child.runId, ['office:pdf:delete_page']),
    ).resolves.toMatchObject({ requestId: 'grant-request-1', status: 'pending' })
    expect(requestMutationGrant).toHaveBeenCalledWith({
      parentSessionId,
      subagentRunId: child.runId,
      documentId,
      exactToolIds: ['office:pdf:delete_page'],
    })
    await expect(
      coordinator.authorizeMutationTool(child.runId, 'office:pdf:delete_page', 'grant-1'),
    ).resolves.toEqual({
      actorId: child.runId,
      runId: child.runId,
      documentId,
      toolId: 'office:pdf:delete_page',
      mutationGrantId: 'grant-1',
    })
    expect(authorizeMutationGrant).toHaveBeenCalledWith({
      grantId: 'grant-1',
      subagentRunId: child.runId,
      documentId,
      toolId: 'office:pdf:delete_page',
    })
    authorizeSnapshot.mockRejectedValueOnce(new Error('project_trust_revoked'))
    await expect(
      coordinator.authorizeMutationTool(child.runId, 'office:pdf:delete_page', 'grant-1'),
    ).rejects.toThrow('project_trust_revoked')
    expect(authorizeMutationGrant).toHaveBeenCalledOnce()
    await expect(
      coordinator.authorizeMutationTool(child.runId, 'office:pdf:read_text', 'grant-1'),
    ).rejects.toMatchObject({ code: 'subagent_mutation_forbidden' })
    engine.emit(child.runId, { type: 'completed', result: { kind: 'text', text: 'done' } })
    await coordinator.wait(child.runId)
  })

  it('creates a trusted named Slides QC actor with one read tool and one grantable mutation', async () => {
    const { coordinator, registry } = await fixture()
    const baseSnapshot = parentSnapshot()
    const snapshot = {
      ...baseSnapshot,
      toolIds: [
        ...baseSnapshot.toolIds,
        'office:slides:read_slide',
        'office:slides:execute_slide_script',
      ],
    }
    const named = await coordinator.beginNamed({
      profile: 'slides-qc',
      role: 'Slides QC',
      parentRunId,
      parentSessionId,
      documentId,
      parentSnapshot: snapshot,
    })

    expect(named.run).toMatchObject({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'Slides QC',
      status: 'waiting',
    })
    expect(named.permissionSnapshot).toMatchObject({
      createdForRunId: named.run.runId,
      toolIds: ['office:slides:read_slide'],
    })
    expect(registry.getInternal(named.run.runId)?.grantableToolIds).toEqual([
      'office:slides:execute_slide_script',
    ])
    expect(coordinator.authorizeTool(named.run.runId, 'office:slides:read_slide')).toMatchObject({
      actorId: named.run.runId,
    })
    expect(() => coordinator.authorizeTool(named.run.runId, 'office:pdf:read_text')).toThrowError(
      'subagent_tool_not_authorized',
    )

    await coordinator.completeNamed(named.run.runId, 'QC complete')
    expect(registry.get(named.run.runId)).toMatchObject({
      status: 'completed',
      result: { kind: 'text', text: 'QC complete' },
    })
  })

  it('rejects forged named profiles and cancels an active local QC run child-first', async () => {
    const { coordinator, registry } = await fixture()
    const baseSnapshot = parentSnapshot()
    const snapshot = {
      ...baseSnapshot,
      toolIds: [
        ...baseSnapshot.toolIds,
        'office:slides:read_slide',
        'office:slides:execute_slide_script',
      ],
    }
    await expect(
      coordinator.beginNamed({
        profile: 'slides-qc',
        role: 'Reviewer' as 'Slides QC',
        parentRunId,
        parentSessionId,
        documentId,
        parentSnapshot: snapshot,
      }),
    ).rejects.toMatchObject({ code: 'subagent_request_invalid' })

    const named = await coordinator.beginNamed({
      profile: 'slides-qc',
      role: 'Slides QC',
      parentRunId,
      parentSessionId,
      documentId,
      parentSnapshot: snapshot,
    })
    await coordinator.cancelTree(named.run.runId, 'document_closed')
    expect(registry.get(named.run.runId)).toMatchObject({ status: 'cancelled' })
  })

  it('validates named QC lineage, exact tools, terminal ownership, and missing grant actors', async () => {
    const { coordinator, registry, authorizeSnapshot } = await fixture()
    const baseSnapshot = parentSnapshot()
    const namedSnapshot = {
      ...baseSnapshot,
      toolIds: [
        ...baseSnapshot.toolIds,
        'office:slides:read_slide',
        'office:slides:execute_slide_script',
      ],
    }
    for (const toolIds of [
      namedSnapshot.toolIds.filter((toolId) => toolId !== 'office:slides:read_slide'),
      namedSnapshot.toolIds.filter((toolId) => toolId !== 'office:slides:execute_slide_script'),
    ]) {
      await expect(
        coordinator.beginNamed({
          profile: 'slides-qc',
          role: 'Slides QC',
          parentRunId,
          parentSessionId,
          documentId,
          parentSnapshot: { ...namedSnapshot, toolIds },
        }),
      ).rejects.toMatchObject({ code: 'subagent_tool_not_authorized' })
    }

    const storedParentRunId = '77777777-7777-4777-8777-777777777777'
    const nestedSnapshot = { ...namedSnapshot, createdForRunId: storedParentRunId }
    await registry.create({
      runId: storedParentRunId,
      rootRunId: storedParentRunId,
      parentRunId: storedParentRunId,
      parentSessionId,
      documentId,
      role: 'Parent',
      model: nestedSnapshot.model,
      budget,
      capabilitySnapshot: nestedSnapshot,
    })
    await expect(
      coordinator.beginNamed({
        profile: 'slides-qc',
        role: 'Slides QC',
        parentRunId: storedParentRunId,
        parentSessionId: 'other-session',
        documentId,
        parentSnapshot: nestedSnapshot,
      }),
    ).rejects.toMatchObject({ code: 'subagent_document_mismatch' })

    const nested = await coordinator.beginNamed({
      profile: 'slides-qc',
      role: 'Slides QC',
      parentRunId: storedParentRunId,
      parentSessionId,
      documentId,
      parentSnapshot: nestedSnapshot,
      projectRoot: '/trusted/project',
    })
    expect(nested.run.rootRunId).toBe(storedParentRunId)
    expect(authorizeSnapshot).toHaveBeenLastCalledWith(expect.anything(), '/trusted/project')
    await coordinator.failNamed(nested.run.runId, 'unsafe error detail!')
    expect(registry.get(nested.run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })

    await expect(coordinator.completeNamed('missing-run', 'done')).rejects.toMatchObject({
      code: 'subagent_parent_invalid',
    })
    await expect(coordinator.failNamed('missing-run', 'failed')).rejects.toMatchObject({
      code: 'subagent_parent_invalid',
    })
    expect(() => coordinator.requestMutationGrant('missing-run', ['office:slides:x'])).toThrow(
      'subagent_parent_invalid',
    )
    await expect(
      coordinator.authorizeMutationTool('missing-run', 'office:slides:x', 'grant-1'),
    ).rejects.toMatchObject({ code: 'subagent_parent_invalid' })
    await coordinator.cancelTree('missing-run', 'already-gone')
  })

  it('keeps mutations forbidden when the Runtime has no Mutation Grant authority', async () => {
    const { coordinator, engine } = await fixture({ mutationGrants: false })
    const child = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      task: 'Inspect without mutation authority.',
      parentSnapshot: parentSnapshot(),
    })
    expect(() => coordinator.requestMutationGrant(child.runId, ['office:pdf:delete_page'])).toThrow(
      'subagent_mutation_forbidden',
    )
    engine.emit(child.runId, { type: 'completed', result: { kind: 'text', text: 'done' } })
    await coordinator.wait(child.runId)
  })

  it('cancels descendants child-first and leaves siblings and the parent session usable', async () => {
    const { coordinator, registry, engine } = await fixture()
    const first = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'first',
      task: 'First.',
      parentSnapshot: parentSnapshot(),
    })
    const second = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'second',
      task: 'Second.',
      parentSnapshot: parentSnapshot(),
    })
    const grandchild = await coordinator.spawn({
      parentRunId: first.runId,
      parentSessionId,
      documentId,
      role: 'grandchild',
      task: 'Nested.',
      parentSnapshot: registry.getInternal(first.runId)!.capabilitySnapshot,
    })

    await coordinator.cancelTree(first.runId, 'parent_stop')
    await Promise.all([coordinator.wait(grandchild.runId), coordinator.wait(first.runId)])
    expect(engine.cancelled).toEqual([grandchild.runId, first.runId])
    expect(registry.get(grandchild.runId)?.status).toBe('cancelled')
    expect(registry.get(first.runId)?.status).toBe('cancelled')
    expect(registry.get(second.runId)?.status).toBe('running')
    engine.emit(second.runId, { type: 'completed', result: { kind: 'text', text: 'still usable' } })
    await coordinator.wait(second.runId)
    expect(registry.get(second.runId)?.status).toBe('completed')
  })

  it('enforces usage budget in execution by cancelling the whole root tree', async () => {
    const { coordinator, registry, engine } = await fixture()
    const first = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'first',
      task: 'First.',
      parentSnapshot: parentSnapshot(),
    })
    const second = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'second',
      task: 'Second.',
      parentSnapshot: parentSnapshot(),
    })
    engine.emit(first.runId, {
      type: 'usage',
      usage: { inputTokens: 70, outputTokens: 31, costUsd: 0, toolCalls: 0 },
    })
    await vi.waitFor(() =>
      expect(engine.cancelled).toEqual(expect.arrayContaining([first.runId, second.runId])),
    )
    await Promise.all([coordinator.wait(first.runId), coordinator.wait(second.runId)])
    expect(registry.get(first.runId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'subagent_budget_tokens',
    })
  })

  it('reconciles crash state, resumes with a new attempt, and never resumes a confirmed result', async () => {
    const { coordinator, registry, engine } = await fixture()
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'recoverable',
      task: 'Recover.',
      parentSnapshot: parentSnapshot(),
      projectRoot: '/trusted/project',
    })
    const internal = registry.getInternal(run.runId)!
    engine.setReconcile(internal.providerRunId!, { status: 'resumable' })
    coordinator.detachExecutionsAfterCrash()
    engine.emit(run.runId, { type: 'assistant.delta', text: 'late after crash' })
    await coordinator.reconcile()
    expect(registry.get(run.runId)).toMatchObject({ status: 'resumable', attempt: 1 })

    const resumed = await coordinator.resume(run.runId)
    expect(resumed).toMatchObject({ runId: run.runId, status: 'running', attempt: 2 })
    expect(engine.inputs.at(-1)).toMatchObject({
      runId: run.runId,
      attempt: 2,
      task: 'Continue the interrupted subagent task from its durable child session.',
    })
    engine.emit(run.runId, { type: 'completed', result: { kind: 'text', text: 'confirmed' } })
    await coordinator.wait(run.runId)
    await expect(coordinator.resume(run.runId)).rejects.toMatchObject({
      code: 'subagent_not_resumable',
    })
    expect(registry.get(run.runId)?.result).toEqual({ kind: 'text', text: 'confirmed' })
  })

  it('maps provider failures to stable codes without exposing raw event bodies', async () => {
    const { coordinator, registry, engine } = await fixture()
    const events: unknown[] = []
    const unsubscribe = coordinator.onEvent((event) => events.push(event))
    const run = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'failure',
      task: 'Fail safely.',
      parentSnapshot: parentSnapshot(),
    })
    engine.emit(run.runId, {
      type: 'failed',
      errorCode: 'provider_failed',
      raw: { secret: 'must-not-leak', body: 'upstream body' },
    })
    await coordinator.wait(run.runId)
    unsubscribe()
    expect(registry.get(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_failed',
    })
    expect(JSON.stringify(events)).not.toContain('must-not-leak')
    expect(JSON.stringify(events)).not.toContain('upstream body')
  })

  it('rejects cross-document nesting and malformed roles before dispatch', async () => {
    const { coordinator, registry, engine } = await fixture()
    const child = await coordinator.spawn({
      parentRunId,
      parentSessionId,
      documentId,
      role: 'valid-role',
      task: 'Valid.',
      parentSnapshot: parentSnapshot(),
    })
    await expect(
      coordinator.spawn({
        parentRunId: child.runId,
        parentSessionId,
        documentId: '44444444-4444-4444-8444-444444444444',
        role: 'cross-document',
        task: 'Invalid.',
        parentSnapshot: registry.getInternal(child.runId)!.capabilitySnapshot,
      }),
    ).rejects.toBeInstanceOf(SubagentCoordinatorError)
    await expect(
      coordinator.spawn({
        parentRunId,
        parentSessionId,
        documentId,
        role: '../unsafe',
        task: 'Invalid.',
        parentSnapshot: parentSnapshot(),
      }),
    ).rejects.toMatchObject({ code: 'subagent_request_invalid' })
    expect(engine.inputs).toHaveLength(1)
    engine.emit(child.runId, { type: 'completed', result: { kind: 'text', text: 'done' } })
    await coordinator.wait(child.runId)
  })
})
