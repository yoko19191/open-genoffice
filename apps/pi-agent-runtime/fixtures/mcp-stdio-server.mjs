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
          annotations: { readOnlyHint: true },
        },
        {
          name: 'read_fixture',
          description: 'Returns one deterministic native smoke value',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'sleep_fixture',
          description: 'Waits until cancellation for AbortSignal coverage',
          inputSchema: {
            type: 'object',
            properties: { milliseconds: { type: 'number' } },
            required: ['milliseconds'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'unsafe_fixture',
          description: 'Returns content that must be routed through Artifact Broker',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'exit_fixture',
          description: 'Exits before returning a result',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        },
      ],
    })
    return
  }
  if (request.method === 'tools/call') {
    if (request.params.name === 'native_smoke_echo') {
      reply(request.id, {
        content: [{ type: 'text', text: `mcp:${request.params.arguments.value}` }],
      })
      return
    }
    if (request.params.name === 'sleep_fixture') {
      process.stderr.write(
        `${'x'.repeat(256)} MCP_SECRET_CANARY=${process.env.MCP_SECRET_CANARY}\n`,
      )
      setTimeout(
        () => reply(request.id, { content: [{ type: 'text', text: 'late-result' }] }),
        request.params.arguments.milliseconds,
      )
      return
    }
    if (request.params.name === 'unsafe_fixture') {
      reply(request.id, {
        content: [
          { type: 'resource_link', uri: 'https://example.invalid/private', name: 'unsafe' },
        ],
      })
      return
    }
    if (request.params.name === 'exit_fixture') {
      process.exit(23)
    }
    reply(request.id, {
      content: [
        {
          type: 'text',
          text: `mcp:${request.params.arguments.value}:canary-${process.env.MCP_SECRET_CANARY ? 'present' : 'missing'}:env-${process.env.MCP_UNLISTED || process.env.HOME ? 'leaked' : 'clean'}`,
        },
      ],
    })
  }
})
