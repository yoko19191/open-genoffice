import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { c } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PackageInstallCoordinator,
  PackageSourceResolver,
  PackageSourceResolverError,
  type GitCommandRunner,
} from '../src/package-source-resolver'

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

async function npmArchive(options: { symlink?: boolean } = {}) {
  const archiveRoot = await root('genoffice-npm-archive-')
  const packageRoot = join(archiveRoot, 'package')
  await write(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'safe-extension', version: '1.2.3' })}\n`,
  )
  await write(join(packageRoot, 'extension.mjs'), 'export default function () {}\n')
  if (options.symlink) {
    await symlink(join(packageRoot, 'extension.mjs'), join(packageRoot, 'linked.mjs'))
  }
  const archive = join(archiveRoot, 'package.tgz')
  await c({ cwd: archiveRoot, file: archive, gzip: true }, ['package'])
  const bytes = await readFile(archive)
  return {
    bytes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}

function response(body: unknown, options: { url?: string; headers?: Record<string, string> } = {}) {
  const bytes = body instanceof Uint8Array ? body : Buffer.from(JSON.stringify(body))
  return {
    ok: true,
    status: 200,
    url: options.url ?? 'https://registry.npmjs.org/safe-extension/1.2.3',
    headers: new Headers(options.headers),
    json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Response
}

describe('PackageSourceResolver', () => {
  it('downloads an exact npm tarball, verifies registry integrity, and extracts safe content', async () => {
    const resourceHome = await root('genoffice-package-resolver-')
    const archive = await npmArchive()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          name: 'safe-extension',
          version: '1.2.3',
          dist: {
            tarball: 'https://registry.npmjs.org/safe-extension/-/safe-extension-1.2.3.tgz',
            integrity: archive.integrity,
          },
        }),
      )
      .mockResolvedValueOnce(
        response(archive.bytes, {
          url: 'https://registry.npmjs.org/safe-extension/-/safe-extension-1.2.3.tgz',
          headers: { 'content-length': String(archive.bytes.byteLength) },
        }),
      )
    const resolver = new PackageSourceResolver({ resourceHome, fetch })
    const resolved = await resolver.resolve({
      type: 'npm',
      name: 'safe-extension',
      version: '1.2.3',
    })

    expect(resolved.source).toEqual({
      type: 'npm',
      name: 'safe-extension',
      version: '1.2.3',
      integrity: archive.integrity,
    })
    await expect(readFile(join(resolved.directory, 'extension.mjs'), 'utf8')).resolves.toContain(
      'export default',
    )
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://registry.npmjs.org/safe-extension/1.2.3',
      expect.objectContaining({ redirect: 'error' }),
    )
    await resolved.cleanup()
    await expect(readFile(resolved.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['floating npm range', { type: 'npm', name: 'safe-extension', version: '^1.2.3' }],
    ['floating npm tag', { type: 'npm', name: 'safe-extension', version: 'latest' }],
    ['floating git ref', { type: 'git', url: 'https://example.com/repo.git', commit: 'main' }],
    [
      'insecure git transport',
      { type: 'git', url: 'http://example.com/repo.git', commit: 'a'.repeat(40) },
    ],
    ['invalid git URL', { type: 'git', url: 'not-a-url', commit: 'a'.repeat(40) }],
  ])('rejects a floating or insecure source before network access: %s', async (_case, source) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const git = vi.fn<GitCommandRunner>()
    const resolver = new PackageSourceResolver({
      resourceHome: await root('genoffice-package-resolver-'),
      fetch,
      git,
    })
    await expect(resolver.resolve(source as never)).rejects.toEqual(
      new PackageSourceResolverError('package_source_invalid'),
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(git).not.toHaveBeenCalled()
  })

  it('resolves a local directory without staging and rejects empty or unavailable paths', async () => {
    const resourceHome = await root('genoffice-package-resolver-local-')
    const directory = await root('genoffice-package-local-source-')
    const canonicalDirectory = await realpath(directory)
    const resolver = new PackageSourceResolver({ resourceHome })
    const resolved = await resolver.resolve({ type: 'local', path: directory })
    expect(resolved).toMatchObject({
      source: { type: 'local', path: canonicalDirectory },
      directory: canonicalDirectory,
    })
    await expect(resolved.cleanup()).resolves.toBeUndefined()
    await expect(resolver.resolve({ type: 'local', path: '' })).rejects.toEqual(
      new PackageSourceResolverError('package_source_invalid'),
    )
    await expect(
      resolver.resolve({ type: 'local', path: join(directory, 'missing') }),
    ).rejects.toEqual(new PackageSourceResolverError('package_source_unavailable'))
  })

  it('fails closed on npm metadata, integrity, size, redirects, and unsafe archive entries', async () => {
    const archive = await npmArchive({ symlink: true })
    const metadata = {
      name: 'safe-extension',
      version: '1.2.3',
      dist: {
        tarball: 'https://registry.npmjs.org/safe-extension/-/safe-extension-1.2.3.tgz',
        integrity: archive.integrity,
      },
    }
    const invalidArchive = Buffer.from('not a tar archive')
    const invalidIntegrity = `sha512-${createHash('sha512').update(invalidArchive).digest('base64')}`
    const cases: Array<{ fetch: typeof globalThis.fetch; code: string }> = [
      {
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(null)),
        code: 'package_source_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response({ ...metadata, version: '1.2.4' })),
        code: 'package_source_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce({ ...response(metadata), ok: false, status: 404 }),
        code: 'package_source_unavailable',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce({ ...response(archive.bytes), ok: false, status: 503 }),
        code: 'package_source_unavailable',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce(response(Buffer.from('drift'))),
        code: 'package_integrity_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce(
            response(archive.bytes, { headers: { 'content-length': String(65 * 1024 * 1024) } }),
          ),
        code: 'package_source_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce(
            response(new Uint8Array(64 * 1024 * 1024 + 1), {
              headers: { 'content-length': '0' },
            }),
          ),
        code: 'package_source_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce(
            response(archive.bytes, { url: 'http://registry.npmjs.org/archive.tgz' }),
          ),
        code: 'package_source_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(response(metadata))
          .mockResolvedValueOnce(response(archive.bytes)),
        code: 'package_integrity_invalid',
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            response({
              ...metadata,
              dist: { ...metadata.dist, integrity: invalidIntegrity },
            }),
          )
          .mockResolvedValueOnce(response(invalidArchive)),
        code: 'package_integrity_invalid',
      },
      {
        fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('offline')),
        code: 'package_source_unavailable',
      },
    ]
    for (const entry of cases) {
      const resolver = new PackageSourceResolver({
        resourceHome: await root('genoffice-package-resolver-invalid-'),
        fetch: entry.fetch,
      })
      await expect(
        resolver.resolve({ type: 'npm', name: 'safe-extension', version: '1.2.3' }),
      ).rejects.toEqual(new PackageSourceResolverError(entry.code as never))
    }

    const invalidInputFetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      new PackageSourceResolver({
        resourceHome: await root('genoffice-package-resolver-invalid-input-'),
        fetch: invalidInputFetch,
      }).resolve({
        type: 'npm',
        name: 'Invalid Package',
        version: '1.2.3',
        integrity: 'invalid',
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_source_invalid'))
    expect(invalidInputFetch).not.toHaveBeenCalled()

    const mismatchFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(metadata))
    await expect(
      new PackageSourceResolver({
        resourceHome: await root('genoffice-package-resolver-integrity-mismatch-'),
        fetch: mismatchFetch,
      }).resolve({
        type: 'npm',
        name: 'safe-extension',
        version: '1.2.3',
        integrity: 'sha512-ZGlmZmVyZW50',
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_integrity_invalid'))
  })

  it('fetches only the requested Git commit and exports a checkout without repository metadata', async () => {
    const resourceHome = await root('genoffice-package-resolver-git-')
    const archiveRoot = await root('genoffice-git-archive-')
    await write(join(archiveRoot, 'package.json'), '{}\n')
    await write(join(archiveRoot, 'extension.mjs'), 'export default function () {}\n')
    const commit = 'a'.repeat(40)
    const calls: string[][] = []
    const git: GitCommandRunner = async (_command, args) => {
      calls.push(args)
      if (args.includes('rev-parse')) return { stdout: `${commit}\n` }
      const output = args.find((argument) => argument.startsWith('--output='))
      if (output)
        await c({ cwd: archiveRoot, file: output.slice('--output='.length) }, [
          'package.json',
          'extension.mjs',
        ])
      return { stdout: '' }
    }
    const resolver = new PackageSourceResolver({ resourceHome, git })
    const resolved = await resolver.resolve({
      type: 'git',
      url: 'ssh://git@example.com/owner/repo.git',
      commit,
    })

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          'fetch',
          '--depth=1',
          '--no-tags',
          'ssh://git@example.com/owner/repo.git',
          commit,
        ]),
        expect.arrayContaining(['rev-parse', 'FETCH_HEAD^{commit}']),
        expect.arrayContaining([
          'archive',
          '--format=tar',
          expect.stringMatching(/^--output=.+package\.tar$/),
          commit,
        ]),
      ]),
    )
    await expect(readFile(join(resolved.directory, 'extension.mjs'), 'utf8')).resolves.toContain(
      'export default',
    )
    await expect(readFile(join(resolved.directory, '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await resolved.cleanup()
  })

  it('rejects a Git fetch that does not resolve to the requested commit', async () => {
    const git = vi.fn<GitCommandRunner>(async (_command, args) => ({
      stdout: args.includes('rev-parse') ? `${'b'.repeat(40)}\n` : '',
    }))
    const resolver = new PackageSourceResolver({
      resourceHome: await root('genoffice-package-resolver-git-invalid-'),
      git,
    })
    await expect(
      resolver.resolve({
        type: 'git',
        url: 'https://example.com/owner/repo.git',
        commit: 'a'.repeat(40),
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_integrity_invalid'))

    const failingGit = vi.fn<GitCommandRunner>().mockRejectedValueOnce(new Error('offline'))
    await expect(
      new PackageSourceResolver({
        resourceHome: await root('genoffice-package-resolver-git-offline-'),
        git: failingGit,
      }).resolve({
        type: 'git',
        url: 'https://example.com/owner/repo.git',
        commit: 'a'.repeat(40),
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_source_unavailable'))
  })

  it('uses the non-shell Git runner in production and maps command failure', async () => {
    const resolver = new PackageSourceResolver({
      resourceHome: await root('genoffice-package-resolver-default-git-'),
    })
    await expect(
      resolver.resolve({
        type: 'git',
        url: 'https://127.0.0.1:1/unavailable.git',
        commit: 'a'.repeat(40),
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_source_unavailable'))
  })

  it('coordinates resolution, immutable lock install, cleanup, and failed resolution without mutation', async () => {
    const cleanup = vi.fn(async () => undefined)
    const resolver = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          source: {
            type: 'npm',
            name: 'safe-extension',
            version: '1.2.3',
            integrity: 'sha512-Zml4ZWQ=',
          },
          directory: '/resolved/package',
          cleanup,
        })
        .mockRejectedValueOnce(new PackageSourceResolverError('package_source_unavailable')),
    }
    const packages = { install: vi.fn(async () => ({ generation: 2, packages: [] })) }
    const coordinator = new PackageInstallCoordinator({ resolver, packages })
    await expect(
      coordinator.install({
        operationId: '11111111-1111-4111-8111-111111111111',
        packageId: 'safe-extension',
        source: { type: 'npm', name: 'safe-extension', version: '1.2.3' },
        expectedPreviousContentSha256: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ generation: 2, packages: [] })
    expect(packages.install).toHaveBeenCalledWith({
      operationId: '11111111-1111-4111-8111-111111111111',
      packageId: 'safe-extension',
      source: {
        type: 'npm',
        name: 'safe-extension',
        version: '1.2.3',
        integrity: 'sha512-Zml4ZWQ=',
      },
      resolvedDirectory: '/resolved/package',
      expectedPreviousContentSha256: 'a'.repeat(64),
    })
    expect(cleanup).toHaveBeenCalledOnce()
    await expect(
      coordinator.install({
        operationId: '22222222-2222-4222-8222-222222222222',
        packageId: 'safe-extension',
        source: { type: 'npm', name: 'safe-extension', version: '1.2.3' },
      }),
    ).rejects.toEqual(new PackageSourceResolverError('package_source_unavailable'))
    expect(packages.install).toHaveBeenCalledOnce()

    resolver.resolve.mockResolvedValueOnce({
      source: { type: 'local', path: '/local/package' },
      directory: '/local/package',
      cleanup,
    })
    packages.install.mockRejectedValueOnce(new Error('lock write failed'))
    await expect(
      coordinator.install({
        operationId: '33333333-3333-4333-8333-333333333333',
        packageId: 'local-extension',
        source: { type: 'local', path: '/local/package' },
      }),
    ).rejects.toThrowError('lock write failed')
    expect(packages.install).toHaveBeenLastCalledWith({
      operationId: '33333333-3333-4333-8333-333333333333',
      packageId: 'local-extension',
      source: { type: 'local', path: '/local/package' },
    })
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
