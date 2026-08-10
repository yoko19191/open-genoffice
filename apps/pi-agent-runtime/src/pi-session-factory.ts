import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
import type { OfficeToolCatalogBinding } from '@genoffice/agent-runtime-protocol'
import {
  resolveOfficeToolDefinitions,
  type OfficeToolDefinition,
} from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import type { RuntimeOfficeToolHostClient } from './runtime-office-tool-host-client'
import type {
  CodexImageGenerateInput,
  CodexImageGenerateResult,
} from './codex-oauth-image-provider'
import type { RunResourceService, RunModelMetadata } from './run-resource-service'
import { ControlledResourceLoader } from './controlled-resource-loader'
import { ResourceReadBoundary } from './resource-read-boundary'
import type { SpawnSubagentRequest } from './subagent-coordinator'
import type { SubagentRunProjection } from './subagent-run-registry'

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
  officeToolCatalog?: OfficeToolCatalogBinding
  officeToolHost?: Pick<RuntimeOfficeToolHostClient, 'invoke'>
  generateImage?: (
    input: CodexImageGenerateInput,
    signal: AbortSignal,
  ) => Promise<CodexImageGenerateResult>
  credentials?: CredentialStore
  spawnSubagent?: (request: SpawnSubagentRequest) => Promise<SubagentRunProjection>
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

