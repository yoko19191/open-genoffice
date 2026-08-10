import { describe, expect, it } from 'vitest'
import type { EventEnvelope, SessionSnapshot } from '@genoffice/agent-runtime-protocol'
import {
  applyAgentSessionEvent,
  createAgentSessionProjection,
  restoreAgentSessionProjection,
  type AgentSessionProjection,
} from '../src'

const snapshot: SessionSnapshot = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  messages: [{ id: 'user-1', role: 'user', text: 'hello' }],
  activeRun: { runId: 'run-1', state: 'queued' },
  lastSequence: 1,
  cursor: 'cursor-1',
}

function event(
  sequence: number,
  type: EventEnvelope['type'],
  payload: Record<string, unknown> = {},
): EventEnvelope {
  return {
    protocolVersion: '1',
    kind: 'event',
    eventId: `event-${sequence}`,
    instanceId: 'instance-1',
    sessionId: snapshot.sessionId,
    documentId: snapshot.documentId,
    runId: 'run-1',
    sequence,
    cursor: `cursor-${sequence}`,
    occurredAt: '2026-08-09T12:00:00.000Z',
    type,
    payload,
  }
}

function apply(projection: AgentSessionProjection, events: EventEnvelope[]) {
  return events.reduce(applyAgentSessionEvent, projection)
}

