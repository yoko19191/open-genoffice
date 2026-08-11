import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_VERSION, type EventEnvelope } from '@genoffice/agent-runtime-protocol'
import { PiRuntimeSupervisor, type SupervisedPiRuntimeManager } from '../src'

function harness(
  options: {
    failStartAt?: number
    delay?: (milliseconds: number) => Promise<void>
    crashDuringShutdown?: boolean
    startGate?: Promise<void>
    waitForStartOnShutdown?: boolean
  } = {},
) {
  let managerId = 0
  let now = 0
  const delays: number[] = []
  const managers: Array<
    SupervisedPiRuntimeManager & {
      crash: () => void
      emit: (event: EventEnvelope) => void
      shutdown: ReturnType<typeof vi.fn>
    }
  > = []
  const createManager = vi.fn((onCrash: () => void) => {
    managerId += 1
    const id = managerId
    let eventListener: (event: EventEnvelope) => void = () => {}
    const manager = {
      start: vi.fn(async () => {
        await options.startGate
        if (options.failStartAt === id) throw new Error(`start-${id}-failed`)
        return {
          state: 'ready' as const,
          pid: 1_000 + id,
          instanceId: `instance-${id}`,
          runtimeVersion: RUNTIME_VERSION,
        }
      }),
      shutdown: vi.fn(async () => {
        if (options.waitForStartOnShutdown) await options.startGate
        if (options.crashDuringShutdown) onCrash()
      }),
      createSession: vi.fn(async (input) => ({
        sessionId: `session-${id}`,
        documentId: input.documentId,
        snapshot: {
          sessionId: `session-${id}`,
          documentId: input.documentId,
          messages: [],
          lastSequence: 0,
          cursor: `cursor-${id}`,
        },
        cursor: `cursor-${id}`,
      })),
      openSession: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        snapshot: {
          sessionId: input.sessionId,
          documentId: input.documentId,
          messages: [],
          lastSequence: 0,
          cursor: `cursor-${id}`,
        },
        cursor: `cursor-${id}`,
      })),
      promptSession: vi.fn(async () => ({ runId: 'run-1', acceptedCursor: `cursor-${id}` })),
      abortSession: vi.fn(async () => ({
        runId: 'run-1',
        state: 'cancelling' as const,
        acceptedCursor: `cursor-${id}`,
      })),
      resumeSubagent: vi.fn(async () => ({
        runId: 'subagent-run-1',
        attempt: 2,
        acceptedCursor: `cursor-${id}`,
      })),
      issueMutationGrant: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        grant: {
          requestId: input.requestId,
          subagentRunId: input.receipt.subagentRunId,
          role: 'Reviewer',
          exactToolIds: input.receipt.exactToolIds,
          requestedAt: input.receipt.issuedAt,
          expiresAt: input.receipt.expiresAt,
          status: 'active' as const,
          grantId: input.receipt.grantId,
        },
        acceptedCursor: `cursor-${id}`,
      })),
      denyMutationGrant: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        grant: {
          requestId: input.requestId,
          subagentRunId: 'subagent-run-1',
          role: 'Reviewer',
          exactToolIds: ['office:docs:insert_content'],
          requestedAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-10T00:05:00.000Z',
          status: 'denied' as const,
        },
        acceptedCursor: `cursor-${id}`,
      })),
      revokeMutationGrant: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        grant: {
          requestId: 'grant-request-1',
          subagentRunId: 'subagent-run-1',
          role: 'Reviewer',
          exactToolIds: ['office:docs:insert_content'],
          requestedAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-10T00:05:00.000Z',
          status: 'revoked' as const,
          grantId: input.grantId,
        },
        acceptedCursor: `cursor-${id}`,
      })),
      revokeDocumentMutationGrants: vi.fn(async () => ({ revoked: true as const })),
      answerUserAction: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        action: {
          requestId: input.requestId,
          runId: 'run-1',
          mode: 'confirm' as const,
          question: 'Continue?',
          requestedAt: '2026-08-11T00:00:00.000Z',
          status: 'answered' as const,
        },
        acceptedCursor: 'cursor-1',
      })),
      forkSession: vi.fn(async (input) => ({
        sessionId: `fork-session-${id}`,
        parentSessionId: input.sessionId,
        documentId: input.documentId,
        snapshot: {
          sessionId: `fork-session-${id}`,
          documentId: input.documentId,
          messages: [],
          branch: { parentSessionId: input.sessionId, nodes: [] },
          lastSequence: 0,
          cursor: `cursor-${id}`,
        },
        cursor: `cursor-${id}`,
      })),
      navigateSession: vi.fn(async (input) => ({
        sessionId: input.sessionId,
        documentId: input.documentId,
        activeLeafId: input.targetEntryId,
        snapshot: {
          sessionId: input.sessionId,
          documentId: input.documentId,
          messages: [],
          branch: { activeLeafId: input.targetEntryId, nodes: [] },
          lastSequence: 0,
          cursor: `cursor-${id}`,
        },
        cursor: `cursor-${id}`,
      })),
      snapshotSession: vi.fn(async (input) => ({
        ...input,
        messages: [],
        lastSequence: 0,
        cursor: `cursor-${id}`,
      })),
      subscribeSession: vi.fn(async (input) => ({
        resetRequired: false,
        snapshot: {
          sessionId: input.sessionId,
          documentId: input.documentId,
          messages: [],
          lastSequence: 0,
          cursor: `cursor-${id}`,
        },
        events: [],
      })),
      putCredential: vi.fn(async (input) => ({
        providerId: input.providerId,
        persistence: input.persistence,
        status: 'available' as const,
        kind: 'api_key' as const,
      })),
      credentialStatus: vi.fn(async (input) => ({
        providerId: input.providerId,
        persistence: 'persistent' as const,
        status: 'missing' as const,
      })),
      deleteCredential: vi.fn(async (input) => ({
        providerId: input.providerId,
        persistence: 'persistent' as const,
        status: 'missing' as const,
      })),
      modelCatalog: vi.fn(async () => ({ providers: [], selections: {} })),
      selectModel: vi.fn(async (input) => ({
        providers: [],
        selections: {
          [input.role]: {
            providerId: input.providerId,
            modelId: input.modelId,
            capabilities: ['text-input' as const],
          },
        },
      })),
      configureModelProvider: vi.fn(async () => ({ providers: [], selections: {} })),
      startModelOAuth: vi.fn(async (input) => ({
        operationId: input.operationId,
        providerId: input.providerId,
        state: 'running' as const,
      })),
      modelOAuthStatus: vi.fn(async (input) => ({
        operationId: input.operationId,
        providerId: 'openai-codex',
        state: 'running' as const,
      })),
      respondModelOAuth: vi.fn(async (input) => ({
        operationId: input.operationId,
        providerId: 'openai-codex',
        state: 'running' as const,
      })),
      cancelModelOAuth: vi.fn(async (input) => ({
        operationId: input.operationId,
        providerId: 'openai-codex',
        state: 'cancelled' as const,
      })),
      logoutModel: vi.fn(async () => ({ providers: [], selections: {} })),
      resourceCatalog: vi.fn(async (input = {}) => ({
        catalogId: 'a'.repeat(64),
        projectState: input.projectRoot ? ('untrusted' as const) : ('none' as const),
        resources: [],
      })),
      grantProjectTrust: vi.fn(async () => ({
        catalogId: 'a'.repeat(64),
        projectState: 'trusted' as const,
        resources: [],
      })),
      revokeProjectTrust: vi.fn(async () => ({
        catalogId: 'a'.repeat(64),
        projectState: 'untrusted' as const,
        resources: [],
      })),
      packageCatalog: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      installLocalPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      installNpmPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      installGitPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      activatePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      enablePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      disablePackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      uninstallPackage: vi.fn(async () => ({ globalGeneration: 1, packages: [] })),
      mcpCatalog: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      activateMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      enableMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      disableMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      retryMcp: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      startMcpOAuth: vi.fn(async (input) => ({
        operationId: input.operationId,
        authorizationUrl: 'https://issuer.example.test/authorize?state=safe-state',
        expiresAt: 123_456,
      })),
      completeMcpOAuth: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      cancelMcpOAuth: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      enableMcpTool: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      disableMcpTool: vi.fn(async () => ({ projectState: 'none' as const, servers: [] })),
      onSessionEvent: vi.fn((listener: (event: EventEnvelope) => void) => {
        eventListener = listener
        return () => {
          eventListener = () => {}
        }
      }),
      crash: onCrash,
      emit: (event: EventEnvelope) => eventListener(event),
    } satisfies SupervisedPiRuntimeManager & {
      crash: () => void
      emit: (event: EventEnvelope) => void
    }
    managers.push(manager)
    return manager
  })
  const states: string[] = []
  const supervisor = new PiRuntimeSupervisor(
    {
      createManager,
      now: () => now,
      delay:
        options.delay ??
        (async (milliseconds) => {
          delays.push(milliseconds)
          now += milliseconds
        }),
    },
    (state) => states.push(state),
  )
  return {
    createManager,
    delays,
    managers,
    states,
    supervisor,
    setNow: (value: number) => (now = value),
  }
}

