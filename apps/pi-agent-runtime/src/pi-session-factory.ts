import { mkdir, writeFile } from 'node:fs/promises'
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
} from '@earendil-works/pi-ai'
import {
  DefaultResourceLoader,
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'

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
  prompt: (text: string) => Promise<PiPromptResult | undefined>
  dispose: () => void
}

export type CreatePiSessionOptions = {
  cwd: string
  agentDir: string
  sessionDir: string
  sessionId: string
  sessionFile?: string
  documentId: string
}

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

export async function createDeterministicPiSession(
  options: CreatePiSessionOptions,
): Promise<PiSessionHandle> {
  await Promise.all([
    mkdir(options.cwd, { recursive: true }),
    mkdir(options.agentDir, { recursive: true }),
    mkdir(options.sessionDir, { recursive: true }),
  ])

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  })
  const faux = fauxProvider({
    api: 'genoffice-faux',
    provider: 'genoffice-faux',
    models: [{ id: 'genoffice-faux-1', reasoning: true }],
    tokenSize: { min: 1, max: 1 },
  })
  modelRuntime.registerNativeProvider(faux.provider)
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: 'medium',
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 32 },
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'You are the isolated GenOffice runtime contract agent.',
  })
  await resourceLoader.reload()

  let sessionManager: SessionManager
  if (options.sessionFile) {
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
    model: faux.getModel(),
    thinkingLevel: 'medium',
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: 'all',
    tools: ['genoffice_contract_probe'],
    customTools: [contractProbe],
  })

  return {
    session,
    sessionManager,
    subscribe: (listener) => session.subscribe(listener),
    prompt: async (text) => {
      faux.appendResponses([
        fauxAssistantMessage(
          [
            fauxThinking('checking contract'),
            fauxText('contract ready'),
            fauxToolCall('genoffice_contract_probe', {}, { id: 'contract-tool-call' }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('contract probe acknowledged'),
        fauxAssistantMessage('contract compaction summary'),
      ])
      await session.prompt(text, { expandPromptTemplates: false, source: 'rpc' })
      await session.compact('Summarize the deterministic contract run.')

      const activeLeafId = sessionManager.getLeafId()
      const parentEntryId = sessionManager
        .getBranch()
        .find((entry) => entry.type === 'message' && entry.message.role === 'user')?.id
      if (!activeLeafId || !parentEntryId) return undefined

      sessionManager.branch(parentEntryId)
      const branchId = sessionManager.appendCustomEntry('genoffice.contract-branch', {
        source: 'deterministic-fake-provider',
      })
      sessionManager.branch(activeLeafId)
      return { branchCreated: { branchId, parentEntryId, activeLeafId } }
    },
    dispose: () => session.dispose(),
  }
}
