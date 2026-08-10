import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SubagentEngineEvent,
  SubagentEngineHandle,
  SubagentEngineInput,
  SubagentExecutionEngine,
} from './subagent-coordinator'
import type { SubagentResult, SubagentUsage } from './subagent-run-registry'

type PiSubagentApi = {
  runSubagent(options: unknown): Promise<unknown>
  getSubagentStatus(options: unknown): Promise<unknown>
  getSubagentLogs(options: unknown): Promise<unknown>
  interruptSubagent(options: unknown): Promise<unknown>
  reconcileSubagentRun(options: unknown): Promise<unknown>
}

export type PiSubagentEngineOptions = {
  resourceHome: string
  api?: PiSubagentApi
  pollIntervalMs?: number
  platform?: NodeJS.Platform
  killWindowsProcessTree?: (pid: number) => Promise<void>
}

const PI_SUBAGENT_API_SPECIFIER = '@agwab/pi-subagent/api'

async function loadDefaultApi(): Promise<PiSubagentApi> {
  const loaded = (await import(PI_SUBAGENT_API_SPECIFIER)) as Partial<PiSubagentApi>
  if (
    typeof loaded.runSubagent !== 'function' ||
    typeof loaded.getSubagentStatus !== 'function' ||
    typeof loaded.getSubagentLogs !== 'function' ||
    typeof loaded.interruptSubagent !== 'function' ||
    typeof loaded.reconcileSubagentRun !== 'function'
  ) {
    throw new Error('subagent_engine_invalid')
  }
  return loaded as PiSubagentApi
}

const MAX_RESULT_CHARS = 64 * 1024
const MAX_CONTEXT_CHARS = 128 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usageFrom(value: unknown): SubagentUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = finiteNonnegative(value.inputTokens ?? value.input) ?? 0
  const outputTokens = finiteNonnegative(value.outputTokens ?? value.output) ?? 0
  const costUsd = finiteNonnegative(value.costUsd ?? value.totalCost ?? value.cost) ?? 0
  const toolCalls = finiteNonnegative(value.toolCalls) ?? 0
  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0 && toolCalls === 0) return undefined
  return { inputTokens, outputTokens, costUsd, toolCalls }
}

function usageForStatus(status: unknown): SubagentUsage | undefined {
  if (!isRecord(status) || !isRecord(status.metadata)) return undefined
  return usageFrom(status.metadata.usage)
}

function sameUsage(left: SubagentUsage | undefined, right: SubagentUsage): boolean {
  return (
    left?.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.costUsd === right.costUsd &&
    left.toolCalls === right.toolCalls
  )
}

function usageDelta(previous: SubagentUsage | undefined, current: SubagentUsage): SubagentUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0)),
    costUsd: Math.max(0, current.costUsd - (previous?.costUsd ?? 0)),
    toolCalls: Math.max(0, current.toolCalls - (previous?.toolCalls ?? 0)),
  }
}

function terminalStatus(value: unknown): 'completed' | 'failed' | 'cancelled' | undefined {
  if (!isRecord(value)) return undefined
  return value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled'
    ? value.status
    : undefined
}

function resultText(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.logText)) return ''
  const output = nonempty(value.logText.output) ?? ''
  return output.slice(0, MAX_RESULT_CHARS)
}