describe('PiRuntimeSupervisor', () => {
  it('restarts with fresh managers and the frozen 250ms/1s/4s backoff sequence', async () => {
    const fixture = harness()
    await expect(fixture.supervisor.start()).resolves.toMatchObject({ instanceId: 'instance-1' })
    for (const instanceId of ['instance-2', 'instance-3', 'instance-4']) {
      fixture.managers.at(-1)!.crash()
      await expect(fixture.supervisor.waitUntilReady()).resolves.toMatchObject({ instanceId })
    }
    expect(fixture.delays).toEqual([250, 1_000, 4_000])
    expect(fixture.createManager).toHaveBeenCalledTimes(4)
    expect(fixture.states).toEqual([
      'starting',
      'ready',
      'crashed',
      'backoff',
      'starting',
      'ready',
      'crashed',
      'backoff',
      'starting',
      'ready',
      'crashed',
      'backoff',
      'starting',
      'ready',
    ])
  })

  it('opens the circuit after the fourth crash inside 60 seconds', async () => {
    const fixture = harness()
    await fixture.supervisor.waitUntilReady()
    for (let index = 0; index < 3; index += 1) {
      fixture.managers.at(-1)!.crash()
      await fixture.supervisor.waitUntilReady()
    }
    fixture.managers.at(-1)!.crash()
    await expect(fixture.supervisor.waitUntilReady()).rejects.toThrowError('runtime_circuit_open')
    expect(fixture.supervisor.state).toBe('circuit_open')
    expect(fixture.createManager).toHaveBeenCalledTimes(4)
  })

  it('forwards Session commands and preserves event listeners across a restart', async () => {
    const fixture = harness()
    const events: EventEnvelope[] = []
    fixture.supervisor.onSessionEvent((event) => events.push(event))
    await fixture.supervisor.start()
    await expect(
      fixture.supervisor.createSession({
        operationId: '11111111-1111-4111-8111-111111111111',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-1' })
    fixture.managers[0]!.crash()
    await fixture.supervisor.waitUntilReady()
    await expect(
      fixture.supervisor.createSession({
        operationId: '22222222-2222-4222-8222-222222222222',
        documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-2' })
    expect(fixture.managers[0]!.onSessionEvent).toHaveBeenCalledOnce()
    expect(fixture.managers[1]!.onSessionEvent).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })

  it('forwards every narrow Session method and detaches an event listener', async () => {
    const fixture = harness()
    const events: EventEnvelope[] = []
    const unsubscribe = fixture.supervisor.onSessionEvent((event) => events.push(event))
    await fixture.supervisor.start()
    await expect(fixture.supervisor.start()).resolves.toMatchObject({ instanceId: 'instance-1' })
    const bound = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    }
    await expect(
      fixture.supervisor.openSession({
        operationId: '11111111-1111-4111-8111-111111111111',
        ...bound,
      }),
    ).resolves.toMatchObject(bound)
    await expect(
      fixture.supervisor.promptSession({
        operationId: '22222222-2222-4222-8222-222222222222',
        ...bound,
        text: 'hello',
      }),
    ).resolves.toMatchObject({ runId: 'run-1' })
    await expect(
      fixture.supervisor.abortSession({
        operationId: '33333333-3333-4333-8333-333333333333',
        ...bound,
        runId: 'run-1',
      }),
    ).resolves.toMatchObject({ state: 'cancelling' })
    await expect(
      fixture.supervisor.resumeSubagent({
        operationId: 'operation-resume',
        sessionId: 'session-1',
        documentId: 'document-1',
        runId: 'subagent-run-1',
      }),
    ).resolves.toMatchObject({ attempt: 2 })
    const grantReceipt = {
      grantId: 'grant-1',
      subagentRunId: 'subagent-run-1',
      documentId: bound.documentId,
      exactToolIds: ['office:docs:insert_content'],
      issuedByUserActionId: 'user-action-1',
      issuedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'active' as const,
    }
    await expect(
      fixture.supervisor.issueMutationGrant({
        operationId: 'operation-grant',
        ...bound,
        requestId: 'grant-request-1',
        receipt: grantReceipt,
      }),
    ).resolves.toMatchObject({ grant: { status: 'active' } })
    await expect(
      fixture.supervisor.denyMutationGrant({
        operationId: 'operation-deny',
        ...bound,
        requestId: 'grant-request-1',
        userActionId: 'user-action-2',
      }),
    ).resolves.toMatchObject({ grant: { status: 'denied' } })
    await expect(
      fixture.supervisor.revokeMutationGrant({
        operationId: 'operation-revoke',
        ...bound,
        grantId: 'grant-1',
        userActionId: 'user-action-3',
      }),
    ).resolves.toMatchObject({ grant: { status: 'revoked' } })
    await expect(
      fixture.supervisor.revokeDocumentMutationGrants({
        operationId: 'operation-close',
        ...bound,
      }),
    ).resolves.toEqual({ revoked: true })
    await expect(
      fixture.supervisor.answerUserAction({
        operationId: 'operation-answer',
        ...bound,
        requestId: 'question-1',
        userActionId: 'user-action-4',
        answer: { confirmed: true },
      }),
    ).resolves.toMatchObject({ action: { status: 'answered' } })
    await expect(
      fixture.supervisor.forkSession({
        operationId: '44444444-4444-4444-8444-444444444444',
        ...bound,
      }),
    ).resolves.toMatchObject({ parentSessionId: bound.sessionId })
    await expect(
      fixture.supervisor.navigateSession({
        operationId: '55555555-5555-4555-8555-555555555555',
        ...bound,
        targetEntryId: 'target-leaf',
      }),
    ).resolves.toMatchObject({ activeLeafId: 'target-leaf' })
    await expect(fixture.supervisor.snapshotSession(bound)).resolves.toMatchObject(bound)
    await expect(fixture.supervisor.subscribeSession(bound)).resolves.toMatchObject({
      resetRequired: false,
    })
    await expect(
      fixture.supervisor.putCredential({
        providerId: 'openai',
        persistence: 'memory_only',
        secretPayload: '{"type":"api_key","key":"supervisor-canary"}',
      }),
    ).resolves.toMatchObject({ status: 'available', persistence: 'memory_only' })
    await expect(
      fixture.supervisor.credentialStatus({ providerId: 'openai' }),
    ).resolves.toMatchObject({ status: 'missing' })
    await expect(
      fixture.supervisor.deleteCredential({ providerId: 'openai' }),
    ).resolves.toMatchObject({ status: 'missing' })
    const oauthOperationId = '66666666-6666-4666-8666-666666666666'
    await expect(fixture.supervisor.modelCatalog()).resolves.toEqual({
      providers: [],
      selections: {},
    })
    await expect(
      fixture.supervisor.selectModel({
        role: 'conversation',
        providerId: 'openai',
        modelId: 'gpt-5.4',
      }),
    ).resolves.toMatchObject({ selections: { conversation: { modelId: 'gpt-5.4' } } })
    await expect(
      fixture.supervisor.configureModelProvider({
        providerId: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'qwen-test',
            name: 'Qwen Test',
            capabilities: ['text-input', 'tool-use'],
          },
        ],
      }),
    ).resolves.toEqual({ providers: [], selections: {} })
    await expect(
      fixture.supervisor.startModelOAuth({
        operationId: oauthOperationId,
        providerId: 'openai-codex',
      }),
    ).resolves.toMatchObject({ state: 'running' })
    await expect(
      fixture.supervisor.modelOAuthStatus({ operationId: oauthOperationId }),
    ).resolves.toMatchObject({ operationId: oauthOperationId })
    await expect(
      fixture.supervisor.respondModelOAuth({
        operationId: oauthOperationId,
        value: 'write-only-response',
      }),
    ).resolves.toMatchObject({ operationId: oauthOperationId })
    await expect(
      fixture.supervisor.cancelModelOAuth({ operationId: oauthOperationId }),
    ).resolves.toMatchObject({ state: 'cancelled' })
    await expect(fixture.supervisor.logoutModel({ providerId: 'openai-codex' })).resolves.toEqual({
      providers: [],
      selections: {},
    })
    const projectRoot = '/selected/project'
    await expect(fixture.supervisor.resourceCatalog({ projectRoot })).resolves.toMatchObject({
      projectState: 'untrusted',
    })
    const trust = { operationId: oauthOperationId, projectRoot }
    await expect(fixture.supervisor.grantProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'trusted',
    })
    await expect(fixture.supervisor.revokeProjectTrust(trust)).resolves.toMatchObject({
      projectState: 'untrusted',
    })
    const packageMutation = {
      namespace: 'global' as const,
      operationId: oauthOperationId,
      packageId: 'safe-extension',
    }
    await expect(fixture.supervisor.packageCatalog({ namespace: 'global' })).resolves.toMatchObject(
      { globalGeneration: 1 },
    )
    await fixture.supervisor.installLocalPackage({
      ...packageMutation,
      localPath: '/main/selected/package',
    })
    await fixture.supervisor.installNpmPackage({
      ...packageMutation,
      name: 'safe-extension',
      version: '1.2.3',
    })
    await fixture.supervisor.installGitPackage({
      ...packageMutation,
      url: 'https://example.com/safe-extension.git',
      commit: 'a'.repeat(40),
    })
    await fixture.supervisor.activatePackage(packageMutation)
    await fixture.supervisor.enablePackage(packageMutation)
    await fixture.supervisor.disablePackage(packageMutation)
    await fixture.supervisor.uninstallPackage(packageMutation)
    const mcpMutation = {
      namespace: 'global' as const,
      operationId: oauthOperationId,
      serverId: 'fixture',
    }
    await fixture.supervisor.mcpCatalog()
    await fixture.supervisor.activateMcp(mcpMutation)
    await fixture.supervisor.enableMcp(mcpMutation)
    await fixture.supervisor.disableMcp(mcpMutation)
    await fixture.supervisor.retryMcp(mcpMutation)
    await fixture.supervisor.startMcpOAuth({
      ...mcpMutation,
      redirectUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${mcpMutation.operationId}`,
    })
    await fixture.supervisor.completeMcpOAuth({
      ...mcpMutation,
      callbackUrl: `http://127.0.0.1:53682/mcp/oauth/callback/${mcpMutation.operationId}?code=x&state=y&iss=https%3A%2F%2Fissuer.example.test`,
    })
    await fixture.supervisor.cancelMcpOAuth(mcpMutation)
    await fixture.supervisor.enableMcpTool({ ...mcpMutation, toolName: 'read_fixture' })
    await fixture.supervisor.disableMcpTool({ ...mcpMutation, toolName: 'read_fixture' })
    expect(fixture.managers[0]!.installLocalPackage).toHaveBeenCalledWith({
      ...packageMutation,
      localPath: '/main/selected/package',
    })
    expect(fixture.managers[0]!.disableMcpTool).toHaveBeenCalledWith({
      ...mcpMutation,
      toolName: 'read_fixture',
    })
    expect(fixture.managers[0]!.cancelMcpOAuth).toHaveBeenCalledWith(mcpMutation)
    const emitted = {
      protocolVersion: '1',
      kind: 'event',
      eventId: 'event-1',
      instanceId: 'instance-1',
      ...bound,
      sequence: 1,
      cursor: 'cursor-1',
      occurredAt: '2026-08-09T12:00:00.000Z',
      type: 'session.opened',
      payload: {},
    } satisfies EventEnvelope
    fixture.managers[0]!.emit(emitted)
    unsubscribe()
    fixture.managers[0]!.emit({ ...emitted, eventId: 'event-2' })
    expect(events).toEqual([emitted])
  })

  it('can start and stop 100 times without retaining managers', async () => {
    const fixture = harness()
    for (let index = 0; index < 100; index += 1) {
      await fixture.supervisor.start()
      await fixture.supervisor.shutdown()
    }
    expect(fixture.createManager).toHaveBeenCalledTimes(100)
    expect(fixture.managers.every((manager) => manager.shutdown.mock.calls.length === 1)).toBe(true)
    expect(fixture.supervisor.state).toBe('stopped')
  })

  it('forgets crashes outside the rolling 60-second window', async () => {
    const fixture = harness()
    await fixture.supervisor.start()
    fixture.managers[0]!.crash()
    await fixture.supervisor.waitUntilReady()
    fixture.setNow(61_000)
    fixture.managers[1]!.crash()
    await fixture.supervisor.waitUntilReady()
    expect(fixture.delays).toEqual([250, 250])
  })

  it('fails a fresh or restarted manager closed and can shut down without one', async () => {
    const initialFailure = harness({ failStartAt: 1 })
    await expect(initialFailure.supervisor.start()).rejects.toThrowError('start-1-failed')
    expect(initialFailure.supervisor.state).toBe('crashed')
    await initialFailure.supervisor.shutdown()
    await initialFailure.supervisor.shutdown()

    const restartFailure = harness({ failStartAt: 2 })
    await restartFailure.supervisor.start()
    restartFailure.managers[0]!.crash()
    await expect(restartFailure.supervisor.waitUntilReady()).rejects.toThrowError('start-2-failed')
    expect(restartFailure.supervisor.state).toBe('crashed')
  })

  it('ignores stale, duplicate, and shutdown crash notifications', async () => {
    const fixture = harness({ crashDuringShutdown: true })
    await fixture.supervisor.start()
    fixture.managers[0]!.crash()
    fixture.managers[0]!.crash()
    await fixture.supervisor.waitUntilReady()
    fixture.managers[0]!.crash()
    expect(fixture.supervisor.state).toBe('ready')
    await fixture.supervisor.shutdown()
    expect(fixture.supervisor.state).toBe('stopped')
  })

  it('stops an in-progress recovery before creating another manager', async () => {
    let releaseDelay!: () => void
    const delayed = new Promise<void>((resolve) => {
      releaseDelay = resolve
    })
    const fixture = harness({ delay: async () => delayed })
    await fixture.supervisor.start()
    fixture.managers[0]!.crash()
    const shutdown = fixture.supervisor.shutdown()
    releaseDelay()
    await shutdown
    await Promise.resolve()
    expect(fixture.createManager).toHaveBeenCalledOnce()
    expect(fixture.supervisor.state).toBe('stopped')
  })

  it('supersedes a shared in-progress start during shutdown without changing stopped state', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const fixture = harness({ startGate, waitForStartOnShutdown: true })
    const first = fixture.supervisor.start()
    const second = fixture.supervisor.start()
    const waiting = fixture.supervisor.waitUntilReady()
    expect(second).toBe(first)
    const shutdown = fixture.supervisor.shutdown()
    releaseStart()
    await expect(first).rejects.toThrowError('runtime_start_superseded')
    await expect(waiting).rejects.toThrowError('runtime_start_superseded')
    await shutdown
    expect(fixture.supervisor.state).toBe('stopped')
  })

  it('rejects new commands racing with shutdown and start after an open circuit', async () => {
    const fixture = harness()
    await fixture.supervisor.start()
    const command = fixture.supervisor.createSession({
      operationId: '11111111-1111-4111-8111-111111111111',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    })
    const shutdown = fixture.supervisor.shutdown()
    await expect(command).rejects.toThrowError('runtime_unavailable')
    await shutdown

    await fixture.supervisor.start()
    for (let index = 0; index < 4; index += 1) {
      fixture.managers.at(-1)!.crash()
      await fixture.supervisor.waitUntilReady().catch(() => {})
    }
    await expect(fixture.supervisor.start()).rejects.toThrowError('runtime_circuit_open')
  })
})
