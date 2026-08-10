import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PackageLockSchema,
  ResourceActivationStore,
  type ResourceActivationDescriptor,
} from '@genoffice/agent-resource'
import { Value } from '@sinclair/typebox/value'
import { GlobalAssetSyncReconciler, InMemorySyncObjectStore } from '@genoffice/project-store'
import { afterEach, describe, expect, it } from 'vitest'
import { GlobalAssetSyncService } from '../src/global-asset-sync'

const DEVICE_A = '11111111-1111-4111-8111-111111111111'
const DEVICE_B = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function seedGlobalAssets(resourceHome: string, extension = 'export const version = 1') {
  await Promise.all(
    [
      'assets/styles',
      'agent/skills/demo',
      'agent/extensions',
      'agent/prompts',
      'mcp',
      'state/secure-store',
      'agent/logs',
    ].map((path) => mkdir(join(resourceHome, path), { recursive: true })),
  )
  const duplicateAsset = Buffer.alloc(1024 * 1024, 5)
  await Promise.all([
    writeFile(join(resourceHome, 'assets/styles/one.bin'), duplicateAsset),
    writeFile(join(resourceHome, 'assets/styles/two.bin'), duplicateAsset),
    writeFile(join(resourceHome, 'agent/skills/demo/SKILL.md'), '# Demo\n'),
    writeFile(join(resourceHome, 'agent/extensions/demo.mjs'), extension),
    writeFile(join(resourceHome, 'agent/prompts/brief.md'), '# Brief\n'),
    writeFile(join(resourceHome, 'state/trust.json'), '{"must":"stay-local"}'),
    writeFile(join(resourceHome, 'state/activations.json'), '{"must":"stay-local"}'),
    writeFile(join(resourceHome, 'state/secure-store/secret.bin'), 'secret-value'),
    writeFile(join(resourceHome, 'agent/logs/runtime.log'), 'secret diagnostic'),
  ])
  const packageLock = {
    schemaVersion: 1,
    generation: 1,
    packages: [
      {
        packageId: 'demo-package',
        source: {
          type: 'npm',
          name: 'demo-package',
          version: '1.0.0',
          integrity: `sha512-${Buffer.from('integrity').toString('base64')}`,
        },
        contentSha256: 'a'.repeat(64),
        license: 'MIT',
        activatedCapabilities: ['executable', 'network'],
        enabled: true,
        tools: [{ extension: 'index.mjs', name: 'demo_read', effect: 'read' }],
      },
      {
        packageId: 'data-package',
        source: {
          type: 'npm',
          name: 'data-package',
          version: '1.0.0',
          integrity: `sha512-${Buffer.from('data-integrity').toString('base64')}`,
        },
        contentSha256: 'b'.repeat(64),
        license: 'MIT',
        activatedCapabilities: [],
        enabled: false,
        tools: [{ extension: 'index.mjs', name: 'data_read', effect: 'read' }],
      },
    ],
  }
  expect(Value.Check(PackageLockSchema, packageLock)).toBe(true)
  await writeFile(
    join(resourceHome, 'agent/packages.lock.json'),
    `${JSON.stringify(packageLock)}\n`,
  )
  await writeFile(
    join(resourceHome, 'mcp/servers.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          serverId: 'remote-tools',
          transport: 'streamable-http',
          endpoint: 'https://mcp.example.test/rpc',
          credentialRef: { slot: 'model/mcp/default', kind: 'oauth' },
          enabledToolIds: ['read'],
          timeoutMs: 1_000,
          enabled: true,
        },
        {
          serverId: 'local-tools',
          transport: 'stdio',
          command: '/usr/bin/local-tools',
          args: ['serve'],
          environment: {
            inherit: ['PATH'],
            credentials: [
              {
                name: 'LOCAL_TOOLS_KEY',
                credentialRef: { slot: 'model/local/default', kind: 'api_key' },
              },
            ],
          },
          enabledToolIds: ['read'],
          timeoutMs: 1_000,
          enabled: true,
        },
        {
          serverId: 'public-tools',
          transport: 'streamable-http',
          endpoint: 'https://public.example.test/rpc',
          enabledToolIds: [],
          timeoutMs: 1_000,
          enabled: false,
        },
      ],
    })}\n`,
  )
}

describe('GlobalAssetSyncService', () => {
  it('restores only the approved declaration set and requires local secret and Activation', async () => {
    const source = await root('global-assets-source-')
    await seedGlobalAssets(source)
    const captured = await new GlobalAssetSyncService({
      resourceHome: source,
      deviceId: DEVICE_A,
    }).capture()
    expect(captured.entries.map((entry) => [entry.canonicalPath, entry.kind])).toEqual(
      expect.arrayContaining([
        ['assets/styles/one.bin', 'global-asset'],
        ['agent/skills/demo/SKILL.md', 'global-skill'],
        ['agent/extensions/demo.mjs', 'global-extension'],
        ['agent/prompts/brief.md', 'global-prompt'],
        ['agent/packages.lock.json', 'global-package-lock'],
        ['mcp/servers.json', 'global-mcp-config'],
      ]),
    )
    const serialized = JSON.stringify(captured.entries)
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('must-stay-local')
    expect(serialized).not.toContain('runtime.log')
    expect(serialized).not.toContain('state/')

    const store = new InMemorySyncObjectStore()
    const publisher = new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-a',
    })
    const published = await publisher.publish(captured.entries)
    if (published.status !== 'published') throw new Error('publish_failed')
    const target = await root('global-assets-target-')
    await expect(
      new GlobalAssetSyncReconciler({
        store,
        scopeId: 'global-assets',
        authorDeviceId: 'device-b',
      }).restore(target),
    ).resolves.toMatchObject({ status: 'restored' })
    await expect(readFile(join(target, 'state/trust.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(target, 'state/activations.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(target, 'state/secure-store/secret.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(target, 'assets/styles/one.bin'))).toEqual(
      await readFile(join(target, 'assets/styles/two.bin')),
    )

    const targetService = new GlobalAssetSyncService({
      resourceHome: target,
      deviceId: DEVICE_B,
    })
    const status = await targetService.inspect({ availableCredentialSlots: [] })
    expect(status.missingCredentialSlots).toEqual(['model/local/default', 'model/mcp/default'])
    expect(status.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'extension/demo',
          state: 'activation_required',
        }),
        expect.objectContaining({ resourceId: 'mcp/public-tools', state: 'disabled' }),
        expect.objectContaining({ resourceId: 'package/data-package', state: 'disabled' }),
        expect.objectContaining({
          resourceId: 'mcp/remote-tools',
          state: 'activation_required',
        }),
        expect.objectContaining({
          resourceId: 'package/demo-package',
          state: 'source_unavailable',
        }),
      ]),
    )
    const activation = new ResourceActivationStore({ rootDirectory: target, deviceId: DEVICE_B })
    const activatable = status.resources.filter(
      (resource): resource is typeof resource & { activation: ResourceActivationDescriptor } =>
        resource.activation !== undefined && resource.state === 'activation_required',
    )
    await Promise.all(activatable.map((resource) => activation.activate(resource.activation)))
    const activated = await targetService.inspect({
      availableCredentialSlots: ['model/local/default', 'model/mcp/default'],
    })
    expect(activated.missingCredentialSlots).toEqual([])
    expect(
      activated.resources.filter((resource) =>
        ['extension/demo', 'mcp/remote-tools'].includes(resource.resourceId),
      ),
    ).toEqual([
      expect.objectContaining({ state: 'eligible' }),
      expect.objectContaining({ state: 'eligible' }),
    ])
  }, 15_000)

  it('invalidates a persisted target-device Activation when synced content hash changes', async () => {
    const firstSource = await root('global-assets-v1-')
    await seedGlobalAssets(firstSource)
    const firstCapture = await new GlobalAssetSyncService({
      resourceHome: firstSource,
      deviceId: DEVICE_A,
    }).capture()
    const store = new InMemorySyncObjectStore()
    const publisher = new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-a',
    })
    const first = await publisher.publish(firstCapture.entries)
    if (first.status !== 'published') throw new Error('publish_failed')

    const firstTarget = await root('global-assets-device-b-v1-')
    await new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-b',
    }).restore(firstTarget)
    const firstTargetService = new GlobalAssetSyncService({
      resourceHome: firstTarget,
      deviceId: DEVICE_B,
    })
    const before = await firstTargetService.inspect()
    const extension = before.resources.find((resource) => resource.resourceId === 'extension/demo')!
    await new ResourceActivationStore({ rootDirectory: firstTarget, deviceId: DEVICE_B }).activate(
      extension.activation!,
    )
    await expect(firstTargetService.inspect()).resolves.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({ resourceId: 'extension/demo', state: 'eligible' }),
      ]),
    })

    const secondSource = await root('global-assets-v2-')
    await seedGlobalAssets(secondSource, 'export const version = 2')
    const secondCapture = await new GlobalAssetSyncService({
      resourceHome: secondSource,
      deviceId: DEVICE_A,
    }).capture()
    const second = await publisher.publish(secondCapture.entries, first.remoteBase)
    if (second.status !== 'published') throw new Error('publish_failed')
    const secondTarget = await root('global-assets-device-b-v2-')
    await mkdir(join(secondTarget, 'state'), { recursive: true })
    await writeFile(
      join(secondTarget, 'state/activations.json'),
      await readFile(join(firstTarget, 'state/activations.json')),
    )
    await new GlobalAssetSyncReconciler({
      store,
      scopeId: 'global-assets',
      authorDeviceId: 'device-b',
    }).restore(secondTarget)
    const changed = await new GlobalAssetSyncService({
      resourceHome: secondTarget,
      deviceId: DEVICE_B,
    }).inspect()
    expect(changed.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: 'extension/demo', state: 'activation_required' }),
      ]),
    )
    expect(
      changed.resources.find((resource) => resource.resourceId === 'extension/demo')?.contentSha256,
    ).not.toBe(extension.contentSha256)
  })

  it('accepts an empty home and rejects malformed declarative configuration', async () => {
    const empty = await root('global-assets-empty-')
    const emptyService = new GlobalAssetSyncService({ resourceHome: empty, deviceId: DEVICE_A })
    await expect(emptyService.capture()).resolves.toEqual({ entries: [] })
    await expect(emptyService.inspect()).resolves.toEqual({
      resources: [],
      missingCredentialSlots: [],
    })

    const invalidPackage = await root('global-assets-invalid-package-')
    await mkdir(join(invalidPackage, 'agent'), { recursive: true })
    const packagePath = join(invalidPackage, 'agent/packages.lock.json')
    await writeFile(packagePath, '{')
    await expect(
      new GlobalAssetSyncService({ resourceHome: invalidPackage, deviceId: DEVICE_A }).capture(),
    ).rejects.toMatchObject({ code: 'global_package_lock_invalid' })
    await writeFile(packagePath, '{"schemaVersion":1,"generation":1,"packages":[{}]}')
    await expect(
      new GlobalAssetSyncService({ resourceHome: invalidPackage, deviceId: DEVICE_A }).capture(),
    ).rejects.toMatchObject({ code: 'global_package_lock_invalid' })

    const dataOnlyLock = {
      schemaVersion: 1,
      generation: 1,
      packages: [
        {
          packageId: 'data-only',
          source: {
            type: 'npm',
            name: 'data-only',
            version: '1.0.0',
            integrity: `sha512-${Buffer.from('data-only').toString('base64')}`,
          },
          contentSha256: 'c'.repeat(64),
          license: 'MIT',
          activatedCapabilities: [],
          enabled: false,
          tools: [{ extension: 'index.mjs', name: 'data_only', effect: 'read' }],
        },
      ],
    }
    await writeFile(packagePath, JSON.stringify(dataOnlyLock))
    await expect(
      new GlobalAssetSyncService({ resourceHome: invalidPackage, deviceId: DEVICE_A }).capture(),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          kind: 'global-package-lock',
          executable: false,
          network: false,
        }),
      ],
    })

    const invalidMcp = await root('global-assets-invalid-mcp-')
    await mkdir(join(invalidMcp, 'mcp'), { recursive: true })
    await writeFile(
      join(invalidMcp, 'mcp/servers.json'),
      JSON.stringify({
        schemaVersion: 1,
        servers: [{ serverId: 'bad', headers: { secret: 'x' } }],
      }),
    )
    await expect(
      new GlobalAssetSyncService({ resourceHome: invalidMcp, deviceId: DEVICE_A }).capture(),
    ).rejects.toMatchObject({ code: 'global_mcp_config_invalid' })
  })

  it('fails closed on unsafe paths, symlinks, limits and a file changed during capture', async () => {
    const invalidRoot = await root('global-assets-invalid-root-')
    await writeFile(join(invalidRoot, 'assets'), 'not-a-directory')
    await expect(
      new GlobalAssetSyncService({ resourceHome: invalidRoot, deviceId: DEVICE_A }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_invalid' })

    const unsafeNames =
      process.platform === 'win32'
        ? ['con.txt', 'e\u0301.txt']
        : ['con.txt', 'bad\\name.txt', 'e\u0301.txt']
    for (const unsafeName of unsafeNames) {
      const unsafe = await root('global-assets-unsafe-name-')
      await mkdir(join(unsafe, 'assets'))
      await writeFile(join(unsafe, 'assets', unsafeName), 'unsafe')
      await expect(
        new GlobalAssetSyncService({ resourceHome: unsafe, deviceId: DEVICE_A }).capture(),
      ).rejects.toMatchObject({ code: 'global_asset_invalid' })
    }

    const linked = await root('global-assets-linked-')
    await mkdir(join(linked, 'assets'))
    await writeFile(join(linked, 'outside.bin'), 'outside')
    await symlink(join(linked, 'outside.bin'), join(linked, 'assets/link.bin'))
    await expect(
      new GlobalAssetSyncService({ resourceHome: linked, deviceId: DEVICE_A }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_invalid' })

    const limited = await root('global-assets-limited-')
    await mkdir(join(limited, 'assets'))
    await Promise.all([
      writeFile(join(limited, 'assets/one.bin'), '12'),
      writeFile(join(limited, 'assets/two.bin'), '34'),
    ])
    await expect(
      new GlobalAssetSyncService({
        resourceHome: limited,
        deviceId: DEVICE_A,
        maxFileBytes: 1,
      }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_invalid' })
    await expect(
      new GlobalAssetSyncService({
        resourceHome: limited,
        deviceId: DEVICE_A,
        maxPaths: 1,
      }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_limit' })

    const finalLimit = await root('global-assets-final-limit-')
    await mkdir(join(finalLimit, 'mcp'))
    await writeFile(
      join(finalLimit, 'mcp/servers.json'),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            serverId: 'limited',
            transport: 'streamable-http',
            endpoint: 'https://limited.example.test/rpc',
            credentialRef: { slot: 'model/limited/default', kind: 'oauth' },
            enabledToolIds: [],
            timeoutMs: 1_000,
            enabled: true,
          },
        ],
      }),
    )
    await expect(
      new GlobalAssetSyncService({
        resourceHome: finalLimit,
        deviceId: DEVICE_A,
        maxPaths: 1,
      }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_limit' })

    let changed = false
    await expect(
      new GlobalAssetSyncService({
        resourceHome: limited,
        deviceId: DEVICE_A,
        faultInjector: async (_stage, path) => {
          if (!changed) {
            changed = true
            await writeFile(path, 'changed-after-read')
          }
        },
      }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_changed' })
    expect(changed).toBe(true)

    const invalidResource = await root('global-assets-invalid-resource-')
    await mkdir(join(invalidResource, 'agent/extensions'), { recursive: true })
    await writeFile(join(invalidResource, 'agent/extensions/not-an-extension.txt'), 'invalid')
    await expect(
      new GlobalAssetSyncService({
        resourceHome: invalidResource,
        deviceId: DEVICE_A,
      }).capture(),
    ).rejects.toMatchObject({ code: 'global_asset_invalid' })
    await expect(
      new GlobalAssetSyncService({
        resourceHome: invalidResource,
        deviceId: DEVICE_A,
      }).inspect(),
    ).resolves.toMatchObject({
      resources: [expect.objectContaining({ state: 'invalid', contentSha256: '' })],
    })
  })
})
