import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionCommand,
  AgentSessionConnectReceipt,
  EventEnvelope,
} from '@genoffice/agent-runtime-protocol'
import { AgentSessionController, type AgentSessionClient } from '../src'

const documentId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'

function event(sequence: number, type: EventEnvelope['type']): EventEnvelope {
  return {
    protocolVersion: '1',
    kind: 'event',
    eventId: `event-${sequence}`,
    instanceId: 'runtime-1',
    sessionId,
    documentId,
    runId,
    sequence,
    cursor: `cursor-${sequence}`,
    occurredAt: '2026-08-10T00:00:00.000Z',
    type,
    payload: {},
  }
}

function receipt(): AgentSessionConnectReceipt {
  return {
    connectionId: '55555555-5555-4555-8555-555555555555',
    sessionId,
    documentId,
    resetRequired: false,
    snapshot: {
      sessionId,
      documentId,
      messages: [{ id: 'message-1', role: 'assistant', text: 'restored' }],
      lastSequence: 1,
      cursor: 'cursor-1',
    },
    events: [],
  }
}

function fixture(connect = vi.fn(async () => receipt())) {
  let listener: ((event: EventEnvelope) => void) | undefined
  const commands: AgentSessionCommand[] = []
  const client: AgentSessionClient = {
    documentId: vi.fn(async () => documentId),
    connect,
    command: vi.fn(async (command) => {
      commands.push(command)
      if (command.type === 'prompt') return { runId, acceptedCursor: 'cursor-2' }
      if (command.type === 'resumeSubagent') {
        return { runId: command.runId, attempt: 2, acceptedCursor: 'cursor-4' }
      }
      if (command.type === 'rollbackRun') {
        return { documentId, runId: command.runId, rolledBack: true }
      }
      if (
        command.type === 'grantMutation' ||
        command.type === 'denyMutation' ||
        command.type === 'revokeMutation'
      ) {
        return {
          sessionId,
          documentId,
          grant: {
            requestId: 'grant-request-1',
            subagentRunId: 'subagent-run-1',
            role: 'Reviewer',
            exactToolIds: ['office:docs:insert_content'],
            requestedAt: '2026-08-10T00:00:00.000Z',
            expiresAt: '2026-08-10T00:05:00.000Z',
            status: command.type === 'grantMutation' ? ('active' as const) : ('revoked' as const),
            ...(command.type === 'grantMutation' || command.type === 'revokeMutation'
              ? { grantId: 'grant-1' }
              : {}),
          },
          acceptedCursor: 'cursor-5',
        }
      }
      if (command.type === 'answerUserAction') {
        return {
          sessionId,
          documentId,
          action: {
            requestId: command.requestId,
            runId,
            mode: 'confirm' as const,
            question: 'Continue?',
            requestedAt: '2026-08-11T00:00:00.000Z',
            status: 'answered' as const,
          },
          acceptedCursor: 'cursor-6',
        }
      }
      return { runId, state: 'cancelling', acceptedCursor: 'cursor-3' }
    }),
    disconnect: vi.fn(),
    onEvent: vi.fn((handler) => {
      listener = handler
      return () => {
        listener = undefined
      }
    }),
  }
  return { client, commands, emit: (value: EventEnvelope) => listener?.(value) }
}

