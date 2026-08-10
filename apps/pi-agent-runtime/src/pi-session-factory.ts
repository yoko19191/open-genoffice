import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type CredentialStore,
  type Api,
  type Model,
} from '@earendil-works/pi-ai'
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import type { CapabilitySnapshot } from '@genoffice/agent-resource'
import type { RunResourceService, RunModelMetadata } from './run-resource-service'
import { ControlledResourceLoader } from './controlled-resource-loader'
import { ResourceReadBoundary } from './resource-read-boundary'

export type PiPromptResult = {
  branchCreated?: {
    branchId: string
    parentEntryId: string
    activeLeafId: string
  }
}

export type PiSessionHandle = {
  session: AgentSession
  sessionManager: SessionManager
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
  prompt: (
    text: string,
    signal: AbortSignal,
    context?: { runId: string; projectRoot?: string },
  ) => Promise<PiPromptResult | undefined>
  abort: () => Promise<void>
  fork: (
    newSessionId: string,
    parentSessionId: string,
  ) => Promise<{ sessionId: string; sessionFile: string; activeLeafId: string }>
  navigate: (targetEntryId: string) => Promise<{ activeLeafId: string }>
  dispose: () => void
}

type CreatePiSessionBaseOptions = {
  cwd: string
  agentDir: string
  sessionDir: string
  sessionId: string
  sessionFile?: string
  documentId: string
  credentials?: CredentialStore
}

export type CreatePiSessionOptions = CreatePiSessionBaseOptions &
  (
    | {
        modelRuntime?: never
        initialModel?: never
        resolveModel?: never
      }
    | {
        modelRuntime: ModelRuntime
        initialModel: Model<Api>
        resolveModel: () => Model<Api>
        resolveModelMetadata: () => RunModelMetadata
        runResources: Pick<RunResourceService, 'prepare' | 'verify' | 'callMcpTool' | 'releaseRun'>
      }
  )

const contractProbe = defineTool({
  name: 'genoffice_contract_probe',
  label: 'GenOffice Contract Probe',
  description: 'Return a deterministic result for the offline Pi runtime contract.',
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    return {
      content: [{ type: 'text' as const, text: 'contract probe completed' }],
      details: { ok: true },
    }
  },
})