describe('shared AI Panel Session projection', () => {
  it('restores and updates a stable Subagent run tree without provider metadata', () => {
    const child = {
      runId: 'subagent-run-1',
      rootRunId: 'run-1',
      parentRunId: 'run-1',
      role: 'researcher',
      depth: 1,
      model: { providerId: 'provider-1', modelId: 'model-1' },
      status: 'running' as const,
      attempt: 1,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, toolCalls: 1 },
      capabilitySnapshotId: 'a'.repeat(64),
      createdAt: '2026-08-10T00:00:00.000Z',
    }
    const initial = createAgentSessionProjection({ ...snapshot, subagents: [child] })
    const completed = applyAgentSessionEvent(
      initial,
      event(2, 'subagent.completed', {
        ...child,
        status: 'completed',
        result: { kind: 'text', text: 'safe child result' },
        providerRunId: 'must-not-project',
      }),
    )
    expect(completed.subagents).toEqual([child])

    const updated = applyAgentSessionEvent(
      initial,
      event(2, 'subagent.completed', {
        ...child,
        status: 'completed',
        result: { kind: 'text', text: 'safe child result' },
      }),
    )
    expect(updated.subagents).toEqual([
      expect.objectContaining({
        runId: 'subagent-run-1',
        status: 'completed',
        result: { kind: 'text', text: 'safe child result' },
      }),
    ])
    expect(JSON.stringify(updated)).not.toContain('providerRunId')
  })

  it('projects Mutation Grant requests and replaces only the matching receipt state', () => {
    const pending = {
      requestId: 'grant-request-1',
      subagentRunId: 'subagent-run-1',
      role: 'Reviewer',
      exactToolIds: ['office:docs:insert_content'],
      requestedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T00:05:00.000Z',
      status: 'pending' as const,
    }
    const initial = createAgentSessionProjection({ ...snapshot, mutationGrants: [pending] })
    const forged = applyAgentSessionEvent(
      initial,
      event(2, 'mutation-grant.updated', {
        ...pending,
        status: 'active',
        grantId: 'grant-1',
        issuedByUserActionId: 'must-not-project',
      }),
    )
    expect(forged.mutationGrants).toEqual([pending])
    const active = applyAgentSessionEvent(
      forged,
      event(3, 'mutation-grant.updated', {
        ...pending,
        status: 'active',
        grantId: 'grant-1',
      }),
    )
    expect(active.mutationGrants).toEqual([{ ...pending, status: 'active', grantId: 'grant-1' }])
    expect(JSON.stringify(active)).not.toContain('issuedByUserActionId')
  })

  it('renders native message, thinking, tool, and run events in journal order', () => {
    const projection = apply(createAgentSessionProjection(snapshot), [
      event(2, 'run.started'),
      event(3, 'message.started', { messageId: 'assistant-1' }),
      event(4, 'thinking.started'),
      event(5, 'thinking.delta', { text: 'checking ' }),
      event(6, 'thinking.delta', { text: 'contract' }),
      event(7, 'thinking.completed'),
      event(8, 'message.delta', { text: 'contract ' }),
      event(9, 'message.delta', { text: 'ready' }),
      event(10, 'tool.requested', { toolCallId: 'tool-1', toolName: 'contract_probe' }),
      event(11, 'tool.started', { toolCallId: 'tool-1', toolName: 'contract_probe' }),
      event(12, 'tool.progress', { toolCallId: 'tool-1' }),
      event(13, 'tool.completed', {
        toolCallId: 'tool-1',
        toolName: 'contract_probe',
        mutationOutcome: 'committed',
      }),
      event(14, 'message.completed', { messageId: 'assistant-1' }),
      event(15, 'compaction.started'),
      event(16, 'compaction.completed', { tokensBefore: 42, estimatedTokensAfter: 12 }),
      event(17, 'branch.created', { branchId: 'branch-1', parentEntryId: 'entry-1' }),
      event(18, 'run.completed'),
    ])

    expect(projection.messages).toEqual([
      { id: 'user-1', role: 'user', text: 'hello' },
      { id: 'assistant-1', role: 'assistant', text: 'contract ready' },
    ])
    expect(projection.thinking).toEqual({ text: 'checking contract', streaming: false })
    expect(projection.tools).toEqual([
      { toolCallId: 'tool-1', toolName: 'contract_probe', state: 'completed' },
    ])
    expect(projection.activeRun).toEqual({ runId: 'run-1', state: 'completed' })
    expect(projection.rollbackRunId).toBe('run-1')
    expect(projection.compaction).toEqual({
      state: 'completed',
      tokensBefore: 42,
      estimatedTokensAfter: 12,
    })
    expect(projection.branch).toEqual({
      state: 'created',
      branchId: 'branch-1',
      parentEntryId: 'entry-1',
    })
    expect(projection.lastSequence).toBe(18)
    expect(projection.cursor).toBe('cursor-18')
  })

  it('keeps only validated platform details on the matching tool row', () => {
    const requested = applyAgentSessionEvent(
      createAgentSessionProjection(snapshot),
      event(2, 'tool.started', { toolCallId: 'image-1', toolName: 'image_search' }),
    )
    const completed = applyAgentSessionEvent(
      requested,
      event(3, 'tool.completed', {
        toolCallId: 'image-1',
        toolName: 'image_search',
        platformTool: {
          toolId: 'platform:image_search',
          kind: 'image_search',
          provider: 'serper',
          images: [
            {
              artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              mediaType: 'image/png',
              byteLength: 68,
              sha256: 'a'.repeat(64),
              title: 'Safe image',
              sourceUrl: 'https://example.test/page',
              source: 'Example',
              width: 1,
              height: 1,
            },
          ],
        },
      }),
    )
    expect(completed.tools[0]).toMatchObject({
      state: 'completed',
      details: { kind: 'image_search', images: [{ artifactId: expect.any(String) }] },
    })

    const forged = applyAgentSessionEvent(
      requested,
      event(3, 'tool.completed', {
        toolCallId: 'image-1',
        toolName: 'image_search',
        platformTool: { kind: 'image_search', imageUrl: 'https://private.example/image.png' },
      }),
    )
    expect(forged.tools[0]).not.toHaveProperty('details')
    expect(JSON.stringify(forged)).not.toContain('private.example')
  })

  it('ignores exact duplicates, rejects gaps and cross-document events, and bounds dedupe state', () => {
    const initial = createAgentSessionProjection({ ...snapshot, activeRun: undefined })
    const started = applyAgentSessionEvent(initial, event(2, 'run.queued'))
    expect(applyAgentSessionEvent(started, event(2, 'run.queued'))).toBe(started)
    expect(() => applyAgentSessionEvent(started, event(4, 'run.started'))).toThrowError(
      'session_event_gap',
    )
    expect(() =>
      applyAgentSessionEvent(started, {
        ...event(3, 'run.started'),
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      }),
    ).toThrowError('session_event_binding_mismatch')
    expect(() =>
      applyAgentSessionEvent(started, { ...event(3, 'run.started'), sessionId: 'other-session' }),
    ).toThrowError('session_event_binding_mismatch')

    const many = Array.from({ length: 140 }, (_value, index) =>
      event(index + 2, 'diagnostic.available'),
    ).reduce(applyAgentSessionEvent, initial)
    expect(many.recentEventIds).toHaveLength(128)
    expect(many.recentEventIds[0]).toBe('event-14')
  })

  it('projects terminal failures, implicit stream starts, and missing optional payload fields safely', () => {
    const projection = apply(createAgentSessionProjection(snapshot), [
      event(2, 'message.delta', { text: 'implicit message' }),
      event(3, 'thinking.delta', { text: 'implicit thought' }),
      event(4, 'tool.requested', { toolCallId: 'tool-1' }),
      event(5, 'tool.failed', { toolCallId: 'tool-1' }),
      event(6, 'tool.aborted', { toolCallId: 'missing-tool' }),
      event(7, 'run.cancelling'),
      event(8, 'run.aborted'),
      event(9, 'branch.created'),
      event(10, 'compaction.completed'),
      event(11, 'diagnostic.available', {
        code: 'provider_auth',
        diagnosticId: 'diagnostic-1',
        privateDetail: 'must not enter the projection',
      }),
    ])
    expect(projection.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'implicit message',
    })
    expect(projection.thinking).toEqual({ text: 'implicit thought', streaming: true })
    expect(projection.tools).toEqual([{ toolCallId: 'tool-1', toolName: 'tool', state: 'failed' }])
    expect(projection.activeRun?.state).toBe('aborted')
    expect(projection.branch).toEqual({ state: 'created' })
    expect(projection.compaction).toEqual({ state: 'completed' })
    expect(projection.error).toEqual({
      code: 'provider_auth',
      diagnosticId: 'diagnostic-1',
    })
    expect(JSON.stringify(projection)).not.toContain('must not enter the projection')
    expect(projection.lastSequence).toBe(11)
  })

  it.each([
    ['run.failed', 'failed'],
    ['run.interrupted', 'interrupted'],
  ] as const)('maps %s to the visible run state', (type, state) => {
    const projection = applyAgentSessionEvent(
      createAgentSessionProjection(snapshot),
      event(2, type),
    )
    expect(projection.activeRun).toEqual({ runId: 'run-1', state })
    if (type === 'run.failed') expect(projection.error).toEqual({ code: 'run_failed' })
  })

  it('uses safe fallbacks for absent renderer payload fields', () => {
    const withoutRunId = { ...event(2, 'run.started') }
    delete withoutRunId.runId
    const started = applyAgentSessionEvent(createAgentSessionProjection(snapshot), withoutRunId)
    expect(started.activeRun).toEqual({ runId: 'run-1', state: 'running' })

    const noActiveRun = createAgentSessionProjection({ ...snapshot, activeRun: undefined })
    expect(applyAgentSessionEvent(noActiveRun, withoutRunId).activeRun).toBeUndefined()

    const fallbackMessage = applyAgentSessionEvent(noActiveRun, {
      ...event(2, 'message.started'),
      runId: undefined,
      payload: null,
    })
    expect(fallbackMessage.messages.at(-1)?.id).toBe('event-2')
    const emptyDelta = applyAgentSessionEvent(fallbackMessage, {
      ...event(3, 'message.delta'),
      payload: {},
    })
    const emptyThinking = applyAgentSessionEvent(emptyDelta, {
      ...event(4, 'thinking.delta'),
      payload: {},
    })
    const completedThinking = applyAgentSessionEvent(
      { ...emptyThinking, thinking: undefined },
      event(5, 'thinking.completed'),
    )
    const missingTool = applyAgentSessionEvent(completedThinking, {
      ...event(6, 'tool.requested'),
      payload: {},
    })
    const userMessage = applyAgentSessionEvent(
      missingTool,
      event(7, 'message.started', { messageId: 'user-fallback', role: 'user', text: 'prompt' }),
    )
    expect(missingTool.thinking).toEqual({ text: '', streaming: false })
    expect(missingTool.tools).toEqual([])
    expect(userMessage.messages.at(-1)).toEqual({
      id: 'user-fallback',
      role: 'user',
      text: 'prompt',
    })
  })

  it('projects failed compaction and branch navigation without optional identifiers', () => {
    const projection = apply(createAgentSessionProjection(snapshot), [
      event(2, 'compaction.failed'),
      event(3, 'branch.navigated'),
    ])
    expect(projection.compaction).toEqual({ state: 'failed' })
    expect(projection.branch).toEqual({ state: 'navigated' })
  })

  it('replaces renderer state from a reconnect snapshot before applying newer events', () => {
    const restored = restoreAgentSessionProjection({
      connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId: snapshot.sessionId,
      documentId: snapshot.documentId,
      resetRequired: false,
      snapshot: {
        ...snapshot,
        messages: [{ id: 'server-message', role: 'assistant', text: 'authoritative' }],
        activeRun: { runId: 'run-1', state: 'running' },
      },
      events: [event(2, 'run.completed')],
    })

    expect(restored.messages).toEqual([
      { id: 'server-message', role: 'assistant', text: 'authoritative' },
    ])
    expect(restored.activeRun?.state).toBe('completed')
    expect(restored.lastSequence).toBe(2)
  })
})
