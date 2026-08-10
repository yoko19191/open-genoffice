import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PackageLockService,
  ProjectTrustStore,
  initializeAgentResourceHome,
  resolveProjectIdentity,
} from '@genoffice/agent-resource'
import { RunResourceService } from '../src/run-resource-service'
import { McpExecutionError } from '../src/mcp-connection-supervisor'
import type { ResolvedMcpServer } from '../src/mcp-config-resolver'

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

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function fixture() {
  const resourceHome = await root('genoffice-run-resources-')
  const projectRoot = await root('genoffice-run-project-')
  await initializeAgentResourceHome({
    rootDirectory: resourceHome,
    runtimeVersion: 'test',
    randomUUID: () => deviceId,
  })
  await write(
    join(resourceHome, 'agent', 'skills', 'global-skill', 'SKILL.md'),
    '---\nname: global-skill\ndescription: global\n---\nGlobal body\n',
  )
  await write(join(resourceHome, 'agent', 'prompts', 'global.md'), 'Global prompt\n')
  await write(join(resourceHome, 'agent', 'extensions', 'inactive.mjs'), 'export default {}\n')
  await write(
    join(projectRoot, '.open-genoffice', 'project.json'),
    `${JSON.stringify({ schemaVersion: 1, projectId: '22222222-2222-4222-8222-222222222222' })}\n`,
  )
  await write(
    join(projectRoot, '.open-genoffice', 'agent', 'skills', 'project-skill', 'SKILL.md'),
    '---\nname: project-skill\ndescription: project\n---\nProject body\n',
  )
  return { resourceHome, projectRoot }
}

