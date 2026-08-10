import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectTrustStore,
  ResourceActivationStore,
  initializeAgentResourceHome,
  resolveProjectIdentity,
} from '@genoffice/agent-resource'
import { McpConfigError, OpenGenOfficeMcpConfigResolver } from '../src/mcp-config-resolver'

const roots: string[] = []
const deviceId = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function server(serverId: string) {
  return {
    serverId,
    transport: 'stdio',
    command: process.execPath,
    args: ['/opt/open-genoffice/mcp-server.mjs'],
    environment: {
      inherit: ['LANG'],
      credentials: [
        {
          name: 'MCP_API_TOKEN',
          credentialRef: { slot: `model/mcp-${serverId}/default`, kind: 'api_key' },
        },
      ],
    },
    enabledToolIds: ['read_fixture'],
    timeoutMs: 2_000,
    enabled: true,
  }
}

function httpServer(
  serverId: string,
  transport: 'streamable-http' | 'legacy-sse' = 'streamable-http',
) {
  return {
    serverId,
    transport,
    endpoint: 'https://mcp.example.test/v1',
    credentialRef: { slot: `model/mcp-${serverId}/default`, kind: 'oauth' },
    enabledToolIds: ['read_fixture'],
    timeoutMs: 2_000,
    enabled: true,
  }
}

async function fixture() {
  const resourceHome = await root('genoffice-mcp-home-')
  const projectRoot = await root('genoffice-mcp-project-')
  await initializeAgentResourceHome({
    rootDirectory: resourceHome,
    runtimeVersion: 'test',
    randomUUID: () => deviceId,
  })
  await write(join(resourceHome, 'mcp', 'servers.json'), {
    schemaVersion: 1,
    servers: [server('global-fixture')],
  })
  await write(join(projectRoot, '.open-genoffice', 'project.json'), {
    schemaVersion: 1,
    projectId: '22222222-2222-4222-8222-222222222222',
  })
  await write(join(projectRoot, '.open-genoffice', 'mcp', 'servers.json'), {
    schemaVersion: 1,
    servers: [server('project-fixture')],
  })
  return { resourceHome, projectRoot }
}