describe('AgentSessionController', () => {
  it('rolls back only the latest committed Office run and clears the one-click action', async () => {
    const test = fixture()
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    await expect(controller.rollbackLastRun()).rejects.toThrowError('office_rollback_unavailable')
    test.emit({
      ...event(2, 'tool.completed'),
      payload: {
        toolCallId: 'office-call-1',
        toolName: 'delete_page',
        mutationOutcome: 'committed',
      },
    })
    await expect(controller.rollbackLastRun()).resolves.toEqual({
      documentId,
      runId,
      rolledBack: true,
    })
    expect(test.commands.at(-1)).toEqual({
      type: 'rollbackRun',
      operationId,
      sessionId,
      documentId,
      runId,
    })
    expect(controller.snapshot()?.rollbackRunId).toBeUndefined()
  })

  it('subscribes before connect and folds events arriving during the snapshot handshake once', async () => {
    let resolveConnect!: (value: AgentSessionConnectReceipt) => void
    const connect = vi.fn(
      () =>
        new Promise<AgentSessionConnectReceipt>((resolve) => {
          resolveConnect = resolve
        }),
    )
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    const changed = vi.fn()
    controller.subscribe(changed)

    const connecting = controller.connect()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith({ documentId }))
    test.emit(event(2, 'run.queued'))
    resolveConnect(receipt())
    await connecting

    expect(controller.snapshot()?.activeRun).toEqual({ runId, state: 'queued' })
    expect(controller.snapshot()?.lastSequence).toBe(2)
    expect(changed).toHaveBeenCalled()
  })

  it('sends only session-bound prompt and active-run abort commands', async () => {
    const test = fixture()
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    const promptReceipt = await controller.prompt('summarize this PDF')

    expect(promptReceipt.runId).toBe(runId)
    expect(test.commands[0]).toEqual({
      type: 'prompt',
      operationId,
      sessionId,
      documentId,
      text: 'summarize this PDF',
    })
    await controller.prompt('read the attachment', [
      {
        artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        mediaType: 'text/plain',
        byteLength: 12,
        sha256: 'a'.repeat(64),
        displayName: 'notes.txt',
      },
    ])
    expect(test.commands[1]).toEqual({
      type: 'prompt',
      operationId,
      sessionId,
      documentId,
      text: 'read the attachment',
      artifacts: [
        {
          artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          mediaType: 'text/plain',
          byteLength: 12,
          sha256: 'a'.repeat(64),
          displayName: 'notes.txt',
        },
      ],
    })
    test.emit(event(2, 'run.started'))
    await expect(controller.abort()).resolves.toMatchObject({ runId, state: 'cancelling' })
    expect(test.commands[2]).toEqual({
      type: 'abort',
      operationId,
      sessionId,
      documentId,
      runId,
    })
  })

  it('grants, denies and revokes only authoritative projected Mutation Grant requests', async () => {
    const connect = vi.fn(async () => ({
      ...receipt(),
      snapshot: {
        ...receipt().snapshot,
        mutationGrants: [
          {
            requestId: 'grant-request-1',
            subagentRunId: 'subagent-run-1',
            role: 'Reviewer',
            exactToolIds: ['office:docs:insert_content'],
            requestedAt: '2026-08-10T00:00:00.000Z',
            expiresAt: '2026-08-10T00:05:00.000Z',
            status: 'pending' as const,
          },
        ],
      },
    }))
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    await controller.grantMutation('grant-request-1')
    expect(test.commands.at(-1)).toEqual({
      type: 'grantMutation',
      operationId,
      sessionId,
      documentId,
      requestId: 'grant-request-1',
      subagentRunId: 'subagent-run-1',
      exactToolIds: ['office:docs:insert_content'],
    })
    await controller.denyMutation('grant-request-1')
    expect(test.commands.at(-1)).toMatchObject({
      type: 'denyMutation',
      requestId: 'grant-request-1',
    })

    test.emit({
      ...event(2, 'mutation-grant.updated'),
      payload: {
        requestId: 'grant-request-1',
        subagentRunId: 'subagent-run-1',
        role: 'Reviewer',
        exactToolIds: ['office:docs:insert_content'],
        requestedAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-10T00:05:00.000Z',
        status: 'active',
        grantId: 'grant-1',
      },
    })
    await controller.revokeMutation('grant-1')
    expect(test.commands.at(-1)).toMatchObject({ type: 'revokeMutation', grantId: 'grant-1' })
    await expect(controller.grantMutation('missing')).rejects.toThrowError(
      'mutation_grant_request_not_pending',
    )
    await expect(controller.denyMutation('missing')).rejects.toThrowError(
      'mutation_grant_request_not_pending',
    )
    await expect(controller.revokeMutation('missing')).rejects.toThrowError(
      'mutation_grant_not_active',
    )
  })

  it('answers only a projected pending question and never supplies a renderer receipt', async () => {
    const connect = vi.fn(async () => ({
      ...receipt(),
      snapshot: {
        ...receipt().snapshot,
        userActions: [
          {
            requestId: 'question-1',
            runId,
            mode: 'confirm' as const,
            question: 'Continue?',
            requestedAt: '2026-08-11T00:00:00.000Z',
            status: 'pending' as const,
          },
          {
            requestId: 'question-2',
            runId,
            mode: 'input' as const,
            question: 'Name this section',
            maxLength: 80,
            requestedAt: '2026-08-11T00:00:00.000Z',
            status: 'pending' as const,
          },
        ],
      },
    }))
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    await controller.answerUserAction('question-1', { confirmed: true })
    expect(test.commands.at(-1)).toEqual({
      type: 'answerUserAction',
      operationId,
      sessionId,
      documentId,
      requestId: 'question-1',
      answer: { confirmed: true },
    })
    expect(test.commands.at(-1)).not.toHaveProperty('userActionId')
    await expect(
      controller.answerUserAction('question-1', { text: 'forged mode' }),
    ).rejects.toThrowError('user_action_answer_invalid')
    await expect(
      controller.answerUserAction('question-2', { confirmed: true }),
    ).rejects.toThrowError('user_action_answer_invalid')
    await controller.answerUserAction('question-2', { text: 'Overview' })
    expect(test.commands.at(-1)).toMatchObject({
      type: 'answerUserAction',
      requestId: 'question-2',
      answer: { text: 'Overview' },
    })
    await expect(controller.answerUserAction('missing', { confirmed: true })).rejects.toThrowError(
      'user_action_not_pending',
    )
  })

  it('rejects empty prompts and aborts without an active run, then disconnects cleanly', async () => {
    const test = fixture()
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await expect(controller.prompt('hello')).rejects.toThrowError('agent_session_not_connected')
    await controller.connect()
    await expect(controller.prompt('   ')).rejects.toThrowError('agent_prompt_empty')
    await expect(controller.abort()).rejects.toThrowError('agent_run_not_active')

    controller.disconnect()
    expect(test.client.disconnect).toHaveBeenCalledOnce()
    test.emit(event(2, 'run.started'))
    expect(controller.snapshot()).toBeUndefined()
  })

  it('resumes only a resumable child from the authoritative projection', async () => {
    const childRunId = 'subagent-run-1'
    const connect = vi.fn(async () => ({
      ...receipt(),
      snapshot: {
        ...receipt().snapshot,
        subagents: [
          {
            runId: childRunId,
            rootRunId: runId,
            parentRunId: runId,
            role: 'researcher',
            depth: 1,
            model: { providerId: 'provider-1', modelId: 'model-1' },
            status: 'resumable' as const,
            attempt: 1,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, toolCalls: 0 },
            capabilitySnapshotId: 'a'.repeat(64),
            createdAt: '2026-08-10T00:00:00.000Z',
          },
        ],
      },
    }))
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    await expect(controller.resumeSubagent(childRunId)).resolves.toMatchObject({ attempt: 2 })
    expect(test.commands.at(-1)).toEqual({
      type: 'resumeSubagent',
      operationId,
      sessionId,
      documentId,
      runId: childRunId,
    })
    await expect(controller.resumeSubagent('missing')).rejects.toThrowError(
      'subagent_run_not_resumable',
    )
  })

  it('reconnects from the last authoritative cursor and ignores already-snapshotted queued events', async () => {
    let calls = 0
    const connect = vi.fn(async () => {
      calls += 1
      if (calls === 1) return receipt()
      return {
        ...receipt(),
        snapshot: {
          ...receipt().snapshot,
          activeRun: { runId, state: 'running' as const },
          lastSequence: 2,
          cursor: 'cursor-2',
        },
      }
    })
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    test.emit(event(2, 'run.started'))
    await controller.connect()

    expect(test.client.connect).toHaveBeenLastCalledWith({ documentId, afterCursor: 'cursor-2' })
    expect(controller.snapshot()?.messages).toEqual([
      { id: 'message-1', role: 'assistant', text: 'restored' },
    ])
  })

  it('clears handshake state after connect failure and fails closed on a stale reconnect snapshot', async () => {
    const rejected = fixture(vi.fn(async () => Promise.reject(new Error('runtime_unavailable'))))
    const failed = new AgentSessionController(rejected.client, { randomUUID: () => operationId })
    await expect(failed.connect()).rejects.toThrowError('runtime_unavailable')
    rejected.emit(event(2, 'run.started'))
    expect(failed.snapshot()).toBeUndefined()

    const test = fixture()
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    test.emit(event(2, 'run.started'))
    await expect(controller.connect()).rejects.toThrowError('agent_session_snapshot_stale')
  })

  it('uses the browser UUID source, immediately publishes an existing snapshot, and removes subscribers', async () => {
    const test = fixture()
    const controller = new AgentSessionController(test.client)
    await controller.connect()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    expect(listener).toHaveBeenCalledWith(controller.snapshot())
    unsubscribe()

    await controller.prompt('hello')
    expect(test.commands[0]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    test.emit(event(2, 'run.queued'))
    expect(listener).toHaveBeenCalledOnce()
    await controller.abort()
  })

  it.each(['queued', 'cancelling'] as const)('allows abort while a run is %s', async (state) => {
    const connect = vi.fn(async () => ({
      ...receipt(),
      snapshot: { ...receipt().snapshot, activeRun: { runId, state } },
    }))
    const test = fixture(connect)
    const controller = new AgentSessionController(test.client, { randomUUID: () => operationId })
    await controller.connect()
    await expect(controller.abort()).resolves.toMatchObject({ runId })
  })
})
