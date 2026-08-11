import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { PiSlidesQcPlanner, PiSlidesQcPlannerError } from '../src/pi-slides-qc-planner'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { slow?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'genoffice-slides-qc-planner-'))
  roots.push(root)
  const resourceHome = join(root, 'resource-home')
  const agentDir = join(root, 'agent')
  await Promise.all([
    mkdir(resourceHome, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ])
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  })
  const provider = fauxProvider({
    api: 'genoffice-slides-qc-faux',
    provider: 'genoffice-slides-qc-faux',
    models: [{ id: 'qc-model', reasoning: false }],
    ...(options.slow ? { tokenSize: { min: 1, max: 1 }, tokensPerSecond: 1_000 } : {}),
  })
  modelRuntime.registerNativeProvider(provider.provider)
  const planner = new PiSlidesQcPlanner({
    resourceHome,
    agentDir,
    modelRuntime,
    resolveModel: () => provider.getModel(),
  })
  return { planner, provider }
}

const input = {
  runId: '11111111-1111-4111-8111-111111111111',
  slideIndex: 2,
  inventory: 'Canvas 1280x720\ntitle at (0,0)',
  issues: ['Overlap: title and body'],
  maxRounds: 2 as const,
}

describe('PiSlidesQcPlanner', () => {
  it('uses an isolated Pi AgentSession and returns at most two restricted scripts', async () => {
    const { planner, provider } = await fixture()
    provider.setResponses([
      fauxAssistantMessage(
        JSON.stringify({ scripts: ['moveBy("title",0,10)', 'resizeBy("body",0,20)'] }),
      ),
    ])
    await expect(planner.plan(input)).resolves.toEqual([
      'moveBy("title",0,10)',
      'resizeBy("body",0,20)',
    ])
  })

  it('fails closed on prose, unknown fields, oversized scripts and aborted work', async () => {
    for (const response of [
      'I would move the title.',
      JSON.stringify({ scripts: ['moveBy("title",0,10)'], extra: true }),
      JSON.stringify({ scripts: ['x'.repeat(25_001)] }),
    ]) {
      const { planner, provider } = await fixture()
      provider.setResponses([fauxAssistantMessage(response)])
      await expect(planner.plan(input)).rejects.toEqual(
        new PiSlidesQcPlannerError('slides_qc_plan_invalid'),
      )
    }

    const { planner } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(planner.plan(input, controller.signal)).rejects.toEqual(
      new PiSlidesQcPlannerError('slides_qc_plan_aborted'),
    )
  })

  it('aborts an in-flight Pi session and normalizes provider failures', async () => {
    const slow = await fixture({ slow: true })
    slow.provider.setResponses([
      fauxAssistantMessage(JSON.stringify({ scripts: ['x'.repeat(5_000)] })),
    ])
    const controller = new AbortController()
    const pending = slow.planner.plan(input, controller.signal)
    setTimeout(() => controller.abort(), 1_000)
    await expect(pending).rejects.toEqual(new PiSlidesQcPlannerError('slides_qc_plan_aborted'))

    const failed = await fixture()
    failed.provider.setResponses([])
    await expect(failed.planner.plan(input)).rejects.toEqual(
      new PiSlidesQcPlannerError('slides_qc_plan_invalid'),
    )

    const noText = await fixture()
    noText.provider.setResponses([fauxAssistantMessage([fauxThinking('layout reasoning')])])
    await expect(noText.planner.plan(input)).rejects.toEqual(
      new PiSlidesQcPlannerError('slides_qc_plan_invalid'),
    )
  }, 15_000)
})
