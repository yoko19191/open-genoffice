import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer({ name: 'open-genoffice-spike04-fixture', version: '0.1.0' })
server.registerTool('sidecar_ping', { description: 'MCP stdio packaging probe' }, async () => ({
  content: [{ type: 'text', text: 'mcp-pong' }],
}))

await server.connect(new StdioServerTransport())
