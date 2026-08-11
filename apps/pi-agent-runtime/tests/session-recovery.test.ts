import { describe, expect, it } from 'vitest'
import type { EventEnvelope } from '@genoffice/agent-runtime-protocol'
import { planSessionRecovery } from '../src/session-recovery'

function event(
  type: EventEnvelope['type'],
  options: {
    runId?: string
    toolCallId?: string
    toolName?: string
    mutationOutcome?: string
  } = {},
): EventEnvelope {
  return {
    protocolVersion: '1',
    kind: 'event',
    eventId: `${type}-event`,
    instanceId: 'old-instance',
    sessionId: 'session-1',
    documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    ...(options.runId ? { runId: options.runId } : {}),
    sequence: 1,
    cursor: 'old-cursor',
    occurredAt: '2026-08-09T12:00:00.000Z',
    type,
    payload: {
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      ...(options.toolName ? { toolName: options.toolName } : {}),
      ...(options.mutationOutcome ? { mutationOutcome: options.mutationOutcome } : {}),
    },
  }
}

describe('Session crash recovery planner', () => {
  it('does nothing without an unterminated active run', () => {
    expect(planSessionRecovery([event('session.opened')])).toBeUndefined()
    expect(
      planSessionRecovery([
        event('run.queued', { runId: 'run-1' }),
        event('run.completed', { runId: 'run-1' }),
      ]),
    ).toBeUndefined()
  })

  it('classifies requested and started tools without replaying any of them', () => {
    const plan = planSessionRecovery([
      event('run.queued', { runId: 'old-run' }),
      event('run.completed', { runId: 'old-run' }),
      event('run.started', { runId: 'run-2' }),
      event('tool.requested', { runId: 'run-2', toolCallId: 'not-started', toolName: 'mcp-read' }),
      event('tool.started', { runId: 'run-2', toolCallId: 'unknown', toolName: 'office-write' }),
      event('tool.started', {
        runId: 'run-2',
        toolCallId: 'committed',
        mutationOutcome: 'committed',
      }),
      event('tool.started', {
        runId: 'run-2',
        toolCallId: 'rolled-back',
        mutationOutcome: 'rolled_back',
      }),
      event('tool.started', {
        runId: 'run-2',
        toolCallId: 'invalid-outcome',
        mutationOutcome: 'maybe',
      }),
      event('tool.started', { runId: 'run-2', toolCallId: 'finished' }),
      event('tool.completed', { runId: 'run-2', toolCallId: 'finished' }),
      event('tool.started', { runId: 'other-run', toolCallId: 'ignored' }),
      event('tool.started', { runId: 'run-2' }),
    ])

    expect(plan).toEqual({
      runId: 'run-2',
      reason: 'runtime_crash',
      documentNeedsReview: true,
      tools: [
        {
          toolCallId: 'not-started',
          toolName: 'mcp-read',
          mutationOutcome: 'not_started',
          terminalType: 'tool.aborted',
        },
        {
          toolCallId: 'unknown',
          toolName: 'office-write',
          mutationOutcome: 'unknown',
          terminalType: 'tool.failed',
        },
        {
          toolCallId: 'committed',
          mutationOutcome: 'committed',
          terminalType: 'tool.completed',
        },
        {
          toolCallId: 'rolled-back',
          mutationOutcome: 'rolled_back',
          terminalType: 'tool.aborted',
        },
        {
          toolCallId: 'invalid-outcome',
          mutationOutcome: 'unknown',
          terminalType: 'tool.failed',
        },
      ],
    })
  })

  it('keeps a recovery plan review-free when no started outcome is unknown', () => {
    expect(
      planSessionRecovery([
        event('run.cancelling', { runId: 'run-1' }),
        event('tool.requested', { runId: 'run-1', toolCallId: 'queued' }),
        event('tool.started', {
          runId: 'run-1',
          toolCallId: 'known',
          mutationOutcome: 'not_started',
        }),
        event('tool.failed', { runId: 'run-1', toolCallId: 'gone' }),
      ]),
    ).toMatchObject({ documentNeedsReview: false })
  })
})
