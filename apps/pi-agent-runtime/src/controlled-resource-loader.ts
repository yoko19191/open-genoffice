import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  DefaultResourceLoader,
  createExtensionRuntime,
  type Extension,
  type LoadExtensionsResult,
  type RegisteredTool,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { PiMcpExtensionFactory, type PiMcpTool } from './pi-mcp-extension-factory'

type DefaultOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

export type ControlledResourceLoaderOptions = Pick<
  DefaultOptions,
  'cwd' | 'agentDir' | 'settingsManager' | 'eventBus' | 'systemPrompt' | 'appendSystemPrompt'
> & {
  authorizeExtensionTool?: (canonicalToolId: string) => Promise<ExtensionToolProvenance>
  executeMcpTool?: (
    tool: PiMcpTool,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<{ content: readonly { type: 'text'; text: string }[]; details: unknown }>
}

export type ExtensionToolProvenance = {
  toolId: string
  actorId: string
  runId: string
  documentId: string
}

export type ControlledExtensionTool = {
  extensionPath: string
  name: string
  canonicalToolId: string
  packageId: string
  contentSha256: string
}

export type ControlledResourcePaths = {
  skillPaths: readonly string[]
  promptPaths: readonly string[]
  extensionTools?: readonly ControlledExtensionTool[]
  mcpTools?: readonly PiMcpTool[]
}

export class ControlledResourceLoader implements ResourceLoader {
  private delegate: DefaultResourceLoader
  private paths: Required<ControlledResourcePaths> = {
    skillPaths: [],
    promptPaths: [],
    extensionTools: [],
    mcpTools: [],
  }

  constructor(private readonly options: ControlledResourceLoaderOptions) {
    this.delegate = this.createDelegate()
  }

  configure(paths: ControlledResourcePaths): void {
    this.paths = {
      skillPaths: [...paths.skillPaths],
      promptPaths: [...paths.promptPaths],
      extensionTools: (paths.extensionTools ?? []).map((tool) => ({ ...tool })),
      mcpTools: (paths.mcpTools ?? []).map((tool) => ({ ...tool })),
    }
  }

  getExtensions(): ReturnType<ResourceLoader['getExtensions']> {
    return this.delegate.getExtensions()
  }

  getSkills(): ReturnType<ResourceLoader['getSkills']> {
    return this.delegate.getSkills()
  }

  getPrompts(): ReturnType<ResourceLoader['getPrompts']> {
    return this.delegate.getPrompts()
  }

  getThemes(): ReturnType<ResourceLoader['getThemes']> {
    return this.delegate.getThemes()
  }

  getAgentsFiles(): ReturnType<ResourceLoader['getAgentsFiles']> {
    return this.delegate.getAgentsFiles()
  }

  getSystemPrompt(): ReturnType<ResourceLoader['getSystemPrompt']> {
    return this.delegate.getSystemPrompt()
  }

  getSystemPromptSource(): ReturnType<ResourceLoader['getSystemPromptSource']> {
    return this.delegate.getSystemPromptSource()
  }

  getAppendSystemPrompt(): ReturnType<ResourceLoader['getAppendSystemPrompt']> {
    return this.delegate.getAppendSystemPrompt()
  }

  getAppendSystemPromptSources(): ReturnType<ResourceLoader['getAppendSystemPromptSources']> {
    return this.delegate.getAppendSystemPromptSources()
  }

  extendResources(paths: Parameters<ResourceLoader['extendResources']>[0]): void {
    if (
      (paths.skillPaths?.length ?? 0) > 0 ||
      (paths.promptPaths?.length ?? 0) > 0 ||
      (paths.themePaths?.length ?? 0) > 0
    ) {
      throw new Error('resource_extension_not_authorized')
    }
  }

  async reload(options?: Parameters<ResourceLoader['reload']>[0]): Promise<void> {
    await this.assertPaths()
    const candidate = this.createDelegate()
    await candidate.reload(options)
    if (
      candidate.getExtensions().errors.length > 0 ||
      candidate.getSkills().diagnostics.length > 0 ||
      candidate.getPrompts().diagnostics.length > 0
    ) {
      throw new Error('resource_loader_diagnostics')
    }
    this.delegate = candidate
  }

  private async assertPaths(): Promise<void> {
    try {
      await Promise.all([
        ...this.paths.skillPaths.map(async (path) => {
          const metadata = await lstat(path)
          if (!metadata.isDirectory()) throw new Error('invalid')
        }),
        ...this.paths.promptPaths.map(async (path) => {
          const metadata = await lstat(path)
          if (!metadata.isFile()) throw new Error('invalid')
        }),
        ...this.paths.extensionTools.map(async ({ extensionPath }) => {
          const metadata = await lstat(extensionPath)
          if (!metadata.isFile()) throw new Error('invalid')
        }),
      ])
    } catch {
      throw new Error('resource_loader_diagnostics')
    }
  }

  private createDelegate(): DefaultResourceLoader {
    const extensionTools = this.paths.extensionTools.map((tool) => ({ ...tool }))
    const mcpTools = this.paths.mcpTools.map((tool) => ({ ...tool }))
    return new DefaultResourceLoader({
      ...this.options,
      additionalExtensionPaths: [
        ...new Set(extensionTools.map(({ extensionPath }) => extensionPath)),
      ],
      additionalSkillPaths: [...this.paths.skillPaths],
      additionalPromptTemplatePaths: [...this.paths.promptPaths],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionsOverride: (base) => {
        const isolated = this.isolateExtensions(base, extensionTools)
        if (mcpTools.length === 0) return isolated
        if (!this.options.executeMcpTool) {
          isolated.errors.push({ path: 'mcp://', error: 'MCP execution is not authorized' })
          return isolated
        }
        return new PiMcpExtensionFactory({
          extensionPath: this.options.cwd,
          execute: this.options.executeMcpTool,
        }).append(isolated, mcpTools)
      },
    })
  }

  private isolateExtensions(
    base: LoadExtensionsResult,
    expectedTools: readonly ControlledExtensionTool[],
  ): LoadExtensionsResult {
    const errors = [...base.errors]
    const expectedByPath = new Map<string, ControlledExtensionTool[]>()
    for (const tool of expectedTools) {
      const path = resolve(tool.extensionPath)
      const entries = expectedByPath.get(path) ?? []
      entries.push(tool)
      expectedByPath.set(path, entries)
    }
    const loadedByPath = new Map(
      base.extensions.map((extension) => [extension.resolvedPath, extension]),
    )
    const providerRegistrationAttempted =
      base.runtime.pendingProviderRegistrations.length > 0 ||
      base.runtime.pendingNativeProviderRegistrations.length > 0
    const extensions: Extension[] = []
    for (const [path, expected] of expectedByPath) {
      const extension = loadedByPath.get(path)
      if (!extension) {
        errors.push({ path, error: 'Declared Extension did not load' })
        continue
      }
      const registeredNames = [...extension.tools.keys()].sort()
      const expectedNames = expected.map(({ name }) => name).sort()
      const hasUndeclaredAuthority =
        extension.handlers.size > 0 ||
        extension.commands.size > 0 ||
        extension.flags.size > 0 ||
        extension.shortcuts.size > 0 ||
        extension.messageRenderers.size > 0 ||
        (extension.entryRenderers?.size ?? 0) > 0 ||
        extension.markdownTransformer !== undefined ||
        providerRegistrationAttempted
      if (
        hasUndeclaredAuthority ||
        registeredNames.length !== expectedNames.length ||
        registeredNames.some((name, index) => name !== expectedNames[index])
      ) {
        errors.push({ path, error: 'Extension authority does not match Package manifest' })
        continue
      }
      const tools = new Map<string, RegisteredTool>()
      for (const permission of expected) {
        const registered = extension.tools.get(permission.name)!
        tools.set(permission.name, {
          sourceInfo: registered.sourceInfo,
          definition: {
            ...registered.definition,
            execute: async (toolCallId, params, signal, onUpdate, context) => {
              const provenance = await this.options.authorizeExtensionTool?.(
                permission.canonicalToolId,
              )
              if (!provenance) throw new Error('extension_tool_not_authorized')
              const result = await registered.definition.execute(
                toolCallId,
                params,
                signal,
                onUpdate,
                context,
              )
              return {
                ...result,
                details: { extension: result.details, provenance },
              }
            },
          },
        })
      }
      extensions.push({
        path: extension.path,
        resolvedPath: extension.resolvedPath,
        sourceInfo: extension.sourceInfo,
        handlers: new Map(),
        tools,
        messageRenderers: new Map(),
        entryRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      })
    }
    base.runtime.invalidate('extension_runtime_isolated')
    return { extensions, errors, runtime: createExtensionRuntime() }
  }
}
