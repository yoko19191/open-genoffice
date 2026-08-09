import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  atomicWriteJson,
  loadEffectiveAgentConfig,
  type EffectiveAgentConfig,
} from '@genoffice/agent-resource'
import type {
  ModelCatalogServiceOptions,
  OpenAICompatibleProviderConfig,
} from './model-catalog-service'

const defaultSettings = {
  schemaVersion: 1 as const,
  capabilities: {
    models: true,
    network: true,
    execution: true,
    mcp: true,
    ocr: false,
    subagentMutation: false,
    sync: true,
  },
}
const builtInProviders = new Set(['openai', 'openai-codex'])

export class ModelSettingsError extends Error {
  constructor(public readonly code: 'model_provider_invalid') {
    super(code)
    this.name = 'ModelSettingsError'
  }
}

async function settings(rootDirectory: string): Promise<EffectiveAgentConfig> {
  return (
    await loadEffectiveAgentConfig({
      defaults: defaultSettings,
      globalPath: join(rootDirectory, 'agent', 'settings.json'),
    })
  ).config
}

async function writeSettings(rootDirectory: string, value: EffectiveAgentConfig): Promise<void> {
  const agentDirectory = join(rootDirectory, 'agent')
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
  await atomicWriteJson(join(agentDirectory, 'settings.json'), value)
}

export async function loadModelCatalogSettings(
  rootDirectory: string,
): Promise<ModelCatalogServiceOptions> {
  const config = await settings(rootDirectory)
  type MutableProvider = Omit<OpenAICompatibleProviderConfig, 'models'> & {
    models: OpenAICompatibleProviderConfig['models'][number][]
  }
  const providers = new Map<string, MutableProvider>()
  for (const model of Object.values(config.models)) {
    const { endpoint, capabilities } = model
    const providerId = model.providerId!
    const modelId = model.modelId!
    if (builtInProviders.has(providerId)) continue
    if (!endpoint || !capabilities?.length) {
      throw new ModelSettingsError('model_provider_invalid')
    }
    const existing = providers.get(providerId)
    if (existing && existing.baseUrl !== endpoint) {
      throw new ModelSettingsError('model_provider_invalid')
    }
    const provider: MutableProvider = existing ?? {
      providerId,
      name: providerId,
      baseUrl: endpoint,
      models: [],
    }
    provider.models.push({
      modelId,
      name: modelId,
      capabilities,
    })
    providers.set(providerId, provider)
  }
  return {
    customProviders: [...providers.values()].sort((left, right) =>
      left.providerId.localeCompare(right.providerId),
    ),
    selections: config.selectedModel
      ? {
          conversation: {
            providerId: config.selectedModel.providerId,
            modelId: config.selectedModel.modelId,
          },
        }
      : {},
  }
}

export async function saveModelSelection(
  rootDirectory: string,
  selection: { providerId: string; modelId: string },
): Promise<void> {
  const config = await settings(rootDirectory)
  await writeSettings(rootDirectory, {
    ...config,
    selectedModel: { providerId: selection.providerId, modelId: selection.modelId },
  })
}

export async function saveOpenAICompatibleProvider(
  rootDirectory: string,
  provider: OpenAICompatibleProviderConfig,
): Promise<void> {
  const config = await settings(rootDirectory)
  const models = { ...config.models }
  for (const [key, model] of Object.entries(models)) {
    if (model.providerId === provider.providerId) delete models[key]
  }
  for (const model of provider.models) {
    models[`${provider.providerId}/${model.modelId}`] = {
      providerId: provider.providerId,
      modelId: model.modelId,
      endpoint: provider.baseUrl,
      capabilities: [...new Set(model.capabilities)].sort(),
    }
  }
  await writeSettings(rootDirectory, { ...config, models })
}
