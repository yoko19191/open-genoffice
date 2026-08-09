import type { EventEnvelope } from '@genoffice/agent-runtime-protocol'

export type RecoveredMutationOutcome = 'not_started' | 'committed' | 'rolled_back' | 'unknown'

export type RecoveredTool = {
  toolCallId: string
  toolName?: string
  mutationOutcome: RecoveredMutationOutcome
  terminalType: 'tool.completed' | 'tool.aborted' | 'tool.failed'
}

export type SessionRecoveryPlan = {
  runId: string
  reason: 'runtime_crash'
  documentNeedsReview: boolean
  tools: RecoveredTool[]
}

const ACTIVE_RUN_EVENTS = new Set<EventEnvelope['type']>([
  'run.queued',
  'run.started',
  'run.cancelling',
])
const TERMINAL_RUN_EVENTS = new Set<EventEnvelope['type']>([
  'run.completed',
  'run.failed',
  'run.aborted',
  'run.interrupted',
])
const TERMINAL_TOOL_EVENTS = new Set<EventEnvelope['type']>([
  'tool.completed',
  'tool.failed',
  'tool.aborted',
])
const MUTATION_OUTCOMES = new Set<RecoveredMutationOutcome>([
  'not_started',
  'committed',
  'rolled_back',
  'unknown',
])

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function startedOutcome(value: unknown): RecoveredMutationOutcome {
  return MUTATION_OUTCOMES.has(value as RecoveredMutationOutcome)
    ? (value as RecoveredMutationOutcome)
    : 'unknown'
}

function terminalType(mutationOutcome: RecoveredMutationOutcome): RecoveredTool['terminalType'] {
  if (mutationOutcome === 'committed') return 'tool.completed'
  if (mutationOutcome === 'unknown') return 'tool.failed'
  return 'tool.aborted'
}

export function planSessionRecovery(
  events: readonly EventEnvelope[],
): SessionRecoveryPlan | undefined {
  let runId: string | undefined
  const terminalRuns = new Set<string>()
  for (const event of events) {
    if (!event.runId) continue
    if (ACTIVE_RUN_EVENTS.has(event.type)) runId = event.runId
    if (TERMINAL_RUN_EVENTS.has(event.type)) terminalRuns.add(event.runId)
  }
  if (!runId || terminalRuns.has(runId)) return undefined

  const tools = new Map<string, RecoveredTool>()
  for (const event of events) {
    if (event.runId !== runId) continue
    const payload = Object(event.payload) as Record<string, unknown>
    const toolCallId = text(payload.toolCallId)
    if (!toolCallId) continue
    if (event.type === 'tool.requested') {
      const toolName = text(payload.toolName)
      tools.set(toolCallId, {
        toolCallId,
        ...(toolName ? { toolName } : {}),
        mutationOutcome: 'not_started',
        terminalType: 'tool.aborted',
      })
    } else if (event.type === 'tool.started') {
      const mutationOutcome = startedOutcome(payload.mutationOutcome)
      const toolName = text(payload.toolName)
      tools.set(toolCallId, {
        toolCallId,
        ...(toolName ? { toolName } : {}),
        mutationOutcome,
        terminalType: terminalType(mutationOutcome),
      })
    } else if (TERMINAL_TOOL_EVENTS.has(event.type)) {
      tools.delete(toolCallId)
    }
  }

  const pendingTools = [...tools.values()]
  return {
    runId,
    reason: 'runtime_crash',
    documentNeedsReview: pendingTools.some((tool) => tool.mutationOutcome === 'unknown'),
    tools: pendingTools,
  }
}
