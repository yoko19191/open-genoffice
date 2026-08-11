import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const require = createRequire(import.meta.url)
const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = join(bundleRoot, 'self-test/native-smoke-extension.mjs')
const mcpServerPath = join(bundleRoot, 'self-test/mcp-stdio-server.mjs')
const nativeAddonPath = join(bundleRoot, 'native/win32-x64/win32-console-mode.node')

const extensionModule = (await import(pathToFileURL(extensionPath).href)) as {
  default?: (api: { registerCommand: (name: string, command: unknown) => void }) => void
}
let extensionCommand: string | undefined
await extensionModule.default?.({
  registerCommand: (name) => {
    extensionCommand = name
  },
})
if (extensionCommand !== 'native-smoke-extension') {
  throw new Error('runtime_capability_extension_failed')
}

const nativeAddon =
  process.platform === 'win32' ? (require(nativeAddonPath), basename(nativeAddonPath)) : null
const client = new Client({ name: 'open-genoffice-native-smoke', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpServerPath],
  stderr: 'pipe',
})
try {
  await client.connect(transport)
  const tools = await client.listTools()
  if (!tools.tools.some((tool) => tool.name === 'native_smoke_echo')) {
    throw new Error('runtime_capability_mcp_list_failed')
  }
  const result = await client.callTool({
    name: 'native_smoke_echo',
    arguments: { value: 'windows-native' },
  })
  const content = result.content[0]
  if (content?.type !== 'text' || content.text !== 'mcp:windows-native') {
    throw new Error('runtime_capability_mcp_call_failed')
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      piEsm: typeof AgentSession === 'function',
      extension: 'native_smoke_extension',
      nativeAddon,
      mcp: { tool: 'native_smoke_echo', result: content.text },
    })}\n`,
  )
} finally {
  await client.close()
}
