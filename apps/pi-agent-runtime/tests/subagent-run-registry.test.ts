import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import {
  DEFAULT_SUBAGENT_ROOT_BUDGET,
  SubagentRunRegistry,
  SubagentRunRegistryError,
  type SubagentRootBudget,
} from '../src/subagent-run-registry'

const roots: string[] = []
const parentRunId = '11111111-1111-4111-8111-111111111111'
const parentSessionId = '22222222-2222-4222-8222-222222222222'
const documentId = '33333333-3333-4333-8333-333333333333'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'genoffice-subagent-registry-'))
  roots.push(value)
  return value
}

function ids() {
  let next = 0
  return () => `${String(++next).padStart(8, '0')}-0000-4000-8000-000000000000`
}

function snapshot(runId: string, toolIds = ['platform:resource:read']): CapabilitySnapshot {
  return {
    snapshotId: 'a'.repeat(64),
    createdForRunId: runId,
    model: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      capabilities: ['text-input', 'tool-use'],
    },
    resourceHashes: { 'global:skill/reviewer': 'b'.repeat(64) },
    toolIds,
    permissionVersion: 'permission-v1',
  }
}

function tightBudget(override: Partial<SubagentRootBudget> = {}): SubagentRootBudget {
  return {
    maxDepth: 2,
    maxChildren: 3,
    maxConcurrency: 2,
    maxWallTimeMs: 1_000,
    maxTokens: 100,
    maxCostUsd: 1,
    maxToolCalls: 5,
    ...override,
  }
}

