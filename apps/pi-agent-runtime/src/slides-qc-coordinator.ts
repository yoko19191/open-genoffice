import { randomUUID } from 'node:crypto'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import type {
  OfficeToolInvocation,
  OfficeToolReceipt,
  MutationGrantProjection,
} from '@genoffice/agent-runtime-protocol'
import type { SubagentRunProjection } from './subagent-run-registry'

export const SLIDES_QC_READ_TOOL_ID = 'office:slides:read_slide'
export const SLIDES_QC_MUTATION_TOOL_ID = 'office:slides:execute_slide_script'
export const SLIDES_QC_MAX_REPAIR_ROUNDS = 2

type PermissionSnapshot = OfficeToolInvocation['permissionSnapshot']

export type SlidesQcReport = {
  slideIndex: number
  issues: string[]
  repairRounds: number
}

export type SlidesQcResult = {
  runId: string
  status: 'awaiting_grant' | 'completed' | 'denied' | 'failed'
  reports: SlidesQcReport[]
  grantRequest?: MutationGrantProjection
  errorCode?: SlidesQcCoordinatorErrorCode
}

export type SlidesQcCoordinatorErrorCode =
  | 'slides_qc_request_invalid'
  | 'slides_qc_not_authorized'
  | 'slides_qc_run_active'
  | 'slides_qc_run_not_found'
  | 'slides_qc_grant_denied'
  | 'slides_qc_plan_invalid'
  | 'slides_qc_cancelled'
  | 'slides_qc_read_failed'
  | 'slides_qc_mutation_failed'
  | 'slides_qc_hard_gate_failed'

export class SlidesQcCoordinatorError extends Error {
  constructor(readonly code: SlidesQcCoordinatorErrorCode) {
    super(code)
    this.name = 'SlidesQcCoordinatorError'
  }
}

export type BeginSlidesQcSubagentRequest = {
  profile: 'slides-qc'
  role: 'Slides QC'
  parentRunId: string
  parentSessionId: string
  documentId: string
  parentSnapshot: CapabilitySnapshot
}

export type NamedSlidesQcSubagent = {
  run: SubagentRunProjection
  permissionSnapshot: PermissionSnapshot
}

export type SlidesQcCoordinatorOptions = {
  subagents: {
    beginNamed(input: BeginSlidesQcSubagentRequest): Promise<NamedSlidesQcSubagent>
    completeNamed(runId: string, result: string): Promise<void>
    failNamed(runId: string, errorCode: string): Promise<void>
    authorizeTool(
      runId: string,
      canonicalToolId: string,
    ): {
      actorId: string
      runId: string
      documentId: string
      toolId: string
    }
    requestMutationGrant(
      runId: string,
      exactToolIds: readonly string[],
    ): Promise<MutationGrantProjection>
    authorizeMutationTool(
      runId: string,
      canonicalToolId: string,
      mutationGrantId: string,
    ): Promise<{
      actorId: string
      runId: string
      documentId: string
      toolId: string
      mutationGrantId: string
    }>
  }
  officeTools: {
    invoke(input: OfficeToolInvocation, signal?: AbortSignal): Promise<OfficeToolReceipt>
  }
  planRepairs(
    input: {
      runId: string
      slideIndex: number
      inventory: string
      issues: readonly string[]
      maxRounds: typeof SLIDES_QC_MAX_REPAIR_ROUNDS
    },
    signal?: AbortSignal,
  ): Promise<readonly string[]>
  randomUUID?: () => string
}

type PageState = {
  slideIndex: number
  inventory: string
  issues: string[]
  contextVersion: string
  scripts: string[]
  repairRounds: number
}

type QcState = {
  run: SubagentRunProjection
  permissionSnapshot: PermissionSnapshot
  pages: PageState[]
  nextToolOrder: number
  status: 'awaiting_grant'
  grantRequestId?: string
  settlement?: {
    promise: Promise<SlidesQcResult>
    resolve: (result: SlidesQcResult) => void
  }
}

