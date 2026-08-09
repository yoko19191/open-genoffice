import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectTrustStore,
  initializeAgentResourceHome,
  resolveProjectIdentity,
} from '@genoffice/agent-resource'
import { RunResourceService } from '../src/run-resource-service'

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

describe('RunResourceService', () => {
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
})
