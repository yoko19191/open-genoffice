import { access, chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import { PiSubagentEngine } from '../src/pi-subagent-engine'
import type { SubagentEngineInput, SubagentEngineEvent } from '../src/subagent-coordinator'

const roots: string[] = []
const piFixture = fileURLToPath(new URL('../fixtures/pi-headless-fixture', import.meta.url))

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  )
})

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

function snapshot(): CapabilitySnapshot {
  return {
    snapshotId: 'a'.repeat(64),
    createdForRunId: '11111111-1111-4111-8111-111111111111',
    model: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      capabilities: ['text-input', 'tool-use'],
    },
    resourceHashes: { 'global:skill/reviewer': 'b'.repeat(64) },
    toolIds: ['mcp:search:query', 'platform:resource:read'],
    permissionVersion: 'permission-v1',
  }
}

function input(signal = new AbortController().signal): SubagentEngineInput {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    rootRunId: '22222222-2222-4222-8222-222222222222',
    parentRunId: '22222222-2222-4222-8222-222222222222',
    parentSessionId: '33333333-3333-4333-8333-333333333333',
    sessionId: '44444444-4444-4444-8444-444444444444',
    documentId: '55555555-5555-4555-8555-555555555555',
    role: 'reviewer',
    task: 'Review the synthetic context.',
    attempt: 1,
    correlationId: '66666666-6666-4666-8666-666666666666',
    model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
    tools: [
      { canonicalToolId: 'mcp:search:query', modelAlias: 'search_query', effect: 'read' },
      {
        canonicalToolId: 'platform:resource:read',
        modelAlias: 'resource_read',
        effect: 'read',
      },
    ],
    capabilitySnapshot: snapshot(),
    officeContext: { kind: 'pdf', revision: 'revision-1', summary: 'synthetic' },
    resourceTexts: ['Reviewer skill', 'Brief prompt'],
    timeoutMs: 2_000,
    signal,
  }
}