const MAX_PAGES = 256
const MAX_SCRIPT_CHARS = 25_000

function activeKey(parentRunId: string, documentId: string): string {
  return `${parentRunId}:${documentId}`
}

function auditIssues(receipt: OfficeToolReceipt): string[] | undefined {
  if (!receipt.details || typeof receipt.details !== 'object' || Array.isArray(receipt.details)) {
    return undefined
  }
  const value = (receipt.details as { auditIssues?: unknown }).auditIssues
  if (!Array.isArray(value) || !value.every((issue) => typeof issue === 'string')) return undefined
  return value.slice(0, 64)
}

function scripts(values: readonly string[]): string[] {
  if (
    values.length > SLIDES_QC_MAX_REPAIR_ROUNDS ||
    values.some(
      (value) =>
        typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SCRIPT_CHARS,
    )
  ) {
    throw new SlidesQcCoordinatorError('slides_qc_plan_invalid')
  }
  return values.map((value) => value.trim())
}

function reports(state: QcState): SlidesQcReport[] {
  return state.pages.map(({ slideIndex, issues, repairRounds }) => ({
    slideIndex,
    issues: [...issues],
    repairRounds,
  }))
}

function settlement(): NonNullable<QcState['settlement']> {
  let resolve!: (result: SlidesQcResult) => void
  const promise = new Promise<SlidesQcResult>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

export class SlidesQcCoordinator {
  private readonly randomUUID: () => string
  private readonly states = new Map<string, QcState>()
  private readonly activeRuns = new Map<string, string>()

  constructor(private readonly options: SlidesQcCoordinatorOptions) {
    this.randomUUID = options.randomUUID ?? randomUUID
  }

  async start(input: {
    parentRunId: string
    parentSessionId: string
    documentId: string
    parentSnapshot: CapabilitySnapshot
    slideIndexes: readonly number[]
    signal?: AbortSignal
    onRunStarted?: (run: SubagentRunProjection) => void
  }): Promise<SlidesQcResult> {
    this.validateStart(input)
    const key = activeKey(input.parentRunId, input.documentId)
    if (this.activeRuns.has(key)) throw new SlidesQcCoordinatorError('slides_qc_run_active')

    const named = await this.options.subagents.beginNamed({
      profile: 'slides-qc',
      role: 'Slides QC',
      parentRunId: input.parentRunId,
      parentSessionId: input.parentSessionId,
      documentId: input.documentId,
      parentSnapshot: input.parentSnapshot,
    })
    const state: QcState = {
      run: named.run,
      permissionSnapshot: structuredClone(named.permissionSnapshot),
      pages: [],
      nextToolOrder: 0,
      status: 'awaiting_grant',
    }
    this.states.set(named.run.runId, state)
    this.activeRuns.set(key, named.run.runId)
    input.onRunStarted?.(named.run)

    try {
      if (input.signal?.aborted) throw new SlidesQcCoordinatorError('slides_qc_cancelled')
      for (const slideIndex of [...input.slideIndexes].sort((left, right) => left - right)) {
        const page = await this.readPage(state, slideIndex, input.signal)
        page.scripts =
          page.issues.length === 0
            ? []
            : scripts(
                await this.options.planRepairs(
                  {
                    runId: named.run.runId,
                    slideIndex,
                    inventory: page.inventory,
                    issues: page.issues,
                    maxRounds: SLIDES_QC_MAX_REPAIR_ROUNDS,
                  },
                  input.signal,
                ),
              )
        state.pages.push(page)
      }

      if (state.pages.every((page) => page.scripts.length === 0)) {
        if (state.pages.some((page) => page.issues.length > 0)) {
          return await this.fail(state, 'slides_qc_hard_gate_failed')
        }
        await this.options.subagents.completeNamed(
          named.run.runId,
          'Deterministic Slides QC completed; no visual auto-fix was proposed.',
        )
        return this.finish(state, {
          runId: named.run.runId,
          status: 'completed',
          reports: reports(state),
        })
      }

      const grantRequest = await this.options.subagents.requestMutationGrant(named.run.runId, [
        SLIDES_QC_MUTATION_TOOL_ID,
      ])
      state.grantRequestId = grantRequest.requestId
      state.settlement = settlement()
      return {
        runId: named.run.runId,
        status: 'awaiting_grant',
        reports: reports(state),
        grantRequest,
      }
    } catch (error) {
      const code = input.signal?.aborted
        ? 'slides_qc_cancelled'
        : error instanceof SlidesQcCoordinatorError
          ? error.code
          : 'slides_qc_read_failed'
      await this.options.subagents.failNamed(named.run.runId, code)
      this.finish(state)
      throw new SlidesQcCoordinatorError(code)
    }
  }

  async deny(runId: string): Promise<SlidesQcResult> {
    const state = this.require(runId)
    await this.options.subagents.completeNamed(
      runId,
      'Deterministic Slides QC completed. Visual auto-fix was not authorized; zero mutations were dispatched.',
    )
    return this.finish(state, { runId, status: 'denied', reports: reports(state) })
  }

  wait(runId: string): Promise<SlidesQcResult> {
    const state = this.require(runId)
    if (!state.settlement) throw new SlidesQcCoordinatorError('slides_qc_run_not_found')
    return state.settlement.promise
  }

  cancel(runId: string): SlidesQcResult | undefined {
    const state = this.states.get(runId)
    if (!state) return undefined
    return this.finish(state, {
      runId,
      status: 'failed',
      reports: reports(state),
      errorCode: 'slides_qc_cancelled',
    })
  }

  async handleGrantProjection(
    projection: MutationGrantProjection,
  ): Promise<SlidesQcResult | undefined> {
    const state = this.states.get(projection.subagentRunId)
    if (
      !state ||
      state.grantRequestId !== projection.requestId ||
      projection.status === 'pending'
    ) {
      return undefined
    }
    if (projection.status === 'active') {
      if (!projection.grantId) return await this.fail(state, 'slides_qc_grant_denied')
      return this.apply(projection.subagentRunId, projection.grantId)
    }
    if (projection.status === 'denied') return this.deny(projection.subagentRunId)
    return this.fail(state, 'slides_qc_grant_denied')
  }

  async apply(runId: string, mutationGrantId: string): Promise<SlidesQcResult> {
    const state = this.require(runId)
    try {
      for (const page of state.pages) {
        for (const code of page.scripts) {
          let authorized
          try {
            authorized = await this.options.subagents.authorizeMutationTool(
              runId,
              SLIDES_QC_MUTATION_TOOL_ID,
              mutationGrantId,
            )
          } catch {
            throw new SlidesQcCoordinatorError('slides_qc_grant_denied')
          }
          const receipt = await this.options.officeTools.invoke({
            operationId: this.randomUUID(),
            sessionId: state.run.parentSessionId,
            documentId: state.run.documentId,
            runId,
            toolCallId: this.randomUUID(),
            toolId: SLIDES_QC_MUTATION_TOOL_ID,
            toolOrder: state.nextToolOrder++,
            contextVersion: page.contextVersion,
            actor: {
              type: 'subagent',
              actorId: authorized.actorId,
              subagentRunId: runId,
              parentRunId: state.run.parentRunId,
            },
            mutationGrantId: authorized.mutationGrantId,
            permissionSnapshot: structuredClone(state.permissionSnapshot),
            input: { slideIndex: page.slideIndex, code },
          })
          if (receipt.status !== 'completed' || receipt.mutationOutcome !== 'committed') {
            return await this.fail(state, 'slides_qc_mutation_failed')
          }
          page.repairRounds += 1
          const audited = await this.readPage(state, page.slideIndex)
          page.inventory = audited.inventory
          page.issues = audited.issues
          page.contextVersion = audited.contextVersion
          if (page.issues.length === 0) break
        }
        if (page.issues.length > 0) {
          return await this.fail(state, 'slides_qc_hard_gate_failed')
        }
      }
      await this.options.subagents.completeNamed(
        runId,
        `Slides QC completed with ${String(state.pages.reduce((sum, page) => sum + page.repairRounds, 0))} repair round(s).`,
      )
      return this.finish(state, { runId, status: 'completed', reports: reports(state) })
    } catch (error) {
      const code =
        error instanceof SlidesQcCoordinatorError ? error.code : 'slides_qc_mutation_failed'
      await this.options.subagents.failNamed(runId, code)
      const normalized =
        error instanceof SlidesQcCoordinatorError
          ? error
          : new SlidesQcCoordinatorError('slides_qc_mutation_failed')
      this.finish(state, {
        runId,
        status: 'failed',
        reports: reports(state),
        errorCode: normalized.code,
      })
      throw normalized
    }
  }

  private async readPage(
    state: QcState,
    slideIndex: number,
    signal?: AbortSignal,
  ): Promise<PageState> {
    const authorized = this.options.subagents.authorizeTool(state.run.runId, SLIDES_QC_READ_TOOL_ID)
    const receipt = await this.options.officeTools.invoke(
      {
        operationId: this.randomUUID(),
        sessionId: state.run.parentSessionId,
        documentId: state.run.documentId,
        runId: state.run.runId,
        toolCallId: this.randomUUID(),
        toolId: SLIDES_QC_READ_TOOL_ID,
        toolOrder: state.nextToolOrder++,
        actor: {
          type: 'subagent',
          actorId: authorized.actorId,
          subagentRunId: state.run.runId,
          parentRunId: state.run.parentRunId,
        },
        permissionSnapshot: structuredClone(state.permissionSnapshot),
        input: { slideIndex },
      },
      signal,
    )
    const issues = auditIssues(receipt)
    if (receipt.status !== 'completed' || !receipt.contextVersionAfter || !issues) {
      throw new SlidesQcCoordinatorError('slides_qc_read_failed')
    }
    return {
      slideIndex,
      inventory: receipt.output,
      issues,
      contextVersion: receipt.contextVersionAfter,
      scripts: [],
      repairRounds: 0,
    }
  }

  private validateStart(input: {
    parentRunId: string
    documentId: string
    parentSnapshot: CapabilitySnapshot
    slideIndexes: readonly number[]
  }): void {
    if (
      input.parentSnapshot.createdForRunId !== input.parentRunId ||
      input.slideIndexes.length === 0 ||
      input.slideIndexes.length > MAX_PAGES ||
      new Set(input.slideIndexes).size !== input.slideIndexes.length ||
      input.slideIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    ) {
      throw new SlidesQcCoordinatorError('slides_qc_request_invalid')
    }
    if (
      !input.parentSnapshot.toolIds.includes(SLIDES_QC_READ_TOOL_ID) ||
      !input.parentSnapshot.toolIds.includes(SLIDES_QC_MUTATION_TOOL_ID)
    ) {
      throw new SlidesQcCoordinatorError('slides_qc_not_authorized')
    }
  }

  private require(runId: string): QcState {
    const state = this.states.get(runId)
    if (!state) throw new SlidesQcCoordinatorError('slides_qc_run_not_found')
    return state
  }

  private async fail(
    state: QcState,
    errorCode: Extract<
      SlidesQcCoordinatorErrorCode,
      'slides_qc_mutation_failed' | 'slides_qc_hard_gate_failed' | 'slides_qc_grant_denied'
    >,
  ): Promise<SlidesQcResult> {
    await this.options.subagents.failNamed(state.run.runId, errorCode)
    return this.finish(state, {
      runId: state.run.runId,
      status: 'failed',
      reports: reports(state),
      errorCode,
    })
  }

  private finish<T extends SlidesQcResult | undefined>(state: QcState, result?: T): T {
    this.states.delete(state.run.runId)
    this.activeRuns.delete(activeKey(state.run.parentRunId, state.run.documentId))
    if (result) state.settlement?.resolve(result)
    return result as T
  }
}
