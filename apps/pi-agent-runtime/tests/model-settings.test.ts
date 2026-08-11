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

async function writeModels(rootDirectory: string, providers: unknown[]): Promise<void> {
  const path = join(rootDirectory, 'agent', 'models.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, providers })}\n`, { mode: 0o600 })
}

async function writeRawModels(rootDirectory: string, value: string): Promise<void> {
  const path = join(rootDirectory, 'agent', 'models.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, { mode: 0o600 })
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
    })
    await writeModels(rootDirectory, [
      {
        providerId: 'local-openai',
        name: 'Local OpenAI',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            modelId: 'qwen-test',
            name: 'Qwen Test',
            capabilities: ['text-input', 'tool-use'],
            contextWindow: 32_768,
            maxTokens: 4_096,
          },
          {
            modelId: 'qwen-vision',
            name: 'Qwen Vision',
            capabilities: ['text-input', 'image-input'],
          },
        ],
      },
      {
        providerId: 'another-local',
        name: 'Another Local',
        baseUrl: 'http://localhost:11436/v1',
        models: [
          {
            modelId: 'model',
            name: 'Another Model',
            capabilities: ['text-input'],
          },
        ],
      },
    ])

    await expect(loadModelCatalogSettings(rootDirectory)).resolves.toEqual({
      customProviders: [
        {
          providerId: 'another-local',
          name: 'Another Local',
          baseUrl: 'http://localhost:11436/v1',
          models: [
            {
              modelId: 'model',
              name: 'Another Model',
              capabilities: ['text-input'],
            },
          ],
        },
        {
          providerId: 'local-openai',
          name: 'Local OpenAI',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            {
              modelId: 'qwen-test',
              name: 'Qwen Test',
              capabilities: ['text-input', 'tool-use'],
              contextWindow: 32_768,
              maxTokens: 4_096,
            },
            {
              modelId: 'qwen-vision',
              name: 'Qwen Vision',
              capabilities: ['text-input', 'image-input'],
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
    await writeModels(rootDirectory, [
      {
        providerId: 'local-openai',
        name: 'Old Local',
        baseUrl: 'http://localhost:11434/v1',
        models: [{ modelId: 'old', name: 'Old', capabilities: ['text-input'] }],
      },
      {
        providerId: 'preserved',
        name: 'Preserved',
        baseUrl: 'http://localhost:11435/v1',
        models: [{ modelId: 'model', name: 'Model', capabilities: ['text-input'] }],
      },
    ])
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
    const text = await readFile(join(rootDirectory, 'agent', 'models.json'), 'utf8')
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      providers: [
        {
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
        },
        {
          providerId: 'preserved',
          name: 'Preserved',
        },
      ],
    })
    expect(text).not.toContain('"modelId":"old"')
    expect(text).not.toContain('apiKey')
  })

  it('fails closed on incomplete custom models or conflicting provider endpoints', async () => {
    const incomplete = await root()
    await writeModels(incomplete, [{ providerId: 'local-openai', name: 'Local', models: [] }])
    await expect(loadModelCatalogSettings(incomplete)).rejects.toEqual(
      new ModelSettingsError('model_provider_invalid'),
    )

    const conflicting = await root()
    await writeModels(conflicting, [
      {
        providerId: 'local-openai',
        name: 'First',
        baseUrl: 'http://localhost:11434/v1',
        models: [{ modelId: 'one', name: 'One', capabilities: ['text-input'] }],
      },
      {
        providerId: 'local-openai',
        name: 'Second',
        baseUrl: 'http://localhost:11435/v1',
        models: [{ modelId: 'two', name: 'Two', capabilities: ['text-input'] }],
      },
    ])
    await expect(loadModelCatalogSettings(conflicting)).rejects.toEqual(
      new ModelSettingsError('model_provider_invalid'),
    )

    const invalidJson = await root()
    await writeRawModels(invalidJson, '{')
    await expect(loadModelCatalogSettings(invalidJson)).rejects.toEqual(
      new ModelSettingsError('model_provider_invalid'),
    )

    for (const invalidFile of [
      null,
      [],
      { schemaVersion: 1, providers: [], secret: true },
      { schemaVersion: 2, providers: [] },
      { schemaVersion: 1, providers: {} },
      { schemaVersion: 1, providers: Array.from({ length: 257 }, () => ({})) },
    ]) {
      const invalidWrapper = await root()
      await writeRawModels(invalidWrapper, JSON.stringify(invalidFile))
      await expect(loadModelCatalogSettings(invalidWrapper)).rejects.toEqual(
        new ModelSettingsError('model_provider_invalid'),
      )
    }
  })
})
