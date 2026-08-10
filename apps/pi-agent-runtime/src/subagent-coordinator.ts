import { randomUUID } from 'node:crypto'
import { createCapabilitySnapshot, type CapabilitySnapshot } from '@genoffice/agent-resource'
import {
  DEFAULT_SUBAGENT_ROOT_BUDGET,
  SubagentRunRegistry,
  SubagentRunRegistryError,
  type SubagentRegistryEvent,
  type SubagentResult,
  type SubagentRootBudget,
  type SubagentRunProjection,
  type SubagentUsage,
} from './subagent-run-registry'

export type SubagentToolDescriptor = {
  canonicalToolId: string
  modelAlias: string
  effect: 'read' | 'mutation' | 'external' | 'orchestration'
}

export type SubagentExecutionContext = {
  officeContext?: unknown
  resourceTexts: readonly string[]
}

export type SubagentEngineInput = {
  runId: string
  rootRunId: string
  parentRunId: string
  parentSessionId: string
  sessionId: string
  documentId: string
  role: string
  task: string
  attempt: number
  correlationId: string
  model: { providerId: string; modelId: string }
  tools: readonly SubagentToolDescriptor[]
  capabilitySnapshot: CapabilitySnapshot
  officeContext?: unknown
  resourceTexts: readonly string[]
  timeoutMs: number
  signal: AbortSignal
}

export type SubagentEngineEvent =
  | { type: 'assistant.delta'; text: string; raw?: unknown }
  | { type: 'tool.started'; toolId: string; raw?: unknown }
  | { type: 'tool.completed'; toolId: string; raw?: unknown }
  | { type: 'usage'; usage: Partial<SubagentUsage>; raw?: unknown }
  | { type: 'waiting'; raw?: unknown }
  | { type: 'running'; raw?: unknown }
  | { type: 'completed'; result: SubagentResult; raw?: unknown }
  | { type: 'failed'; errorCode: string; raw?: unknown }
  | { type: 'cancelled'; raw?: unknown }

export type SubagentEngineHandle = {
  providerRunId: string
  providerAttemptId: string
  events: AsyncIterable<SubagentEngineEvent>
  cancel: (reason: string) => Promise<void>
}

export interface SubagentExecutionEngine {
  spawn(input: SubagentEngineInput): Promise<SubagentEngineHandle>
  reconcile(input: {
    providerRunId: string
    providerAttemptId?: string
  }): Promise<
    | { status: 'completed'; result: SubagentResult; usage?: Partial<SubagentUsage> }
    | { status: 'failed'; errorCode?: string }
    | { status: 'cancelled' }
    | { status: 'resumable' }
    | { status: 'unknown' }
  >
}

export type SpawnSubagentRequest = {
  parentRunId: string
  parentSessionId: string
  documentId: string
  role: string
  task: string
  parentSnapshot: CapabilitySnapshot
  requestedTools?: readonly string[]
  projectRoot?: string
}

export type SubagentCoordinatorEvent =
  | {
      type: SubagentRegistryEvent['type']
      run: SubagentRunProjection
    }
  | {
      type: 'assistant.delta' | 'tool.started' | 'tool.completed'
      runId: string
      rootRunId: string
      parentRunId: string
      parentSessionId: string
      documentId: string
      text?: string
      toolId?: string
    }

export type SubagentCoordinatorOptions = {
  registry: SubagentRunRegistry
  engine: SubagentExecutionEngine
  randomUUID?: () => string
  budget?: SubagentRootBudget
  authorizeSnapshot: (snapshot: CapabilitySnapshot, projectRoot?: string) => Promise<void>
  resolveTool: (canonicalToolId: string) => SubagentToolDescriptor | undefined
  resolveContext: (input: {
    runId: string
    parentRunId: string
    parentSessionId: string
    documentId: string
    parentSnapshot: CapabilitySnapshot
    projectRoot?: string
  }) => Promise<SubagentExecutionContext>
}

export type SubagentCoordinatorErrorCode =
  | 'subagent_request_invalid'
  | 'subagent_parent_invalid'
  | 'subagent_document_mismatch'
  | 'subagent_mutation_forbidden'
  | 'subagent_tool_not_authorized'
  | 'subagent_not_resumable'
  | 'subagent_engine_failed'

export class SubagentCoordinatorError extends Error {
  constructor(readonly code: SubagentCoordinatorErrorCode) {
    super(code)
    this.name = 'SubagentCoordinatorError'
  }
}

