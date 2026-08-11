import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CapabilitySnapshotError,
  createCapabilitySnapshot,
  scanResourceCatalog,
  verifyCapabilitySnapshot,
} from '../src'

const roots: string[] = []

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

describe('Resource Catalog', () => {
  it('discovers only fixed global and trusted project Skill/Prompt paths', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const projectRoot = await root('genoffice-resource-project-')
    await write(join(resourceHome, 'agent', 'skills', 'global-skill', 'SKILL.md'), '# Global\n')
    await write(join(resourceHome, 'agent', 'prompts', 'global.md'), 'Global prompt\n')
    await write(
      join(projectRoot, '.open-genoffice', 'agent', 'skills', 'project-skill', 'SKILL.md'),
      '# Project\n',
    )
    await write(join(projectRoot, '.pi', 'skills', 'forbidden', 'SKILL.md'), '# Forbidden\n')
    await write(join(projectRoot, '.codex', 'skills', 'forbidden', 'SKILL.md'), '# Forbidden\n')
    await write(join(projectRoot, '.mcp.json'), '{"secret":true}\n')

    const catalog = await scanResourceCatalog({
      resourceHome,
      projectRoot,
      projectTrusted: true,
    })

    expect(
      catalog.resources.map(({ resourceId, namespace, kind, state }) => ({
        resourceId,
        namespace,
        kind,
        state,
      })),
    ).toEqual([
      { resourceId: 'global', namespace: 'global', kind: 'prompt', state: 'eligible' },
      { resourceId: 'global-skill', namespace: 'global', kind: 'skill', state: 'eligible' },
      { resourceId: 'project-skill', namespace: 'project', kind: 'skill', state: 'eligible' },
    ])
    expect(JSON.stringify(catalog)).not.toContain('.pi')
    expect(JSON.stringify(catalog)).not.toContain('.codex')
    expect(JSON.stringify(catalog)).not.toContain('.mcp.json')
  })

  it('shows untrusted project resources as restricted without reading their body', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const projectRoot = await root('genoffice-resource-project-')
    const skill = join(
      projectRoot,
      '.open-genoffice',
      'agent',
      'skills',
      'project-skill',
      'SKILL.md',
    )
    await write(skill, 'private project instructions\n')
    const catalog = await scanResourceCatalog({
      resourceHome,
      projectRoot,
      projectTrusted: false,
    })
    expect(catalog.resources).toMatchObject([
      {
        resourceId: 'project-skill',
        namespace: 'project',
        state: 'restricted',
        reason: 'project_untrusted',
      },
    ])
    expect(catalog.resources[0]).not.toHaveProperty('contentSha256')
    expect(JSON.stringify(catalog)).not.toContain('private project instructions')
  })

  it('isolates global/project collisions, reserved IDs, symlinks, and invalid shapes', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const projectRoot = await root('genoffice-resource-project-')
    for (const rootDirectory of [
      join(resourceHome, 'agent'),
      join(projectRoot, '.open-genoffice', 'agent'),
    ]) {
      await write(join(rootDirectory, 'skills', 'same', 'SKILL.md'), '# Same\n')
    }
    await write(join(resourceHome, 'agent', 'skills', 'broken', 'README.md'), '# Not a skill\n')
    await write(
      join(resourceHome, 'agent', 'skills', 'open-genoffice%2Foverride', 'SKILL.md'),
      '# Bad\n',
    )
    await symlink(
      join(resourceHome, 'agent', 'skills', 'same'),
      join(resourceHome, 'agent', 'skills', 'linked'),
    )

    const catalog = await scanResourceCatalog({
      resourceHome,
      projectRoot,
      projectTrusted: true,
    })
    const bySource = new Map(catalog.resources.map((resource) => [resource.source, resource]))
    expect(bySource.get('global:skills/same')).toMatchObject({
      state: 'invalid',
      reason: 'resource_collision',
    })
    expect(bySource.get('project:skills/same')).toMatchObject({
      state: 'invalid',
      reason: 'resource_collision',
    })
    expect(bySource.get('global:skills/broken')).toMatchObject({
      state: 'invalid',
      reason: 'resource_shape_invalid',
    })
    expect(bySource.get('global:skills/open-genoffice%2Foverride')).toMatchObject({
      state: 'invalid',
      reason: 'reserved_resource_id',
    })
    expect(bySource.get('global:skills/linked')).toMatchObject({
      state: 'invalid',
      reason: 'resource_symlink_forbidden',
    })
  })

  it('requires explicit Activation for executable Extension content', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    await write(join(resourceHome, 'agent', 'extensions', 'sample.mjs'), 'export default {}\n')
    const inactive = await scanResourceCatalog({
      resourceHome,
      isActivated: vi.fn(async () => false),
    })
    expect(inactive.resources).toMatchObject([
      { resourceId: 'sample', state: 'restricted', reason: 'activation_required' },
    ])
    const isActivated = vi.fn(async () => true)
    const active = await scanResourceCatalog({ resourceHome, isActivated })
    expect(active.resources).toMatchObject([{ resourceId: 'sample', state: 'eligible' }])
    expect(isActivated).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'global',
        resourceId: 'extension/sample',
        capabilities: ['executable'],
      }),
    )
  })

  it('reserves the built-in namespace and hashes content deterministically', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const builtInRoot = await root('genoffice-resource-builtin-')
    const builtInSkill = join(builtInRoot, 'core')
    await write(join(builtInSkill, 'SKILL.md'), '# Built in\n')
    await write(
      join(resourceHome, 'agent', 'skills', 'open-genoffice%2Fcore', 'SKILL.md'),
      '# Override\n',
    )

    const catalog = await scanResourceCatalog({
      resourceHome,
      builtInResources: [
        { resourceId: 'open-genoffice/core', kind: 'skill', path: builtInSkill },
        { resourceId: 'external/core', kind: 'skill', path: builtInSkill },
        { resourceId: 'open-genoffice/missing', kind: 'skill', path: join(builtInRoot, 'missing') },
      ],
    })
    const byKey = new Map(catalog.resources.map((resource) => [resource.resourceKey, resource]))
    expect(byKey.get('skill:builtin/open-genoffice/core')).toMatchObject({
      state: 'eligible',
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(byKey.get('skill:global/open-genoffice/core')).toMatchObject({
      state: 'invalid',
      reason: 'reserved_resource_id',
    })
    expect(byKey.get('skill:builtin/external/core')).toMatchObject({
      state: 'invalid',
      reason: 'reserved_resource_id',
    })
    expect(byKey.get('skill:builtin/open-genoffice/missing')).toMatchObject({
      state: 'invalid',
      reason: 'resource_integrity_invalid',
    })

    const sameContentElsewhere = await root('genoffice-resource-catalog-')
    await write(join(sameContentElsewhere, 'agent', 'skills', 'stable', 'SKILL.md'), '# Stable\n')
    await write(join(resourceHome, 'agent', 'skills', 'stable', 'SKILL.md'), '# Stable\n')
    const first = await scanResourceCatalog({ resourceHome: sameContentElsewhere })
    const second = await scanResourceCatalog({ resourceHome })
    expect(first.resources[0]?.contentSha256).toBe(
      second.resources.find(({ resourceId }) => resourceId === 'stable')?.contentSha256,
    )
    await write(join(sameContentElsewhere, 'agent', 'skills', 'stable', 'SKILL.md'), '# Changed\n')
    const changed = await scanResourceCatalog({ resourceHome: sameContentElsewhere })
    expect(changed.resources[0]?.contentSha256).not.toBe(first.resources[0]?.contentSha256)
    expect(changed.catalogId).not.toBe(first.catalogId)
  })

  it('rejects malformed, linked, and oversized trusted resource bodies', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const skills = join(resourceHome, 'agent', 'skills')
    await write(join(skills, '%E0%A4%A', 'SKILL.md'), '# Bad encoding\n')
    await write(join(skills, 'linked-body', 'SKILL.md'), '# Linked body\n')
    await symlink(join(skills, 'linked-body', 'SKILL.md'), join(skills, 'linked-body', 'linked.md'))
    await mkdir(join(skills, 'manifest-directory', 'SKILL.md'), { recursive: true })
    await write(join(skills, 'manifest-link-target'), '# Target\n')
    await mkdir(join(skills, 'manifest-link'), { recursive: true })
    await symlink(join(skills, 'manifest-link-target'), join(skills, 'manifest-link', 'SKILL.md'))
    await write(join(resourceHome, 'agent', 'prompts', 'wrong.txt'), 'wrong extension\n')
    const oversized = join(resourceHome, 'agent', 'extensions', 'oversized.mjs')
    await write(oversized, '')
    await truncate(oversized, 64 * 1024 * 1024 + 1)

    const catalog = await scanResourceCatalog({ resourceHome })
    const bySource = new Map(catalog.resources.map((resource) => [resource.source, resource]))
    expect(bySource.get('global:skills/%E0%A4%A')).toMatchObject({
      state: 'invalid',
      reason: 'resource_shape_invalid',
    })
    expect(bySource.get('global:skills/linked-body')).toMatchObject({
      state: 'invalid',
      reason: 'resource_symlink_forbidden',
    })
    expect(bySource.get('global:skills/manifest-directory')).toMatchObject({
      state: 'invalid',
      reason: 'resource_shape_invalid',
    })
    expect(bySource.get('global:skills/manifest-link')).toMatchObject({
      state: 'invalid',
      reason: 'resource_symlink_forbidden',
    })
    expect(bySource.get('global:prompts/wrong.txt')).toMatchObject({
      state: 'invalid',
      reason: 'resource_shape_invalid',
    })
    expect(bySource.get('global:extensions/oversized.mjs')).toMatchObject({
      state: 'invalid',
      reason: 'resource_integrity_invalid',
    })
  })

  it('uses project Activation descriptors and ignores non-directory roots', async () => {
    const resourceHome = await root('genoffice-resource-catalog-')
    const projectRoot = await root('genoffice-resource-project-')
    await write(join(resourceHome, 'agent', 'skills'), 'not a directory\n')
    await write(
      join(projectRoot, '.open-genoffice', 'agent', 'extensions', 'project.mjs'),
      'export default {}\n',
    )
    const isActivated = vi.fn(async () => true)
    const catalog = await scanResourceCatalog({
      resourceHome,
      projectRoot,
      projectTrusted: true,
      isActivated,
    })
    expect(catalog.resources).toMatchObject([
      { resourceId: 'project', namespace: 'project', state: 'eligible' },
    ])
    expect(isActivated).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'project', resourceId: 'extension/project' }),
    )
  })
})

