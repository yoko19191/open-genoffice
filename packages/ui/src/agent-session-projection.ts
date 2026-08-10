import type {
  AgentSessionConnectReceipt,
  EventEnvelope,
  SessionMessageProjection,
  SessionSnapshot,
  SubagentRunProjection,
  MutationGrantProjection,
} from '@genoffice/agent-runtime-protocol'
import {
  parseMutationGrantProjection,
  parseSubagentRunProjection,
} from '@genoffice/agent-runtime-protocol'
import {
  parsePlatformToolDetails,
  type PlatformToolDetails,
} from '@genoffice/agent-runtime-protocol/platform-tool-catalog'

export type AgentPanelTool = {
  toolCallId: string
  toolName: string
  state: 'requested' | 'running' | 'completed' | 'failed' | 'aborted'
  details?: PlatformToolDetails
}

export type AgentSessionProjection = {
  sessionId: string
  documentId: string
  messages: SessionMessageProjection[]
  thinking?: { text: string; streaming: boolean }
  tools: AgentPanelTool[]
  subagents: SubagentRunProjection[]
  mutationGrants: MutationGrantProjection[]
  compaction?: {
    state: 'running' | 'completed' | 'failed'
    tokensBefore?: number
    estimatedTokensAfter?: number
  }
  branch?: {
    state: 'created' | 'navigated'
    branchId?: string
    parentEntryId?: string
    activeLeafId?: string
  }
  error?: {
    code: string
    diagnosticId?: string
  }
  activeRun?: {
    runId: string
    state: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  }
  rollbackRunId?: string
  lastSequence: number
  cursor: string
  recentEventIds: string[]
}

const EVENT_DEDUPE_WINDOW = 128

function lastAssistantIndex(messages: SessionMessageProjection[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index
  }
  return -1
}

