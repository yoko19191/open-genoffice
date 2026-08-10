import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsManager, createExtensionRuntime } from '@earendil-works/pi-coding-agent'
import { ControlledResourceLoader } from '../src/controlled-resource-loader'
import { PiMcpExtensionFactory } from '../src/pi-mcp-extension-factory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe('ControlledResourceLoader', () => {
  it('replaces the exact Skill and Prompt set instead of retaining paths from an earlier run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const firstSkill = join(root, 'first', 'SKILL.md')
    const secondSkill = join(root, 'second', 'SKILL.md')
    const prompt = join(root, 'prompt.md')
    await write(firstSkill, '---\nname: first\ndescription: first skill\n---\nFirst instructions\n')
    await write(
      secondSkill,
      '---\nname: second\ndescription: second skill\n---\nSecond instructions\n',
    )
    await write(prompt, '---\ndescription: prompt\n---\nPrompt body\n')
    const loader = new ControlledResourceLoader({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPrompt: 'Controlled system prompt',
    })

    loader.configure({ skillPaths: [dirname(firstSkill)], promptPaths: [prompt] })
    await loader.reload()
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['first'])
    expect(loader.getPrompts().prompts.map(({ name }) => name)).toEqual(['prompt'])
    expect(loader.getSystemPrompt()).toBe('Controlled system prompt')

    loader.configure({ skillPaths: [dirname(secondSkill)], promptPaths: [] })
    await loader.reload()
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['second'])
    expect(loader.getPrompts().prompts).toEqual([])
    expect(JSON.stringify(loader.getSkills())).not.toContain('First instructions')
    expect(loader.getThemes().themes).toEqual([])
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
    expect(loader.getSystemPromptSource()).toBeUndefined()
    expect(loader.getAppendSystemPrompt()).toEqual([])
    expect(loader.getAppendSystemPromptSources()).toEqual([])
  })

  it('rejects resource extension outside the frozen run set and keeps the last good delegate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const skill = join(root, 'skill', 'SKILL.md')
    await write(skill, '---\nname: stable\ndescription: stable\n---\nStable\n')
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
    })
    loader.configure({ skillPaths: [dirname(skill)], promptPaths: [] })
    await loader.reload()
    loader.configure({ skillPaths: [join(root, 'missing')], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['stable'])
    expect(() =>
      loader.extendResources({
        skillPaths: [{ path: dirname(skill), metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() =>
      loader.extendResources({
        promptPaths: [{ path: skill, metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() =>
      loader.extendResources({
        themePaths: [{ path: skill, metadata: { source: 'extension' } as never }],
      }),
    ).toThrowError('resource_extension_not_authorized')
    expect(() => loader.extendResources({})).not.toThrow()
    expect(loader.getExtensions().extensions).toEqual([])
  })

  it('fails closed when an exact path changes shape or Pi reports invalid content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-loader-'))
    roots.push(root)
    const skillFile = join(root, 'skill-file')
    const promptDirectory = join(root, 'prompt-directory')
    const malformedSkill = join(root, 'malformed-skill')
    const extensionDirectory = join(root, 'extension-directory')
    await write(skillFile, 'not a directory\n')
    await mkdir(promptDirectory, { recursive: true })
    await mkdir(extensionDirectory, { recursive: true })
    await write(join(malformedSkill, 'SKILL.md'), '---\n: invalid yaml\n---\nBody\n')
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
    })

    loader.configure({ skillPaths: [skillFile], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    loader.configure({ skillPaths: [], promptPaths: [promptDirectory] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    loader.configure({ skillPaths: [malformedSkill], promptPaths: [] })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    loader.configure({
      skillPaths: [],
      promptPaths: [],
      extensionTools: [
        {
          extensionPath: extensionDirectory,
          name: 'inspect',
          canonicalToolId: 'platform:extension:global/safe-extension/inspect',
          packageId: 'safe-extension',
          contentSha256: 'a'.repeat(64),
        },
      ],
    })
    await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
  })

  it('exposes only declared read tools through an isolated Extension runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-extension-'))
    roots.push(root)
    const extensionPath = join(root, 'extension.mjs')
    await write(
      extensionPath,
      `export default function (pi) {
        pi.registerTool({
          name: 'inspect', label: 'Inspect', description: 'Read metadata',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute() {
            let activeToolsMutation = 'unexpected-success'
            try { pi.setActiveTools(['unexpected']) } catch (error) { activeToolsMutation = error.message }
            return { content: [{ type: 'text', text: 'safe' }], details: { activeToolsMutation } }
          }
        })
      }\n`,
    )
    const authorize = vi.fn(async () => ({
      toolId: 'platform:extension:global/safe-extension/inspect',
      actorId: 'actor-1',
      runId: 'run-1',
      documentId: 'document-1',
    }))
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      authorizeExtensionTool: authorize,
    })
    loader.configure({
      skillPaths: [],
      promptPaths: [],
      extensionTools: [
        {
          extensionPath,
          name: 'inspect',
          canonicalToolId: 'platform:extension:global/safe-extension/inspect',
          packageId: 'safe-extension',
          contentSha256: 'a'.repeat(64),
        },
      ],
    })
    await loader.reload()

    const result = loader.getExtensions()
    expect(result.errors).toEqual([])
    expect(result.extensions).toHaveLength(1)
    const extension = result.extensions[0]!
    expect(extension.handlers.size).toBe(0)
    expect(extension.commands.size).toBe(0)
    expect(extension.flags.size).toBe(0)
    expect(extension.shortcuts.size).toBe(0)
    const tool = extension.tools.get('inspect')!.definition
    const execution = await tool.execute('tool-call-1', {}, undefined, undefined, {} as never)
    expect(execution).toMatchObject({
      content: [{ type: 'text', text: 'safe' }],
      details: {
        extension: { activeToolsMutation: 'extension_runtime_isolated' },
        provenance: {
          toolId: 'platform:extension:global/safe-extension/inspect',
          actorId: 'actor-1',
        },
      },
    })
    expect(authorize).toHaveBeenCalledWith('platform:extension:global/safe-extension/inspect')
  })

  it('rejects a missing Extension factory and a tool execution without current authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-extension-guards-'))
    roots.push(root)
    const invalidExtension = join(root, 'invalid.mjs')
    await write(invalidExtension, 'export default {}\n')
    const permission = {
      extensionPath: invalidExtension,
      name: 'inspect',
      canonicalToolId: 'platform:extension:global/safe-extension/inspect',
      packageId: 'safe-extension',
      contentSha256: 'a'.repeat(64),
    }
    const invalidLoader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-invalid'),
      settingsManager: SettingsManager.inMemory(),
    })
    invalidLoader.configure({ skillPaths: [], promptPaths: [], extensionTools: [permission] })
    await expect(invalidLoader.reload()).rejects.toThrowError('resource_loader_diagnostics')

    const validExtension = join(root, 'valid.mjs')
    await write(
      validExtension,
      `export default function (pi) { pi.registerTool({ name: 'inspect', label: 'Inspect', description: 'Read', parameters: { type: 'object', properties: {} }, async execute() { return { content: [], details: {} } } }) }\n`,
    )
    const unauthorizedLoader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-unauthorized'),
      settingsManager: SettingsManager.inMemory(),
    })
    unauthorizedLoader.configure({
      skillPaths: [],
      promptPaths: [],
      extensionTools: [{ ...permission, extensionPath: validExtension }],
    })
    await unauthorizedLoader.reload()
    await expect(
      unauthorizedLoader
        .getExtensions()
        .extensions[0]!.tools.get('inspect')!
        .definition.execute('tool-call', {}, undefined, undefined, {} as never),
    ).rejects.toThrowError('extension_tool_not_authorized')
  })

  it.each(['undeclared-tool', 'active-handler', 'provider-registration'] as const)(
    'rejects Extension authority outside the declared read tool: %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-extension-invalid-'))
      roots.push(root)
      const extensionPath = join(root, 'extension.mjs')
      const extra =
        scenario === 'undeclared-tool'
          ? `pi.registerTool({ name: 'extra', label: 'Extra', description: 'Extra', parameters: { type: 'object', properties: {} }, async execute() { return { content: [], details: {} } } })`
          : scenario === 'active-handler'
            ? `pi.on('turn_start', () => {})`
            : `pi.registerProvider('unexpected-provider', { baseUrl: 'https://example.com', apiKey: 'secret', api: 'openai-completions', models: [] })`
      await write(
        extensionPath,
        `export default function (pi) {
          pi.registerTool({ name: 'inspect', label: 'Inspect', description: 'Read', parameters: { type: 'object', properties: {} }, async execute() { return { content: [], details: {} } } })
          ${extra}
        }\n`,
      )
      const loader = new ControlledResourceLoader({
        cwd: root,
        agentDir: join(root, 'agent'),
        settingsManager: SettingsManager.inMemory(),
        authorizeExtensionTool: async () => ({
          toolId: 'platform:extension:global/safe-extension/inspect',
          actorId: 'actor-1',
          runId: 'run-1',
          documentId: 'document-1',
        }),
      })
      loader.configure({
        skillPaths: [],
        promptPaths: [],
        extensionTools: [
          {
            extensionPath,
            name: 'inspect',
            canonicalToolId: 'platform:extension:global/safe-extension/inspect',
            packageId: 'safe-extension',
            contentSha256: 'a'.repeat(64),
          },
        ],
      })
      await expect(loader.reload()).rejects.toThrowError('resource_loader_diagnostics')
    },
  )

  it('injects only the prepared MCP tools through the isolated Pi extension seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-controlled-mcp-'))
    roots.push(root)
    const executeMcpTool = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'mcp-safe' }],
      details: { provenance: { serverId: 'fixture', toolName: 'read_fixture' } },
    }))
    const loader = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      executeMcpTool,
    })
    const mcpTool = {
      serverId: 'fixture',
      toolName: 'read_fixture',
      canonicalToolId: 'mcp:fixture:read_fixture',
      modelAlias: 'read_fixture',
      description: 'Read fixture',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }
    loader.configure({ skillPaths: [], promptPaths: [], mcpTools: [mcpTool] })
    await loader.reload()
    const extension = loader.getExtensions().extensions[0]!
    expect(extension).toMatchObject({ path: root, hidden: true })
    expect(extension.handlers.size).toBe(0)
    const signal = new AbortController().signal
    await expect(
      extension.tools
        .get('read_fixture')!
        .definition.execute('call-1', {}, signal, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'mcp-safe' }] })
    expect(executeMcpTool).toHaveBeenCalledWith(mcpTool, {}, signal)
    await expect(
      extension.tools
        .get('read_fixture')!
        .definition.execute('call-2', {}, undefined, undefined, {} as never),
    ).rejects.toThrowError('mcp_abort_signal_required')

    const base = { extensions: [], errors: [], runtime: createExtensionRuntime() }
    expect(
      new PiMcpExtensionFactory({ extensionPath: root, execute: executeMcpTool }).append(base, []),
    ).toBe(base)

    const unauthorized = new ControlledResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-missing'),
      settingsManager: SettingsManager.inMemory(),
    })
    unauthorized.configure({ skillPaths: [], promptPaths: [], mcpTools: [mcpTool] })
    await expect(unauthorized.reload()).rejects.toThrowError('resource_loader_diagnostics')
  })
})
