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
  const sender = {
    id: 42,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn((name: string, listener: () => void) => lifecycle.set(name, listener)),
  }
  let deliver: ((event: EventEnvelope) => void) | undefined
  const broker = {
    connect: vi.fn(async (_id, _request, next) => {
      deliver = next
      return receipt
    }),
    command: vi.fn(async () => ({ runId: 'run-1', acceptedCursor: 'cursor-2' })),
    disconnect: vi.fn(),
    close: vi.fn(async () => {}),
  }
  return {
    broker,
    handlers,
    ipcMain,
    lifecycle,
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
    await expect(api.connect({ documentId: 'other' })).rejects.toThrowError(
      'agent_session_connect_request_invalid',
    )
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(4)

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
    await expect(api.connect({ documentId, sessionId })).rejects.toThrowError(
      'agent_session_connect_receipt_invalid',
    )
    await expect(
      api.command({ type: 'prompt', operationId, sessionId, documentId, text: 'go' }),
    ).rejects.toThrowError('session_prompt_receipt_invalid')
  })
})