function result(text: string): SubagentResult {
  return { kind: 'text', text }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function safeContext(input: SubagentEngineInput): string {
  let officeContext = ''
  if (input.officeContext !== undefined) {
    try {
      officeContext = JSON.stringify(input.officeContext)
    } catch {
      throw new Error('subagent_context_invalid')
    }
  }
  const resources = input.resourceTexts.join('\n\n---\n\n')
  const body = [
    `You are the read-only GenOffice Subagent assigned the role ${JSON.stringify(input.role)}.`,
    'You have an independent child context. Use only the explicitly enabled read-only tools. Never edit the Office document, change the user view, write project files, or create unmanaged agents.',
    officeContext ? `Granted Office Context:\n${officeContext}` : undefined,
    resources ? `Activated Skills and Prompts:\n${resources}` : undefined,
  ]
    .filter((section): section is string => section !== undefined)
    .join('\n\n')
  if (body.length > MAX_CONTEXT_CHARS) throw new Error('subagent_context_invalid')
  return body
}

function providerReference(value: unknown): { runId: string; attemptId: string } {
  if (!isRecord(value)) throw new Error('subagent_engine_invalid')
  const runId = nonempty(value.runId)
  const attemptId = nonempty(value.attemptId)
  if (!runId || !attemptId) throw new Error('subagent_engine_invalid')
  return { runId, attemptId }
}

function providerProcessId(status: unknown, attemptId: string): number | undefined {
  if (!isRecord(status) || !Array.isArray(status.attempts)) return undefined
  const attempt = status.attempts.find((value) => isRecord(value) && value.attemptId === attemptId)
  if (!isRecord(attempt)) return undefined
  const pid = attempt.pid
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export class PiSubagentEngine implements SubagentExecutionEngine {
  private readonly configuredApi: PiSubagentApi | undefined
  private apiPromise: Promise<PiSubagentApi> | undefined
  private readonly pollIntervalMs: number
  private readonly platform: NodeJS.Platform
  private readonly killWindowsTree: (pid: number) => Promise<void>

  constructor(private readonly options: PiSubagentEngineOptions) {
    this.configuredApi = options.api
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250)
    this.platform = options.platform ?? process.platform
    this.killWindowsTree = options.killWindowsProcessTree ?? killWindowsProcessTree
  }

  async spawn(input: SubagentEngineInput): Promise<SubagentEngineHandle> {
    const api = await this.api()
    const cwd = join(this.options.resourceHome, 'state', 'subagent-engine', input.runId)
    const runsDir = 'provider-runs'
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const started = await api.runSubagent({
      backend: 'headless',
      async: true,
      onComplete: 'detach',
      asyncDependency: 'needed-before-final',
      agentScope: 'global',
      confirmProjectAgents: true,
      cwd,
      runsDir,
      task: input.task,
      systemPrompt: safeContext(input),
      model: `${input.model.providerId}/${input.model.modelId}`,
      tools: [...new Set(input.tools.map((tool) => tool.modelAlias))].sort(),
      skills: [],
      extensions: [],
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    const provider = providerReference(started)
    const ref = { cwd, runsDir, runId: provider.runId, attemptId: provider.attemptId }
    const state = { cancelRequested: false }
    return {
      providerRunId: provider.runId,
      providerAttemptId: provider.attemptId,
      events: this.watch(api, ref, input.signal, state),
      cancel: async (reason) => {
        const status = await api.getSubagentStatus(ref).catch(() => undefined)
        const terminal = terminalStatus(status)
        state.cancelRequested = terminal !== 'completed' && terminal !== 'failed'
        let windowsTreeKill: Promise<void> | undefined
        if (this.platform === 'win32' && !terminal) {
          const pid = providerProcessId(status, provider.attemptId)
          if (pid) windowsTreeKill = this.killWindowsTree(pid)
        }
        await api.interruptSubagent({ ...ref, reason })
        await windowsTreeKill?.catch(() => undefined)
      },
    }
  }

  async reconcile(input: {
    providerRunId: string
    providerAttemptId?: string
  }): Promise<
    | { status: 'completed'; result: SubagentResult; usage?: Partial<SubagentUsage> }
    | { status: 'failed'; errorCode?: string }
    | { status: 'cancelled' }
    | { status: 'resumable' }
    | { status: 'unknown' }
  > {
    const api = await this.api()
    const ref = {
      runId: input.providerRunId,
      ...(input.providerAttemptId ? { attemptId: input.providerAttemptId } : {}),
    }
    let reconciled: unknown
    try {
      reconciled = await api.reconcileSubagentRun(ref)
    } catch {
      return { status: 'unknown' }
    }
    if (!isRecord(reconciled)) return { status: 'unknown' }
    if (reconciled.status === 'marked-stale') return { status: 'resumable' }
    if (reconciled.status === 'marked-cancelled') return { status: 'cancelled' }
    if (reconciled.status !== 'committed-result' && reconciled.status !== 'already-terminal') {
      return { status: 'unknown' }
    }
    let status: unknown
    try {
      status = await api.getSubagentStatus(ref)
    } catch {
      return { status: 'unknown' }
    }
    const terminal = terminalStatus(status)
    if (terminal === 'cancelled') return { status: 'cancelled' }
    if (terminal === 'failed' || !terminal)
      return { status: 'failed', errorCode: 'subagent_provider_failed' }
    const logs = await api.getSubagentLogs(ref).catch(() => undefined)
    const usage = usageForStatus(status)
    return {
      status: 'completed',
      result: result(resultText(logs)),
      ...(usage ? { usage } : {}),
    }
  }

  private async *watch(
    api: PiSubagentApi,
    ref: { cwd: string; runsDir: string; runId: string; attemptId: string },
    signal: AbortSignal,
    state: { cancelRequested: boolean },
  ): AsyncIterable<SubagentEngineEvent> {
    let previousUsage: SubagentUsage | undefined
    while (true) {
      if (signal.aborted) {
        yield { type: 'cancelled' }
        return
      }
      let status: unknown
      try {
        status = await api.getSubagentStatus(ref)
      } catch {
        yield state.cancelRequested
          ? { type: 'cancelled' }
          : { type: 'failed', errorCode: 'subagent_provider_failed' }
        return
      }
      if (status === null || !isRecord(status)) {
        yield state.cancelRequested
          ? { type: 'cancelled' }
          : { type: 'failed', errorCode: 'subagent_provider_failed' }
        return
      }
      const usage = usageForStatus(status)
      if (usage && !sameUsage(previousUsage, usage)) {
        const delta = usageDelta(previousUsage, usage)
        previousUsage = usage
        yield { type: 'usage', usage: delta }
      }
      const terminal = terminalStatus(status)
      if (terminal === 'completed') {
        const logs = await api.getSubagentLogs(ref).catch(() => undefined)
        yield { type: 'completed', result: result(resultText(logs)) }
        return
      }
      if (terminal === 'failed') {
        yield state.cancelRequested
          ? { type: 'cancelled' }
          : { type: 'failed', errorCode: 'subagent_provider_failed' }
        return
      }
      if (terminal === 'cancelled') {
        yield { type: 'cancelled' }
        return
      }
      await delay(this.pollIntervalMs)
    }
  }

  private api(): Promise<PiSubagentApi> {
    if (this.configuredApi) return Promise.resolve(this.configuredApi)
    this.apiPromise ??= loadDefaultApi()
    return this.apiPromise
  }
}
