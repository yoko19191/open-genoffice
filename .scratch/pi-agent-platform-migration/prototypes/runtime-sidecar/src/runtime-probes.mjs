import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { DefaultResourceLoader, VERSION as piVersion } from '@earendil-works/pi-coding-agent'

const here = dirname(fileURLToPath(import.meta.url))

export async function probeExtension(extensionPath, workDir) {
  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir: workDir,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  const tools = []
  const errors = []
  let executionText
  for (const extension of loaded.extensions) {
    for (const [name, tool] of extension.tools) {
      tools.push(name)
      const execution = await tool.definition.execute()
      executionText = execution.content.find((block) => block.type === 'text').text
    }
  }
  for (const error of loaded.errors) errors.push(error.error)
  return {
    extensionCount: loaded.extensions.length,
    errors,
    tools,
    executionText,
  }
}

export function probeNativeAddon() {
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const requireFromPi = createRequire(piEntry)
  const clipboard = requireFromPi('@mariozechner/clipboard')
  return {
    module: '@mariozechner/clipboard',
    exports: Object.keys(clipboard).sort(),
  }
}

export async function probeMcpStdio(nodeExecutable) {
  const serverPath = fileURLToPath(new URL('../fixture/mcp-server.mjs', import.meta.url))
  const transport = new StdioClientTransport({
    command: nodeExecutable,
    args: [serverPath],
    cwd: here,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'open-genoffice-spike04', version: '0.1.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const called = await client.callTool({ name: 'sidecar_ping', arguments: {} })
    return {
      childPid: transport.pid,
      tools: listed.tools.map((tool) => tool.name),
      text: called.content.find((block) => block.type === 'text').text,
    }
  } finally {
    await client.close()
  }
}

export async function runRuntimeProbes({ extensionPath, workDir }) {
  return {
    node: process.version,
    executable: process.execPath,
    piVersion,
    extension: await probeExtension(extensionPath, workDir),
    nativeAddon: probeNativeAddon(),
    mcp: await probeMcpStdio(process.execPath),
  }
}
