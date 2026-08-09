import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProjectSecurityError,
  ProjectTrustStore,
  ResourceActivationStore,
  resolveProjectIdentity,
} from '../src/index'

const DEVICE_A = '11111111-1111-4111-8111-111111111111'
const DEVICE_B = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

async function projectFixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(root, '.open-genoffice'))
  await writeFile(
    join(root, '.open-genoffice', 'project.json'),
    `${JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID })}\n`,
  )
  return root
}

describe('Project Trust', () => {
  it('persists trust for the same device, project, canonical root, and file identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-trust-home-'))
    const root = await projectFixture('project-trust-root-')
    const identity = await resolveProjectIdentity(root, DEVICE_A)
    const store = new ProjectTrustStore({ rootDirectory: home, deviceId: DEVICE_A })

    expect(await store.isTrusted(identity)).toBe(false)
    await store.grant(identity)
    expect(await store.isTrusted(identity)).toBe(true)
    expect(
      await new ProjectTrustStore({ rootDirectory: home, deviceId: DEVICE_A }).isTrusted(identity),
    ).toBe(true)
    expect(await store.isTrusted({ ...identity, deviceId: DEVICE_B })).toBe(false)

    await store.revoke(identity)
    expect(await store.isTrusted(identity)).toBe(false)
  })

  it('invalidates trust after an external move, copy, project reset, or root identity change', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-trust-change-home-'))
    const root = await projectFixture('project-trust-change-root-')
    const store = new ProjectTrustStore({ rootDirectory: home, deviceId: DEVICE_A })
    const original = await resolveProjectIdentity(root, DEVICE_A)
    await store.grant(original)

    const moved = `${root}-moved`
    await rename(root, moved)
    expect(await store.isTrusted(await resolveProjectIdentity(moved, DEVICE_A))).toBe(false)

    const copied = `${moved}-copy`
    await cp(moved, copied, { recursive: true })
    expect(await store.isTrusted(await resolveProjectIdentity(copied, DEVICE_A))).toBe(false)

    await writeFile(
      join(moved, '.open-genoffice', 'project.json'),
      `${JSON.stringify({ schemaVersion: 1, projectId: DEVICE_B })}\n`,
    )
    expect(await store.isTrusted(await resolveProjectIdentity(moved, DEVICE_A))).toBe(false)
  })

  it('rejects a symlinked project metadata directory and invalid project manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-trust-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'project-trust-outside-'))
    await writeFile(
      join(outside, 'project.json'),
      JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID }),
    )
    await symlink(outside, join(root, '.open-genoffice'))
    await expect(resolveProjectIdentity(root, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_metadata_symlink_forbidden'),
    )

    const invalid = await projectFixture('project-trust-invalid-')
    await writeFile(join(invalid, '.open-genoffice', 'project.json'), '{"schemaVersion":2}\n')
    await expect(resolveProjectIdentity(invalid, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_manifest_invalid'),
    )

    const missing = await mkdtemp(join(tmpdir(), 'project-trust-missing-'))
    await expect(resolveProjectIdentity(missing, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_manifest_invalid'),
    )
    await expect(resolveProjectIdentity(join(missing, 'absent'), DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_root_invalid'),
    )
    const fileRoot = join(missing, 'file-root')
    await writeFile(fileRoot, 'not a directory')
    await expect(resolveProjectIdentity(fileRoot, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_root_invalid'),
    )

    const metadataFileRoot = await mkdtemp(join(tmpdir(), 'project-trust-metadata-file-'))
    await writeFile(join(metadataFileRoot, '.open-genoffice'), 'not a directory')
    await expect(resolveProjectIdentity(metadataFileRoot, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_manifest_invalid'),
    )

    const manifestDirectoryRoot = await mkdtemp(join(tmpdir(), 'project-trust-manifest-dir-'))
    await mkdir(join(manifestDirectoryRoot, '.open-genoffice', 'project.json'), { recursive: true })
    await expect(resolveProjectIdentity(manifestDirectoryRoot, DEVICE_A)).rejects.toEqual(
      new ProjectSecurityError('project_manifest_invalid'),
    )

    const invalidDevice = await projectFixture('project-trust-invalid-device-')
    await expect(resolveProjectIdentity(invalidDevice, 'invalid-device')).rejects.toEqual(
      new ProjectSecurityError('project_identity_invalid'),
    )
  })

  it('fails closed on corrupt local trust state without overwriting it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-trust-corrupt-'))
    const root = await projectFixture('project-trust-corrupt-root-')
    const state = join(home, 'state', 'trust.json')
    await mkdir(join(home, 'state'))
    await writeFile(state, '{corrupt')
    const store = new ProjectTrustStore({ rootDirectory: home, deviceId: DEVICE_A })
    await expect(store.isTrusted(await resolveProjectIdentity(root, DEVICE_A))).rejects.toEqual(
      new ProjectSecurityError('project_trust_state_invalid'),
    )
    expect(await readFile(state, 'utf8')).toBe('{corrupt')

    await writeFile(
      state,
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        records: [
          {
            ...(await resolveProjectIdentity(root, DEVICE_A)),
            grantedAt: 'not-a-date',
          },
        ],
      }),
    )
    await expect(store.isTrusted(await resolveProjectIdentity(root, DEVICE_A))).rejects.toEqual(
      new ProjectSecurityError('project_trust_state_invalid'),
    )
  })

  it('rejects invalid identities, makes absent revocation idempotent, and supports Windows policy', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-trust-invalid-identity-'))
    expect(
      () => new ProjectTrustStore({ rootDirectory: home, deviceId: 'invalid-device' }),
    ).toThrow(new ProjectSecurityError('project_identity_invalid'))
    const root = await projectFixture('project-trust-invalid-identity-root-')
    const identity = await resolveProjectIdentity(root, DEVICE_A)
    const windowsStore = new ProjectTrustStore({
      rootDirectory: home,
      deviceId: DEVICE_A,
      platform: 'win32',
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    expect(await windowsStore.isTrusted({ ...identity, projectId: 'invalid' })).toBe(false)
    await expect(windowsStore.grant({ ...identity, deviceId: DEVICE_B })).rejects.toEqual(
      new ProjectSecurityError('project_identity_invalid'),
    )
    await expect(windowsStore.revoke({ ...identity, projectId: 'invalid' })).rejects.toEqual(
      new ProjectSecurityError('project_identity_invalid'),
    )
    const unchanged = await windowsStore.revoke(identity)
    expect(unchanged).toEqual({ schemaVersion: 1, generation: 1, records: [] })
    const granted = await windowsStore.grant(identity)
    expect(granted.records[0]?.grantedAt).toBe('2026-08-10T00:00:00.000Z')
  })
})

