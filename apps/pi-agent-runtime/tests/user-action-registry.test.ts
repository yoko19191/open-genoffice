import { describe, expect, it, vi } from 'vitest'
import { UserActionRegistry, UserActionRegistryError } from '../src/user-action-registry'

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const documentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function harness() {
  let uuid = 0
  const registry = new UserActionRegistry({
    randomUUID: () => `question-${++uuid}`,
    now: () => new Date('2026-08-11T00:00:00.000Z'),
  })
  return { registry }
}

describe('UserActionRegistry', () => {
  it('pauses a confirm request, emits a safe projection and resumes with an exact answer', async () => {
    const { registry } = harness()
    const events: unknown[] = []
    const unsubscribe = registry.onEvent((event) => events.push(event))
    const waiting = registry.request({
      sessionId,
      documentId,
      runId: 'run-1',
      mode: 'confirm',
      question: 'Apply these changes?',
      confirmLabel: 'Apply',
      cancelLabel: 'Cancel',
    })

    expect(registry.listForSession(sessionId)).toEqual([
      expect.objectContaining({ requestId: 'question-1', status: 'pending' }),
    ])
    await expect(
      registry.answer({
        sessionId,
        documentId,
        requestId: 'question-1',
        userActionId: 'gesture-1',
        answer: { confirmed: true },
      }),
    ).resolves.toMatchObject({ status: 'answered' })
    await expect(waiting).resolves.toEqual({
      requestId: 'question-1',
      answer: { confirmed: true },
    })
    expect(registry.listForSession(sessionId)).toEqual([])
    expect(JSON.stringify(events)).not.toContain('gesture-1')
    expect(JSON.stringify(events)).not.toContain('confirmed')
    unsubscribe()
  })

  it('rejects wrong bindings, forged answer shapes and mode mismatches', async () => {
    const { registry } = harness()
    const waiting = registry.request({
      sessionId,
      documentId,
      runId: 'run-1',
      mode: 'input',
      question: 'Name this section',
      maxLength: 4,
    })
    await expect(
      registry.answer({
        sessionId,
        documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        requestId: 'question-1',
        userActionId: 'gesture-1',
        answer: { text: 'safe' },
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_binding_invalid'))
    await expect(
      registry.answer({
        sessionId,
        documentId,
        requestId: 'question-1',
        userActionId: 'gesture-1',
        answer: { confirmed: true },
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_answer_invalid'))
    await expect(
      registry.answer({
        sessionId,
        documentId,
        requestId: 'question-1',
        userActionId: 'gesture-1',
        answer: { text: 'too long' },
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_answer_invalid'))
    await registry.answer({
      sessionId,
      documentId,
      requestId: 'question-1',
      userActionId: 'gesture-1',
      answer: { text: 'safe' },
    })
    await waiting
  })

  it('cancels pending work on Stop and enforces the per-session bound', async () => {
    const { registry } = harness()
    const abort = new AbortController()
    const waiting = registry.request({
      sessionId,
      documentId,
      runId: 'run-1',
      mode: 'confirm',
      question: 'Continue?',
      signal: abort.signal,
    })
    abort.abort()
    await expect(waiting).rejects.toEqual(new UserActionRegistryError('user_action_cancelled'))
    await expect(
      registry.answer({
        sessionId,
        documentId,
        requestId: 'question-1',
        userActionId: 'gesture-1',
        answer: { confirmed: true },
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_not_found'))

    const waits = Array.from({ length: 16 }, (_, index) =>
      registry.request({
        sessionId,
        documentId,
        runId: `run-${index + 2}`,
        mode: 'confirm' as const,
        question: 'Continue?',
      }),
    )
    await expect(
      registry.request({
        sessionId,
        documentId,
        runId: 'run-overflow',
        mode: 'confirm',
        question: 'Continue?',
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_limit_exceeded'))
    registry.cancelForSession(sessionId)
    await Promise.allSettled(waits)
  })

  it('rejects malformed requests and supports explicit run cancellation', async () => {
    const { registry } = harness()
    await expect(
      registry.request({
        sessionId,
        documentId,
        runId: 'run-1',
        mode: 'confirm',
        question: '',
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_request_invalid'))
    const waiting = registry.request({
      sessionId,
      documentId,
      runId: 'run-1',
      mode: 'input',
      question: 'Value?',
      placeholder: 'Type here',
    })
    expect(registry.cancelForRun('run-1')).toBe(1)
    expect(registry.cancelForRun('run-1')).toBe(0)
    await expect(waiting).rejects.toEqual(new UserActionRegistryError('user_action_cancelled'))
    expect(vi.isMockFunction(registry.onEvent)).toBe(false)
  })

  it('covers pre-abort, duplicate ids, mode-only fields and default input length', async () => {
    const defaults = new UserActionRegistry()
    const defaultWaiting = defaults.request({
      sessionId,
      documentId,
      runId: 'run-defaults',
      mode: 'confirm',
      question: 'Continue?',
    })
    expect(defaults.listForSession(sessionId)).toHaveLength(1)
    defaults.cancelForSession(sessionId)
    await expect(defaultWaiting).rejects.toEqual(
      new UserActionRegistryError('user_action_cancelled'),
    )
    const abort = new AbortController()
    abort.abort()
    await expect(
      harness().registry.request({
        sessionId,
        documentId,
        runId: 'run-pre-abort',
        mode: 'confirm',
        question: 'Continue?',
        signal: abort.signal,
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_cancelled'))

    const registry = new UserActionRegistry({
      randomUUID: () => 'same-question',
      now: () => new Date('2026-08-11T00:00:00.000Z'),
    })
    const first = registry.request({
      sessionId,
      documentId,
      runId: 'run-1',
      mode: 'input',
      question: 'Name?',
      placeholder: 'Optional',
    })
    await expect(
      registry.request({
        sessionId,
        documentId,
        runId: 'run-2',
        mode: 'input',
        question: 'Another?',
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_request_invalid'))
    await expect(
      registry.answer({
        sessionId,
        documentId,
        requestId: 'same-question',
        userActionId: '',
        answer: { text: 'Overview' },
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_answer_invalid'))
    await registry.answer({
      sessionId,
      documentId,
      requestId: 'same-question',
      userActionId: 'gesture-1',
      answer: { text: 'Overview' },
    })
    await first

    await expect(
      registry.request({
        sessionId,
        documentId,
        runId: 'run-3',
        mode: 'confirm',
        question: 'Continue?',
        placeholder: 'not allowed',
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_request_invalid'))
    await expect(
      registry.request({
        sessionId,
        documentId,
        runId: 'run-4',
        mode: 'input',
        question: 'Name?',
        confirmLabel: 'not allowed',
      }),
    ).rejects.toEqual(new UserActionRegistryError('user_action_request_invalid'))
  })
})