type ActiveExecution = {
  generation: number
  handle: SubagentEngineHandle
  completion: Promise<void>
  timer?: NodeJS.Timeout
}

const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/
const TERMINAL_EVENTS = new Set<SubagentEngineEvent['type']>(['completed', 'failed', 'cancelled'])

function safeErrorCode(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : 'subagent_provider_failed'
}

export class SubagentCoordinator {
  private readonly registry: SubagentRunRegistry
  private readonly engine: SubagentExecutionEngine
  private readonly randomUUID: () => string
  private readonly budget: SubagentRootBudget
  private readonly listeners = new Set<(event: SubagentCoordinatorEvent) => void>()
  private readonly executions = new Map<string, ActiveExecution>()
  private generation = 1
  private readonly unsubscribeRegistry: () => void

  constructor(private readonly options: SubagentCoordinatorOptions) {
    this.registry = options.registry
    this.engine = options.engine
    this.randomUUID = options.randomUUID ?? randomUUID
    this.budget = structuredClone(options.budget ?? DEFAULT_SUBAGENT_ROOT_BUDGET)
    this.unsubscribeRegistry = this.registry.onEvent((event) => {
      this.emit({ type: event.type, run: event.projection })
    })
  }

  onEvent(listener: (event: SubagentCoordinatorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listForSession(parentSessionId: string): SubagentRunProjection[] {
    return this.registry.listForSession(parentSessionId)
  }

  parentSessionIdsWithRuns(): string[] {
    return [...new Set(this.registry.activeRuns().map((record) => record.parentSessionId))].sort()
  }

  async spawn(request: SpawnSubagentRequest): Promise<SubagentRunProjection> {
    this.validateRequest(request)
    const parent = this.registry.getInternal(request.parentRunId)
    if (
      parent &&
      (parent.parentSessionId !== request.parentSessionId ||
        parent.documentId !== request.documentId)
    ) {
      throw new SubagentCoordinatorError('subagent_document_mismatch')
    }
    const rootRunId = parent?.rootRunId ?? request.parentRunId
    const runId = this.randomUUID()
    const depth = parent ? parent.depth + 1 : 1
    const tools = request.parentSnapshot.toolIds
      .map((toolId) => this.options.resolveTool(toolId))
      .filter((tool): tool is SubagentToolDescriptor => tool !== undefined)
      .filter(
        (tool) =>
          tool.effect === 'read' ||
          (tool.effect === 'orchestration' && depth < this.budget.maxDepth),
      )
      .sort((left, right) => left.canonicalToolId.localeCompare(right.canonicalToolId))
    const capabilitySnapshot = createCapabilitySnapshot({
      createdForRunId: runId,
      model: request.parentSnapshot.model,
      resources: Object.entries(request.parentSnapshot.resourceHashes).map(
        ([resourceKey, contentSha256]) => ({ resourceKey, contentSha256 }),
      ),
      toolIds: tools.map((tool) => tool.canonicalToolId),
      permissionVersion: request.parentSnapshot.permissionVersion,
    })
    await this.options.authorizeSnapshot(capabilitySnapshot, request.projectRoot)
    const context = await this.options.resolveContext({
      runId,
      parentRunId: request.parentRunId,
      parentSessionId: request.parentSessionId,
      documentId: request.documentId,
      parentSnapshot: request.parentSnapshot,
      ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    })
    const record = await this.registry.create({
      runId,
      rootRunId,
      parentRunId: request.parentRunId,
      parentSessionId: request.parentSessionId,
      documentId: request.documentId,
      role: request.role,
      model: request.parentSnapshot.model,
      budget: this.budget,
      capabilitySnapshot,
      ...(request.projectRoot ? { projectRoot: request.projectRoot } : {}),
    })
    await this.start(record.runId, request.task, tools, context)
    return this.requireProjection(record.runId)
  }

  authorizeTool(
    runId: string,
    canonicalToolId: string,
  ): {
    actorId: string
    runId: string
    documentId: string
    toolId: string
  } {
    const record = this.registry.getInternal(runId)
    if (!record) throw new SubagentCoordinatorError('subagent_parent_invalid')
    const descriptor = this.options.resolveTool(canonicalToolId)
    if (descriptor?.effect === 'mutation') {
      throw new SubagentCoordinatorError('subagent_mutation_forbidden')
    }
    if (
      !descriptor ||
      !record.capabilitySnapshot.toolIds.includes(canonicalToolId) ||
      (descriptor.effect !== 'read' && descriptor.effect !== 'orchestration')
    ) {
      throw new SubagentCoordinatorError('subagent_tool_not_authorized')
    }
    return {
      actorId: runId,
      runId,
      documentId: record.documentId,
      toolId: canonicalToolId,
    }
  }

  async cancelTree(parentRunId: string, reason: string): Promise<void> {
    const children = this.registry.listChildren(parentRunId)
    for (const child of children) await this.cancelTree(child.runId, reason)
    const execution = this.executions.get(parentRunId)
    const record = this.registry.getInternal(parentRunId)
    if (!record || !execution) return
    if (
      record.status !== 'queued' &&
      record.status !== 'running' &&
      record.status !== 'waiting' &&
      record.status !== 'cancelling'
    ) {
      return
    }
    if (record.status !== 'cancelling') await this.registry.beginCancelling(parentRunId, reason)
    await execution.handle.cancel(reason)
    await execution.completion
  }

  async wait(runId: string): Promise<void> {
    await this.executions.get(runId)?.completion
  }

  async reconcile(): Promise<void> {
    for (const record of this.registry.activeRuns()) {
      if (!record.providerRunId) {
        await this.registry.fail(record.runId, 'subagent_reconcile_failed')
        continue
      }
      await this.registry.beginReconcile(record.runId)
      let status: Awaited<ReturnType<SubagentExecutionEngine['reconcile']>>
      try {
        status = await this.engine.reconcile({
          providerRunId: record.providerRunId,
          ...(record.providerAttemptId ? { providerAttemptId: record.providerAttemptId } : {}),
        })
      } catch {
        status = { status: 'unknown' }
      }
      if (status.status === 'completed') {
        if (status.usage) {
          await this.registry.updateUsage(record.runId, status.usage, 'attempt-total')
        }
        await this.registry.complete(record.runId, { result: status.result })
      } else if (status.status === 'cancelled') {
        await this.registry.cancel(record.runId)
      } else if (status.status === 'failed') {
        await this.registry.fail(
          record.runId,
          safeErrorCode(status.errorCode ?? 'subagent_provider_failed'),
        )
      } else if (status.status === 'resumable') {
        await this.registry.markReconciled(record.runId, {
          resumable: true,
          errorCode: 'runtime_crash',
        })
      } else {
        await this.registry.markReconciled(record.runId, {
          resumable: false,
          errorCode: 'subagent_reconcile_failed',
        })
      }
    }
  }

  async resume(runId: string): Promise<SubagentRunProjection> {
    const before = this.registry.getInternal(runId)
    if (!before || before.status !== 'resumable') {
      throw new SubagentCoordinatorError('subagent_not_resumable')
    }
    await this.options.authorizeSnapshot(before.capabilitySnapshot, before.projectRoot)
    const context = await this.options.resolveContext({
      runId,
      parentRunId: before.parentRunId,
      parentSessionId: before.parentSessionId,
      documentId: before.documentId,
      parentSnapshot: before.capabilitySnapshot,
      ...(before.projectRoot ? { projectRoot: before.projectRoot } : {}),
    })
    await this.registry.beginResume(runId)
    const current = this.registry.getInternal(runId)!
    const tools = current.capabilitySnapshot.toolIds
      .map((toolId) => this.options.resolveTool(toolId))
      .filter((tool): tool is SubagentToolDescriptor => tool !== undefined)
      .filter((tool) => tool.effect === 'read' || tool.effect === 'orchestration')
    await this.start(
      runId,
      'Continue the interrupted subagent task from its durable child session.',
      tools,
      context,
    )
    return this.requireProjection(runId)
  }

  close(): void {
    this.unsubscribeRegistry()
    for (const execution of this.executions.values()) clearTimeout(execution.timer)
    this.executions.clear()
    this.listeners.clear()
  }

  /** Drops volatile handles after an unexpected Runtime exit; durable records remain reconcilable. */
  detachExecutionsAfterCrash(): void {
    this.generation += 1
    for (const execution of this.executions.values()) clearTimeout(execution.timer)
    this.executions.clear()
  }

  private async start(
    runId: string,
    task: string,
    tools: readonly SubagentToolDescriptor[],
    context: SubagentExecutionContext,
  ): Promise<void> {
    const record = this.registry.getInternal(runId)
    if (!record) throw new SubagentCoordinatorError('subagent_parent_invalid')
    const controller = new AbortController()
    let handle: SubagentEngineHandle
    try {
      handle = await this.engine.spawn({
        runId,
        rootRunId: record.rootRunId,
        parentRunId: record.parentRunId,
        parentSessionId: record.parentSessionId,
        sessionId: record.sessionId,
        documentId: record.documentId,
        role: record.role,
        task,
        attempt: record.attempt,
        correlationId: record.correlationId,
        model: record.model,
        tools,
        capabilitySnapshot: record.capabilitySnapshot,
        ...(context.officeContext === undefined ? {} : { officeContext: context.officeContext }),
        resourceTexts: context.resourceTexts,
        timeoutMs: record.budget.maxWallTimeMs,
        signal: controller.signal,
      })
    } catch {
      await this.registry.fail(runId, 'subagent_engine_failed')
      throw new SubagentCoordinatorError('subagent_engine_failed')
    }
    await this.registry.markStarted(runId, {
      providerRunId: handle.providerRunId,
      providerAttemptId: handle.providerAttemptId,
    })
    const generation = this.generation
    const timer = setTimeout(() => {
      void this.registry
        .assertWallTime(runId)
        .catch((error) =>
          error instanceof SubagentRunRegistryError
            ? this.cancelTree(record.rootRunId, error.code)
            : undefined,
        )
    }, record.budget.maxWallTimeMs + 1)
    timer.unref()
    const completion = this.consume(runId, handle, generation).finally(() => {
      clearTimeout(timer)
      if (this.executions.get(runId)?.generation === generation) this.executions.delete(runId)
    })
    this.executions.set(runId, { generation, handle, completion, timer })
  }

  private async consume(
    runId: string,
    handle: SubagentEngineHandle,
    generation: number,
  ): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (generation !== this.generation) return
        await this.consumeEvent(runId, event)
        if (TERMINAL_EVENTS.has(event.type)) return
      }
      if (generation === this.generation) {
        const current = this.registry.getInternal(runId)
        if (current && !['completed', 'failed', 'cancelled'].includes(current.status)) {
          await this.registry.fail(runId, 'subagent_provider_incomplete')
        }
      }
    } catch (error) {
      if (generation !== this.generation) return
      const current = this.registry.getInternal(runId)
      if (current && !['completed', 'failed', 'cancelled'].includes(current.status)) {
        await this.registry.fail(
          runId,
          error instanceof SubagentRunRegistryError ? error.code : 'subagent_provider_failed',
        )
      }
    }
  }

  private async consumeEvent(runId: string, event: SubagentEngineEvent): Promise<void> {
    const record = this.registry.getInternal(runId)
    if (!record) return
    if (event.type === 'usage') {
      try {
        await this.registry.updateUsage(runId, event.usage)
      } catch (error) {
        if (
          error instanceof SubagentRunRegistryError &&
          error.code.startsWith('subagent_budget_')
        ) {
          void this.cancelTree(record.rootRunId, error.code)
          return
        }
        throw error
      }
      return
    }
    if (event.type === 'waiting' || event.type === 'running') {
      await this.registry.markWaiting(runId, event.type === 'waiting')
      return
    }
    if (event.type === 'assistant.delta') {
      this.emit({
        type: 'assistant.delta',
        runId,
        rootRunId: record.rootRunId,
        parentRunId: record.parentRunId,
        parentSessionId: record.parentSessionId,
        documentId: record.documentId,
        text: event.text,
      })
      return
    }
    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      this.authorizeTool(runId, event.toolId)
      this.emit({
        type: event.type,
        runId,
        rootRunId: record.rootRunId,
        parentRunId: record.parentRunId,
        parentSessionId: record.parentSessionId,
        documentId: record.documentId,
        toolId: event.toolId,
      })
      return
    }
    if (event.type === 'completed') {
      await this.registry.complete(runId, { result: event.result })
    } else if (event.type === 'failed') {
      await this.registry.fail(runId, safeErrorCode(event.errorCode))
    } else {
      await this.registry.cancel(runId)
    }
  }

  private validateRequest(request: SpawnSubagentRequest): void {
    if (
      !ROLE_PATTERN.test(request.role) ||
      request.task.trim().length === 0 ||
      request.task.length > 64 * 1024 ||
      request.parentSnapshot.createdForRunId !== request.parentRunId
    ) {
      throw new SubagentCoordinatorError('subagent_request_invalid')
    }
  }

  private requireProjection(runId: string): SubagentRunProjection {
    const projection = this.registry.get(runId)
    if (!projection) throw new SubagentCoordinatorError('subagent_parent_invalid')
    return projection
  }

  private emit(event: SubagentCoordinatorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
