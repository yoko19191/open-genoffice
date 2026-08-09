import { createInterface } from 'node:readline'

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'open-genoffice-native-smoke', version: '1.0.0' },
    })
    return
  }
  if (request.method === 'tools/list') {
    reply(request.id, {
      tools: [
        {
          name: 'native_smoke_echo',
          description: 'Returns one deterministic native smoke value',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
    })
    return
  }
  if (request.method === 'tools/call') {
    reply(request.id, {
      content: [{ type: 'text', text: `mcp:${request.params.arguments.value}` }],
    })
  }
})
