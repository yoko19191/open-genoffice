import { describe, expect, it, vi } from 'vitest'
import { McpAuthorizationBroker } from '../src/mcp-authorization-broker'

const input = {
  actorId: 'actor',
  documentId: 'document',
  runId: 'run',
  serverId: 'fixture',
  toolName: 'read_fixture',
  canonicalToolId: 'mcp:fixture:read_fixture',
  effect: 'read' as const,
  arguments: {},
}

describe('McpAuthorizationBroker', () => {
  it('applies hard effect, run, and argument policy in deny-first order', async () => {
    const authorizeRun = vi.fn(async () => true)
    const authorizeArguments = vi.fn(async () => true)
    const broker = new McpAuthorizationBroker({ authorizeRun, authorizeArguments })
    await expect(broker.authorize(input)).resolves.toBe(true)
    await expect(broker.authorize({ ...input, effect: 'mutation' as never })).resolves.toBe(false)
    expect(authorizeRun).toHaveBeenCalledOnce()

    const deniedRun = new McpAuthorizationBroker({ authorizeRun: async () => false })
    await expect(deniedRun.authorize(input)).resolves.toBe(false)
    const deniedArgs = new McpAuthorizationBroker({
      authorizeRun: async () => true,
      authorizeArguments: async () => false,
    })
    await expect(deniedArgs.authorize(input)).resolves.toBe(false)
    const noArgumentPolicy = new McpAuthorizationBroker({ authorizeRun: async () => true })
    await expect(noArgumentPolicy.authorize(input)).resolves.toBe(true)
  })
})