describe('Resource Activation', () => {
  const resource = {
    namespace: 'project' as const,
    resourceId: 'extension/chart-tools',
    source: 'sync:project/demo',
    contentSha256: HASH_A,
    capabilities: ['executable', 'network'] as const,
  }

  it('binds activation to device, namespace, resource, source, hash, and exact capabilities', async () => {
    const home = await mkdtemp(join(tmpdir(), 'activation-home-'))
    const store = new ResourceActivationStore({ rootDirectory: home, deviceId: DEVICE_A })
    expect(await store.isActive(resource)).toBe(false)
    await store.activate(resource)
    expect(await store.isActive(resource)).toBe(true)
    expect(await store.isActive({ ...resource, contentSha256: HASH_B })).toBe(false)
    expect(await store.isActive({ ...resource, source: 'sync:project/other' })).toBe(false)
    expect(await store.isActive({ ...resource, capabilities: ['executable'] })).toBe(false)
    expect(
      await new ResourceActivationStore({ rootDirectory: home, deviceId: DEVICE_B }).isActive(
        resource,
      ),
    ).toBe(false)
  })

  it('normalizes capability order, persists atomically, and supports exact revocation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'activation-persist-'))
    const store = new ResourceActivationStore({ rootDirectory: home, deviceId: DEVICE_A })
    await Promise.all([
      store.activate(resource),
      store.activate({ ...resource, capabilities: ['network', 'executable'] }),
    ])
    expect(await store.isActive(resource)).toBe(true)
    expect(
      await new ResourceActivationStore({ rootDirectory: home, deviceId: DEVICE_A }).isActive(
        resource,
      ),
    ).toBe(true)
    await store.revoke(resource)
    expect(await store.isActive(resource)).toBe(false)
  })

  it('rejects malformed descriptors and corrupt activation state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'activation-invalid-'))
    const store = new ResourceActivationStore({ rootDirectory: home, deviceId: DEVICE_A })
    await expect(store.activate({ ...resource, contentSha256: 'not-a-hash' })).rejects.toEqual(
      new ProjectSecurityError('resource_activation_invalid'),
    )
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(join(home, 'state', 'activations.json'), '{corrupt')
    await expect(store.isActive(resource)).rejects.toEqual(
      new ProjectSecurityError('resource_activation_state_invalid'),
    )

    await writeFile(
      join(home, 'state', 'activations.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        records: [
          {
            ...resource,
            deviceId: DEVICE_A,
            activatedAt: 'not-a-date',
          },
        ],
      }),
    )
    await expect(store.isActive(resource)).rejects.toEqual(
      new ProjectSecurityError('resource_activation_state_invalid'),
    )
  })

  it('keeps absent revocation idempotent and surfaces atomic commit failures', async () => {
    const home = await mkdtemp(join(tmpdir(), 'activation-atomic-'))
    const stable = new ResourceActivationStore({
      rootDirectory: home,
      deviceId: DEVICE_A,
      platform: 'win32',
    })
    expect(await stable.revoke(resource)).toEqual({
      schemaVersion: 1,
      generation: 1,
      records: [],
    })
    const failing = new ResourceActivationStore({
      rootDirectory: home,
      deviceId: DEVICE_A,
      atomicWriteOptions: () => ({ failAt: 'before_rename' }),
    })
    await expect(failing.activate(resource)).rejects.toThrow('injected_atomic_write_failure')
    expect(await stable.isActive(resource)).toBe(false)
  })
})