async function collect(events: AsyncIterable<SubagentEngineEvent>): Promise<SubagentEngineEvent[]> {
  const result: SubagentEngineEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

async function installPiFixture(bin: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  if (process.platform === 'win32') {
    const nativeFixture = process.env.GENOFFICE_WINDOWS_PI_FIXTURE
    if (!nativeFixture) throw new Error('windows_pi_fixture_missing')
    await copyFile(nativeFixture, join(bin, 'pi.exe'))
    return
  }
  await chmod(piFixture, 0o755)
  await symlink(piFixture, join(bin, 'pi'))
}

describe('PiSubagentEngine', () => {
  it('runs the official public API through a hermetic headless Pi process', async () => {
    const resourceHome = await root('genoffice-subagent-official-')
    const fakeHome = await root('genoffice-subagent-official-home-')
    const bin = await root('genoffice-subagent-official-bin-')
    await installPiFixture(bin)
    const previous = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    }
    process.env.HOME = fakeHome
    process.env.PATH = `${bin}${delimiter}${previous.PATH ?? ''}`
    process.env.PI_CODING_AGENT_DIR = join(resourceHome, 'state', 'subagent-pi-agent')
    try {
      const engine = new PiSubagentEngine({ resourceHome, pollIntervalMs: 10 })
      const handle = await engine.spawn({ ...input(), tools: [], timeoutMs: 10_000 })
      const events = await collect(handle.events)
      if (!events.some((event) => event.type === 'completed')) {
        const attemptDirectory = join(
          resourceHome,
          'state',
          'subagent-engine',
          input().runId,
          'provider-runs',
          handle.providerRunId,
          'attempts',
          handle.providerAttemptId,
        )
        const diagnostics = Object.fromEntries(
          await Promise.all(
            ['result.json', 'stderr.log', 'output.log', 'worker.log'].map(async (name) => [
              name,
              (await readFile(join(attemptDirectory, name), 'utf8').catch(() => '')).slice(-4000),
            ]),
          ),
        )
        throw new Error(
          `native_subagent_test_incomplete:${JSON.stringify({ events, diagnostics })}`,
        )
      }
      expect(events).toEqual(
        expect.arrayContaining([
          {
            type: 'completed',
            result: { kind: 'text', text: 'fixture child completed' },
          },
        ]),
      )
      await expect(
        engine.reconcile({
          providerRunId: handle.providerRunId,
          providerAttemptId: handle.providerAttemptId,
        }),
      ).resolves.toMatchObject({
        status: 'completed',
        result: { kind: 'text', text: 'fixture child completed' },
      })
      await expect(access(join(fakeHome, '.pi', 'agents'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(access(join(fakeHome, '.pi', 'agent', 'agents'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(
        access(join(resourceHome, 'state', 'subagent-engine', input().runId, 'provider-runs')),
      ).resolves.toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 15_000)

  it('cancels the official headless process tree without leaving a grandchild', async () => {
    const resourceHome = await root('genoffice-subagent-official-cancel-')
    const bin = await root('genoffice-subagent-official-cancel-bin-')
    await installPiFixture(bin)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
    try {
      const engine = new PiSubagentEngine({ resourceHome, pollIntervalMs: 10 })
      const handle = await engine.spawn({
        ...input(),
        task: 'BLOCK_FOR_CANCEL',
        tools: [],
        timeoutMs: 10_000,
      })
      const childPidPath = join(
        resourceHome,
        'state',
        'subagent-engine',
        input().runId,
        'fixture-child.pid',
      )
      await vi.waitFor(async () => expect(await readFile(childPidPath, 'utf8')).toMatch(/^\d+$/), {
        timeout: 5_000,
      })
      const childPid = Number(await readFile(childPidPath, 'utf8'))
      await handle.cancel('parent_run_aborted')
      await expect(collect(handle.events)).resolves.toContainEqual({ type: 'cancelled' })
      await vi.waitFor(
        () => {
          expect(() => process.kill(childPid, 0)).toThrow()
        },
        { timeout: 5_000 },
      )
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  }, 20_000)

  it('uses the fixed public headless API with an agentless, product-owned workspace and no ambient Pi resources', async () => {
    const resourceHome = await root('genoffice-subagent-engine-')
    const fakeHome = await root('genoffice-subagent-fake-home-')
    const calls: unknown[] = []
    let reads = 0
    const api = {
      runSubagent: vi.fn(async (options: unknown) => {
        calls.push(options)
        return {
          runId: 'provider-run-1',
          attemptId: 'provider-attempt-1',
          status: 'running',
        }
      }),
      getSubagentStatus: vi.fn(async () => {
        reads += 1
        return reads === 1
          ? {
              runId: 'provider-run-1',
              attemptId: 'provider-attempt-1',
              status: 'running',
              metadata: {
                usage: { input: 8, output: 5, totalCost: 0.125, toolCalls: 2 },
              },
            }
          : {
              runId: 'provider-run-1',
              attemptId: 'provider-attempt-1',
              status: 'completed',
              metadata: {
                usage: { input: 8, output: 5, totalCost: 0.125, toolCalls: 2 },
              },
            }
      }),
      getSubagentLogs: vi.fn(async () => ({
        logText: { output: 'structured provider result' },
      })),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(),
    }
    const previousHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 1 })
      const handle = await engine.spawn(input())
      expect(handle).toMatchObject({
        providerRunId: 'provider-run-1',
        providerAttemptId: 'provider-attempt-1',
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        backend: 'headless',
        async: true,
        onComplete: 'detach',
        agentScope: 'global',
        confirmProjectAgents: true,
        task: 'Review the synthetic context.',
        model: 'fixture-provider/fixture-model',
        tools: ['resource_read', 'search_query'],
        skills: [],
        extensions: [],
        sessionId: '44444444-4444-4444-8444-444444444444',
        correlationId: '66666666-6666-4666-8666-666666666666',
        timeoutMs: 2_000,
        runsDir: 'provider-runs',
      })
      expect(calls[0]).not.toHaveProperty('agent')
      expect(calls[0]).not.toHaveProperty('requestedTools')
      expect(String((calls[0] as { systemPrompt: string }).systemPrompt)).toContain(
        'read-only GenOffice Subagent',
      )
      expect(String((calls[0] as { systemPrompt: string }).systemPrompt)).toContain(
        '"summary":"synthetic"',
      )

      await expect(collect(handle.events)).resolves.toEqual([
        {
          type: 'usage',
          usage: { inputTokens: 8, outputTokens: 5, costUsd: 0.125, toolCalls: 2 },
        },
        { type: 'completed', result: { kind: 'text', text: 'structured provider result' } },
      ])
      await expect(access(join(fakeHome, '.pi'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.stringify(calls)).not.toContain(fakeHome)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  it('interrupts the exact provider attempt and maps cancellation without raw signals', async () => {
    const resourceHome = await root('genoffice-subagent-engine-')
    let status = 'running'
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: 'provider-run-2',
        attemptId: 'provider-attempt-2',
        status: 'running',
      })),
      getSubagentStatus: vi.fn(async () => ({
        runId: 'provider-run-2',
        attemptId: 'provider-attempt-2',
        status,
        metadata: {},
      })),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(async () => {
        status = 'cancelled'
        return { status: 'interrupted' }
      }),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 1 })
    const handle = await engine.spawn(input())
    await handle.cancel('parent_stop')
    expect(api.interruptSubagent).toHaveBeenCalledWith({
      cwd: join(resourceHome, 'state', 'subagent-engine', input().runId),
      runsDir: 'provider-runs',
      runId: 'provider-run-2',
      attemptId: 'provider-attempt-2',
      reason: 'parent_stop',
    })
    await expect(collect(handle.events)).resolves.toEqual([{ type: 'cancelled' }])
  })

  it('accepts a provider-originated cancelled terminal state without a local cancel request', async () => {
    const resourceHome = await root('genoffice-subagent-engine-provider-cancelled-')
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: 'provider-run-cancelled',
        attemptId: 'provider-attempt-cancelled',
      })),
      getSubagentStatus: vi.fn(async () => ({ status: 'cancelled' })),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 1 })
    const handle = await engine.spawn(input())

    await expect(collect(handle.events)).resolves.toEqual([{ type: 'cancelled' }])
    expect(api.interruptSubagent).not.toHaveBeenCalled()
  })

  it('kills a Windows provider process tree before settling the exact attempt as cancelled', async () => {
    const resourceHome = await root('genoffice-subagent-engine-windows-')
    const statuses: Array<unknown | Error> = [
      new Error('private status error'),
      null,
      { attempts: [] },
      { attempts: [{ attemptId: 'provider-attempt-3', pid: 0 }, 'invalid'] },
      { attempts: [{ attemptId: 'provider-attempt-3', pid: 4321 }] },
    ]
    const killWindowsProcessTree = vi.fn(async () => undefined)
    let interrupted = false
    const api = {
      runSubagent: vi.fn(async () => {
        interrupted = false
        return {
          runId: 'provider-run-3',
          attemptId: 'provider-attempt-3',
        }
      }),
      getSubagentStatus: vi.fn(async () => {
        if (interrupted) return { status: 'cancelled' }
        const next = statuses.shift()
        if (next instanceof Error) throw next
        return next
      }),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(async () => {
        interrupted = true
        return { status: 'interrupt-requested' }
      }),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({
      resourceHome,
      api,
      platform: 'win32',
      killWindowsProcessTree,
    })
    for (let index = 0; index < 5; index += 1) {
      const handle = await engine.spawn(input())
      await handle.cancel('parent_stop')
      await expect(collect(handle.events)).resolves.toEqual([{ type: 'cancelled' }])
    }
    expect(killWindowsProcessTree).toHaveBeenCalledOnce()
    expect(killWindowsProcessTree).toHaveBeenCalledWith(4321)
    expect(api.interruptSubagent).toHaveBeenCalledTimes(5)
  })

  it('keeps provider interruption authoritative when native Windows tree cleanup is unavailable', async () => {
    const resourceHome = await root('genoffice-subagent-engine-windows-fallback-')
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: 'provider-run-fallback',
        attemptId: 'provider-attempt-fallback',
      })),
      getSubagentStatus: vi.fn(async () => ({
        status: 'running',
        attempts: [{ attemptId: 'provider-attempt-fallback', pid: Number.MAX_SAFE_INTEGER }],
      })),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(async () => ({ status: 'interrupt-requested' })),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({ resourceHome, api, platform: 'win32' })
    const handle = await engine.spawn(input())
    await expect(handle.cancel('parent_stop')).resolves.toBeUndefined()
    await expect(collect(handle.events)).resolves.toEqual([{ type: 'cancelled' }])
    expect(api.interruptSubagent).toHaveBeenCalledOnce()
  })

  it('finishes Windows tree cleanup before upstream interruption can orphan descendants', async () => {
    const resourceHome = await root('genoffice-subagent-engine-windows-order-')
    const order: string[] = []
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: 'provider-run-order',
        attemptId: 'provider-attempt-order',
      })),
      getSubagentStatus: vi.fn(async () => ({
        status: 'running',
        attempts: [{ attemptId: 'provider-attempt-order', pid: 4321 }],
      })),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(async () => {
        order.push('interrupt')
      }),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({
      resourceHome,
      api,
      platform: 'win32',
      killWindowsProcessTree: async () => {
        await Promise.resolve()
        order.push('tree-killed')
      },
    })
    const handle = await engine.spawn(input())
    await handle.cancel('parent_stop')
    expect(order).toEqual(['tree-killed', 'interrupt'])
  })

  it.each([
    ['committed-result', 'completed'],
    ['already-terminal', 'failed'],
    ['marked-stale', 'resumable'],
    ['marked-cancelled', 'cancelled'],
    ['not-found', 'unknown'],
  ] as const)(
    'maps reconcile %s to %s without returning upstream records',
    async (upstream, expected) => {
      const resourceHome = await root('genoffice-subagent-engine-')
      const api = {
        runSubagent: vi.fn(),
        getSubagentStatus: vi.fn(async () => ({
          status: expected === 'completed' ? 'completed' : 'failed',
          metadata: {},
        })),
        getSubagentLogs: vi.fn(async () => ({ logText: { output: 'reconciled result' } })),
        interruptSubagent: vi.fn(),
        reconcileSubagentRun: vi.fn(async () => ({
          status: upstream,
          record: { privatePath: '/must/not/leak' },
        })),
      }
      const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 1 })
      const result = await engine.reconcile({
        providerRunId: 'provider-run',
        providerAttemptId: 'provider-attempt',
      })
      expect(result.status).toBe(expected)
      expect(JSON.stringify(result)).not.toContain('privatePath')
      if (expected === 'completed') {
        expect(result).toMatchObject({ result: { kind: 'text', text: 'reconciled result' } })
      }
    },
  )

  it('bounds result text and treats malformed usage and provider exceptions as stable failures', async () => {
    const resourceHome = await root('genoffice-subagent-engine-')
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: 'provider-run',
        attemptId: 'provider-attempt',
        status: 'running',
      })),
      getSubagentStatus: vi.fn(async () => ({
        status: 'failed',
        failureKind: 'provider_error',
        metadata: { usage: { input: -1, output: Number.NaN, totalCost: 'secret' } },
      })),
      getSubagentLogs: vi.fn(async () => ({ logText: { output: 'x'.repeat(70_000) } })),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(async () => {
        throw new Error('private upstream error')
      }),
    }
    const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 1 })
    const handle = await engine.spawn(input())
    await expect(collect(handle.events)).resolves.toEqual([
      { type: 'failed', errorCode: 'subagent_provider_failed' },
    ])
    await expect(
      engine.reconcile({ providerRunId: 'provider-run', providerAttemptId: 'provider-attempt' }),
    ).resolves.toEqual({ status: 'unknown' })
  })

  it('rejects malformed provider references and bounded child context before watching', async () => {
    const resourceHome = await root('genoffice-subagent-engine-invalid-')
    const api = {
      runSubagent: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ runId: 'provider-run' }),
      getSubagentStatus: vi.fn(),
      getSubagentLogs: vi.fn(),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({ resourceHome, api })
    await expect(engine.spawn(input())).rejects.toThrowError('subagent_engine_invalid')
    await expect(engine.spawn(input())).rejects.toThrowError('subagent_engine_invalid')

    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(engine.spawn({ ...input(), officeContext: circular })).rejects.toThrowError(
      'subagent_context_invalid',
    )
    await expect(
      engine.spawn({
        ...input(),
        officeContext: undefined,
        resourceTexts: ['x'.repeat(128 * 1024)],
      }),
    ).rejects.toThrowError('subagent_context_invalid')
  })

  it('maps aborted, throwing, malformed and completed watch states to bounded public events', async () => {
    const resourceHome = await root('genoffice-subagent-engine-watch-')
    const statuses: Array<unknown | Error> = [
      new Error('private status failure'),
      null,
      { status: 'completed', metadata: null },
    ]
    const api = {
      runSubagent: vi.fn(async () => ({
        runId: `provider-run-${api.runSubagent.mock.calls.length}`,
        attemptId: `provider-attempt-${api.runSubagent.mock.calls.length}`,
      })),
      getSubagentStatus: vi.fn(async () => {
        const next = statuses.shift()
        if (next instanceof Error) throw next
        return next
      }),
      getSubagentLogs: vi.fn(async () => {
        throw new Error('private logs failure')
      }),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(),
    }
    const engine = new PiSubagentEngine({ resourceHome, api, pollIntervalMs: 0 })

    const throwing = await engine.spawn(input())
    await expect(collect(throwing.events)).resolves.toEqual([
      { type: 'failed', errorCode: 'subagent_provider_failed' },
    ])
    const malformed = await engine.spawn(input())
    await expect(collect(malformed.events)).resolves.toEqual([
      { type: 'failed', errorCode: 'subagent_provider_failed' },
    ])
    const completed = await engine.spawn({
      ...input(),
      officeContext: undefined,
      resourceTexts: [],
    })
    await expect(collect(completed.events)).resolves.toEqual([
      { type: 'completed', result: { kind: 'text', text: '' } },
    ])

    const controller = new AbortController()
    const aborted = await engine.spawn(input(controller.signal))
    controller.abort()
    await expect(collect(aborted.events)).resolves.toEqual([{ type: 'cancelled' }])
  })

  it('fails closed across malformed reconcile status and unavailable provider status', async () => {
    const resourceHome = await root('genoffice-subagent-engine-reconcile-invalid-')
    const reconciled: unknown[] = [
      null,
      { status: 'committed-result' },
      { status: 'already-terminal' },
      { status: 'committed-result' },
    ]
    const api = {
      runSubagent: vi.fn(),
      getSubagentStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('private status failure'))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ status: 'completed', metadata: {} }),
      getSubagentLogs: vi.fn(async () => {
        throw new Error('private logs failure')
      }),
      interruptSubagent: vi.fn(),
      reconcileSubagentRun: vi.fn(async () => reconciled.shift()),
    }
    const engine = new PiSubagentEngine({ resourceHome, api })
    await expect(engine.reconcile({ providerRunId: 'provider-run' })).resolves.toEqual({
      status: 'unknown',
    })
    await expect(engine.reconcile({ providerRunId: 'provider-run' })).resolves.toEqual({
      status: 'unknown',
    })
    await expect(engine.reconcile({ providerRunId: 'provider-run' })).resolves.toEqual({
      status: 'failed',
      errorCode: 'subagent_provider_failed',
    })
    await expect(engine.reconcile({ providerRunId: 'provider-run' })).resolves.toEqual({
      status: 'completed',
      result: { kind: 'text', text: '' },
    })
  })
})
