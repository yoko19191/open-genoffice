import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModelSettingsError,
  loadModelCatalogSettings,
  saveModelSelection,
  saveOpenAICompatibleProvider,
} from '../src'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'genoffice-model-settings-'))
  roots.push(value)
  return value
}

async function writeSettings(rootDirectory: string, value: unknown): Promise<void> {
  const path = join(rootDirectory, 'agent', 'settings.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

describe('model settings', () => {
  it('loads no external Agent home and returns an empty controlled catalog by default', async () => {
    await expect(loadModelCatalogSettings(await root())).resolves.toEqual({
      customProviders: [],
      selections: {},
    })
  })

  it('groups explicit local models and restores only the conversation selection', async () => {
    const rootDirectory = await root()
    await writeSettings(rootDirectory, {
      schemaVersion: 1,
      selectedModel: { providerId: 'local-openai', modelId: 'qwen-test' },
      models: {
        'local-openai/qwen-test': {
          providerId: 'local-openai',
          modelId: 'qwen-test',
          endpoint: 'http://127.0.0.1:11434/v1',
          capabilities: ['text-input', 'tool-use'],
        },
        'local-openai/qwen-vision': {
          providerId: 'local-openai',
          modelId: 'qwen-vision',
          endpoint: 'http://127.0.0.1:11434/v1',
          capabilities: ['text-input', 'image-input'],
        },
        'openai/gpt': {
          providerId: 'openai',
          modelId: 'gpt',
          capabilities: ['text-input'],
        },
        'another-local/model': {
          providerId: 'another-local',
          modelId: 'model',
          endpoint: 'http://localhost:11436/v1',
          capabilities: ['text-input'],
        },
      },
    })

    await expect(loadModelCatalogSettings(rootDirectory)).resolves.toEqual({
      customProviders: [
        {
          providerId: 'another-local',
          name: 'another-local',
          baseUrl: 'http://localhost:11436/v1',
          models: [
            {
              modelId: 'model',
              name: 'model',
              capabilities: ['text-input'],
            },
          ],
        },
        {
          providerId: 'local-openai',
          name: 'local-openai',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            {
              modelId: 'qwen-test',
              name: 'qwen-test',
              capabilities: ['text-input', 'tool-use'],
            },
            {
              modelId: 'qwen-vision',
              name: 'qwen-vision',
              capabilities: ['image-input', 'text-input'],
            },
          ],
        },
      ],
      selections: {
        conversation: { providerId: 'local-openai', modelId: 'qwen-test' },
      },
    })
  })

  it('atomically saves a selection while preserving unrelated settings', async () => {
    const rootDirectory = await root()
    await writeSettings(rootDirectory, {
      schemaVersion: 1,
      capabilities: { network: false },
      resourceOrder: ['global/one'],
    })
    await saveModelSelection(rootDirectory, {
      providerId: 'openai-codex',
      modelId: 'gpt-5.4',
    })
    const saved = JSON.parse(await readFile(join(rootDirectory, 'agent', 'settings.json'), 'utf8'))
    expect(saved).toMatchObject({
      schemaVersion: 1,
      capabilities: { network: false },
      selectedModel: { providerId: 'openai-codex', modelId: 'gpt-5.4' },
      resourceOrder: ['global/one'],
    })
  })

  it('atomically saves sanitized OpenAI-compatible provider models without credentials', async () => {
    const rootDirectory = await root()
    await writeSettings(rootDirectory, {
      schemaVersion: 1,
      models: {
        'local-openai/old': {
          providerId: 'local-openai',
          modelId: 'old',
          endpoint: 'http://localhost:11434/v1',
          capabilities: ['text-input'],
        },
        'preserved/model': {
          providerId: 'preserved',
          modelId: 'model',
          endpoint: 'http://localhost:11435/v1',
          capabilities: ['text-input'],
        },
      },
    })
    await saveOpenAICompatibleProvider(rootDirectory, {
      providerId: 'local-openai',
      name: 'ignored display name',
      baseUrl: 'http://localhost:11434/v1',
      models: [
        {
          modelId: 'qwen-test',
          name: 'ignored model name',
          capabilities: ['text-input', 'tool-use'],
        },
      ],
    })
    const text = await readFile(join(rootDirectory, 'agent', 'settings.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({
      models: {
        'local-openai/qwen-test': {
          providerId: 'local-openai',
          modelId: 'qwen-test',
          endpoint: 'http://localhost:11434/v1',
          capabilities: ['text-input', 'tool-use'],
        },
        'preserved/model': {
          providerId: 'preserved',
          modelId: 'model',
        },
      },
    })
    expect(JSON.parse(text).models).not.toHaveProperty('local-openai/old')
    expect(text).not.toContain('apiKey')
  })

  it('fails closed on incomplete custom models or conflicting provider endpoints', async () => {
    const incomplete = await root()
    await writeSettings(incomplete, {
      schemaVersion: 1,
      models: {
        local: { providerId: 'local-openai', modelId: 'qwen-test' },
      },
    })
    await expect(loadModelCatalogSettings(incomplete)).rejects.toEqual(
      new ModelSettingsError('model_provider_invalid'),
    )

    const conflicting = await root()
    await writeSettings(conflicting, {
      schemaVersion: 1,
      models: {
        one: {
          providerId: 'local-openai',
          modelId: 'one',
          endpoint: 'http://localhost:11434/v1',
          capabilities: ['text-input'],
        },
        two: {
          providerId: 'local-openai',
          modelId: 'two',
          endpoint: 'http://localhost:11435/v1',
          capabilities: ['text-input'],
        },
      },
    })
    await expect(loadModelCatalogSettings(conflicting)).rejects.toEqual(
      new ModelSettingsError('model_provider_invalid'),
    )
  })
})
