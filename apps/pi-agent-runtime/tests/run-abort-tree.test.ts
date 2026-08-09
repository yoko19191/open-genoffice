import { describe, expect, it, vi } from 'vitest'
import { RunAbortTree } from '../src/run-abort-tree'

describe('RunAbortTree', () => {
  it('rejects invalid deadlines and duplicate descendant identifiers', () => {
    expect(() => new RunAbortTree({ cooperativeAbortMs: 0, forceAbortMs: 1 })).toThrowError(
      'invalid_abort_deadline',
    )
    expect(() => new RunAbortTree({ cooperativeAbortMs: 2, forceAbortMs: 1 })).toThrowError(
      'invalid_abort_deadline',
    )
    const tree = new RunAbortTree({ cooperativeAbortMs: 10, forceAbortMs: 20 })
    const descendant = { id: 'same', kind: 'model' as const, abort: async () => {} }
    tree.register(descendant)
    expect(() => tree.register(descendant)).toThrowError('duplicate_abort_descendant')
  })

  it('shares one root signal, revokes subagent grants, and settles every cooperative descendant', async () => {
    const calls: string[] = []
    const tree = new RunAbortTree({ cooperativeAbortMs: 100, forceAbortMs: 200 })
    for (const kind of ['model', 'office', 'mcp', 'subagent'] as const) {
      tree.register({
        id: kind,
        kind,
        ...(kind === 'office' ? { mutation: true } : {}),
        ...(kind === 'subagent' ? { revoke: async () => void calls.push('subagent:revoke') } : {}),
        abort: async (signal) => {
          expect(signal).toBe(tree.signal)
          expect(signal.aborted).toBe(true)
          calls.push(`${kind}:abort`)
          return kind === 'office' ? { mutationOutcome: 'rolled_back' as const } : undefined
        },
      })
    }

    const first = tree.abort()
    expect(tree.abort()).toBe(first)
    await expect(first).resolves.toMatchObject({ complete: true })
    expect(calls).toContain('subagent:revoke')
    expect(calls.indexOf('subagent:revoke')).toBeLessThan(calls.indexOf('subagent:abort'))
    expect(calls).toEqual(expect.arrayContaining(['model:abort', 'office:abort', 'mcp:abort']))
  })

  it('force-kills an uncooperative Runtime subprocess after the cooperative deadline', async () => {
    const forceKill = vi.fn(async () => {})
    const tree = new RunAbortTree({ cooperativeAbortMs: 10, forceAbortMs: 50 })
    tree.register({
      id: 'child-process',
      kind: 'process',
      abort: async () => new Promise<never>(() => {}),
      forceKill,
    })

    await expect(tree.abort()).resolves.toMatchObject({
      complete: true,
      descendants: [{ id: 'child-process', kind: 'process', state: 'forced' }],
    })
    expect(forceKill).toHaveBeenCalledOnce()
  })

  it('terminates a real child that ignores inherited stdin EOF', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end', () => setInterval(() => {}, 1000))",
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    await once(child.stdout!, 'data')
    const tree = new RunAbortTree({ cooperativeAbortMs: 20, forceAbortMs: 500 })
    tree.register({
      id: 'ignore-eof-child',
      kind: 'process',
      abort: async () => {
        child.stdin!.end()
        await once(child, 'exit')
      },
      forceKill: async () => {
        child.kill('SIGKILL')
        await once(child, 'exit')
      },
    })

    await expect(tree.abort()).resolves.toMatchObject({
      complete: true,
      descendants: [{ id: 'ignore-eof-child', state: 'forced' }],
    })
    expect(child.exitCode ?? child.signalCode).not.toBeNull()
  })

  it('reports abort_incomplete for an uncertain mutation and never invokes it twice', async () => {
    const abort = vi.fn(async () => ({ mutationOutcome: 'unknown' as const }))
    const tree = new RunAbortTree({ cooperativeAbortMs: 100, forceAbortMs: 200 })
    tree.register({ id: 'office-write', kind: 'office', mutation: true, abort })

    const result = await tree.abort()
    expect(result).toMatchObject({
      complete: false,
      descendants: [
        {
          id: 'office-write',
          state: 'settled',
          mutationOutcome: 'unknown',
        },
      ],
    })
    await tree.abort()
    expect(abort).toHaveBeenCalledOnce()
  })

  it('reports rejected cooperative cancellation and failed force-kill as incomplete', async () => {
    const cooperativeFailure = new RunAbortTree({
      cooperativeAbortMs: 100,
      forceAbortMs: 200,
    })
    cooperativeFailure.register({
      id: 'rejected',
      kind: 'mcp',
      abort: async () => {
        throw new Error('private adapter error')
      },
    })
    await expect(cooperativeFailure.abort()).resolves.toMatchObject({
      complete: false,
      descendants: [{ state: 'incomplete' }],
    })

    const forceFailure = new RunAbortTree({ cooperativeAbortMs: 5, forceAbortMs: 50 })
    forceFailure.register({
      id: 'mutation-process',
      kind: 'process',
      mutation: true,
      abort: async () => new Promise<never>(() => {}),
      forceKill: async () => {
        throw new Error('private kill error')
      },
    })
    await expect(forceFailure.abort()).resolves.toMatchObject({
      complete: false,
      descendants: [{ state: 'incomplete', mutationOutcome: 'unknown' }],
    })
  })

  it('treats a mutation without an explicit cancellation outcome as unknown', async () => {
    const tree = new RunAbortTree({ cooperativeAbortMs: 100, forceAbortMs: 200 })
    tree.register({ id: 'office-write', kind: 'office', mutation: true, abort: async () => {} })
    await expect(tree.abort()).resolves.toMatchObject({
      complete: false,
      descendants: [{ mutationOutcome: 'unknown' }],
    })
  })

  it('removes naturally completed descendants and rejects registration after cancellation starts', async () => {
    const abort = vi.fn(async () => {})
    const tree = new RunAbortTree({ cooperativeAbortMs: 100, forceAbortMs: 200 })
    const complete = tree.register({ id: 'finished', kind: 'mcp', abort })
    complete()
    await expect(tree.abort()).resolves.toEqual({ complete: true, descendants: [] })
    expect(abort).not.toHaveBeenCalled()
    expect(() => tree.register({ id: 'late', kind: 'model', abort })).toThrowError(
      'abort_already_started',
    )
  })
})
import { once } from 'node:events'
import { spawn } from 'node:child_process'
