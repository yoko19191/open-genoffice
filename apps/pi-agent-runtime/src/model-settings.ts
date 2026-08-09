import { mkdir, readFile } from 'node:fs/promises'
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
import { parseOpenAICompatibleProviderConfiguration } from '@genoffice/agent-runtime-protocol'

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

async function loadCustomProviders(
  rootDirectory: string,
): Promise<OpenAICompatibleProviderConfig[]> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(rootDirectory, 'agent', 'models.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new ModelSettingsError('model_provider_invalid')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'providers') ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { providers?: unknown }).providers) ||
    (value as { providers: unknown[] }).providers.length > 256
  ) {
    throw new ModelSettingsError('model_provider_invalid')
  }
  try {
    const providers = (value as { providers: unknown[] }).providers.map((provider) =>
      parseOpenAICompatibleProviderConfiguration(provider),
    )
    if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) {
      throw new Error('duplicate_provider')
    }
    return providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
  } catch {
    throw new ModelSettingsError('model_provider_invalid')
  }
}

export async function loadModelCatalogSettings(
  rootDirectory: string,
): Promise<ModelCatalogServiceOptions> {
  const config = await settings(rootDirectory)
  return {
    customProviders: await loadCustomProviders(rootDirectory),
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
  const providers = await loadCustomProviders(rootDirectory)
  const next = [
    ...providers.filter((existing) => existing.providerId !== provider.providerId),
    provider,
  ].sort((left, right) => left.providerId.localeCompare(right.providerId))
  const agentDirectory = join(rootDirectory, 'agent')
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
  await atomicWriteJson(join(agentDirectory, 'models.json'), {
    schemaVersion: 1,
    providers: next,
  })
}