describe('OpenGenOfficeMcpConfigResolver', () => {
  it('does not read project config until Project Trust and Activation both allow it', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })

    const untrusted = await resolver.resolve(projectRoot)
    expect(untrusted.map(({ serverId }) => serverId)).toEqual(['global-fixture'])
    expect(untrusted[0]).toMatchObject({ namespace: 'global', state: 'activation_required' })

    const identity = await resolveProjectIdentity(projectRoot, deviceId)
    await new ProjectTrustStore({ rootDirectory: resourceHome, deviceId }).grant(identity)
    const trusted = await resolver.resolve(projectRoot)
    expect(trusted.map(({ serverId }) => serverId)).toEqual(['global-fixture', 'project-fixture'])

    const activation = new ResourceActivationStore({ rootDirectory: resourceHome, deviceId })
    await activation.activate(trusted[0].activation)
    const active = await resolver.resolve(projectRoot)
    expect(active[0]).toMatchObject({ state: 'eligible' })
    expect(active[0].contentSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails closed on unknown fields, interpolation, non-absolute commands and literal env', async () => {
    const resourceHome = await root('genoffice-mcp-invalid-')
    await initializeAgentResourceHome({
      rootDirectory: resourceHome,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })
    const path = join(resourceHome, 'mcp', 'servers.json')
    for (const invalid of [
      { ...server('bad'), command: 'node' },
      { ...server('bad'), args: ['${TOKEN}'] },
      { ...server('bad'), environment: { inherit: [], credentials: [], TOKEN: 'secret' } },
      { ...server('bad'), secret: 'canary' },
      { ...server('bad'), environment: { inherit: [], credentials: 'invalid' } },
      { ...server('bad'), environment: { inherit: [], credentials: [null] } },
      {
        ...server('bad'),
        environment: {
          inherit: [],
          credentials: [{ name: 'TOKEN', credentialRef: { slot: 'invalid', kind: 'api_key' } }],
        },
      },
      {
        ...server('bad'),
        environment: {
          inherit: [],
          credentials: [
            { name: 'TOKEN', credentialRef: { slot: 'model/one/default', kind: 'api_key' } },
            { name: 'TOKEN', credentialRef: { slot: 'model/two/default', kind: 'api_key' } },
          ],
        },
      },
      {
        ...server('bad'),
        environment: {
          inherit: ['TOKEN'],
          credentials: [
            { name: 'TOKEN', credentialRef: { slot: 'model/one/default', kind: 'api_key' } },
          ],
        },
      },
      { ...server('bad'), inheritedEnv: ['LANG', 'LANG'] },
      { ...server('bad'), enabledToolIds: ['read_fixture', 'read_fixture'] },
    ]) {
      await write(path, { schemaVersion: 1, servers: [invalid] })
      await expect(resolver.resolve()).rejects.toBeInstanceOf(McpConfigError)
    }
    await write(path, { schemaVersion: 2, servers: [] })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'mcp_config_invalid' })
    await write(path, { schemaVersion: 1, servers: [server('duplicate'), server('duplicate')] })
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'mcp_config_invalid' })
    await writeFile(path, '{not-json}\n')
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'mcp_config_invalid' })
  })

  it('accepts Streamable HTTP by default and legacy SSE only when explicitly configured', async () => {
    const resourceHome = await root('genoffice-mcp-http-')
    await initializeAgentResourceHome({
      rootDirectory: resourceHome,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    const path = join(resourceHome, 'mcp', 'servers.json')
    await write(path, {
      schemaVersion: 1,
      servers: [
        httpServer('streamable'),
        httpServer('legacy', 'legacy-sse'),
        {
          ...httpServer('ipv6-loopback'),
          endpoint: 'http://[::1]:3456/mcp',
          credentialRef: undefined,
        },
        {
          ...httpServer('loopback'),
          endpoint: 'http://127.0.0.1:3456/mcp',
          credentialRef: undefined,
        },
      ],
    })
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })
    const resolved = await resolver.resolve()
    expect(resolved).toMatchObject([
      {
        serverId: 'ipv6-loopback',
        transport: 'streamable-http',
        endpoint: 'http://[::1]:3456/mcp',
      },
      {
        serverId: 'legacy',
        transport: 'legacy-sse',
        endpoint: 'https://mcp.example.test/v1',
        activation: { capabilities: ['network'] },
      },
      {
        serverId: 'loopback',
        transport: 'streamable-http',
        endpoint: 'http://127.0.0.1:3456/mcp',
      },
      {
        serverId: 'streamable',
        transport: 'streamable-http',
        credentialRef: {
          slot: 'model/mcp-streamable/default',
          kind: 'oauth',
        },
      },
    ])

    for (const invalid of [
      { ...httpServer('bad'), endpoint: 'http://mcp.example.test/v1' },
      { ...httpServer('bad'), endpoint: 'https://user:secret@mcp.example.test/v1' },
      { ...httpServer('bad'), endpoint: 'https://mcp.example.test/v1?token=secret' },
      { ...httpServer('bad'), endpoint: 'https://mcp.example.test/v1#fragment' },
      { ...httpServer('bad'), endpoint: 'https://${MCP_HOST}/v1' },
      { ...httpServer('bad'), transport: 'http' },
      { ...httpServer('bad'), command: process.execPath },
      { ...httpServer('bad'), credentialRef: { slot: 'invalid', kind: 'oauth' } },
      { ...httpServer('bad'), credentialRef: { slot: 'model/mcp-bad/default', kind: 'secret' } },
    ]) {
      await write(path, { schemaVersion: 1, servers: [invalid] })
      await expect(resolver.resolve()).rejects.toMatchObject({ code: 'mcp_config_invalid' })
    }
  })

  it('isolates both servers when global and trusted project IDs collide', async () => {
    const { resourceHome, projectRoot } = await fixture()
    await write(join(projectRoot, '.open-genoffice', 'mcp', 'servers.json'), {
      schemaVersion: 1,
      servers: [server('global-fixture')],
    })
    const identity = await resolveProjectIdentity(projectRoot, deviceId)
    await new ProjectTrustStore({ rootDirectory: resourceHome, deviceId }).grant(identity)

    const resolved = await new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId }).resolve(
      projectRoot,
    )
    expect(resolved).toHaveLength(2)
    expect(resolved.every(({ state }) => state === 'server_id_collision')).toBe(true)
  })

  it('applies exact idempotent server and tool controls without accepting an untrusted scope', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome, deviceId })
    await resolver.activate({ namespace: 'global' }, 'global-fixture')
    expect((await resolver.resolve())[0]).toMatchObject({ state: 'eligible' })

    await resolver.setToolEnabled({ namespace: 'global' }, 'global-fixture', 'second_read', true)
    expect((await resolver.resolve())[0]).toMatchObject({
      state: 'activation_required',
      enabledToolIds: ['read_fixture', 'second_read'],
    })
    await resolver.setToolEnabled({ namespace: 'global' }, 'global-fixture', 'second_read', false)
    await resolver.setServerEnabled({ namespace: 'global' }, 'global-fixture', false)
    await resolver.setServerEnabled({ namespace: 'global' }, 'global-fixture', false)
    expect((await resolver.resolve())[0]).toMatchObject({ state: 'disabled', enabled: false })

    await expect(
      resolver.setServerEnabled({ namespace: 'project', projectRoot }, 'project-fixture', false),
    ).rejects.toMatchObject({ code: 'mcp_project_untrusted' })
    await expect(
      resolver.activate({ namespace: 'global', projectRoot }, 'global-fixture'),
    ).rejects.toMatchObject({ code: 'mcp_scope_invalid' })
    await expect(resolver.activate({ namespace: 'global' }, 'missing')).rejects.toMatchObject({
      code: 'mcp_server_not_found',
    })
    await expect(
      resolver.setToolEnabled({ namespace: 'global' }, 'global-fixture', '../invalid', true),
    ).rejects.toMatchObject({ code: 'mcp_config_invalid' })
    await expect(
      resolver.setServerEnabled({ namespace: 'global' }, 'missing', true),
    ).rejects.toMatchObject({ code: 'mcp_server_not_found' })
    await expect(
      resolver.activate({ namespace: 'project' }, 'project-fixture'),
    ).rejects.toMatchObject({ code: 'mcp_scope_invalid' })
    await expect(
      resolver.activate(
        { namespace: 'project', projectRoot: join(projectRoot, 'missing') },
        'project-fixture',
      ),
    ).rejects.toMatchObject({ code: 'mcp_project_untrusted' })
  })
})
