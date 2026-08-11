import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceActivationStore, initializeAgentResourceHome } from '@genoffice/agent-resource'
import { OpenGenOfficeMcpConfigResolver } from '../src/mcp-config-resolver'
import { McpConnectionSupervisor } from '../src/mcp-connection-supervisor'
import { RunResourceService } from '../src/run-resource-service'

const roots: string[] = []
const deviceId = '11111111-1111-4111-8111-111111111111'
const fixtureServer = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

describe('stdio MCP runtime integration', () => {
  it('snapshots, executes, revokes and reaps a real stdio server without exposing its config', async () => {
    const resourceHome = await mkdtemp(join(tmpdir(), 'genoffice-mcp-runtime-'))
    roots.push(resourceHome)
    await initializeAgentResourceHome({
      rootDirectory: resourceHome,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    await write(join(resourceHome, 'mcp', 'servers.json'), {
      schemaVersion: 1,
      servers: [
        {
          serverId: 'fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureServer],
          environment: { inherit: [], credentials: [] },
          enabledToolIds: ['read_fixture'],
          timeoutMs: 2_000,
          enabled: true,
        },
      ],
    })
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })
    const configured = await resolver.resolve()
    await new ResourceActivationStore({ rootDirectory: resourceHome, deviceId }).activate(
      configured[0]!.activation,
    )
    let supervisor: McpConnectionSupervisor | undefined
    const service = new RunResourceService({
      resourceHome,
      deviceId,
      mcpResolver: resolver,
      createMcpSupervisor: (server, authorize) => {
        supervisor = new McpConnectionSupervisor({
          server,
          credentials: { read: vi.fn(async () => undefined) },
          environment: {},
          authorize,
        })
        return supervisor
      },
    })
    const prepared = await service.prepare({
      runId: 'run-mcp',
      model: { providerId: 'fixture', modelId: 'fixture', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(prepared.mcpTools).toMatchObject([
      {
        namespace: 'global',
        serverId: 'fixture',
        toolName: 'read_fixture',
        canonicalToolId: 'mcp:fixture:read_fixture',
      },
    ])
    expect(prepared.snapshot.toolIds).toEqual(['mcp:fixture:read_fixture'])
    expect(prepared.snapshot.resourceHashes).toHaveProperty('mcp:global/fixture')
    expect(JSON.stringify(prepared)).not.toContain(fixtureServer)

    await expect(service.mcpCatalog()).resolves.toMatchObject({
      projectState: 'none',
      servers: [
        {
          serverId: 'fixture',
          state: 'ready',
          action: 'disable',
          tools: expect.arrayContaining([
            {
              canonicalToolId: 'mcp:fixture:read_fixture',
              toolName: 'read_fixture',
              modelAlias: 'read_fixture',
              enabled: true,
            },
            expect.objectContaining({ toolName: 'sleep_fixture', enabled: false }),
          ]),
        },
      ],
    })

    await expect(
      service.callMcpTool(
        'mcp:fixture:read_fixture',
        { value: 'integrated' },
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-mcp',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'mcp:integrated:canary-missing:env-clean' }],
      details: {
        provenance: { serverId: 'fixture', toolName: 'read_fixture', runId: 'run-mcp' },
      },
    })

    await new ResourceActivationStore({ rootDirectory: resourceHome, deviceId }).revoke(
      configured[0]!.activation,
    )
    await expect(
      service.callMcpTool(
        'mcp:fixture:read_fixture',
        {},
        {
          actorId: 'session-1',
          documentId: 'document-1',
          runId: 'run-mcp',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'capability_revoked' })

    const pid = supervisor!.pid
    await expect(
      service.setMcpServerEnabled({ namespace: 'global' }, 'fixture', false),
    ).resolves.toMatchObject({
      servers: [expect.objectContaining({ state: 'disabled', action: 'enable' })],
    })

    service.releaseRun('run-mcp')
    await service.shutdown()
    expect(supervisor!.pid).toBeNull()
    expect(pid).toBeTypeOf('number')
  })
})