describe('Capability Snapshot', () => {
  it('freezes only model metadata, resource hashes, tool IDs, and permission version', async () => {
    const snapshot = createCapabilitySnapshot({
      createdForRunId: 'run-1',
      model: {
        providerId: 'local-openai',
        modelId: 'qwen-test',
        capabilities: ['tool-use', 'text-input'],
      },
      resources: [
        { resourceKey: 'skill:global/one', contentSha256: 'b'.repeat(64) },
        { resourceKey: 'prompt:project/two', contentSha256: 'a'.repeat(64) },
      ],
      toolIds: ['office:pdf:read', 'office:pdf:annotate', 'office:pdf:read'],
      permissionVersion: 'permission-7',
    })
    expect(snapshot).toEqual({
      snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/),
      createdForRunId: 'run-1',
      model: {
        providerId: 'local-openai',
        modelId: 'qwen-test',
        capabilities: ['text-input', 'tool-use'],
      },
      resourceHashes: {
        'prompt:project/two': 'a'.repeat(64),
        'skill:global/one': 'b'.repeat(64),
      },
      toolIds: ['office:pdf:annotate', 'office:pdf:read'],
      permissionVersion: 'permission-7',
    })
    expect(JSON.stringify(snapshot)).not.toContain('instructions')
    expect(JSON.stringify(snapshot)).not.toContain('schema')
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('keeps a historical snapshot but rejects a revoked resource, tool, or permission', async () => {
    const snapshot = createCapabilitySnapshot({
      createdForRunId: 'run-1',
      model: { providerId: 'openai', modelId: 'gpt', capabilities: ['text-input'] },
      resources: [{ resourceKey: 'skill:project/one', contentSha256: 'a'.repeat(64) }],
      toolIds: ['office:pdf:read'],
      permissionVersion: 'permission-1',
    })
    await expect(
      verifyCapabilitySnapshot(snapshot, {
        permissionVersion: 'permission-1',
        isResourceAuthorized: async () => true,
        isToolEnabled: () => true,
      }),
    ).resolves.toBeUndefined()
    for (const current of [
      {
        permissionVersion: 'permission-2',
        isResourceAuthorized: async () => true,
        isToolEnabled: () => true,
      },
      {
        permissionVersion: 'permission-1',
        isResourceAuthorized: async () => false,
        isToolEnabled: () => true,
      },
      {
        permissionVersion: 'permission-1',
        isResourceAuthorized: async () => true,
        isToolEnabled: () => false,
      },
    ]) {
      await expect(verifyCapabilitySnapshot(snapshot, current)).rejects.toEqual(
        new CapabilitySnapshotError('capability_revoked'),
      )
    }
    expect(snapshot.resourceHashes).toEqual({ 'skill:project/one': 'a'.repeat(64) })
  })

  it.each([
    {
      createdForRunId: '',
      model: { providerId: 'p', modelId: 'm', capabilities: [] },
      resources: [],
      toolIds: [],
      permissionVersion: 'v',
    },
    {
      createdForRunId: 'r',
      model: { providerId: '', modelId: 'm', capabilities: [] },
      resources: [],
      toolIds: [],
      permissionVersion: 'v',
    },
    {
      createdForRunId: 'r',
      model: { providerId: 'p', modelId: '', capabilities: [] },
      resources: [],
      toolIds: [],
      permissionVersion: 'v',
    },
    {
      createdForRunId: 'r',
      model: { providerId: 'p', modelId: 'm', capabilities: [] },
      resources: [],
      toolIds: [],
      permissionVersion: '',
    },
    {
      createdForRunId: 'r',
      model: { providerId: 'p', modelId: 'm', capabilities: [] },
      resources: [{ resourceKey: '', contentSha256: 'a'.repeat(64) }],
      toolIds: [],
      permissionVersion: 'v',
    },
    {
      createdForRunId: 'r',
      model: { providerId: 'p', modelId: 'm', capabilities: [] },
      resources: [{ resourceKey: 'skill:global/one', contentSha256: 'bad' }],
      toolIds: [],
      permissionVersion: 'v',
    },
    {
      createdForRunId: 'r',
      model: { providerId: 'p', modelId: 'm', capabilities: [] },
      resources: [],
      toolIds: [''],
      permissionVersion: 'v',
    },
  ])('rejects invalid capability snapshot input %#', (input) => {
    expect(() => createCapabilitySnapshot(input)).toThrow(
      new CapabilitySnapshotError('capability_snapshot_invalid'),
    )
  })
})
