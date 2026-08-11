import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type Extension,
  type LoadExtensionsResult,
  type RegisteredTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

export type PiMcpTool = {
  serverId: string
  toolName: string
  canonicalToolId: string
  modelAlias: string
  description: string
  inputSchema: unknown
}

export type PiMcpExtensionFactoryOptions = {
  extensionPath: string
  execute: (
    tool: PiMcpTool,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<{ content: readonly { type: 'text'; text: string }[]; details: unknown }>
}

export class PiMcpExtensionFactory {
  constructor(private readonly options: PiMcpExtensionFactoryOptions) {}

  append(base: LoadExtensionsResult, tools: readonly PiMcpTool[]): LoadExtensionsResult {
    if (tools.length === 0) return base
    const byServer = new Map<string, PiMcpTool[]>()
    for (const tool of tools) {
      const entries = byServer.get(tool.serverId) ?? []
      entries.push(tool)
      byServer.set(tool.serverId, entries)
    }
    const extensions = [...base.extensions]
    for (const [serverId, serverTools] of byServer) {
      const path = this.options.extensionPath
      const sourceInfo = createSyntheticSourceInfo(path, {
        source: `mcp:${serverId}`,
        scope: 'temporary',
      })
      const registered = new Map<string, RegisteredTool>()
      for (const tool of serverTools) {
        const definition: ToolDefinition = {
          name: tool.modelAlias,
          label: tool.toolName,
          description: tool.description,
          promptSnippet: tool.description,
          parameters: tool.inputSchema as ToolDefinition['parameters'],
          executionMode: 'parallel',
          execute: async (_toolCallId, params, signal) => {
            if (!signal) throw new Error('mcp_abort_signal_required')
            const result = await this.options.execute(tool, params, signal)
            return { content: [...result.content], details: result.details }
          },
        }
        registered.set(tool.modelAlias, { definition, sourceInfo })
      }
      const extension: Extension = {
        path,
        resolvedPath: path,
        sourceInfo,
        hidden: true,
        handlers: new Map(),
        tools: registered,
        messageRenderers: new Map(),
        entryRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      }
      extensions.push(extension)
    }
    base.runtime.invalidate('mcp_extension_runtime_isolated')
    return { extensions, errors: [...base.errors], runtime: createExtensionRuntime() }
  }
}
