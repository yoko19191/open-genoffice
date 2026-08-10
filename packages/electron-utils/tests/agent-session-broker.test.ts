import { describe, expect, it, vi } from 'vitest'
import type {
  EventEnvelope,
  SessionConnectionReceipt,
  SessionSnapshot,
  SessionSubscriptionReceipt,
} from '@genoffice/agent-runtime-protocol'
import { PDF_OFFICE_TOOL_CATALOG_BINDING } from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import { AgentSessionBroker } from '../src'

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const forkSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

function snapshot(sequence: number): SessionSnapshot {
  return {
    sessionId,
    documentId,
    messages: [],
    activeRun: { runId: 'run-1', state: 'running' },
    lastSequence: sequence,
    cursor: `cursor-${sequence}`,
  }
}

function connection(sequence = 1): SessionConnectionReceipt {
  return {
    sessionId,
    documentId,
    snapshot: snapshot(sequence),
    cursor: `cursor-${sequence}`,
  }
}

function event(sequence: number, type: EventEnvelope['type'] = 'message.delta'): EventEnvelope {
  return {
    protocolVersion: '1',
    kind: 'event',
    eventId: `event-${sequence}`,
    instanceId: 'instance-1',
    sessionId,
    documentId,
    runId: 'run-1',
    sequence,
    cursor: `cursor-${sequence}`,
    occurredAt: '2026-08-09T13:00:00.000Z',
    type,
    payload: type === 'message.delta' ? { text: `chunk-${sequence}` } : {},
  }
}

