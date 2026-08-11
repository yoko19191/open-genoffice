import { describe, expect, it } from 'vitest'
import { createDeterministicFakeProvider } from '../src'

describe('deterministic fake model provider', () => {
  it('repeats the frozen native event sequence byte-for-byte', async () => {
    const provider = createDeterministicFakeProvider()
    const first = await provider.run('g0-contract')
    const second = await provider.run('g0-contract')

    expect(second).toEqual(first)
    expect(first.map((event) => event.type)).toEqual([
      'message.started',
      'thinking.delta',
      'message.delta',
      'tool.requested',
      'tool.completed',
      'compaction.completed',
      'branch.created',
      'run.completed',
    ])
    expect(first.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(JSON.stringify(first)).not.toContain('g0-contract')
  })

  it('uses a fixed synthetic usage receipt without wall-clock or random fields', async () => {
    const events = await createDeterministicFakeProvider().run('private prompt')
    expect(events.at(-1)).toEqual({
      type: 'run.completed',
      sequence: 8,
      payload: { inputTokens: 32, outputTokens: 16 },
    })
  })
})