function payloadString(event: EventEnvelope, key: string): string | undefined {
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function payloadNumber(event: EventEnvelope, key: string): number | undefined {
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function runState(
  event: EventEnvelope,
): NonNullable<AgentSessionProjection['activeRun']>['state'] | undefined {
  if (event.type === 'run.queued') return 'queued'
  if (event.type === 'run.started') return 'running'
  if (event.type === 'run.cancelling') return 'cancelling'
  if (event.type === 'run.completed') return 'completed'
  if (event.type === 'run.failed') return 'failed'
  if (event.type === 'run.aborted') return 'aborted'
  if (event.type === 'run.interrupted') return 'interrupted'
  return undefined
}

function toolState(event: EventEnvelope): AgentPanelTool['state'] | undefined {
  if (event.type === 'tool.requested') return 'requested'
  if (event.type === 'tool.started') return 'running'
  if (event.type === 'tool.completed') return 'completed'
  if (event.type === 'tool.failed') return 'failed'
  if (event.type === 'tool.aborted') return 'aborted'
  return undefined
}

function subagentProjection(event: EventEnvelope): SubagentRunProjection | undefined {
  if (!event.type.startsWith('subagent.')) return undefined
  try {
    return parseSubagentRunProjection(event.payload)
  } catch {
    return undefined
  }
}

function mutationGrantProjection(event: EventEnvelope): MutationGrantProjection | undefined {
  if (event.type !== 'mutation-grant.updated') return undefined
  try {
    return parseMutationGrantProjection(event.payload)
  } catch {
    return undefined
  }
}

function platformToolDetails(event: EventEnvelope): PlatformToolDetails | undefined {
  if (event.type !== 'tool.completed') return undefined
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  try {
    return parsePlatformToolDetails((payload as { platformTool?: unknown }).platformTool)
  } catch {
    return undefined
  }
}

export function createAgentSessionProjection(snapshot: SessionSnapshot): AgentSessionProjection {
  return {
    sessionId: snapshot.sessionId,
    documentId: snapshot.documentId,
    messages: structuredClone(snapshot.messages),
    tools: [],
    subagents: structuredClone(snapshot.subagents ?? []),
    mutationGrants: structuredClone(snapshot.mutationGrants ?? []),
    ...(snapshot.activeRun ? { activeRun: { ...snapshot.activeRun } } : {}),
    lastSequence: snapshot.lastSequence,
    cursor: snapshot.cursor,
    recentEventIds: [],
  }
}

export function restoreAgentSessionProjection(
  receipt: AgentSessionConnectReceipt,
): AgentSessionProjection {
  return receipt.events.reduce(
    applyAgentSessionEvent,
    createAgentSessionProjection(receipt.snapshot),
  )
}

export function applyAgentSessionEvent(
  projection: AgentSessionProjection,
  event: EventEnvelope,
): AgentSessionProjection {
  if (event.sessionId !== projection.sessionId || event.documentId !== projection.documentId) {
    throw new Error('session_event_binding_mismatch')
  }
  if (projection.recentEventIds.includes(event.eventId)) return projection
  if (event.sequence !== projection.lastSequence + 1) throw new Error('session_event_gap')

  const next: AgentSessionProjection = {
    ...projection,
    messages: [...projection.messages],
    tools: [...projection.tools],
    subagents: [...projection.subagents],
    mutationGrants: [...projection.mutationGrants],
    lastSequence: event.sequence,
    cursor: event.cursor,
    recentEventIds: [...projection.recentEventIds, event.eventId].slice(-EVENT_DEDUPE_WINDOW),
  }

  const nextRunState = runState(event)
  if (nextRunState) {
    const runId = event.runId ?? projection.activeRun?.runId
    if (runId) next.activeRun = { runId, state: nextRunState }
  }

  const nextSubagent = subagentProjection(event)
  if (nextSubagent) {
    const index = next.subagents.findIndex((candidate) => candidate.runId === nextSubagent.runId)
    if (index === -1) next.subagents.push(nextSubagent)
    else next.subagents[index] = nextSubagent
  }

  if (event.type === 'tool.completed' && payloadString(event, 'mutationOutcome') === 'committed') {
    if (event.runId) next.rollbackRunId = event.runId
  }

  const nextGrant = mutationGrantProjection(event)
  if (nextGrant) {
    const index = next.mutationGrants.findIndex(
      (candidate) => candidate.requestId === nextGrant.requestId,
    )
    if (index === -1) next.mutationGrants.push(nextGrant)
    else next.mutationGrants[index] = nextGrant
  }

  if (event.type === 'message.started') {
    const role = payloadString(event, 'role') === 'user' ? 'user' : 'assistant'
    next.messages.push({
      id: payloadString(event, 'messageId') ?? event.eventId,
      role,
      text: role === 'user' ? (payloadString(event, 'text') ?? '') : '',
    })
  } else if (event.type === 'message.delta') {
    const text = payloadString(event, 'text') ?? ''
    const index = lastAssistantIndex(next.messages)
    if (index === -1) {
      next.messages.push({ id: event.eventId, role: 'assistant', text })
    } else {
      next.messages[index] = {
        ...next.messages[index]!,
        text: `${next.messages[index]!.text}${text}`,
      }
    }
  } else if (event.type === 'thinking.started') {
    next.thinking = { text: '', streaming: true }
  } else if (event.type === 'thinking.delta') {
    next.thinking = {
      text: `${projection.thinking?.text ?? ''}${payloadString(event, 'text') ?? ''}`,
      streaming: true,
    }
  } else if (event.type === 'thinking.completed') {
    next.thinking = { text: projection.thinking?.text ?? '', streaming: false }
  }

  if (event.type === 'compaction.started') {
    next.compaction = { state: 'running' }
  } else if (event.type === 'compaction.completed') {
    const tokensBefore = payloadNumber(event, 'tokensBefore')
    const estimatedTokensAfter = payloadNumber(event, 'estimatedTokensAfter')
    next.compaction = {
      state: 'completed',
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
    }
  } else if (event.type === 'compaction.failed') {
    next.compaction = { state: 'failed' }
  }

  if (event.type === 'branch.created' || event.type === 'branch.navigated') {
    const branchId = payloadString(event, 'branchId')
    const parentEntryId = payloadString(event, 'parentEntryId')
    const activeLeafId = payloadString(event, 'activeLeafId')
    next.branch = {
      state: event.type === 'branch.created' ? 'created' : 'navigated',
      ...(branchId ? { branchId } : {}),
      ...(parentEntryId ? { parentEntryId } : {}),
      ...(activeLeafId ? { activeLeafId } : {}),
    }
  }

  if (
    event.type === 'run.failed' ||
    event.type === 'compaction.failed' ||
    event.type === 'diagnostic.available' ||
    event.type === 'runtime.degraded'
  ) {
    const code =
      payloadString(event, 'code') ?? payloadString(event, 'reason') ?? event.type.replace('.', '_')
    const diagnosticId = payloadString(event, 'diagnosticId')
    next.error = { code, ...(diagnosticId ? { diagnosticId } : {}) }
  }

  const nextToolState = toolState(event)
  if (nextToolState) {
    const details = platformToolDetails(event)
    const toolCallId = payloadString(event, 'toolCallId')
    if (toolCallId) {
      const index = next.tools.findIndex((tool) => tool.toolCallId === toolCallId)
      if (index === -1) {
        if (nextToolState === 'requested' || nextToolState === 'running') {
          next.tools.push({
            toolCallId,
            toolName: payloadString(event, 'toolName') ?? 'tool',
            state: nextToolState,
          })
        }
      } else {
        const toolName = payloadString(event, 'toolName')
        next.tools[index] = {
          ...next.tools[index]!,
          ...(toolName ? { toolName } : {}),
          ...(details ? { details } : {}),
          state: nextToolState,
        }
      }
    }
  }

  return next
}
