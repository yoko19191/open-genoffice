import eventSequence from '../fixtures/fake-provider-events.json' with { type: 'json' }

export {
  createAuthenticatedRuntimeServer,
  type AuthenticatedRuntimeServer,
  type AuthenticatedRuntimeServerOptions,
} from './authenticated-server'

export type FakeProviderEvent = {
  type: string
  sequence: number
  payload: Record<string, unknown>
}

const EVENT_SEQUENCE: readonly FakeProviderEvent[] = eventSequence

export function createDeterministicFakeProvider() {
  return {
    async run(_prompt: string): Promise<readonly FakeProviderEvent[]> {
      return structuredClone(EVENT_SEQUENCE)
    },
  }
}
