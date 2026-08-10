import { describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '@genoffice/agent-runtime-protocol'
import {
  AGENT_SESSION_CHANNELS,
  createAgentSessionPreloadApi,
  installAgentSessionIpc,
} from '../src'

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const documentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const snapshot = {
  sessionId,
  documentId,
  messages: [],
  activeRun: { runId: 'run-1', state: 'running' as const },
  lastSequence: 1,
  cursor: 'cursor-1',
}
const receipt = {
  connectionId: operationId,
  sessionId,
  documentId,
  resetRequired: false,
  snapshot,
  events: [],
}
const liveEvent: EventEnvelope = {
  protocolVersion: '1',
  kind: 'event',
  eventId: 'event-2',
  instanceId: 'instance-1',
  sessionId,
  documentId,
  runId: 'run-1',
  sequence: 2,
  cursor: 'cursor-2',
  occurredAt: '2026-08-09T13:00:00.000Z',
  type: 'run.completed',
  payload: {},
}

function mainHarness() {
  const handlers = new Map<string, (event: never, value: unknown) => unknown>()
  const listeners = new Map<string, (event: never) => void>()
  const ipcMain = {
    handle: vi.fn((channel: string, listener: (event: never, value: unknown) => unknown) =>
      handlers.set(channel, listener),
    ),
    on: vi.fn((channel: string, listener: (event: never) => void) =>
      listeners.set(channel, listener),
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
  }
  const lifecycle = new Map<string, () => void>()
  const inputListeners = new Map<
    string,
    (event: unknown, input: { type: string; key?: string }) => void
  >()
  const sender = {
    id: 42,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn((name: string, listener: () => void) => lifecycle.set(name, listener)),
    on: vi.fn(
      (name: string, listener: (event: unknown, input: { type: string; key?: string }) => void) =>
        inputListeners.set(name, listener),
    ),
  }
  let deliver: ((event: EventEnvelope) => void) | undefined
  const broker = {
    connect: vi.fn(async (_id, _request, next) => {
      deliver = next
      return receipt
    }),
    command: vi.fn(async () => ({ runId: 'run-1', acceptedCursor: 'cursor-2' })),
    recordTrustedUserGesture: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(async () => {}),
  }
  return {
    broker,
    handlers,
    ipcMain,
    lifecycle,
    inputListeners,
    listeners,
    sender,
    emit: () => deliver?.(liveEvent),
  }
}

describe('Agent Session IPC main bridge', () => {
  it('validates requests, observes a sender once, and routes only safe events', async () => {
    const fixture = mainHarness()
    const resolveDocumentId = vi.fn(async () => documentId)
    const dispose = installAgentSessionIpc(fixture.ipcMain as never, fixture.broker as never, {
      documentIdFor: resolveDocumentId,
    })
    const connect = fixture.handlers.get(AGENT_SESSION_CHANNELS.connect)!
    const document = fixture.handlers.get(AGENT_SESSION_CHANNELS.document)!
    const event = { sender: fixture.sender } as never
    await expect(document(event, undefined)).resolves.toBe(documentId)
    expect(resolveDocumentId).toHaveBeenCalledWith(42)
    await expect(connect(event, { documentId, sessionId })).resolves.toEqual(receipt)
    await expect(connect(event, { documentId, sessionId })).resolves.toEqual(receipt)
    expect(fixture.sender.once).toHaveBeenCalledTimes(2)
    fixture.inputListeners.get('before-input-event')?.({}, { type: 'keyUp', key: 'Enter' })
    expect(fixture.broker.recordTrustedUserGesture).toHaveBeenCalledWith(42, {
      type: 'keyUp',
      key: 'Enter',
    })
    fixture.emit()
    expect(fixture.sender.send).toHaveBeenCalledWith(AGENT_SESSION_CHANNELS.event, liveEvent)

    fixture.sender.isDestroyed.mockReturnValue(true)
    fixture.emit()
    expect(fixture.sender.send).toHaveBeenCalledTimes(1)
    fixture.lifecycle.get('render-process-gone')?.()
    expect(fixture.broker.disconnect).toHaveBeenCalledWith(42)

    await expect(connect(event, { documentId, method: 'invoke' })).rejects.toThrowError(
      'agent_session_connect_request_invalid',
    )
    expect(fixture.broker.connect).toHaveBeenCalledTimes(2)
    await dispose()
    expect(fixture.ipcMain.removeHandler).toHaveBeenCalledTimes(3)
    expect(fixture.broker.close).toHaveBeenCalledOnce()
  })

  it('validates commands and handles explicit disconnect', async () => {
    const fixture = mainHarness()
    const dispose = installAgentSessionIpc(fixture.ipcMain as never, fixture.broker as never)
    const event = { sender: fixture.sender } as never
    const command = fixture.handlers.get(AGENT_SESSION_CHANNELS.command)!
    await expect(
      command(event, { type: 'prompt', operationId, sessionId, documentId, text: 'go' }),
    ).resolves.toMatchObject({ runId: 'run-1' })
    expect(() =>
      command(event, { type: 'invoke', operationId, sessionId, documentId, text: 'go' }),
    ).toThrowError('agent_session_command_invalid')
    expect(() =>
      command(event, {
        type: 'grantMutation',
        operationId,
        sessionId,
        documentId,
        requestId: 'request-1',
        subagentRunId: 'subagent-run-1',
        exactToolIds: ['office:docs:insert_content'],
        userActionId: 'forged-renderer-action',
      }),
    ).toThrowError('agent_session_command_invalid')
    fixture.listeners.get(AGENT_SESSION_CHANNELS.disconnect)!(event)
    expect(fixture.broker.disconnect).toHaveBeenCalledWith(42)
    await dispose()
    expect(fixture.ipcMain.removeListener).toHaveBeenCalledOnce()
  })

  it('fails closed when the main process resolves a malformed document id', async () => {
    const fixture = mainHarness()
    const dispose = installAgentSessionIpc(fixture.ipcMain as never, fixture.broker as never, {
      documentIdFor: async () => 'forged',
    })
    const document = fixture.handlers.get(AGENT_SESSION_CHANNELS.document)!
    await expect(document({ sender: fixture.sender } as never, undefined)).rejects.toThrowError(
      'agent_document_id_invalid',
    )
    await dispose()
  })
})

describe('Agent Session preload bridge', () => {
  it('exposes five typed methods without a raw invoke surface', async () => {
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    const ipcRenderer = {
      invoke: vi.fn(async (channel: string): Promise<unknown> => {
        if (channel === AGENT_SESSION_CHANNELS.document) return documentId
        if (channel === AGENT_SESSION_CHANNELS.connect) return receipt
        return { runId: 'run-1', acceptedCursor: 'cursor-2' }
      }),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) =>
        listeners.set(channel, listener),
      ),
      removeListener: vi.fn(),
    }
    const api = createAgentSessionPreloadApi(ipcRenderer)
    expect(Object.keys(api).sort()).toEqual([
      'command',
      'connect',
      'disconnect',
      'documentId',
      'onEvent',
    ])
    await expect(api.documentId()).resolves.toBe(documentId)
    await expect(api.connect({ documentId, sessionId })).resolves.toEqual(receipt)
    await expect(
      api.command({ type: 'prompt', operationId, sessionId, documentId, text: 'go' }),
    ).resolves.toMatchObject({ runId: 'run-1' })
    ipcRenderer.invoke.mockResolvedValueOnce({
      runId: 'run-1',
      state: 'cancelling',
      acceptedCursor: 'cursor-3',
    })
    await expect(
      api.command({ type: 'abort', operationId, sessionId, documentId, runId: 'run-1' }),
    ).resolves.toMatchObject({ state: 'cancelling' })
    ipcRenderer.invoke.mockResolvedValueOnce({
      runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      attempt: 2,
      acceptedCursor: 'cursor-4',
    })
    await expect(
      api.command({
        type: 'resumeSubagent',
        operationId,
        sessionId,
        documentId,
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      }),
    ).resolves.toMatchObject({ attempt: 2 })
    ipcRenderer.invoke.mockResolvedValueOnce({
      sessionId,
      documentId,
      action: {
        requestId: 'question-1',
        runId: 'run-1',
        mode: 'confirm',
        question: 'Continue?',
        requestedAt: '2026-08-11T00:00:00.000Z',
        status: 'answered',
      },
      acceptedCursor: 'cursor-5',
    })
    await expect(
      api.command({
        type: 'answerUserAction',
        operationId,
        sessionId,
        documentId,
        requestId: 'question-1',
        answer: { confirmed: true },
      }),
    ).resolves.toMatchObject({ action: { status: 'answered' } })
    for (const type of ['grantMutation', 'denyMutation', 'revokeMutation'] as const) {
      ipcRenderer.invoke.mockResolvedValueOnce({
        sessionId,
        documentId,
        grant: {
          requestId: 'grant-request-1',
          subagentRunId: 'subagent-run-1',
          role: 'Reviewer',
          exactToolIds: ['office:docs:insert_content'],
          requestedAt: '2026-08-10T00:00:00.000Z',
          expiresAt: '2026-08-10T00:05:00.000Z',
          status: type === 'grantMutation' ? 'active' : 'revoked',
          ...(type === 'denyMutation' ? {} : { grantId: 'grant-1' }),
        },
        acceptedCursor: 'cursor-6',
      })
      await expect(
        api.command(
          type === 'grantMutation'
            ? {
                type,
                operationId,
                sessionId,
                documentId,
                requestId: 'grant-request-1',
                subagentRunId: 'subagent-run-1',
                exactToolIds: ['office:docs:insert_content'],
              }
            : type === 'denyMutation'
              ? { type, operationId, sessionId, documentId, requestId: 'grant-request-1' }
              : { type, operationId, sessionId, documentId, grantId: 'grant-1' },
        ),
      ).resolves.toMatchObject({ grant: { requestId: 'grant-request-1' } })
    }
    const forkSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ipcRenderer.invoke.mockResolvedValueOnce({
      sessionId: forkSessionId,
      parentSessionId: sessionId,
      documentId,
      snapshot: {
        ...snapshot,
        sessionId: forkSessionId,
        branch: { parentSessionId: sessionId, nodes: [] },
      },
      cursor: snapshot.cursor,
    })
    await expect(
      api.command({ type: 'fork', operationId, sessionId, documentId }),
    ).resolves.toMatchObject({ sessionId: forkSessionId, parentSessionId: sessionId })
    ipcRenderer.invoke.mockResolvedValueOnce({
      sessionId: forkSessionId,
      documentId,
      activeLeafId: 'navigation-leaf',
      snapshot: {
        ...snapshot,
        sessionId: forkSessionId,
        branch: { activeLeafId: 'navigation-leaf', nodes: [] },
      },
      cursor: snapshot.cursor,
    })
    await expect(
      api.command({
        type: 'navigate',
        operationId,
        sessionId: forkSessionId,
        documentId,
        targetEntryId: 'target-leaf',
      }),
    ).resolves.toMatchObject({ activeLeafId: 'navigation-leaf' })
    await expect(api.connect({ documentId: 'other' })).rejects.toThrowError(
      'agent_session_connect_request_invalid',
    )
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(11)

    const next = vi.fn()
    const remove = api.onEvent(next)
    listeners.get(AGENT_SESSION_CHANNELS.event)?.({}, liveEvent)
    expect(next).toHaveBeenCalledWith(liveEvent)
    expect(() =>
      listeners.get(AGENT_SESSION_CHANNELS.event)?.({}, { token: 'secret' }),
    ).toThrowError('event_envelope_invalid')
    remove()
    api.disconnect()
    expect(ipcRenderer.send).toHaveBeenCalledWith(AGENT_SESSION_CHANNELS.disconnect)
  })

  it('rejects malformed main-process receipts', async () => {
    const ipcRenderer = {
      invoke: vi.fn(async () => ({ ...receipt, socket: '/tmp/runtime.sock' })),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    }
    const api = createAgentSessionPreloadApi(ipcRenderer)
    await expect(api.documentId()).rejects.toThrowError('agent_document_id_invalid')
    await expect(api.connect({ documentId, sessionId })).rejects.toThrowError(
      'agent_session_connect_receipt_invalid',
    )
    await expect(
      api.command({ type: 'prompt', operationId, sessionId, documentId, text: 'go' }),
    ).rejects.toThrowError('session_prompt_receipt_invalid')
  })
})