describe('SubagentRunRegistry', () => {
  it('covers lifecycle transitions, wall time, cumulative attempts and event unsubscription', async () => {
    const rootDirectory = await root()
    let now = new Date('2026-08-10T10:00:00.000Z')
    const registry = new SubagentRunRegistry({
      rootDirectory,
      randomUUID: ids(),
      now: () => now,
    })
    const events: string[] = []
    const unsubscribe = registry.onEvent((event) => events.push(event.type))
    await expect(
      registry.create({
        rootRunId: parentRunId,
        parentRunId,
        parentSessionId,
        documentId,
        role: 'before-init',
        model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
        capabilitySnapshot: snapshot('missing'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_registry_invalid' })
    await registry.initialize()
    await registry.initialize()
    const run = await registry.create({
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      projectRoot: '/trusted/project',
      role: 'lifecycle',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    })
    expect(registry.getInternal(run.runId)).toMatchObject({ projectRoot: '/trusted/project' })
    await registry.markStarted(run.runId, {
      providerRunId: 'provider-1',
      providerAttemptId: 'attempt-1',
    })
    expect(registry.activeRuns().map(({ runId }) => runId)).toContain(run.runId)
    await registry.markWaiting(run.runId, true)
    await registry.markWaiting(run.runId, false)
    await registry.updateUsage(run.runId, { inputTokens: 10 })
    await registry.updateUsage(run.runId, { inputTokens: 15, outputTokens: 3 }, 'attempt-total')
    expect(registry.getInternal(run.runId)).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 3 },
      attemptUsage: { inputTokens: 15, outputTokens: 3 },
    })
    await expect(registry.assertWallTime(run.runId)).resolves.toBeUndefined()
    now = new Date('2026-08-10T10:00:01.001Z')
    await expect(registry.assertWallTime(run.runId)).rejects.toMatchObject({
      code: 'subagent_budget_wall_time',
    })
    await registry.cancel(run.runId)
    await expect(registry.updateUsage(run.runId, { inputTokens: 1 })).rejects.toMatchObject({
      code: 'subagent_state_invalid',
    })
    expect(registry.get(run.runId)).toMatchObject({ status: 'cancelled', durationMs: 1_001 })
    unsubscribe()
    const eventCount = events.length

    const failed = await registry.create({
      rootRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      parentRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      parentSessionId,
      documentId,
      role: 'failed',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    })
    await registry.beginCancelling(failed.runId, 'parent_cancelled')
    await registry.fail(failed.runId, 'provider_failed')
    const sibling = await registry.create({
      rootRunId: failed.rootRunId,
      parentRunId: failed.parentRunId,
      parentSessionId,
      documentId,
      role: 'sibling',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
    })
    await registry.fail(sibling.runId, 'provider_failed')
    expect(registry.listChildren(failed.parentRunId)).toHaveLength(2)
    expect(events).toHaveLength(eventCount)
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.getInternal('missing')).toBeUndefined()
    await expect(registry.cancel('missing')).rejects.toMatchObject({
      code: 'subagent_run_not_found',
    })
  })

  it('rejects invalid creation, state, persistence and lineage variants fail closed', async () => {
    const rootDirectory = await root()
    const registry = new SubagentRunRegistry({ rootDirectory, randomUUID: ids() })
    await registry.initialize()
    const base = {
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'guard',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
    }
    await expect(
      registry.create({
        ...base,
        budget: { ...tightBudget(), maxDepth: 0 },
        capabilitySnapshot: snapshot('invalid-budget'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_budget_invalid' })
    await expect(
      registry.create({ ...base, capabilitySnapshot: { ...snapshot('bad'), snapshotId: 'bad' } }),
    ).rejects.toMatchObject({ code: 'subagent_registry_invalid' })
    const first = await registry.create({
      ...base,
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      capabilitySnapshot: snapshot('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    })
    await expect(
      registry.create({
        ...base,
        runId: first.runId,
        capabilitySnapshot: snapshot(first.runId),
      }),
    ).rejects.toMatchObject({ code: 'subagent_registry_invalid' })
    await expect(
      registry.create({
        ...base,
        budget: tightBudget({ maxTokens: 101 }),
        capabilitySnapshot: snapshot('mismatched-budget'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_budget_invalid' })
    await expect(
      registry.create({
        ...base,
        rootRunId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        parentRunId: first.runId,
        capabilitySnapshot: snapshot('wrong-root'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_registry_invalid' })
    await expect(
      registry
        .markStarted(first.runId, {
          providerRunId: 'provider-1',
          providerAttemptId: 'attempt-1',
        })
        .then(() =>
          registry.markStarted(first.runId, {
            providerRunId: 'provider-2',
            providerAttemptId: 'attempt-2',
          }),
        ),
    ).rejects.toMatchObject({ code: 'subagent_state_invalid' })
    await expect(registry.updateUsage(first.runId, { costUsd: Number.NaN })).rejects.toMatchObject({
      code: 'subagent_budget_invalid',
    })
    await expect(
      registry.complete(first.runId, { result: { kind: 'text', text: 'x'.repeat(70_000) } }),
    ).rejects.toMatchObject({ code: 'subagent_registry_invalid' })
    const child = await registry.create({
      ...base,
      parentRunId: first.runId,
      runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      capabilitySnapshot: snapshot('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    })

    const directory = join(rootDirectory, 'state', 'subagent-runs')
    await writeFile(join(directory, 'ignored.txt'), 'ignored')
    const persistedPath = join(directory, `${first.runId}.json`)
    await rename(persistedPath, join(directory, 'wrong-name.json'))
    await expect(new SubagentRunRegistry({ rootDirectory }).initialize()).rejects.toMatchObject({
      code: 'subagent_registry_invalid',
    })
    await rename(join(directory, 'wrong-name.json'), persistedPath)
    await symlink(persistedPath, join(directory, 'linked.json'))
    await expect(new SubagentRunRegistry({ rootDirectory }).initialize()).rejects.toMatchObject({
      code: 'subagent_registry_invalid',
    })
    await writeFile(persistedPath, JSON.stringify({ schemaVersion: 1 }))
    await expect(new SubagentRunRegistry({ rootDirectory }).initialize()).rejects.toMatchObject({
      code: 'subagent_registry_invalid',
    })
    await rm(join(directory, 'linked.json'))
    const childPath = join(directory, `${child.runId}.json`)
    const persistedChild = JSON.parse(await readFile(childPath, 'utf8'))
    persistedChild.documentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    await writeFile(childPath, JSON.stringify(persistedChild))
    await expect(new SubagentRunRegistry({ rootDirectory }).initialize()).rejects.toMatchObject({
      code: 'subagent_registry_invalid',
    })
    persistedChild.documentId = documentId
    await writeFile(childPath, JSON.stringify(persistedChild))
    const persisted = JSON.parse(await readFile(persistedPath, 'utf8'))
    persisted.depth = 2
    await writeFile(persistedPath, JSON.stringify(persisted))
    await expect(new SubagentRunRegistry({ rootDirectory }).initialize()).rejects.toMatchObject({
      code: 'subagent_registry_invalid',
    })
  })

  it('persists authoritative lineage, attempts, budget and a renderer-safe tree', async () => {
    const rootDirectory = await root()
    const registry = new SubagentRunRegistry({
      rootDirectory,
      randomUUID: ids(),
      now: () => new Date('2026-08-10T10:00:00.000Z'),
    })
    await registry.initialize()

    const child = await registry.create({
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'researcher',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('00000001-0000-4000-8000-000000000000'),
    })
    await registry.markStarted(child.runId, {
      providerRunId: 'provider-private-run',
      providerAttemptId: 'provider-private-attempt',
    })
    await registry.updateUsage(child.runId, {
      inputTokens: 11,
      outputTokens: 7,
      costUsd: 0.125,
      toolCalls: 2,
    })
    const grandchild = await registry.create({
      rootRunId: parentRunId,
      parentRunId: child.runId,
      parentSessionId,
      documentId,
      role: 'critic',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('00000003-0000-4000-8000-000000000000'),
    })
    await registry.markStarted(grandchild.runId, {
      providerRunId: 'provider-private-child',
      providerAttemptId: 'provider-private-child-attempt',
    })
    await registry.complete(grandchild.runId, {
      result: { kind: 'text', text: 'structured child result' },
    })
    await registry.complete(child.runId, {
      result: { kind: 'text', text: 'structured root result' },
    })

    const restored = new SubagentRunRegistry({ rootDirectory, randomUUID: ids() })
    await restored.initialize()
    const records = restored.listForSession(parentSessionId)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      runId: child.runId,
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      depth: 1,
      status: 'completed',
      attempt: 1,
      usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.125, toolCalls: 2 },
      result: { kind: 'text', text: 'structured root result' },
      capabilitySnapshotId: 'a'.repeat(64),
    })
    expect(records[1]).toMatchObject({
      runId: grandchild.runId,
      parentRunId: child.runId,
      depth: 2,
      status: 'completed',
    })
    expect(restored.listChildren(child.runId).map(({ runId }) => runId)).toEqual([grandchild.runId])
    const serializedProjection = JSON.stringify(records)
    expect(serializedProjection).not.toContain('provider-private')
    expect(serializedProjection).not.toContain('resourceHashes')
    expect(serializedProjection).not.toContain('toolIds')

    const persisted = await readFile(
      join(rootDirectory, 'state', 'subagent-runs', `${child.runId}.json`),
      'utf8',
    )
    expect(persisted).toContain('provider-private-run')
    expect(persisted).toContain('provider-private-attempt')
    expect(persisted).toContain('correlationId')
    expect(persisted).toContain('capabilitySnapshot')
  })

  it('enforces depth, total children and concurrency against the shared root budget', async () => {
    const registry = new SubagentRunRegistry({
      rootDirectory: await root(),
      randomUUID: ids(),
    })
    await registry.initialize()
    const budget = tightBudget({ maxChildren: 2, maxConcurrency: 1 })
    const first = await registry.create({
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'first',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget,
      capabilitySnapshot: snapshot('00000001-0000-4000-8000-000000000000'),
    })
    await registry.markStarted(first.runId, {
      providerRunId: 'provider-1',
      providerAttemptId: 'attempt-1',
    })

    await expect(
      registry.create({
        rootRunId: parentRunId,
        parentRunId,
        parentSessionId,
        documentId,
        role: 'concurrent',
        model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
        budget,
        capabilitySnapshot: snapshot('00000002-0000-4000-8000-000000000000'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_budget_concurrency' })

    await registry.complete(first.runId, { result: { kind: 'text', text: 'done' } })
    const second = await registry.create({
      rootRunId: parentRunId,
      parentRunId: first.runId,
      parentSessionId,
      documentId,
      role: 'second',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget,
      capabilitySnapshot: snapshot('00000003-0000-4000-8000-000000000000'),
    })
    await registry.complete(second.runId, { result: { kind: 'text', text: 'done' } })
    await expect(
      registry.create({
        rootRunId: parentRunId,
        parentRunId: second.runId,
        parentSessionId,
        documentId,
        role: 'too-deep',
        model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
        budget,
        capabilitySnapshot: snapshot('00000004-0000-4000-8000-000000000000'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_budget_depth' })
    await expect(
      registry.create({
        rootRunId: parentRunId,
        parentRunId,
        parentSessionId,
        documentId,
        role: 'too-many',
        model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
        budget,
        capabilitySnapshot: snapshot('00000005-0000-4000-8000-000000000000'),
      }),
    ).rejects.toMatchObject({ code: 'subagent_budget_children' })
  })

  it.each([
    ['tokens', { inputTokens: 60, outputTokens: 41 }, 'subagent_budget_tokens'],
    ['cost', { costUsd: 1.01 }, 'subagent_budget_cost'],
    ['tools', { toolCalls: 6 }, 'subagent_budget_tools'],
  ] as const)(
    'terminates execution when the shared %s budget is exceeded',
    async (_name, usage, code) => {
      const registry = new SubagentRunRegistry({
        rootDirectory: await root(),
        randomUUID: ids(),
      })
      await registry.initialize()
      const run = await registry.create({
        rootRunId: parentRunId,
        parentRunId,
        parentSessionId,
        documentId,
        role: 'budget-check',
        model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
        budget: tightBudget(),
        capabilitySnapshot: snapshot('00000001-0000-4000-8000-000000000000'),
      })
      await registry.markStarted(run.runId, {
        providerRunId: 'provider-1',
        providerAttemptId: 'attempt-1',
      })
      await expect(registry.updateUsage(run.runId, usage)).rejects.toMatchObject({ code })
      expect(registry.get(run.runId)).toMatchObject({ status: 'cancelling', errorCode: code })
    },
  )

  it('marks stale active work resumable or failed and resumes with a new product attempt', async () => {
    const rootDirectory = await root()
    const registry = new SubagentRunRegistry({ rootDirectory, randomUUID: ids() })
    await registry.initialize()
    const run = await registry.create({
      rootRunId: parentRunId,
      parentRunId,
      parentSessionId,
      documentId,
      role: 'recoverable',
      model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
      budget: tightBudget(),
      capabilitySnapshot: snapshot('00000001-0000-4000-8000-000000000000'),
    })
    await registry.markStarted(run.runId, {
      providerRunId: 'provider-old',
      providerAttemptId: 'attempt-old',
    })
    await registry.beginReconcile(run.runId)
    await registry.markReconciled(run.runId, { resumable: true, errorCode: 'runtime_crash' })
    expect(registry.get(run.runId)).toMatchObject({ status: 'resumable', attempt: 1 })
    await registry.beginResume(run.runId)
    await registry.markStarted(run.runId, {
      providerRunId: 'provider-new',
      providerAttemptId: 'attempt-new',
    })
    expect(registry.getInternal(run.runId)).toMatchObject({
      status: 'running',
      attempt: 2,
      providerRunId: 'provider-new',
      providerAttemptId: 'attempt-new',
    })
    await registry.markReconciled(run.runId, {
      resumable: false,
      errorCode: 'provider_result_unknown',
    })
    expect(registry.get(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'provider_result_unknown',
    })
  })

  it('fails closed on malformed or unknown registry files and exposes fixed defaults', async () => {
    const rootDirectory = await root()
    const directory = join(rootDirectory, 'state', 'subagent-runs')
    await writeFile(join(rootDirectory, 'placeholder'), '')
    const registry = new SubagentRunRegistry({ rootDirectory, randomUUID: ids() })
    await registry.initialize()
    await writeFile(join(directory, 'malformed.json'), '{')
    const restored = new SubagentRunRegistry({ rootDirectory, randomUUID: ids() })
    await expect(restored.initialize()).rejects.toBeInstanceOf(SubagentRunRegistryError)
    expect(DEFAULT_SUBAGENT_ROOT_BUDGET).toEqual({
      maxDepth: 2,
      maxChildren: 8,
      maxConcurrency: 4,
      maxWallTimeMs: 30 * 60 * 1_000,
      maxTokens: 200_000,
      maxCostUsd: 10,
      maxToolCalls: 128,
    })
  })
})
