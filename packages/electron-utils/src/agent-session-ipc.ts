import {
  parseAgentSessionCommand,
  parseAgentSessionConnectReceipt,
  parseAgentSessionConnectRequest,
  parseEventEnvelope,
  parseSessionAbortReceipt,
  parseSessionForkReceipt,
  parseSessionNavigateReceipt,
  parseSessionPromptReceipt,
  parseSessionSubagentResumeReceipt,
  type AgentSessionCommand,
  type AgentSessionConnectReceipt,
  type AgentSessionConnectRequest,
  type EventEnvelope,
  type SessionPromptReceipt,
  type SessionAbortReceipt,
  type SessionForkReceipt,
  type SessionNavigateReceipt,
  type SessionSubagentResumeReceipt,
} from '@genoffice/agent-runtime-protocol'
import type { AgentSessionBroker } from './agent-session-broker'

export const AGENT_SESSION_CHANNELS = Object.freeze({
  connect: 'agent-session:connect',
  command: 'agent-session:command',
  disconnect: 'agent-session:disconnect',
  document: 'agent-session:document',
  event: 'agent-session:event',
})

type IpcSender = {
  id: number
  isDestroyed(): boolean
  send(channel: string, value: unknown): void
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
}

type IpcMainEvent = { sender: IpcSender }

export type AgentSessionIpcMain = {
  handle(
    channel: string,
    listener: (event: IpcMainEvent, value: unknown) => unknown | Promise<unknown>,
  ): void
  on(channel: string, listener: (event: IpcMainEvent) => void): void
  removeHandler(channel: string): void
  removeListener(channel: string, listener: (event: IpcMainEvent) => void): void
}

export type AgentSessionIpcRenderer = {
  invoke(channel: string, value: unknown): Promise<unknown>
  send(channel: string): void
  on(channel: string, listener: (event: unknown, value: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): void
}

export interface AgentSessionPreloadApi {
  documentId(): Promise<string>
  connect(request: AgentSessionConnectRequest): Promise<AgentSessionConnectReceipt>
  command(
    command: AgentSessionCommand,
  ): Promise<
    | SessionPromptReceipt
    | SessionAbortReceipt
    | SessionSubagentResumeReceipt
    | SessionForkReceipt
    | SessionNavigateReceipt
  >
  disconnect(): void
  onEvent(handler: (event: EventEnvelope) => void): () => void
}

export function installAgentSessionIpc(
  ipcMain: AgentSessionIpcMain,
  broker: AgentSessionBroker<number>,
  options?: { documentIdFor(clientId: number): string | Promise<string> },
): () => Promise<void> {
  const observedSenders = new WeakSet<IpcSender>()
  const observeSender = (sender: IpcSender) => {
    if (observedSenders.has(sender)) return
    observedSenders.add(sender)
    const disconnect = () => broker.disconnect(sender.id)
    sender.once('destroyed', disconnect)
    sender.once('render-process-gone', disconnect)
  }
  ipcMain.handle(AGENT_SESSION_CHANNELS.connect, async (event, value) => {
    observeSender(event.sender)
    const request = parseAgentSessionConnectRequest(value)
    const receipt = await broker.connect(event.sender.id, request, (next) => {
      if (!event.sender.isDestroyed()) event.sender.send(AGENT_SESSION_CHANNELS.event, next)
    })
    return parseAgentSessionConnectReceipt(receipt)
  })
  ipcMain.handle(AGENT_SESSION_CHANNELS.command, (event, value) => {
    observeSender(event.sender)
    return broker.command(event.sender.id, parseAgentSessionCommand(value))
  })
  if (options) {
    ipcMain.handle(AGENT_SESSION_CHANNELS.document, async (event) => {
      const documentId = await options.documentIdFor(event.sender.id)
      try {
        return parseAgentSessionConnectRequest({ documentId }).documentId
      } catch {
        throw new Error('agent_document_id_invalid')
      }
    })
  }
  const disconnect = (event: IpcMainEvent) => broker.disconnect(event.sender.id)
  ipcMain.on(AGENT_SESSION_CHANNELS.disconnect, disconnect)

  return async () => {
    ipcMain.removeHandler(AGENT_SESSION_CHANNELS.connect)
    ipcMain.removeHandler(AGENT_SESSION_CHANNELS.command)
    if (options) ipcMain.removeHandler(AGENT_SESSION_CHANNELS.document)
    ipcMain.removeListener(AGENT_SESSION_CHANNELS.disconnect, disconnect)
    await broker.close()
  }
}

export function createAgentSessionPreloadApi(
  ipcRenderer: AgentSessionIpcRenderer,
): AgentSessionPreloadApi {
  const api: AgentSessionPreloadApi = {
    async documentId() {
      const documentId = await ipcRenderer.invoke(AGENT_SESSION_CHANNELS.document, undefined)
      try {
        return parseAgentSessionConnectRequest({ documentId }).documentId
      } catch {
        throw new Error('agent_document_id_invalid')
      }
    },
    async connect(request: AgentSessionConnectRequest) {
      const validated = parseAgentSessionConnectRequest(request)
      return parseAgentSessionConnectReceipt(
        await ipcRenderer.invoke(AGENT_SESSION_CHANNELS.connect, validated),
      )
    },
    async command(command: AgentSessionCommand) {
      const validated = parseAgentSessionCommand(command)
      const receipt = await ipcRenderer.invoke(AGENT_SESSION_CHANNELS.command, validated)
      if (validated.type === 'prompt') return parseSessionPromptReceipt(receipt)
      if (validated.type === 'abort') return parseSessionAbortReceipt(receipt)
      if (validated.type === 'resumeSubagent') {
        return parseSessionSubagentResumeReceipt(receipt)
      }
      if (validated.type === 'fork') return parseSessionForkReceipt(receipt)
      return parseSessionNavigateReceipt(receipt)
    },
    disconnect() {
      ipcRenderer.send(AGENT_SESSION_CHANNELS.disconnect)
    },
    onEvent(handler: (event: EventEnvelope) => void) {
      const listener = (_event: unknown, value: unknown) => handler(parseEventEnvelope(value))
      ipcRenderer.on(AGENT_SESSION_CHANNELS.event, listener)
      return () => ipcRenderer.removeListener(AGENT_SESSION_CHANNELS.event, listener)
    },
  }
  return Object.freeze(api)
}
