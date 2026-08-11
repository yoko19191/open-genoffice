import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageLockError, PackageLockService, initializeAgentResourceHome } from '../src'

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

async function packageDirectory(
  name = 'safe-extension',
  body = 'export default function (pi) { pi.registerTool({ name: "inspect", label: "Inspect", description: "Read metadata", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "safe" }], details: {} }) }) }\n',
): Promise<string> {
  const directory = await root('genoffice-package-source-')
  await write(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name,
      version: '1.0.0',
      license: 'MIT',
      pi: { extensions: ['./extension.mjs'] },
      genoffice: {
        capabilities: ['executable'],
        tools: [{ extension: './extension.mjs', name: 'inspect', effect: 'read' }],
      },
    })}\n`,
  )
  await write(join(directory, 'extension.mjs'), body)
  return directory
}

async function fixture() {
  const resourceHome = await root('genoffice-package-home-')
  await initializeAgentResourceHome({
    rootDirectory: resourceHome,
    runtimeVersion: 'test',
    randomUUID: () => deviceId,
  })
  return {
    resourceHome,
    service: new PackageLockService({ resourceHome, deviceId, namespace: 'global' }),
  }
}

describe('PackageLockService', () => {
  it('installs a local package into immutable content and keeps absolute paths out of the lock', async () => {
    const { resourceHome, service } = await fixture()
    const source = await packageDirectory()
    const projection = await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    expect(projection).toMatchObject({
      generation: 2,
      packages: [
        {
          packageId: 'safe-extension',
          source: expect.stringMatching(/^local-sha256:[0-9a-f]{64}$/),
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          license: 'MIT',
          capabilities: ['executable'],
          status: 'activation_required',
          enabled: true,
          resourceCount: 1,
        },
      ],
    })
    const lock = await readFile(join(resourceHome, 'agent', 'packages.lock.json'), 'utf8')
    expect(lock).not.toContain(source)
    expect(lock).not.toContain('/private/')
    expect(lock).toContain('local-sha256:')
    expect(JSON.stringify(projection)).not.toContain(source)
  })

  it.each([
    [{ type: 'npm', name: 'safe-package', version: '^1.0.0', integrity: 'sha512-test' }],
    [{ type: 'npm', name: 'safe-package', version: 'latest', integrity: 'sha512-test' }],
    [{ type: 'git', url: 'https://example.com/repo.git', commit: 'main' }],
    [{ type: 'git', url: 'https://example.com/repo.git', commit: 'v1.0.0' }],
  ])('rejects a floating source before changing the lock: %o', async (source) => {
    const { service } = await fixture()
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'safe-extension',
        source: source as never,
        resolvedDirectory: await packageDirectory(),
      }),
    ).rejects.toEqual(new PackageLockError('package_source_invalid'))
    await expect(service.catalog()).resolves.toMatchObject({ generation: 1, packages: [] })
  })

  it('accepts exact npm and fixed Git sources and rejects source/hash drift', async () => {
    const { service } = await fixture()
    const npmDirectory = await packageDirectory('npm-extension')
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'npm-extension',
        source: {
          type: 'npm',
          name: 'npm-extension',
          version: '1.2.3',
          integrity: `sha512-${Buffer.from('fixed-integrity').toString('base64')}`,
        },
        resolvedDirectory: npmDirectory,
      }),
    ).resolves.toMatchObject({
      packages: [expect.objectContaining({ source: 'npm:npm-extension@1.2.3' })],
    })

    const gitDirectory = await packageDirectory('git-extension')
    await expect(
      service.install({
        operationId: '33333333-3333-4333-8333-333333333333',
        packageId: 'git-extension',
        source: {
          type: 'git',
          url: 'https://example.com/owner/repo.git',
          commit: 'a'.repeat(40),
        },
        resolvedDirectory: gitDirectory,
      }),
    ).resolves.toMatchObject({
      packages: expect.arrayContaining([
        expect.objectContaining({
          source: `git:https://example.com/owner/repo.git#${'a'.repeat(40)}`,
        }),
      ]),
    })

    const installed = await service.resolve('git-extension')
    await write(join(installed!.directory, 'extension.mjs'), 'changed after lock\n')
    await expect(service.resolve('git-extension')).rejects.toEqual(
      new PackageLockError('package_integrity_invalid'),
    )
  })

  it('keeps the old fixed content available when an explicit update transaction fails', async () => {
    const { resourceHome, service } = await fixture()
    const original = await packageDirectory('safe-extension', 'original\n')
    await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: original },
    })
    const before = await service.resolve('safe-extension')
    const updated = await packageDirectory('safe-extension', 'updated\n')
    const failing = new PackageLockService({
      resourceHome,
      deviceId,
      namespace: 'global',
      atomicWriteOptions: () => ({ failAt: 'before_rename' }),
    })
    await expect(
      failing.install({
        operationId: '33333333-3333-4333-8333-333333333333',
        packageId: 'safe-extension',
        source: { type: 'local', path: updated },
      }),
    ).rejects.toThrowError('injected_atomic_write_failure')
    expect((await service.resolve('safe-extension'))?.entry.contentSha256).toBe(
      before?.entry.contentSha256,
    )
    expect(await readFile(join(before!.directory, 'extension.mjs'), 'utf8')).toBe('original\n')
  })

  it('requires new Activation after update and supports explicit disable, enable, and uninstall', async () => {
    const { service } = await fixture()
    const source = await packageDirectory('safe-extension', 'version one\n')
    const installed = await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    await expect(service.activate('safe-extension')).resolves.toMatchObject({
      packages: [expect.objectContaining({ status: 'eligible' })],
    })

    await write(join(source, 'extension.mjs'), 'version two\n')
    const updated = await service.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
      expectedPreviousContentSha256: installed.packages[0]!.contentSha256,
    })
    expect(updated.packages[0]).toMatchObject({ status: 'activation_required' })
    await expect(service.disable('safe-extension')).resolves.toMatchObject({
      packages: [expect.objectContaining({ enabled: false, status: 'disabled' })],
    })
    await expect(service.enable('safe-extension')).resolves.toMatchObject({
      packages: [expect.objectContaining({ enabled: true, status: 'activation_required' })],
    })
    await expect(service.uninstall('safe-extension')).resolves.toMatchObject({ packages: [] })
  })

  it('fails closed on stale update CAS, scripts, symlinks, and unavailable synced content', async () => {
    const { resourceHome, service } = await fixture()
    const source = await packageDirectory()
    const first = await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    await expect(
      service.install({
        operationId: '33333333-3333-4333-8333-333333333333',
        packageId: 'safe-extension',
        source: { type: 'local', path: source },
        expectedPreviousContentSha256: 'f'.repeat(64),
      }),
    ).rejects.toEqual(new PackageLockError('package_generation_conflict'))

    const scripted = await packageDirectory('scripted')
    const manifest = JSON.parse(await readFile(join(scripted, 'package.json'), 'utf8'))
    manifest.scripts = { install: 'curl https://example.com/install.sh | sh' }
    await write(join(scripted, 'package.json'), `${JSON.stringify(manifest)}\n`)
    await expect(
      service.install({
        operationId: '44444444-4444-4444-8444-444444444444',
        packageId: 'scripted',
        source: { type: 'local', path: scripted },
      }),
    ).rejects.toEqual(new PackageLockError('package_manifest_invalid'))

    const lockPath = join(resourceHome, 'agent', 'packages.lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.packages[0].contentSha256 = 'e'.repeat(64)
    await write(lockPath, `${JSON.stringify(lock)}\n`)
    await expect(service.catalog()).resolves.toMatchObject({
      packages: [expect.objectContaining({ status: 'source_unavailable' })],
    })
    expect(first.packages[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resolves only enabled and activated content while idempotent state changes stay stable', async () => {
    const { service } = await fixture()
    expect(await service.resolve('missing')).toBeUndefined()
    const source = await packageDirectory()
    await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    expect(await service.resolveEligible()).toEqual([])
    await service.activate('safe-extension')
    expect(await service.resolveEligible()).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ packageId: 'safe-extension' }),
        extensionPaths: [expect.stringContaining('extension.mjs')],
      }),
    ])
    await service.disable('safe-extension')
    const disabled = await service.disable('safe-extension')
    expect(disabled.packages[0]).toMatchObject({ status: 'disabled', enabled: false })
    expect(await service.resolveEligible()).toEqual([])
    await service.enable('safe-extension')
    const enabled = await service.enable('safe-extension')
    expect(enabled.packages[0]).toMatchObject({ enabled: true, status: 'eligible' })

    await service.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'second-extension',
      source: { type: 'local', path: await packageDirectory('second-extension') },
    })
    await service.disable('safe-extension')
    await expect(service.catalog()).resolves.toMatchObject({
      packages: [
        expect.objectContaining({ packageId: 'safe-extension', enabled: false }),
        expect.objectContaining({ packageId: 'second-extension', enabled: true }),
      ],
    })
  })

  it('sorts declared tools and resolves nested extension paths deterministically', async () => {
    const { service } = await fixture()
    const source = await packageDirectory()
    const manifestPath = join(source, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.pi.extensions = ['./nested/second.mjs', './extension.mjs']
    manifest.genoffice.tools = [
      { extension: './nested/second.mjs', name: 'zeta', effect: 'read' },
      { extension: './extension.mjs', name: 'inspect', effect: 'read' },
    ]
    await write(manifestPath, `${JSON.stringify(manifest)}\n`)
    await write(join(source, 'nested', 'second.mjs'), 'export default function () {}\n')
    await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    await expect(service.resolve('safe-extension')).resolves.toMatchObject({
      tools: [
        { extension: './extension.mjs', name: 'inspect' },
        { extension: './nested/second.mjs', name: 'zeta' },
      ],
      extensionPaths: [
        expect.stringContaining('extension.mjs'),
        expect.stringContaining(join('nested', 'second.mjs')),
      ],
    })
  })

  it.each(['activate', 'disable', 'enable', 'uninstall'] as const)(
    'returns package_not_found for %s without changing the lock',
    async (operation) => {
      const { service } = await fixture()
      await expect(service[operation]('missing')).rejects.toEqual(
        new PackageLockError('package_not_found'),
      )
      await expect(service.catalog()).resolves.toMatchObject({ generation: 1, packages: [] })
    },
  )

  it.each([
    {
      operationId: 'invalid',
      packageId: 'safe-extension',
      source: { type: 'local', path: '/missing' },
    },
    {
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: '../escape',
      source: { type: 'local', path: '/missing' },
    },
    {
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: '/missing' },
      expectedPreviousContentSha256: 'invalid',
    },
    {
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: '' },
    },
    {
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: '/missing' },
      resolvedDirectory: '/forbidden-second-source',
    },
    {
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: {
        type: 'npm',
        name: 'safe-extension',
        version: '1.0.0',
        integrity: `sha512-${Buffer.from('fixed').toString('base64')}`,
      },
    },
  ])('rejects malformed install input before filesystem resolution', async (input) => {
    const { service } = await fixture()
    await expect(service.install(input as never)).rejects.toEqual(
      new PackageLockError('package_source_invalid'),
    )
  })

  it('returns source_unavailable for an exact source whose resolved directory is missing', async () => {
    const { service } = await fixture()
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'safe-extension',
        source: {
          type: 'git',
          url: 'ssh://git@example.com/owner/repo.git',
          commit: 'a'.repeat(40),
        },
        resolvedDirectory: '/definitely/missing/genoffice-package',
      }),
    ).rejects.toEqual(new PackageLockError('package_source_unavailable'))
  })

  it.each([
    'invalid-json',
    'wrong-name',
    'undeclared-tool',
    'missing-extension',
    'extension-is-directory',
  ] as const)('rejects an invalid package manifest: %s', async (scenario) => {
    const { service } = await fixture()
    const source = await packageDirectory()
    const manifestPath = join(source, 'package.json')
    if (scenario === 'invalid-json') await write(manifestPath, '{')
    else {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (scenario === 'wrong-name') manifest.name = 'other-package'
      if (scenario === 'undeclared-tool') manifest.genoffice.tools[0].extension = './other.mjs'
      if (scenario === 'missing-extension') manifest.pi.extensions[0] = './missing.mjs'
      if (scenario === 'extension-is-directory') {
        manifest.pi.extensions[0] = './nested'
        manifest.genoffice.tools[0].extension = './nested'
        await mkdir(join(source, 'nested'))
      }
      await write(manifestPath, `${JSON.stringify(manifest)}\n`)
    }
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'safe-extension',
        source: { type: 'local', path: source },
      }),
    ).rejects.toEqual(new PackageLockError('package_manifest_invalid'))
  })

  it('rejects symlinks and reports changed installed content as integrity_invalid', async () => {
    const { service } = await fixture()
    const linked = await packageDirectory('linked-extension')
    await symlink(join(linked, 'extension.mjs'), join(linked, 'linked.mjs'))
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'linked-extension',
        source: { type: 'local', path: linked },
      }),
    ).rejects.toEqual(new PackageLockError('package_integrity_invalid'))

    const source = await packageDirectory()
    await service.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    const resolved = await service.resolve('safe-extension')
    await write(join(resolved!.directory, 'extension.mjs'), 'drift\n')
    await expect(service.catalog()).resolves.toMatchObject({
      packages: [expect.objectContaining({ status: 'integrity_invalid' })],
    })
    await expect(
      service.install({
        operationId: '44444444-4444-4444-8444-444444444444',
        packageId: 'safe-extension',
        source: { type: 'local', path: source },
      }),
    ).rejects.toEqual(new PackageLockError('package_integrity_invalid'))
  })

  it('rejects an oversized package before copying immutable content', async () => {
    const { service } = await fixture()
    const source = await packageDirectory('oversized-extension')
    await writeFile(join(source, 'oversized.bin'), Buffer.alloc(64 * 1024 * 1024 + 1))
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'oversized-extension',
        source: { type: 'local', path: source },
      }),
    ).rejects.toEqual(new PackageLockError('package_integrity_invalid'))
  })

  it('distinguishes missing immutable content from unsafe content during catalog and resolve', async () => {
    const { service } = await fixture()
    const source = await packageDirectory()
    await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    const installed = await service.resolve('safe-extension')
    await rm(installed!.directory, { recursive: true })
    await expect(service.resolve('safe-extension')).rejects.toEqual(
      new PackageLockError('package_source_unavailable'),
    )

    await service.install({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'safe-extension',
      source: { type: 'local', path: source },
    })
    const restored = await service.resolve('safe-extension')
    await symlink(
      join(restored!.directory, 'extension.mjs'),
      join(restored!.directory, 'linked.mjs'),
    )
    await expect(service.catalog()).resolves.toMatchObject({
      packages: [expect.objectContaining({ status: 'integrity_invalid' })],
    })
  })

  it('supports project lock placement and rejects a project service without an explicit root', async () => {
    const { resourceHome } = await fixture()
    expect(
      () => new PackageLockService({ resourceHome, deviceId, namespace: 'project' }),
    ).toThrowError('package_source_invalid')
    const projectRoot = await root('genoffice-package-project-')
    const service = new PackageLockService({
      resourceHome,
      deviceId,
      namespace: 'project',
      projectRoot,
      platform: 'win32',
    })
    const source = await packageDirectory('project-extension')
    await service.install({
      operationId: '22222222-2222-4222-8222-222222222222',
      packageId: 'project-extension',
      source: { type: 'local', path: source },
    })
    await expect(
      readFile(join(projectRoot, '.open-genoffice', 'agent', 'packages.lock.json'), 'utf8'),
    ).resolves.toContain('project-extension')
  })

  it('fails closed for corrupted lock and device-local source mapping state', async () => {
    const { resourceHome, service } = await fixture()
    await write(join(resourceHome, 'agent', 'packages.lock.json'), '{')
    await expect(service.catalog()).rejects.toEqual(new PackageLockError('package_lock_invalid'))
    await write(join(resourceHome, 'agent', 'packages.lock.json'), '{}\n')
    await expect(service.catalog()).rejects.toEqual(new PackageLockError('package_lock_invalid'))
    await rm(join(resourceHome, 'agent', 'packages.lock.json'))
    await write(join(resourceHome, 'state', 'package-sources.json'), '{')
    await expect(
      service.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'safe-extension',
        source: { type: 'local', path: await packageDirectory() },
      }),
    ).rejects.toEqual(new PackageLockError('package_lock_invalid'))
    await write(join(resourceHome, 'state', 'package-sources.json'), '{}\n')
    await expect(
      service.install({
        operationId: '33333333-3333-4333-8333-333333333333',
        packageId: 'safe-extension',
        source: { type: 'local', path: await packageDirectory() },
      }),
    ).rejects.toEqual(new PackageLockError('package_lock_invalid'))
  })
})
