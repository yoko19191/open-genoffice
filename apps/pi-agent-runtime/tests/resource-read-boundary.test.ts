import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilitySnapshotError, createCapabilitySnapshot } from '@genoffice/agent-resource'
import { ResourceReadBoundary } from '../src/resource-read-boundary'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function snapshot() {
  return createCapabilitySnapshot({
    createdForRunId: 'run-1',
    model: { providerId: 'local', modelId: 'model', capabilities: ['text-input'] },
    resources: [{ resourceKey: 'skill:global/one', contentSha256: 'a'.repeat(64) }],
    toolIds: ['platform:resource:read'],
    permissionVersion: 'permission-1',
  })
}

describe('ResourceReadBoundary', () => {
  it('reads only files under a Skill root after current authorization succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-resource-read-'))
    roots.push(root)
    const skillRoot = join(root, 'skill')
    const skill = join(skillRoot, 'SKILL.md')
    const reference = join(skillRoot, 'references', 'guide.md')
    const sibling = join(root, 'secret.txt')
    await write(skill, 'Skill instructions\n')
    await write(reference, 'Reference\n')
    await write(sibling, 'Secret\n')
    const verify = vi.fn(async () => undefined)
    const boundary = new ResourceReadBoundary({ verify })
    boundary.configure({ snapshot: snapshot(), skillRoots: [skillRoot] })

    await expect(boundary.access(skill)).resolves.toBeUndefined()
    await expect(boundary.readFile(reference)).resolves.toEqual(Buffer.from('Reference\n'))
    expect(verify).toHaveBeenCalledTimes(2)
    await expect(boundary.readFile(sibling)).rejects.toEqual(
      new CapabilitySnapshotError('capability_revoked'),
    )
  })

  it('fails closed when unconfigured, revoked, linked, or replaced by a later run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-resource-read-'))
    roots.push(root)
    const firstRoot = join(root, 'first')
    const secondRoot = join(root, 'second')
    const first = join(firstRoot, 'SKILL.md')
    const second = join(secondRoot, 'SKILL.md')
    await write(first, 'First\n')
    await write(second, 'Second\n')
    const linked = join(secondRoot, 'linked.md')
    await symlink(first, linked)
    const directory = join(secondRoot, 'directory')
    await mkdir(directory)
    const verify = vi.fn(async () => undefined)
    const boundary = new ResourceReadBoundary({ verify })
    await expect(boundary.readFile(first)).rejects.toMatchObject({ code: 'capability_revoked' })

    boundary.configure({ snapshot: snapshot(), skillRoots: [firstRoot] })
    verify.mockRejectedValueOnce(new CapabilitySnapshotError('capability_revoked'))
    await expect(boundary.readFile(first)).rejects.toMatchObject({ code: 'capability_revoked' })
    boundary.configure({
      snapshot: snapshot(),
      skillRoots: [secondRoot],
      projectRoot: '/trusted/project',
    })
    await expect(boundary.readFile(first)).rejects.toMatchObject({ code: 'capability_revoked' })
    await expect(boundary.readFile(linked)).rejects.toMatchObject({ code: 'capability_revoked' })
    await expect(boundary.readFile(directory)).rejects.toMatchObject({
      code: 'capability_revoked',
    })
    await expect(boundary.readFile(second)).resolves.toEqual(Buffer.from('Second\n'))
    expect(verify).toHaveBeenLastCalledWith(expect.any(Object), '/trusted/project')
  })
})