async function packageSource(rootDirectory: string, packageId: string, toolName: string) {
  const directory = join(rootDirectory, `${packageId}-source`)
  await write(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name: packageId,
      version: '1.0.0',
      license: 'MIT',
      pi: { extensions: ['./extension.mjs'] },
      genoffice: {
        capabilities: ['executable'],
        tools: [{ extension: './extension.mjs', name: toolName, effect: 'read' }],
      },
    })}\n`,
  )
  await write(
    join(directory, 'extension.mjs'),
    `export default function (pi) { pi.registerTool({ name: '${toolName}', label: 'Read', description: 'Read', parameters: { type: 'object', properties: {} }, async execute() { return { content: [], details: {} } } }) }\n`,
  )
  return directory
}

function mcpServer(
  serverId: string,
  state: ResolvedMcpServer['state'] = 'eligible',
): ResolvedMcpServer {
  const contentSha256 = serverId.charCodeAt(0).toString(16).padStart(64, '0').slice(-64)
  return {
    namespace: 'global',
    serverId,
    transport: 'stdio',
    command: process.execPath,
    args: [],
    inheritedEnv: [],
    credentialEnvironment: [],
    enabledToolIds: ['shared_alias'],
    timeoutMs: 2_000,
    enabled: state !== 'disabled',
    contentSha256,
    activation: {
      namespace: 'global',
      resourceId: `mcp/${serverId}`,
      source: `global:mcp/${serverId}`,
      contentSha256,
      capabilities: ['executable'],
    },
    state,
  }
}

describe('RunResourceService', () => {
  it('manages fixed Packages through a path-free catalog and requires Project Trust', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const service = new RunResourceService({ resourceHome, deviceId })
    const source = await packageSource(resourceHome, 'managed-extension', 'inspect_managed')

    const installed = await service.installPackage({
      namespace: 'global',
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'managed-extension',
      source: { type: 'local', path: source },
    })
    expect(installed).toMatchObject({
      globalGeneration: 2,
      packages: [
        {
          namespace: 'global',
          packageId: 'managed-extension',
          source: expect.stringMatching(/^local-sha256:[0-9a-f]{64}$/),
          status: 'activation_required',
          enabled: true,
          resourceCount: 1,
        },
      ],
    })
    expect(JSON.stringify(installed)).not.toContain(source)

    expect(
      await service.activatePackage({
        namespace: 'global',
        operationId: '44444444-4444-4444-8444-444444444444',
        packageId: 'managed-extension',
      }),
    ).toMatchObject({ packages: [expect.objectContaining({ status: 'eligible' })] })
    expect(
      await service.disablePackage({
        namespace: 'global',
        operationId: '55555555-5555-4555-8555-555555555555',
        packageId: 'managed-extension',
      }),
    ).toMatchObject({ packages: [expect.objectContaining({ status: 'disabled' })] })
    expect(
      await service.enablePackage({
        namespace: 'global',
        operationId: '66666666-6666-4666-8666-666666666666',
        packageId: 'managed-extension',
      }),
    ).toMatchObject({ packages: [expect.objectContaining({ status: 'eligible' })] })

    await expect(
      service.installPackage({
        namespace: 'project',
        projectRoot,
        operationId: '77777777-7777-4777-8777-777777777777',
        packageId: 'project-extension',
        source: {
          type: 'local',
          path: await packageSource(projectRoot, 'project-extension', 'inspect_project'),
        },
      }),
    ).rejects.toMatchObject({ code: 'package_project_untrusted' })
    await service.grantProjectTrust(projectRoot)
    const projectInstalled = await service.installPackage({
      namespace: 'project',
      projectRoot,
      operationId: '88888888-8888-4888-8888-888888888888',
      packageId: 'project-extension',
      source: {
        type: 'local',
        path: await packageSource(projectRoot, 'project-extension', 'inspect_project'),
      },
    })
    expect(projectInstalled).toMatchObject({
      globalGeneration: 4,
      projectGeneration: 2,
      packages: expect.arrayContaining([
        expect.objectContaining({ namespace: 'global', packageId: 'managed-extension' }),
        expect.objectContaining({ namespace: 'project', packageId: 'project-extension' }),
      ]),
    })
    expect(JSON.stringify(projectInstalled)).not.toContain(projectRoot)

    expect(
      await service.uninstallPackage({
        namespace: 'project',
        projectRoot,
        operationId: '99999999-9999-4999-8999-999999999999',
        packageId: 'project-extension',
      }),
    ).toMatchObject({ projectGeneration: 3 })
    await expect(
      service.packageCatalog({ namespace: 'global', projectRoot }),
    ).rejects.toMatchObject({ code: 'package_scope_invalid' })
  })

  it('adds newly trusted project resources only to the next run snapshot', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const service = new RunResourceService({ resourceHome, deviceId })
    const model = {
      providerId: 'local',
      modelId: 'test-model',
      capabilities: ['tool-use', 'text-input'],
    }
    const first = await service.prepare({
      runId: 'run-1',
      projectRoot,
      model,
      toolIds: ['office:pdf:read'],
    })
    expect(first.catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: 'global-skill', state: 'eligible' }),
        expect.objectContaining({
          resourceId: 'project-skill',
          state: 'restricted',
          reason: 'project_untrusted',
        }),
      ]),
    )
    expect(first.skillPaths).toEqual([join(resourceHome, 'agent', 'skills', 'global-skill')])
    expect(first.promptPaths).toEqual([join(resourceHome, 'agent', 'prompts', 'global.md')])
    expect(Object.keys(first.snapshot.resourceHashes)).toEqual([
      'prompt:global/global',
      'skill:global/global-skill',
    ])

    const identity = await resolveProjectIdentity(projectRoot, deviceId)
    await new ProjectTrustStore({ rootDirectory: resourceHome, deviceId }).grant(identity)
    const second = await service.prepare({
      runId: 'run-2',
      projectRoot,
      model,
      toolIds: ['office:pdf:read'],
    })
    expect(second.skillPaths).toEqual([
      join(resourceHome, 'agent', 'skills', 'global-skill'),
      join(projectRoot, '.open-genoffice', 'agent', 'skills', 'project-skill'),
    ])
    expect(Object.keys(second.snapshot.resourceHashes)).toEqual([
      'prompt:global/global',
      'skill:global/global-skill',
      'skill:project/project-skill',
    ])
    expect(first.snapshot.resourceHashes).not.toHaveProperty('skill:project/project-skill')
    await expect(service.verify(first.snapshot, projectRoot)).resolves.toBeUndefined()
  })

  it('projects only safe catalog metadata and grants or revokes the selected project', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const service = new RunResourceService({ resourceHome, deviceId })

    expect(await service.catalog()).toMatchObject({ projectState: 'none' })
    const untrusted = await service.catalog(projectRoot)
    expect(untrusted).toMatchObject({
      projectState: 'untrusted',
      resources: expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'project-skill',
          source: 'project:skills/project-skill',
          action: 'trust_project',
        }),
        expect.objectContaining({
          resourceId: 'global-skill',
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          action: 'none',
        }),
        expect.objectContaining({
          resourceId: 'inactive',
          reason: 'activation_required',
          action: 'activate_resource',
        }),
      ]),
    })
    expect(JSON.stringify(untrusted)).not.toContain(projectRoot)
    expect(JSON.stringify(untrusted)).not.toContain('Project body')
    expect(JSON.stringify(untrusted)).not.toContain('activatedCapabilities')

    const trusted = await service.grantProjectTrust(projectRoot)
    expect(trusted).toMatchObject({
      projectState: 'trusted',
      resources: expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'project-skill',
          state: 'eligible',
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
    })
    expect(await service.revokeProjectTrust(projectRoot)).toMatchObject({
      projectState: 'untrusted',
    })

    await write(
      join(projectRoot, '.open-genoffice', 'agent', 'skills', 'global-skill', 'SKILL.md'),
      '---\nname: global-skill\ndescription: collision\n---\nCollision\n',
    )
    await write(join(resourceHome, 'agent', 'prompts', 'malformed.txt'), 'wrong extension\n')
    expect(await service.catalog(projectRoot)).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'global-skill',
          reason: 'resource_collision',
          action: 'rename_resource',
        }),
        expect.objectContaining({
          resourceId: 'malformed',
          state: 'invalid',
          action: 'fix_resource',
        }),
      ]),
    })

    const invalidProject = await root('genoffice-invalid-project-projection-')
    expect(await service.catalog(invalidProject)).toMatchObject({ projectState: 'invalid' })
    await expect(service.grantProjectTrust(invalidProject)).rejects.toMatchObject({
      code: 'project_manifest_invalid',
    })
  })

  it('only snapshots the controlled read tool when at least one Skill is active', async () => {
    const { resourceHome } = await fixture()
    const service = new RunResourceService({ resourceHome, deviceId })
    const withSkill = await service.prepare({
      runId: 'run-with-skill',
      model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
      toolIds: ['platform:resource:read', 'office:pdf:read'],
    })
    expect(withSkill.snapshot.toolIds).toEqual(['office:pdf:read', 'platform:resource:read'])

    await rm(join(resourceHome, 'agent', 'skills', 'global-skill'), {
      recursive: true,
      force: true,
    })
    const withoutSkill = await service.prepare({
      runId: 'run-without-skill',
      model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
      toolIds: ['platform:resource:read', 'office:pdf:read'],
    })
    expect(withoutSkill.snapshot.toolIds).toEqual(['office:pdf:read'])
  })

  it('rejects current execution after Trust, resource, tool, or permission revocation', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const permissionVersion = vi.fn(() => 'permission-1')
    const isToolEnabled = vi.fn(() => true)
    const service = new RunResourceService({
      resourceHome,
      deviceId,
      permissionVersion,
      isToolEnabled,
    })
    const identity = await resolveProjectIdentity(projectRoot, deviceId)
    const trust = new ProjectTrustStore({ rootDirectory: resourceHome, deviceId })
    await trust.grant(identity)
    const prepared = await service.prepare({
      runId: 'run-1',
      projectRoot,
      model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
      toolIds: ['office:pdf:read'],
    })
    await expect(service.verify(prepared.snapshot, projectRoot)).resolves.toBeUndefined()

    isToolEnabled.mockReturnValue(false)
    await expect(service.verify(prepared.snapshot, projectRoot)).rejects.toMatchObject({
      code: 'capability_revoked',
    })
    isToolEnabled.mockReturnValue(true)
    permissionVersion.mockReturnValue('permission-2')
    await expect(service.verify(prepared.snapshot, projectRoot)).rejects.toMatchObject({
      code: 'capability_revoked',
    })
    permissionVersion.mockReturnValue('permission-1')
    await trust.revoke(identity)
    await expect(service.verify(prepared.snapshot, projectRoot)).rejects.toMatchObject({
      code: 'capability_revoked',
    })
  })

  it('fails closed for a changed resource hash and ignores an invalid project identity', async () => {
    const { resourceHome } = await fixture()
    const service = new RunResourceService({ resourceHome, deviceId })
    const prepared = await service.prepare({
      runId: 'run-1',
      model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
      toolIds: [],
    })
    await write(
      join(resourceHome, 'agent', 'skills', 'global-skill', 'SKILL.md'),
      '---\nname: global-skill\ndescription: global\n---\nChanged body\n',
    )
    await expect(service.verify(prepared.snapshot)).rejects.toMatchObject({
      code: 'capability_revoked',
    })

    const invalidProject = await root('genoffice-invalid-run-project-')
    await write(
      join(invalidProject, '.open-genoffice', 'agent', 'skills', 'safe-manifest', 'SKILL.md'),
      'must not be read\n',
    )
    const invalid = await service.prepare({
      runId: 'run-2',
      projectRoot: invalidProject,
      model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
      toolIds: [],
    })
    expect(invalid.catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'safe-manifest',
          state: 'restricted',
          reason: 'project_untrusted',
        }),
      ]),
    )
  })

  it('adds activated Package tools and immutable hashes only to the next run snapshot', async () => {
    const { resourceHome } = await fixture()
    const packages = new PackageLockService({ resourceHome, deviceId, namespace: 'global' })
    await packages.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'safe-extension',
      source: {
        type: 'local',
        path: await packageSource(resourceHome, 'safe-extension', 'inspect_package'),
      },
    })
    const service = new RunResourceService({ resourceHome, deviceId })
    const before = await service.prepare({
      runId: 'run-before-activation',
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(before.extensionTools).toEqual([])
    expect(before.snapshot.resourceHashes).not.toHaveProperty('package:global/safe-extension')

    await packages.activate('safe-extension')
    const after = await service.prepare({
      runId: 'run-after-activation',
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(after.extensionTools).toEqual([
      expect.objectContaining({
        packageId: 'safe-extension',
        name: 'inspect_package',
        canonicalToolId: 'platform:extension:global/safe-extension/inspect_package',
        extensionPath: expect.stringContaining('extension.mjs'),
      }),
    ])
    expect(after.snapshot.resourceHashes).toMatchObject({
      'package:global/safe-extension': expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(after.snapshot.toolIds).toContain(
      'platform:extension:global/safe-extension/inspect_package',
    )
    expect(before.snapshot.toolIds).not.toContain(
      'platform:extension:global/safe-extension/inspect_package',
    )
    await expect(service.verify(after.snapshot)).resolves.toBeUndefined()
    await packages.disable('safe-extension')
    await expect(service.verify(after.snapshot)).rejects.toMatchObject({
      code: 'capability_revoked',
    })
  })

  it('isolates every Package involved in a model alias collision', async () => {
    const { resourceHome } = await fixture()
    const packages = new PackageLockService({ resourceHome, deviceId, namespace: 'global' })
    for (const [index, packageId] of ['first-extension', 'second-extension'].entries()) {
      await packages.install({
        operationId: `${index + 3}3333333-3333-4333-8333-333333333333`,
        packageId,
        source: {
          type: 'local',
          path: await packageSource(resourceHome, packageId, 'shared_alias'),
        },
      })
      await packages.activate(packageId)
    }
    await packages.install({
      operationId: '55555555-5555-4555-8555-555555555555',
      packageId: 'reserved-extension',
      source: {
        type: 'local',
        path: await packageSource(resourceHome, 'reserved-extension', 'read'),
      },
    })
    await packages.activate('reserved-extension')
    const service = new RunResourceService({ resourceHome, deviceId })
    const prepared = await service.prepare({
      runId: 'run-collision',
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(prepared.extensionTools).toEqual([])
    expect(prepared.packageDiagnostics).toEqual([
      { packageId: 'first-extension', code: 'tool_alias_collision' },
      { packageId: 'reserved-extension', code: 'tool_alias_collision' },
      { packageId: 'second-extension', code: 'tool_alias_collision' },
    ])
    expect(Object.keys(prepared.snapshot.resourceHashes)).not.toEqual(
      expect.arrayContaining([
        'package:global/first-extension',
        'package:global/reserved-extension',
        'package:global/second-extension',
      ]),
    )
  })

  it('loads project Package tools only after Project Trust and project Activation', async () => {
    const { resourceHome, projectRoot } = await fixture()
    const projectPackages = new PackageLockService({
      resourceHome,
      deviceId,
      namespace: 'project',
      projectRoot,
    })
    await projectPackages.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'project-extension',
      source: {
        type: 'local',
        path: await packageSource(projectRoot, 'project-extension', 'inspect_project'),
      },
    })
    await projectPackages.activate('project-extension')
    const service = new RunResourceService({ resourceHome, deviceId })
    const input = {
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [] as string[],
    }
    expect(
      (await service.prepare({ ...input, runId: 'run-untrusted', projectRoot })).extensionTools,
    ).toEqual([])
    await new ProjectTrustStore({ rootDirectory: resourceHome, deviceId }).grant(
      await resolveProjectIdentity(projectRoot, deviceId),
    )
    expect(
      (await service.prepare({ ...input, runId: 'run-trusted', projectRoot })).extensionTools,
    ).toEqual([
      expect.objectContaining({
        packageId: 'project-extension',
        canonicalToolId: 'platform:extension:project/project-extension/inspect_project',
      }),
    ])
  })

  it('isolates MCP and Package tools on either side of a model alias collision', async () => {
    const { resourceHome } = await fixture()
    const packages = new PackageLockService({ resourceHome, deviceId, namespace: 'global' })
    await packages.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'colliding-package',
      source: {
        type: 'local',
        path: await packageSource(resourceHome, 'colliding-package', 'shared_alias'),
      },
    })
    await packages.activate('colliding-package')
    const configured = mcpServer('collision-fixture')
    const mcpResolver = {
      resolve: vi.fn(async () => [configured]),
      activate: vi.fn(),
      setServerEnabled: vi.fn(),
      setToolEnabled: vi.fn(),
    }
    const supervisor = {
      connect: vi.fn(async () => [
        {
          canonicalToolId: 'mcp:collision-fixture:shared_alias',
          modelAlias: 'shared_alias',
          serverId: 'collision-fixture',
          toolName: 'shared_alias',
          description: 'Shared alias',
          inputSchema: { type: 'object' },
          effect: 'read' as const,
        },
      ]),
      catalogTools: vi.fn(() => []),
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
    }
    const service = new RunResourceService({
      resourceHome,
      deviceId,
      mcpResolver,
      createMcpSupervisor: () => supervisor as never,
    })
    const prepared = await service.prepare({
      runId: 'run-cross-collision',
      model: { providerId: 'local', modelId: 'model', capabilities: ['tool-use'] },
      toolIds: [],
    })
    expect(prepared.extensionTools).toEqual([])
    expect(prepared.mcpTools).toEqual([])
    expect(prepared.packageDiagnostics).toContainEqual({
      packageId: 'colliding-package',
      code: 'tool_alias_collision',
    })
    expect(prepared.mcpDiagnostics).toContainEqual({
      serverId: 'collision-fixture',
      code: 'tool_alias_collision',
    })
    await expect(service.mcpCatalog()).resolves.toMatchObject({
      servers: [
        expect.objectContaining({ state: 'tool_alias_collision', action: 'fix_collision' }),
      ],
    })
    await expect(
      service.callMcpTool(
        'mcp:collision-fixture:shared_alias',
        {},
        {
          actorId: 'actor',
          documentId: 'document',
          runId: 'missing-run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrowError('tool_not_in_snapshot')
  })

  it('projects every safe MCP state and forwards project-scoped lifecycle controls', async () => {
    const { resourceHome, projectRoot } = await fixture()
    await new ProjectTrustStore({ rootDirectory: resourceHome, deviceId }).grant(
      await resolveProjectIdentity(projectRoot, deviceId),
    )
    const servers = [
      mcpServer('activation', 'activation_required'),
      mcpServer('collision', 'server_id_collision'),
      mcpServer('disabled', 'disabled'),
      mcpServer('ready'),
      mcpServer('credential'),
      mcpServer('failed'),
    ].map((server) => ({ ...server, namespace: 'project' as const }))
    const mcpResolver = {
      resolve: vi.fn(async () => servers),
      activate: vi.fn(async () => undefined),
      setServerEnabled: vi.fn(async () => undefined),
      setToolEnabled: vi.fn(async () => undefined),
    }
    const closed: string[] = []
    const service = new RunResourceService({
      resourceHome,
      deviceId,
      mcpResolver,
      createMcpSupervisor: (server) =>
        ({
          connect: vi.fn(async () => {
            if (server.serverId === 'credential') {
              throw new McpExecutionError('mcp_credential_missing')
            }
            if (server.serverId === 'failed') throw new Error('opaque')
            return [
              {
                canonicalToolId: `mcp:${server.serverId}:${server.serverId}_read`,
                modelAlias: `${server.serverId}_read`,
                serverId: server.serverId,
                toolName: `${server.serverId}_read`,
                description: 'Read',
                inputSchema: { type: 'object' },
                effect: 'read' as const,
              },
            ]
          }),
          catalogTools: vi.fn(() => [
            {
              canonicalToolId: `mcp:${server.serverId}:${server.serverId}_read`,
              modelAlias: `${server.serverId}_read`,
              serverId: server.serverId,
              toolName: `${server.serverId}_read`,
              description: 'Read',
              inputSchema: { type: 'object' },
              effect: 'read' as const,
            },
          ]),
          callTool: vi.fn(),
          close: vi.fn(async () => {
            closed.push(server.serverId)
          }),
        }) as never,
    })
    const catalog = await service.mcpCatalog(projectRoot)
    expect(catalog.projectState).toBe('trusted')
    expect(catalog.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: 'activation', action: 'activate' }),
        expect.objectContaining({ serverId: 'collision', action: 'fix_collision' }),
        expect.objectContaining({ serverId: 'disabled', action: 'enable' }),
        expect.objectContaining({ serverId: 'ready', state: 'ready', action: 'disable' }),
        expect.objectContaining({
          serverId: 'credential',
          state: 'needs_credentials',
          action: 'configure_credentials',
        }),
        expect.objectContaining({ serverId: 'failed', state: 'failed', action: 'retry' }),
      ]),
    )

    const scope = { namespace: 'project' as const, projectRoot }
    await service.activateMcp(scope, 'activation')
    await service.setMcpServerEnabled(scope, 'ready', true)
    await service.setMcpToolEnabled(scope, 'ready', 'shared_alias', false)
    await service.retryMcp(scope, 'ready')
    expect(mcpResolver.activate).toHaveBeenCalledWith(scope, 'activation')
    expect(mcpResolver.setServerEnabled).toHaveBeenCalledWith(scope, 'ready', true)
    expect(mcpResolver.setToolEnabled).toHaveBeenCalledWith(scope, 'ready', 'shared_alias', false)
    expect(closed).toContain('ready')

    const untrustedRoot = await root('genoffice-mcp-untrusted-')
    expect(await service.mcpCatalog(untrustedRoot)).toMatchObject({ projectState: 'invalid' })
    await service.shutdown()
  })
})
