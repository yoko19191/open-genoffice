import { describe, expect, it, vi } from 'vitest'
import { ToolResultReorderBuffer } from '../src/tool-result-reorder-buffer'

describe('ToolResultReorderBuffer', () => {
  it('publishes parallel completions strictly by toolOrder', async () => {
    const transcript: string[] = []
    const modelResults: string[] = []
    const uiEvents: string[] = []
    const buffer = new ToolResultReorderBuffer<string>(3, async (value) => {
      transcript.push(value)
      modelResults.push(value)
      uiEvents.push(value)
    })
    const third = buffer.settle(2, 'third')
    const second = buffer.settle(1, 'second')
    expect(transcript).toEqual([])
    const first = buffer.settle(0, 'first')
    await Promise.all([third, second, first])
    expect(transcript).toEqual(['first', 'second', 'third'])
    expect(modelResults).toEqual(transcript)
    expect(uiEvents).toEqual(transcript)
    expect(buffer.nextToolOrder).toBe(3)
  })

  it('keeps independent Session buffers from crossing transcripts', async () => {
    const sessionA: string[] = []
    const sessionB: string[] = []
    const first = new ToolResultReorderBuffer<string>(2, async (value) => void sessionA.push(value))
    const second = new ToolResultReorderBuffer<string>(
      2,
      async (value) => void sessionB.push(value),
    )
    await Promise.all([first.settle(0, 'session-a'), second.settle(0, 'session-b')])
    expect(sessionA).toEqual(['session-a'])
    expect(sessionB).toEqual(['session-b'])
  })

  it('rejects duplicates, late orders, and overflow without publishing them', async () => {
    const publish = vi.fn(async (_value: string) => {})
    const buffer = new ToolResultReorderBuffer<string>(2, publish)
    const second = buffer.settle(1, 'second')
    expect(() => buffer.settle(1, 'duplicate')).toThrowError('duplicate_tool_order')
    expect(() => buffer.settle(3, 'overflow')).toThrowError('tool_reorder_buffer_full')
    await buffer.settle(0, 'first')
    await second
    expect(() => buffer.settle(0, 'late')).toThrowError('tool_order_already_published')
    expect(publish.mock.calls.map(([value]) => value)).toEqual(['first', 'second'])
  })

  it('propagates publication failure to the affected result', async () => {
    const buffer = new ToolResultReorderBuffer<string>(1, async () => {
      throw new Error('journal unavailable')
    })
    await expect(buffer.settle(0, 'failed')).rejects.toThrowError('journal unavailable')
    expect(() => buffer.settle(0, 'after-failure')).toThrowError('tool_result_publish_failed')
  })

  it('normalizes a non-Error publication failure', async () => {
    const buffer = new ToolResultReorderBuffer<string>(1, async () => {
      throw 'private failure'
    })
    await expect(buffer.settle(0, 'failed')).rejects.toThrowError('tool_result_publish_failed')
  })

  it('rejects an invalid buffer bound', () => {
    expect(() => new ToolResultReorderBuffer(0, async () => {})).toThrowError(
      'invalid_tool_reorder_buffer_size',
    )
    const buffer = new ToolResultReorderBuffer(2, async () => {})
    expect(() => buffer.settle(0.5, 'fractional')).toThrowError('tool_order_already_published')
  })
})
