import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentConfigError,
  AgentConfigurationService,
  loadEffectiveAgentConfig,
  resolveEffectiveAgentConfig,
} from '../src/index'

const defaults = {
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
  selectedModel: { providerId: 'openai', modelId: 'gpt-5' },
  resourceOrder: ['open-genoffice/default'],
}

describe('Agent configuration', () => {
  it('merges value fields in order, keyed models by ID, and ordered lists by replacement', () => {
    const result = resolveEffectiveAgentConfig({
      defaults,
      global: {
        schemaVersion: 1,
        selectedModel: { providerId: 'local', modelId: 'qwen3' },
        resourceOrder: ['global/one'],
        models: {
          alpha: {
            providerId: 'cloud',
            modelId: 'cloud-model',
            capabilities: ['text-input'],
          },
          local: {
            providerId: 'openai-compatible',
            modelId: 'qwen3',
            endpoint: 'http://127.0.0.1:11434/v1',
            capabilities: ['text-input'],
          },
        },
      },
      project: {
        schemaVersion: 1,
        selectedModel: { providerId: 'project', modelId: 'project-model' },
        resourceOrder: ['project/one', 'project/two'],
        models: {
          local: { credentialSlot: 'local-project-slot', capabilities: ['tool-use'] },
        },
      },
      projectTrusted: true,
      session: {
        schemaVersion: 1,
        selectedModel: { providerId: 'session', modelId: 'session-model' },
      },
      sessionOverrideAuthorized: true,
    })

    expect(result.config.selectedModel).toEqual({
      providerId: 'session',
      modelId: 'session-model',
    })
    expect(result.config.resourceOrder).toEqual(['project/one', 'project/two'])
    expect(result.config.models.local).toEqual({
      providerId: 'openai-compatible',
      modelId: 'qwen3',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialSlot: 'local-project-slot',
      capabilities: ['tool-use'],
    })
    expect(result.appliedSources).toEqual(['defaults', 'global', 'project', 'session'])
    expect(result.configHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('applies deny-wins across hard policy, global, project, session, and actor capability gates', () => {
    const result = resolveEffectiveAgentConfig({
      defaults,
      productPolicy: { execution: false },
      global: { schemaVersion: 1, capabilities: { network: false, execution: true } },
      project: {
        schemaVersion: 1,
        capabilities: { network: true, execution: true, mcp: false },
      },
      projectTrusted: true,
      session: { schemaVersion: 1, capabilities: { mcp: true, sync: false } },
      sessionOverrideAuthorized: true,
      actorCapabilities: { models: false },
    })

    expect(result.config.capabilities).toEqual({
      models: false,
      network: false,
      execution: false,
      mcp: false,
      ocr: false,
      subagentMutation: false,
      sync: false,
    })
  })

  it('isolates an invalid trusted project source without partially applying its safe fields', () => {
    const result = resolveEffectiveAgentConfig({
      defaults,
      global: { schemaVersion: 1, selectedModel: { providerId: 'global', modelId: 'safe' } },
      project: {
        schemaVersion: 1,
        selectedModel: { providerId: 'project', modelId: 'must-not-apply' },
        apiKey: 'plaintext-secret',
      },
      projectTrusted: true,
    })

    expect(result.config.selectedModel).toEqual({ providerId: 'global', modelId: 'safe' })
    expect(result.appliedSources).toEqual(['defaults', 'global'])
    expect(result.diagnostics).toEqual(['project_config_invalid'])
    expect(JSON.stringify(result)).not.toContain('plaintext-secret')
  })

  it('rejects unknown fields, secret fields, command interpolation, and unauthorized session overrides', () => {
    for (const global of [
      { schemaVersion: 1, unknown: true },
      { schemaVersion: 1, apiKey: 'secret' },
      {
        schemaVersion: 1,
        selectedModel: { providerId: 'local', modelId: 'x', endpoint: '${MODEL_ENDPOINT}' },
      },
      {
        schemaVersion: 1,
        selectedModel: { providerId: 'local', modelId: 'x', endpoint: '$(resolver)' },
      },
    ]) {
      expect(() => resolveEffectiveAgentConfig({ defaults, global })).toThrow(
        new AgentConfigError('global_config_invalid'),
      )
    }
    expect(() =>
      resolveEffectiveAgentConfig({
        defaults,
        session: { schemaVersion: 1, selectedModel: { providerId: 'x', modelId: 'y' } },
      }),
    ).toThrow(new AgentConfigError('session_override_unauthorized'))
    expect(() => resolveEffectiveAgentConfig({ defaults, global: null })).toThrow(
      new AgentConfigError('global_config_invalid'),
    )
    expect(() =>
      resolveEffectiveAgentConfig({
        defaults: { schemaVersion: 1 },
      }),
    ).toThrow(new AgentConfigError('defaults_config_invalid'))
    expect(() =>
      resolveEffectiveAgentConfig({
        defaults,
        global: { schemaVersion: 1, models: { partial: { credentialSlot: 'slot' } } },
      }),
    ).toThrow(new AgentConfigError('effective_config_invalid'))
    expect(() =>
      resolveEffectiveAgentConfig({
        defaults,
        session: { schemaVersion: 1, unknown: true },
        sessionOverrideAuthorized: true,
      }),
    ).toThrow(new AgentConfigError('session_config_invalid'))
  })

  it('does not read project settings or expose its credential slot before Project Trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-untrusted-'))
    const globalPath = join(root, 'global.json')
    const projectPath = join(root, 'project.json')
    await writeFile(globalPath, JSON.stringify({ schemaVersion: 1 }))
    await writeFile(
      projectPath,
      JSON.stringify({
        schemaVersion: 1,
        selectedModel: {
          providerId: 'malicious',
          modelId: 'model',
          credentialSlot: 'must-not-resolve',
        },
      }),
    )
    const read = vi.fn(async (path: string) => {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8')
    })

    const result = await loadEffectiveAgentConfig({
      defaults,
      globalPath,
      projectPath,
      projectTrusted: false,
      readTextFile: read,
    })

    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(globalPath)
    expect(result.config.selectedModel).toEqual(defaults.selectedModel)
    expect(JSON.stringify(result)).not.toContain('must-not-resolve')
  })

  it('treats missing optional sources as absent and malformed global JSON as invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-files-'))
    const globalPath = join(root, 'missing', 'settings.json')
    expect(
      (
        await loadEffectiveAgentConfig({
          defaults,
          globalPath,
          projectTrusted: false,
        })
      ).appliedSources,
    ).toEqual(['defaults'])

    await mkdir(join(root, 'missing'))
    await writeFile(globalPath, '{not-json')
    await expect(
      loadEffectiveAgentConfig({ defaults, globalPath, projectTrusted: false }),
    ).rejects.toEqual(new AgentConfigError('global_config_invalid'))
  })

  it('loads a trusted project file and isolates malformed project JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-trusted-files-'))
    const projectPath = join(root, 'settings.json')
    await writeFile(
      projectPath,
      JSON.stringify({
        schemaVersion: 1,
        selectedModel: { providerId: 'project', modelId: 'trusted' },
      }),
    )
    expect(
      (await loadEffectiveAgentConfig({ defaults, projectPath, projectTrusted: true })).config
        .selectedModel,
    ).toEqual({ providerId: 'project', modelId: 'trusted' })

    await writeFile(projectPath, '{malformed')
    const isolated = await loadEffectiveAgentConfig({ defaults, projectPath, projectTrusted: true })
    expect(isolated.config.selectedModel).toEqual(defaults.selectedModel)
    expect(isolated.diagnostics).toEqual(['project_config_invalid'])
  })

  it('supports defaults without a selected model while keeping a deterministic empty catalog', () => {
    const result = resolveEffectiveAgentConfig({
      defaults: { schemaVersion: 1, capabilities: defaults.capabilities },
    })
    expect(result.config.selectedModel).toBeUndefined()
    expect(result.config.models).toEqual({})
    expect(result.config.resourceOrder).toEqual([])
  })

  it('hashes equivalent keyed configuration canonically regardless of JSON key order', () => {
    const left = resolveEffectiveAgentConfig({
      defaults,
      global: {
        schemaVersion: 1,
        models: {
          zed: {
            providerId: 'cloud',
            modelId: 'z',
            capabilities: ['tool-use', 'text-input'],
          },
          alpha: { providerId: 'local', modelId: 'a' },
        },
      },
    })
    const right = resolveEffectiveAgentConfig({
      defaults,
      global: {
        models: {
          alpha: { modelId: 'a', providerId: 'local' },
          zed: {
            capabilities: ['text-input', 'tool-use'],
            modelId: 'z',
            providerId: 'cloud',
          },
        },
        schemaVersion: 1,
      },
    })
    expect(left.configHash).toBe(right.configHash)
  })

  it('uses fixed global/project paths and derives project authorization from the local TrustStore', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-config-service-home-'))
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-config-service-project-'))
    await mkdir(join(home, 'agent'), { recursive: true })
    await mkdir(join(projectRoot, '.open-genoffice', 'agent'), { recursive: true })
    await writeFile(
      join(projectRoot, '.open-genoffice', 'project.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: '33333333-3333-4333-8333-333333333333',
      }),
    )
    await writeFile(
      join(home, 'agent', 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        selectedModel: { providerId: 'global', modelId: 'global-model' },
      }),
    )
    await writeFile(
      join(projectRoot, '.open-genoffice', 'agent', 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        selectedModel: { providerId: 'project', modelId: 'project-model' },
      }),
    )
    const service = new AgentConfigurationService({
      rootDirectory: home,
      deviceId: '11111111-1111-4111-8111-111111111111',
      defaults,
      productPolicy: { execution: false },
    })

    const restricted = await service.resolve({ projectRoot })
    expect(restricted.project?.trusted).toBe(false)
    expect(restricted.config.selectedModel?.providerId).toBe('global')
    expect(restricted.config.capabilities.execution).toBe(false)

    await service.grantProject(projectRoot)
    const trusted = await service.resolve({ projectRoot })
    expect(trusted.project?.trusted).toBe(true)
    expect(trusted.config.selectedModel?.providerId).toBe('project')

    await service.revokeProject(projectRoot)
    expect((await service.resolve({ projectRoot })).project?.trusted).toBe(false)
    expect((await service.resolve()).project).toBeUndefined()
  })
})