function redactImagePromptForPersistence<T extends { role: string; content?: unknown }>(
  message: T,
): T {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message
  const content = message.content.map((item: unknown) =>
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'toolCall' &&
    (item as { name?: unknown }).name === 'generate_image'
      ? { ...item, arguments: {} }
      : item,
  )
  return { ...message, content } as T
}

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
  const officeToolDefinitions: readonly OfficeToolDefinition[] = options.officeToolCatalog
    ? resolveOfficeToolDefinitions(options.officeToolCatalog)
    : []
  if (managedModel && officeToolDefinitions.length > 0 && !options.officeToolHost) {
    throw new Error('office_tool_host_required')
  }
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
  let nextOfficeToolOrder = 0
  let latestOfficeContextVersion: string | undefined
  let latestFormInventoryVersion: string | undefined
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
              signal: signal ?? new AbortController().signal,
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
  const subagentTool =
    managedModel && options.spawnSubagent
      ? defineTool({
          name: 'subagent',
          label: 'Read-only Subagent',
          description:
            'Create an independent, read-only child agent for bounded research or analysis.',
          promptSnippet:
            'Delegate bounded read-only research to an independent child context when useful.',
          parameters: Type.Object(
            {
              role: Type.String({ minLength: 1, maxLength: 64 }),
              task: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
              tools: Type.Optional(
                Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 128 }),
              ),
            },
            { additionalProperties: false },
          ),
          async execute(_toolCallId, input) {
            if (!extensionExecution) throw new Error('subagent_parent_context_required')
            if (!extensionExecution.snapshot.toolIds.includes('platform:subagent:spawn')) {
              throw new Error('subagent_not_authorized')
            }
            const child = await options.spawnSubagent!({
              parentRunId: extensionExecution.runId,
              parentSessionId: options.sessionId,
              documentId: options.documentId,
              role: input.role,
              task: input.task,
              parentSnapshot: extensionExecution.snapshot,
              ...(input.tools ? { requestedTools: input.tools } : {}),
              ...(extensionExecution.projectRoot
                ? { projectRoot: extensionExecution.projectRoot }
                : {}),
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    runId: child.runId,
                    status: child.status,
                    attempt: child.attempt,
                  }),
                },
              ],
              details: {
                runId: child.runId,
                rootRunId: child.rootRunId,
                parentRunId: child.parentRunId,
                status: child.status,
                attempt: child.attempt,
              },
            }
          },
        })
      : undefined
  const imageTool =
    managedModel && options.generateImage
      ? defineTool({
          name: 'generate_image',
          label: 'Generate image',
          description:
            'Generate one image through the configured Codex OAuth image provider. The result is an opaque ArtifactRef; insert it with an Office image tool.',
          promptSnippet: 'Generate an image as an ArtifactRef before inserting it into a document.',
          parameters: Type.Object(
            { prompt: Type.String({ minLength: 1, maxLength: 16_000 }) },
            { additionalProperties: false },
          ),
          async execute(_toolCallId, input, signal) {
            if (!extensionExecution) throw new Error('image_parent_context_required')
            if (!extensionExecution.snapshot.toolIds.includes('platform:image:generate')) {
              throw new Error('image_generation_not_authorized')
            }
            const result = await options.generateImage!(
              {
                operationId: randomUUID(),
                documentId: options.documentId,
                runId: extensionExecution.runId,
                prompt: input.prompt,
              },
              signal ?? new AbortController().signal,
            )
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    artifactId: result.artifact.artifactId,
                    mediaType: result.artifact.mediaType,
                    byteLength: result.artifact.byteLength,
                    sha256: result.artifact.sha256,
                    width: result.width,
                    height: result.height,
                  }),
                },
              ],
              details: result,
            }
          },
        })
      : undefined
  const officeTools = officeToolDefinitions.map((definition) =>
    defineTool({
      name: definition.modelAlias,
      label: definition.label,
      description: definition.description,
      promptSnippet: definition.description,
      parameters: definition.parameters,
      executionMode: definition.effect === 'read' ? 'parallel' : 'sequential',
      async execute(toolCallId, input, signal) {
        if (!extensionExecution) throw new Error('office_tool_run_context_required')
        const toolOrder = nextOfficeToolOrder++
        const contextVersion =
          definition.modelAlias === 'fill_form_field'
            ? latestFormInventoryVersion
            : definition.effect === 'read'
              ? undefined
              : latestOfficeContextVersion
        const operationId = randomUUID()
        const receipt = await options.officeToolHost!.invoke(
          {
            operationId,
            sessionId: options.sessionId,
            documentId: options.documentId,
            runId: extensionExecution.runId,
            toolCallId,
            toolId: definition.id,
            toolOrder,
            ...(contextVersion ? { contextVersion } : {}),
            actor: {
              type: 'parent',
              actorId: options.sessionId,
              sessionId: options.sessionId,
            },
            permissionSnapshot: {
              snapshotId: extensionExecution.snapshot.snapshotId,
              createdForRunId: extensionExecution.snapshot.createdForRunId,
              permissionVersion: extensionExecution.snapshot.permissionVersion,
              toolIds: [...extensionExecution.snapshot.toolIds].filter((id) =>
                id.startsWith('office:'),
              ),
            },
            input,
          },
          signal,
        )
        if (receipt.status === 'completed' && receipt.contextVersionAfter) {
          latestOfficeContextVersion = receipt.contextVersionAfter
          if (definition.modelAlias === 'list_form_fields') {
            latestFormInventoryVersion = receipt.contextVersionAfter
          }
        }
        return {
          content: [{ type: 'text' as const, text: receipt.output }],
          details: {
            ...(typeof receipt.details === 'object' && receipt.details !== null
              ? receipt.details
              : {}),
            officeTool: {
              operationId: receipt.operationId,
              toolId: receipt.toolId,
              status: receipt.status,
              ...(receipt.mutationOutcome ? { mutationOutcome: receipt.mutationOutcome } : {}),
            },
          },
        }
      },
    }),
  )

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
      ...(options.officeToolCatalog ? { officeToolCatalog: options.officeToolCatalog } : {}),
    })
  }
  const appendMessage = sessionManager.appendMessage.bind(sessionManager)
  sessionManager.appendMessage = (message) =>
    appendMessage(redactImagePromptForPersistence(message))
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
    customTools: managedModel
      ? [resourceReadTool, subagentTool, imageTool, ...officeTools].filter(
          (tool): tool is NonNullable<typeof tool> => tool !== undefined,
        )
      : [contractProbe],
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
        nextOfficeToolOrder = 0
        latestOfficeContextVersion = undefined
        latestFormInventoryVersion = undefined
        const prepared = await options.runResources.prepare({
          runId: context.runId,
          ...(context.projectRoot ? { projectRoot: context.projectRoot } : {}),
          model: options.resolveModelMetadata(),
          toolIds: [
            'platform:resource:read',
            ...(options.spawnSubagent ? ['platform:subagent:spawn'] : []),
            ...(options.generateImage ? ['platform:image:generate'] : []),
            ...officeToolDefinitions.map(({ id }) => id),
          ],
          reservedToolAliases: [
            ...(options.generateImage ? ['generate_image'] : []),
            ...officeToolDefinitions.map(({ modelAlias }) => modelAlias),
          ],
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
          ...(options.spawnSubagent ? ['subagent'] : []),
          ...(options.generateImage ? ['generate_image'] : []),
          ...officeToolDefinitions.map(({ modelAlias }) => modelAlias),
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
