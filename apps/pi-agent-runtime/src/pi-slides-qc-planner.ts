import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { ControlledResourceLoader } from './controlled-resource-loader'

const SlidesQcPlanSchema = Type.Object(
  {
    scripts: Type.Array(Type.String({ minLength: 1, maxLength: 25_000 }), {
      maxItems: 2,
    }),
  },
  { additionalProperties: false },
)

const SLIDES_QC_SYSTEM_PROMPT = `You are the isolated GenOffice Slides layout QC planner.
Only correct the listed layout issues. Do not redesign, rewrite, add, or delete slide content.
Return exactly one JSON object with the shape {"scripts":["..."]} and no prose or extra fields.
Each item must be a restricted execute_slide_script body. Return at most two scripts.`

export type PiSlidesQcPlanInput = {
  runId: string
  slideIndex: number
  inventory: string
  issues: readonly string[]
  maxRounds: 2
}

export type PiSlidesQcPlannerOptions = {
  resourceHome: string
  agentDir: string
  modelRuntime: ModelRuntime
  resolveModel: () => Model<Api>
}

export type PiSlidesQcPlannerErrorCode = 'slides_qc_plan_aborted' | 'slides_qc_plan_invalid'

export class PiSlidesQcPlannerError extends Error {
  constructor(readonly code: PiSlidesQcPlannerErrorCode) {
    super(code)
    this.name = 'PiSlidesQcPlannerError'
  }
}

export class PiSlidesQcPlanner {
  constructor(private readonly options: PiSlidesQcPlannerOptions) {}

  async plan(
    input: PiSlidesQcPlanInput,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<string[]> {
    if (signal.aborted) throw new PiSlidesQcPlannerError('slides_qc_plan_aborted')

    const cwd = join(
      this.options.resourceHome,
      'state',
      'slides-qc',
      input.runId,
      String(input.slideIndex),
    )
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const settingsManager = SettingsManager.inMemory({
      defaultThinkingLevel: 'medium',
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 32 },
    })
    const resourceLoader = new ControlledResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      systemPrompt: SLIDES_QC_SYSTEM_PROMPT,
    })
    resourceLoader.configure({ skillPaths: [], promptPaths: [] })
    await resourceLoader.reload()
    const sessionManager = SessionManager.inMemory(cwd, {
      id: `slides-qc-${input.runId}-${input.slideIndex}`,
    })
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: this.options.modelRuntime,
      model: this.options.resolveModel(),
      thinkingLevel: 'medium',
      sessionManager,
      settingsManager,
      resourceLoader,
      noTools: 'all',
    })
    const abort = () => void session.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await session.prompt(
        JSON.stringify({
          task: 'repair_slide_layout',
          slideIndex: input.slideIndex,
          inventory: input.inventory,
          issues: input.issues,
          maxRounds: input.maxRounds,
        }),
        { expandPromptTemplates: false, source: 'rpc' },
      )
      if (signal.aborted) throw new PiSlidesQcPlannerError('slides_qc_plan_aborted')

      const assistant = [...session.state.messages]
        .reverse()
        .find((message) => message.role === 'assistant')!
      const text = assistant.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new PiSlidesQcPlannerError('slides_qc_plan_invalid')
      }
      if (!Value.Check(SlidesQcPlanSchema, value)) {
        throw new PiSlidesQcPlannerError('slides_qc_plan_invalid')
      }
      return value.scripts
    } catch {
      if (signal.aborted) throw new PiSlidesQcPlannerError('slides_qc_plan_aborted')
      throw new PiSlidesQcPlannerError('slides_qc_plan_invalid')
    } finally {
      signal.removeEventListener('abort', abort)
      session.dispose()
    }
  }
}
