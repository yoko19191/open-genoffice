import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiSubagentEngine } from '../src/pi-subagent-engine'
import type { SubagentEngineEvent, SubagentEngineInput } from '../src/subagent-coordinator'

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceHome = await mkdtemp(join(tmpdir(), 'open-genoffice-native-subagent-'))
const previousPath = process.env.PATH
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR
const previousRunIndexDirectory = process.env.PI_SUBAGENT_RUN_INDEX_DIR
const previousSmokeMode = process.env.GENOFFICE_PI_SMOKE
process.env.PATH = `${join(bundleRoot, 'node')}${delimiter}${previousPath ?? ''}`
process.env.PI_CODING_AGENT_DIR = join(resourceHome, 'state', 'subagent-pi-agent')
process.env.PI_SUBAGENT_RUN_INDEX_DIR = join(resourceHome, 'state', 'subagent-run-index')
process.env.GENOFFICE_PI_SMOKE = '1'

const input: SubagentEngineInput = {
  runId: '11111111-1111-4111-8111-111111111111',
  rootRunId: '22222222-2222-4222-8222-222222222222',
  parentRunId: '22222222-2222-4222-8222-222222222222',
  parentSessionId: '33333333-3333-4333-8333-333333333333',
  sessionId: '44444444-4444-4444-8444-444444444444',
  documentId: '55555555-5555-4555-8555-555555555555',
  role: 'packaged-runtime-smoke',
  task: 'Verify the packaged native Subagent path.',
  attempt: 1,
  correlationId: '66666666-6666-4666-8666-666666666666',
  model: { providerId: 'fixture-provider', modelId: 'fixture-model' },
  tools: [],
  capabilitySnapshot: {
    snapshotId: 'a'.repeat(64),
    createdForRunId: '11111111-1111-4111-8111-111111111111',
    model: {
      providerId: 'fixture-provider',
      modelId: 'fixture-model',
      capabilities: ['text-input', 'tool-use'],
    },
    resourceHashes: {},
    toolIds: [],
    permissionVersion: 'permission-v1',
  },
  resourceTexts: [],
  timeoutMs: 10_000,
  signal: new AbortController().signal,
}

async function collect(events: AsyncIterable<SubagentEngineEvent>): Promise<SubagentEngineEvent[]> {
  const collected: SubagentEngineEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

try {
  const engine = new PiSubagentEngine({ resourceHome, pollIntervalMs: 10 })
  const handle = await engine.spawn(input)
  const events = await collect(handle.events)
  const completed = events.find((event) => event.type === 'completed')
  if (completed?.type !== 'completed' || completed.result.text !== 'fixture child completed') {
    const attemptDirectory = join(
      resourceHome,
      'state',
      'subagent-engine',
      input.runId,
      'provider-runs',
      handle.providerRunId,
      'attempts',
      handle.providerAttemptId,
    )
    const [result, stderr, output, workerLog] = await Promise.all(
      ['result.json', 'stderr.log', 'output.log', 'worker.log'].map((name) =>
        readFile(join(attemptDirectory, name), 'utf8').catch(() => ''),
      ),
    )
    throw new Error(
      `native_subagent_smoke_incomplete:${JSON.stringify({
        events,
        result: result.slice(-4000),
        stderr: stderr.slice(-4000),
        output: output.slice(-4000),
        workerLog: workerLog.slice(-4000),
      })}`,
    )
  }
  const reconciled = await engine.reconcile({
    providerRunId: handle.providerRunId,
    providerAttemptId: handle.providerAttemptId,
  })
  if (reconciled.status !== 'completed' || reconciled.result.text !== 'fixture child completed') {
    throw new Error(`native_subagent_smoke_reconcile_failed:${JSON.stringify(reconciled)}`)
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      backend: 'headless',
      providerRunId: handle.providerRunId,
      result: completed.result.text,
      reconciled: reconciled.status,
    })}\n`,
  )
} finally {
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory
  if (previousRunIndexDirectory === undefined) delete process.env.PI_SUBAGENT_RUN_INDEX_DIR
  else process.env.PI_SUBAGENT_RUN_INDEX_DIR = previousRunIndexDirectory
  if (previousSmokeMode === undefined) delete process.env.GENOFFICE_PI_SMOKE
  else process.env.GENOFFICE_PI_SMOKE = previousSmokeMode
  await rm(resourceHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