function harness() {
  let listener: (value: EventEnvelope) => void = () => {}
  let currentSnapshot = snapshot(1)
  let subscription: SessionSubscriptionReceipt = {
    resetRequired: false,
    snapshot: currentSnapshot,
    events: [],
  }
  const unsubscribe = vi.fn()
  const transport = {
    createSession: vi.fn(async () => connection(currentSnapshot.lastSequence)),
    openSession: vi.fn(async () => connection(currentSnapshot.lastSequence)),
    subscribeSession: vi.fn(async () => subscription),
    promptSession: vi.fn(async () => ({ runId: 'run-1', acceptedCursor: 'cursor-2' })),
    abortSession: vi.fn(async () => ({
      runId: 'run-1',
      state: 'cancelling' as const,
      acceptedCursor: 'cursor-3',
    })),
    resumeSubagent: vi.fn(async () => ({
      runId: 'subagent-run-1',
      attempt: 2,
      acceptedCursor: 'cursor-4',
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
      acceptedCursor: 'cursor-5',
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
      acceptedCursor: 'cursor-5',
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
      acceptedCursor: 'cursor-5',
    })),
    revokeDocumentMutationGrants: vi.fn(async () => ({ revoked: true as const })),
    forkSession: vi.fn(async () => {
      const forkSnapshot = {
        ...currentSnapshot,
        sessionId: forkSessionId,
        branch: { parentSessionId: sessionId, activeLeafId: 'fork-leaf', nodes: [] },
      }
      return {
        sessionId: forkSessionId,
        parentSessionId: sessionId,
        documentId,
        snapshot: forkSnapshot,
        cursor: forkSnapshot.cursor,
      }
    }),
    navigateSession: vi.fn(async (input: { sessionId: string; documentId: string }) => {
      const navigatedSnapshot = {
        ...currentSnapshot,
        sessionId: input.sessionId,
        documentId: input.documentId,
        branch: { activeLeafId: 'navigation-leaf', nodes: [] },
      }
      return {
        sessionId: input.sessionId,
        documentId: input.documentId,
        activeLeafId: 'navigation-leaf',
        snapshot: navigatedSnapshot,
        cursor: navigatedSnapshot.cursor,
      }
    }),
    onSessionEvent: vi.fn(async (next: (value: EventEnvelope) => void) => {
      listener = next
      return unsubscribe
    }),
  }
  let uuid = 0
  let now = new Date('2026-08-10T00:00:00.000Z')
  const authorize = vi.fn(async () => true)
  const resolveProjectRoot = vi.fn(async () => undefined as string | undefined)
  const rollbackRun = vi.fn(async () => true)
  const broker = new AgentSessionBroker(transport, {
    authorize,
    resolveProjectRoot,
    randomUUID: () => `${String(++uuid).padStart(8, '0')}-0000-4000-8000-000000000000`,
    now: () => now,
    replayWindowSize: 4,
    rollbackRun,
  })
  return {
    authorize,
    resolveProjectRoot,
    rollbackRun,
    broker,
    transport,
    emit: (value: EventEnvelope) => listener(value),
    setSnapshot: (sequence: number) => {
      currentSnapshot = snapshot(sequence)
      subscription = { resetRequired: false, snapshot: currentSnapshot, events: [] }
    },
    setSubscription: (value: SessionSubscriptionReceipt) => {
      subscription = value
    },
    unsubscribe,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}

describe('Electron main Agent Session broker', () => {
  it('rolls back an exact document run only after a trusted user gesture', async () => {
    const fixture = harness()
    await fixture.broker.connect(1, { documentId, sessionId }, () => {})
    const command = {
      type: 'rollbackRun' as const,
      operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      sessionId,
      documentId,
      runId: 'run-1',
    }
    await expect(fixture.broker.command(1, command)).rejects.toThrowError(
      'trusted_user_gesture_required',
    )
    fixture.broker.recordTrustedUserGesture(1, { type: 'mouseUp' })
    await expect(fixture.broker.command(1, command)).resolves.toEqual({
      documentId,
      runId: 'run-1',
      rolledBack: true,
    })
    expect(fixture.rollbackRun).toHaveBeenCalledWith(documentId, 'run-1')
    await fixture.broker.close()
  })

  it('fails closed when no product rollback host is installed', async () => {
    const fixture = harness()
    const broker = new AgentSessionBroker(fixture.transport, {
      authorize: async () => true,
      randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    await broker.connect(1, { documentId, sessionId }, () => {})
    broker.recordTrustedUserGesture(1, { type: 'mouseUp' })
    await expect(
      broker.command(1, {
        type: 'rollbackRun',
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sessionId,
        documentId,
        runId: 'run-1',
      }),
    ).rejects.toThrowError('office_rollback_unavailable')
    await broker.close()
  })

  it('issues a precise Mutation Grant only after a one-time real main-process user gesture', async () => {
    const fixture = harness()
    await fixture.broker.connect(1, { documentId, sessionId }, () => {})
    const command = {
      type: 'grantMutation' as const,
      operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      sessionId,
      documentId,
      requestId: 'grant-request-1',
      subagentRunId: 'subagent-run-1',
      exactToolIds: ['office:docs:insert_content'],
    }
    await expect(fixture.broker.command(1, command)).rejects.toThrowError(
      'trusted_user_gesture_required',
    )
    expect(fixture.transport.issueMutationGrant).not.toHaveBeenCalled()

    fixture.broker.recordTrustedUserGesture(1, { type: 'mouseUp' })
    await expect(fixture.broker.command(1, command)).resolves.toMatchObject({
      grant: { status: 'active', exactToolIds: command.exactToolIds },
    })
    expect(fixture.transport.issueMutationGrant).toHaveBeenCalledWith({
      operationId: command.operationId,
      sessionId,
      documentId,
      requestId: command.requestId,
      receipt: {
        grantId: '00000004-0000-4000-8000-000000000000',
        subagentRunId: command.subagentRunId,
        documentId,
        exactToolIds: command.exactToolIds,
        issuedByUserActionId: '00000003-0000-4000-8000-000000000000',
        issuedAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-10T00:05:00.000Z',
        status: 'active',
      },
    })
    expect(
      fixture.broker.authorizeMutationGrant({
        grantId: '00000004-0000-4000-8000-000000000000',
        subagentRunId: command.subagentRunId,
        documentId,
        toolId: command.exactToolIds[0]!,
      }),
    ).toBe(true)
    expect(
      fixture.broker.authorizeMutationGrant({
        grantId: '00000004-0000-4000-8000-000000000000',
        subagentRunId: command.subagentRunId,
        documentId,
        toolId: 'office:docs:other',
      }),
    ).toBe(false)
    fixture.advance(5 * 60 * 1_000)
    expect(
      fixture.broker.authorizeMutationGrant({
        grantId: '00000004-0000-4000-8000-000000000000',
        subagentRunId: command.subagentRunId,
        documentId,
        toolId: command.exactToolIds[0]!,
      }),
    ).toBe(false)
    expect(
      fixture.broker.authorizeMutationGrant({
        grantId: '00000004-0000-4000-8000-000000000000',
        subagentRunId: command.subagentRunId,
        documentId,
        toolId: command.exactToolIds[0]!,
      }),
    ).toBe(false)
    await expect(fixture.broker.command(1, command)).rejects.toThrowError(
      'trusted_user_gesture_required',
    )
    await fixture.broker.close()
  })

  it('rejects stale or non-activation input and requires gestures for deny and revoke', async () => {
    const fixture = harness()
    await fixture.broker.connect(1, { documentId, sessionId }, () => {})
    fixture.broker.recordTrustedUserGesture(1, { type: 'mouseDown' })
    await expect(
      fixture.broker.command(1, {
        type: 'denyMutation',
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sessionId,
        documentId,
        requestId: 'grant-request-1',
      }),
    ).rejects.toThrowError('trusted_user_gesture_required')

    fixture.broker.recordTrustedUserGesture(1, { type: 'keyUp', key: 'Enter' })
    fixture.advance(1_501)
    await expect(
      fixture.broker.command(1, {
        type: 'revokeMutation',
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId,
        documentId,
        grantId: 'grant-1',
      }),
    ).rejects.toThrowError('trusted_user_gesture_required')
    expect(fixture.transport.denyMutationGrant).not.toHaveBeenCalled()
    expect(fixture.transport.revokeMutationGrant).not.toHaveBeenCalled()
    await fixture.broker.close()
  })
  it('atomically merges replay with live events and delivers each event once in sequence', async () => {
    const fixture = harness()
    let release!: (value: SessionSubscriptionReceipt) => void
    fixture.transport.subscribeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const delivered: EventEnvelope[] = []
    const connecting = fixture.broker.connect(
      101,
      { documentId, sessionId, afterCursor: 'cursor-1' },
      (value) => delivered.push(value),
    )
    await vi.waitFor(() => expect(fixture.transport.subscribeSession).toHaveBeenCalledOnce())
    fixture.emit(event(2))
    fixture.emit(event(2))
    fixture.emit(event(3))
    release({ resetRequired: false, snapshot: snapshot(1), events: [event(2)] })

    const receipt = await connecting
    expect(receipt.events.map((value) => value.sequence)).toEqual([2, 3])
    expect(receipt.snapshot.lastSequence).toBe(1)
    expect(delivered).toEqual([])

    fixture.emit(event(4))
    fixture.emit(event(4))
    expect(delivered.map((value) => value.sequence)).toEqual([4])
    expect(fixture.transport.onSessionEvent).toHaveBeenCalledOnce()
    await fixture.broker.close()
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
  })

  it('disconnects only the renderer and survives 50 reloads with one terminal event', async () => {
    const fixture = harness()
    const delivered: EventEnvelope[] = []

    for (let index = 0; index < 50; index += 1) {
      const clientId = index + 1
      await fixture.broker.connect(
        clientId,
        { documentId, sessionId, afterCursor: 'cursor-1' },
        (value) => delivered.push(value),
      )
      fixture.broker.disconnect(clientId)
    }

    await fixture.broker.connect(51, { documentId, sessionId, afterCursor: 'cursor-1' }, (value) =>
      delivered.push(value),
    )
    fixture.emit(event(2, 'run.completed'))
    expect(delivered.filter((value) => value.type === 'run.completed')).toHaveLength(1)
    expect(fixture.transport.onSessionEvent).toHaveBeenCalledOnce()
    expect(fixture.transport.openSession).toHaveBeenCalledTimes(51)
    await fixture.broker.close()
  })

  it('resets on a detected gap and rejects unauthorized documents before Runtime access', async () => {
    const fixture = harness()
    await fixture.broker.connect(1, { documentId, sessionId, afterCursor: 'cursor-1' }, () => {})
    fixture.emit(event(4))
    const resetSnapshot = { resetRequired: false, snapshot: snapshot(4), events: [] }
    fixture.transport.subscribeSession.mockResolvedValueOnce(resetSnapshot)
    let releaseReset!: (value: SessionSubscriptionReceipt) => void
    fixture.transport.subscribeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseReset = resolve
        }),
    )
    const reconnecting = fixture.broker.connect(
      2,
      { documentId, sessionId, afterCursor: 'cursor-1' },
      () => {},
    )
    await vi.waitFor(() => expect(fixture.transport.subscribeSession).toHaveBeenCalledTimes(3))
    fixture.emit(event(5))
    releaseReset({ resetRequired: true, snapshot: snapshot(4), events: [] })
    const receipt = await reconnecting
    expect(receipt).toMatchObject({
      resetRequired: true,
      snapshot: { lastSequence: 4 },
      events: [{ sequence: 5 }],
    })
    expect(fixture.transport.subscribeSession).toHaveBeenLastCalledWith({
      sessionId,
      documentId,
    })

    fixture.authorize.mockResolvedValueOnce(false)
    await expect(
      fixture.broker.connect(3, { documentId, sessionId }, () => {}),
    ).rejects.toThrowError('document_access_denied')
    expect(fixture.transport.openSession).toHaveBeenCalledTimes(2)
    await fixture.broker.close()
  })

  it('creates a Session when no sessionId is supplied and bounds retained replay events', async () => {
    const fixture = harness()
    const created = await fixture.broker.connect(1, { documentId }, () => {})
    expect(created.sessionId).toBe(sessionId)
    expect(fixture.transport.createSession).toHaveBeenCalledOnce()

    for (let sequence = 2; sequence <= 8; sequence += 1) fixture.emit(event(sequence))
    fixture.setSnapshot(8)
    await fixture.broker.connect(2, { documentId, sessionId, afterCursor: 'cursor-1' }, () => {})
    expect(fixture.transport.onSessionEvent).toHaveBeenCalledOnce()
    await fixture.broker.close()
  })

  it('restores one persisted current Session and rejects a non-current renderer request', async () => {
    const fixture = harness()
    let currentSessionId: string | undefined
    const currentSessions = {
      resolveCurrent: vi.fn(async (_documentId: string, create: () => Promise<string>) => {
        currentSessionId ??= await create()
        return currentSessionId
      }),
      assertCurrent: vi.fn(async (_documentId: string, requestedSessionId: string) => {
        if (requestedSessionId !== currentSessionId) throw new Error('document_session_not_current')
      }),
      advanceCurrent: vi.fn(
        async (_documentId: string, expectedSessionId: string, nextSessionId: string) => {
          if (expectedSessionId !== currentSessionId) {
            throw new Error('document_session_not_current')
          }
          currentSessionId = nextSessionId
        },
      ),
    }
    const options = {
      authorize: async () => true,
      randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      currentSessions,
    }
    const broker = new AgentSessionBroker(fixture.transport, options)

    await expect(broker.connect(1, { documentId }, () => {})).resolves.toMatchObject({ sessionId })
    await broker.close()
    const restarted = new AgentSessionBroker(fixture.transport, options)
    await expect(restarted.connect(2, { documentId }, () => {})).resolves.toMatchObject({
      sessionId,
    })
    await expect(restarted.connect(3, { documentId, sessionId }, () => {})).resolves.toMatchObject({
      sessionId,
    })
    expect(fixture.transport.createSession).toHaveBeenCalledOnce()
    expect(fixture.transport.openSession).toHaveBeenCalledTimes(2)
    await expect(
      restarted.connect(
        4,
        { documentId, sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        () => {},
      ),
    ).rejects.toThrowError('document_session_not_current')
    expect(fixture.transport.openSession).toHaveBeenCalledTimes(2)
    await restarted.close()
  })

  it('allows commands only for the connected renderer and exact document binding', async () => {
    const fixture = harness()
    const command = {
      type: 'prompt' as const,
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId,
      documentId,
      text: 'continue',
    }
    await expect(fixture.broker.command(1, command)).rejects.toThrowError(
      'agent_session_not_connected',
    )
    await fixture.broker.connect(1, { documentId, sessionId }, () => {})
    fixture.resolveProjectRoot.mockResolvedValue('/trusted/project')
    await expect(fixture.broker.command(1, command)).resolves.toMatchObject({ runId: 'run-1' })
    expect(fixture.transport.promptSession).toHaveBeenCalledWith({
      operationId: command.operationId,
      sessionId,
      documentId,
      text: 'continue',
      projectRoot: '/trusted/project',
    })
    await expect(
      fixture.broker.command(1, {
        type: 'abort',
        operationId: command.operationId,
        sessionId,
        documentId,
        runId: 'run-1',
      }),
    ).resolves.toMatchObject({ state: 'cancelling' })
    expect(fixture.transport.abortSession).toHaveBeenCalledWith({
      operationId: command.operationId,
      sessionId,
      documentId,
      runId: 'run-1',
    })
    await expect(
      fixture.broker.command(1, {
        type: 'resumeSubagent',
        operationId: command.operationId,
        sessionId,
        documentId,
        runId: 'subagent-run-1',
      }),
    ).resolves.toMatchObject({ runId: 'subagent-run-1', attempt: 2 })
    expect(fixture.transport.resumeSubagent).toHaveBeenCalledWith({
      operationId: command.operationId,
      sessionId,
      documentId,
      runId: 'subagent-run-1',
    })
    fixture.authorize.mockResolvedValueOnce(false)
    await expect(fixture.broker.command(1, command)).rejects.toThrowError('document_access_denied')
    await fixture.broker.close()
  })

  it('attaches the Electron-owned Office catalog to create and open', async () => {
    const fixture = harness()
    const resolveOfficeToolCatalog = vi.fn(async () => PDF_OFFICE_TOOL_CATALOG_BINDING)
    const broker = new AgentSessionBroker(fixture.transport, {
      authorize: async () => true,
      randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resolveOfficeToolCatalog,
    })
    await broker.connect(1, { documentId }, () => {})
    expect(fixture.transport.createSession).toHaveBeenCalledWith({
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      documentId,
      officeToolCatalog: PDF_OFFICE_TOOL_CATALOG_BINDING,
    })
    broker.disconnect(1)
    await broker.connect(2, { documentId, sessionId }, () => {})
    expect(fixture.transport.openSession).toHaveBeenCalledWith({
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sessionId,
      documentId,
      officeToolCatalog: PDF_OFFICE_TOOL_CATALOG_BINDING,
    })
    expect(resolveOfficeToolCatalog).toHaveBeenCalledTimes(2)
    await broker.close()
  })

  it('atomically advances the current Session after fork and keeps navigate in that tree', async () => {
    const fixture = harness()
    let current = sessionId
    const currentSessions = {
      resolveCurrent: vi.fn(async () => current),
      assertCurrent: vi.fn(async (_documentId: string, requestedSessionId: string) => {
        if (requestedSessionId !== current) throw new Error('document_session_not_current')
      }),
      advanceCurrent: vi.fn(
        async (_documentId: string, expectedSessionId: string, nextSessionId: string) => {
          if (expectedSessionId !== current) throw new Error('document_session_not_current')
          current = nextSessionId
        },
      ),
    }
    const broker = new AgentSessionBroker(fixture.transport, {
      authorize: async () => true,
      randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      currentSessions,
    })
    await broker.connect(1, { documentId, sessionId }, () => {})

    const forked = await broker.command(1, {
      type: 'fork',
      operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sessionId,
      documentId,
    })
    expect(forked).toMatchObject({ sessionId: forkSessionId, parentSessionId: sessionId })
    expect(currentSessions.advanceCurrent).toHaveBeenCalledWith(
      documentId,
      sessionId,
      forkSessionId,
    )

    await expect(
      broker.command(1, {
        type: 'navigate',
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sessionId: forkSessionId,
        documentId,
        targetEntryId: 'target-leaf',
      }),
    ).resolves.toMatchObject({ sessionId: forkSessionId, activeLeafId: 'navigation-leaf' })
    expect(fixture.transport.navigateSession).toHaveBeenCalledWith({
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      sessionId: forkSessionId,
      documentId,
      targetEntryId: 'target-leaf',
    })
    await expect(
      broker.command(1, {
        type: 'prompt',
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        sessionId,
        documentId,
        text: 'stale parent',
      }),
    ).rejects.toThrowError('agent_session_not_connected')
    await broker.close()
  })

  it('fails closed on Runtime binding mismatches and ignores forged live bindings', async () => {
    const fixture = harness()
    fixture.transport.openSession.mockResolvedValueOnce({
      ...connection(),
      documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    })
    await expect(
      fixture.broker.connect(1, { documentId, sessionId }, () => {}),
    ).rejects.toThrowError('document_binding_mismatch')

    const delivered: EventEnvelope[] = []
    await fixture.broker.connect(1, { documentId, sessionId }, (value) => delivered.push(value))
    fixture.emit({ ...event(2), documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' })
    fixture.emit(event(2))
    fixture.emit({ ...event(1), eventId: 'late-event' })
    expect(delivered.map((value) => value.eventId)).toEqual(['event-2'])
    await fixture.broker.close()
  })

  it('can close before listening and clamps a zero replay window to one event', async () => {
    const fixture = harness()
    const broker = new AgentSessionBroker(fixture.transport, {
      authorize: async () => true,
      randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      replayWindowSize: 0,
    })
    await broker.close()
    expect(fixture.unsubscribe).not.toHaveBeenCalled()
  })

  it('detects transport replay gaps and live sequence gaps without forwarding them', async () => {
    const replayGap = harness()
    replayGap.setSubscription({
      resetRequired: false,
      snapshot: snapshot(1),
      events: [event(3)],
    })
    await expect(
      replayGap.broker.connect(1, { documentId, sessionId, afterCursor: 'cursor-1' }, () => {}),
    ).resolves.toMatchObject({ resetRequired: true, events: [] })
    await replayGap.broker.close()

    const liveGap = harness()
    const delivered: EventEnvelope[] = []
    await liveGap.broker.connect(1, { documentId, sessionId }, (value) => delivered.push(value))
    liveGap.emit(event(2))
    liveGap.emit(event(4))
    expect(delivered.map((value) => value.sequence)).toEqual([2])
    await liveGap.broker.close()
  })

  it('skips events older than a renderer snapshot and routes by Session', async () => {
    const fixture = harness()
    fixture.setSnapshot(4)
    const delivered: EventEnvelope[] = []
    await fixture.broker.connect(1, { documentId, sessionId }, (value) => delivered.push(value))

    const secondSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const secondDocumentId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
    const secondSnapshot = {
      ...snapshot(4),
      sessionId: secondSessionId,
      documentId: secondDocumentId,
    }
    fixture.transport.openSession.mockResolvedValueOnce({
      sessionId: secondSessionId,
      documentId: secondDocumentId,
      snapshot: secondSnapshot,
      cursor: secondSnapshot.cursor,
    })
    fixture.transport.subscribeSession.mockResolvedValueOnce({
      resetRequired: false,
      snapshot: secondSnapshot,
      events: [],
    })
    await fixture.broker.connect(
      2,
      { documentId: secondDocumentId, sessionId: secondSessionId },
      (value) => delivered.push(value),
    )

    fixture.emit({ ...event(4), eventId: 'older-than-snapshot' })
    fixture.emit(event(5))
    expect(delivered.map((value) => value.sequence)).toEqual([5])
    await fixture.broker.close()
  })

  it('rejects one Session being rebound to another document even if transport echoes it', async () => {
    const fixture = harness()
    await fixture.broker.connect(1, { documentId, sessionId }, () => {})
    const otherDocumentId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
    const reboundSnapshot = { ...snapshot(1), documentId: otherDocumentId }
    fixture.transport.openSession.mockResolvedValueOnce({
      sessionId,
      documentId: otherDocumentId,
      snapshot: reboundSnapshot,
      cursor: reboundSnapshot.cursor,
    })
    fixture.transport.subscribeSession.mockResolvedValueOnce({
      resetRequired: false,
      snapshot: reboundSnapshot,
      events: [],
    })
    await expect(
      fixture.broker.connect(2, { documentId: otherDocumentId, sessionId }, () => {}),
    ).rejects.toThrowError('document_binding_mismatch')
    await fixture.broker.close()
  })
})
