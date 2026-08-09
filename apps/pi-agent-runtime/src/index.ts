export type FakeProviderEvent = {
  type: string
  sequence: number
  payload: Record<string, unknown>
}

const EVENT_SEQUENCE: readonly FakeProviderEvent[] = [
  { type: 'message.started', sequence: 1, payload: { messageId: 'fake-message-1' } },
  { type: 'thinking.delta', sequence: 2, payload: { text: 'checking contract' } },
  { type: 'message.delta', sequence: 3, payload: { text: 'contract ready' } },
  { type: 'tool.requested', sequence: 4, payload: { toolCallId: 'fake-tool-1' } },
  { type: 'tool.completed', sequence: 5, payload: { toolCallId: 'fake-tool-1', ok: true } },
  { type: 'compaction.completed', sequence: 6, payload: { retainedMessages: 1 } },
  { type: 'branch.created', sequence: 7, payload: { branchId: 'fake-branch-1' } },
  { type: 'run.completed', sequence: 8, payload: { inputTokens: 32, outputTokens: 16 } },
]

export function createDeterministicFakeProvider() {
  return {
    async run(_prompt: string): Promise<readonly FakeProviderEvent[]> {
      return structuredClone(EVENT_SEQUENCE)
    },
  }
}