async function repairJsonlTail(path: string): Promise<void> {
  const content = await readFile(path)
  const lastNewline = content.lastIndexOf(0x0a)
  const completeLength = lastNewline + 1
  const complete = content.subarray(0, completeLength).toString('utf8')
  try {
    for (const line of complete.split('\n').filter(Boolean)) JSON.parse(line)
  } catch {
    throw new Error('session_jsonl_invalid')
  }
  if (completeLength === content.length) return
  if (lastNewline < 0) throw new Error('session_jsonl_invalid')

  const tail = content.subarray(completeLength).toString('utf8')
  let tailIsComplete: boolean
  try {
    JSON.parse(tail)
    tailIsComplete = true
  } catch {
    tailIsComplete = false
  }
  const handle = await open(path, 'r+')
  try {
    if (tailIsComplete) await handle.write('\n', content.length, 'utf8')
    else await handle.truncate(completeLength)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function createDeterministicPiSession(
  options: CreatePiSessionOptions,
): Promise<PiSessionHandle> {
  await Promise.all([
    mkdir(options.cwd, { recursive: true }),
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.sessionDir, { recursive: true }),
  ])

  const managedModel = options.modelRuntime !== undefined
  const modelRuntime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      credentials: options.credentials ?? new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    }))
  const fixtureProvider = managedModel
    ? undefined
    : fauxProvider({
        api: 'genoffice-faux',
        provider: 'genoffice-faux',
        models: [{ id: 'genoffice-faux-1', reasoning: true }],
        tokenSize: { min: 1, max: 1 },
        tokensPerSecond: 32,
      })
  if (fixtureProvider) modelRuntime.registerNativeProvider(fixtureProvider.provider)
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: 'medium',
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 32 },
  })
  let extensionExecution:
    { snapshot: CapabilitySnapshot; projectRoot?: string; runId: string } | undefined
  const resourceLoader = new ControlledResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPrompt: managedModel
      ? 'You are the GenOffice document assistant. Use only the capabilities provided for this session.'
      : 'You are the isolated GenOffice runtime contract agent.',
    ...(managedModel
      ? {
          authorizeExtensionTool: async (canonicalToolId: string) => {
            if (
              !extensionExecution ||
              !extensionExecution.snapshot.toolIds.includes(canonicalToolId)
            ) {
              throw new Error('extension_tool_not_authorized')
            }
            await options.runResources!.verify(
              extensionExecution.snapshot,
              extensionExecution.projectRoot,
            )
            return {
              toolId: canonicalToolId,
              actorId: options.sessionId,
              runId: extensionExecution.runId,
              documentId: options.documentId,
            }
          },
          executeMcpTool: async (tool, params, signal) => {
            if (
              !extensionExecution ||
              !extensionExecution.snapshot.toolIds.includes(tool.canonicalToolId)
            ) {
              throw new Error('tool_not_in_snapshot')
            }
            return options.runResources!.callMcpTool(tool.canonicalToolId, params, {
              actorId: options.sessionId,
              documentId: options.documentId,
              runId: extensionExecution.runId,
              signal,
            })
          },
        }
      : {}),
  })
  await resourceLoader.reload()
  const resourceReadBoundary = managedModel
    ? new ResourceReadBoundary({
        verify: (snapshot, projectRoot) => options.runResources.verify(snapshot, projectRoot),
      })
    : undefined
  const resourceReadTool = resourceReadBoundary
    ? defineTool({
        name: 'read',
        label: 'Read active Skill resource',
        description: 'Read a text file contained in an active Skill from this run snapshot.',
        promptSnippet: 'Read text files from active Skill resources.',
        parameters: Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            offset: Type.Optional(Type.Integer({ minimum: 1 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, input) {
          const lines = (await resourceReadBoundary.readFile(input.path))
            .toString('utf8')
            .split('\n')
          const offset = input.offset ?? 1
          const limit = input.limit ?? 2_000
          return {
            content: [
              {
                type: 'text' as const,
                text: lines.slice(offset - 1, offset - 1 + limit).join('\n'),
              },
            ],
            details: { offset, limit },
          }
        },
      })
    : undefined

  let sessionManager: SessionManager
  if (options.sessionFile) {
    await repairJsonlTail(options.sessionFile)
    sessionManager = SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
  } else {
    const canonicalSessionFile = join(options.sessionDir, `${options.sessionId}.jsonl`)
    await writeFile(
      canonicalSessionFile,
      `${JSON.stringify({
        type: 'session',
        version: CURRENT_SESSION_VERSION,
        id: options.sessionId,
        timestamp: new Date().toISOString(),
        cwd: options.cwd,
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )
    sessionManager = SessionManager.open(canonicalSessionFile, options.sessionDir, options.cwd)
    sessionManager.appendCustomEntry('genoffice.document-binding', {
      documentId: options.documentId,
    })
  }
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model: options.initialModel ?? fixtureProvider!.getModel(),
    thinkingLevel: 'medium',
    sessionManager,
    settingsManager,
    resourceLoader,
    ...(managedModel ? {} : { noTools: 'all' as const, tools: ['genoffice_contract_probe'] }),
    customTools: managedModel ? [resourceReadTool!] : [contractProbe],
  })
  if (managedModel) session.setActiveToolsByName([])

  return {
    session,
    sessionManager,
    subscribe: (listener) => session.subscribe(listener),
    prompt: async (text, signal, context) => {
      if (managedModel) {
        if (signal.aborted) return undefined
        if (!context) throw new Error('run_context_required')
        const model = options.resolveModel()
        const prepared = await options.runResources.prepare({
          runId: context.runId,
          ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
          model: options.resolveModelMetadata(),
          toolIds: ['platform:resource:read'],
        })
        resourceLoader.configure({
          skillPaths: prepared.skillPaths,
          promptPaths: prepared.promptPaths,
          extensionTools: prepared.extensionTools,
          mcpTools: prepared.mcpTools,
        })
        extensionExecution = {
          snapshot: prepared.snapshot,
          ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
          runId: context.runId,
        }
        resourceReadBoundary!.configure({
          snapshot: prepared.snapshot,
          skillRoots: prepared.skillPaths,
          ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
        })
        await session.reload()
        session.setActiveToolsByName([
          ...(prepared.skillPaths.length > 0 ? ['read'] : []),
          ...prepared.extensionTools.map(({ name }) => name),
          ...prepared.mcpTools.map(({ modelAlias }) => modelAlias),
        ])
        sessionManager.appendCustomEntry('genoffice.capability-snapshot', prepared.snapshot)
        await options.runResources.verify(prepared.snapshot, context.projectRoot)
        if (signal.aborted) return undefined
        await session.setModel(model)
        try {
          await session.prompt(text, { expandPromptTemplates: true, source: 'rpc' })
          return undefined
        } finally {
          options.runResources.releaseRun(context.runId)
          extensionExecution = undefined
        }
      }
      fixtureProvider!.setResponses([
        fauxAssistantMessage(
          [
            fauxThinking('checking contract'),
            fauxText('contract ready'),
            fauxToolCall('genoffice_contract_probe', {}, { id: 'contract-tool-call' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('contract probe acknowledged'),
      ])
      await session.prompt(text, { expandPromptTemplates: false, source: 'rpc' })
      if (signal.aborted) return undefined
      fixtureProvider!.setResponses([
        fauxAssistantMessage('contract compaction summary'),
        fauxAssistantMessage('contract compaction summary'),
      ])
      await session.compact('Summarize the deterministic contract run.')

      const activeLeafId = sessionManager.getLeafId()!
      const parentEntryId = sessionManager
        .getBranch()
        .find((entry) => entry.type === 'message' && entry.message.role === 'user')!.id

      sessionManager.branch(parentEntryId)
      const branchId = sessionManager.appendCustomEntry('genoffice.contract-branch', {
        source: 'deterministic-fake-provider',
      })
      sessionManager.branch(activeLeafId)
      return { branchCreated: { branchId, parentEntryId, activeLeafId } }
    },
    abort: () => session.abort(),
    fork: async (newSessionId, parentSessionId) => {
      const sourceFile = sessionManager.getSessionFile()
      const sourceLeafId = sessionManager.getLeafId()
      if (!sourceFile || !sourceLeafId) throw new Error('session_fork_unavailable')
      const forkFile = join(options.sessionDir, `${newSessionId}.jsonl`)
      const timestamp = new Date().toISOString()
      const forkEntryId = `genoffice-fork-${newSessionId}`
      const lines = [
        {
          type: 'session',
          version: CURRENT_SESSION_VERSION,
          id: newSessionId,
          timestamp,
          cwd: options.cwd,
          parentSession: sourceFile,
        },
        ...sessionManager.getEntries(),
        {
          type: 'custom',
          id: forkEntryId,
          parentId: sourceLeafId,
          timestamp,
          customType: 'genoffice.session-fork',
          data: { documentId: options.documentId, parentSessionId },
        },
      ]
      await writeFile(forkFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      return { sessionId: newSessionId, sessionFile: forkFile, activeLeafId: forkEntryId }
    },
    navigate: async (targetEntryId) => {
      if (!sessionManager.getEntry(targetEntryId)) throw new Error('branch_not_found')
      const result = await session.navigateTree(targetEntryId, { summarize: false })
      if (result.cancelled || result.aborted) throw new Error('branch_navigation_cancelled')
      const activeLeafId = sessionManager.appendCustomEntry('genoffice.branch-navigation', {
        targetEntryId,
      })
      return { activeLeafId }
    },
    dispose: () => session.dispose(),
  }
}
