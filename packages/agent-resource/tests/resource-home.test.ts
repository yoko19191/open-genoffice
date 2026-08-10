import { lstat, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentResourceError,
  RESOURCE_HOME_DIRECTORIES,
  initializeAgentResourceHome,
} from '../src/index'

const DEVICE_ID = '11111111-1111-4111-8111-111111111111'

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777
}

describe('Agent Resource Home', () => {
  it('initializes only the prescribed layout in a clean fake HOME with private POSIX modes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-resource-home-'))
    for (const legacy of ['.pi', '.codex', '.genoffice']) {
      await mkdir(join(home, legacy))
      await writeFile(join(home, legacy, 'canary'), `${legacy}-untouched\n`)
    }

    const initialized = await initializeAgentResourceHome({
      rootDirectory: join(home, '.open-genoffice'),
      runtimeVersion: '1.0.0',
      platform: 'linux',
      randomUUID: () => DEVICE_ID,
    })

    expect(initialized.root).toBe(join(home, '.open-genoffice'))
    expect(initialized.schema).toEqual({
      schemaVersion: 1,
      createdByRuntimeVersion: '1.0.0',
      deviceId: DEVICE_ID,
    })
    expect(await readdir(initialized.root, { recursive: true })).toEqual(
      expect.arrayContaining([
        'schema.json',
        ...RESOURCE_HOME_DIRECTORIES.filter((path) => path.length > 0),
      ]),
    )
    expect(await mode(initialized.root)).toBe(0o700)
    expect(await mode(join(initialized.root, 'state'))).toBe(0o700)
    expect(await mode(join(initialized.root, 'agent', 'sessions'))).toBe(0o700)
    expect(await mode(join(initialized.root, 'schema.json'))).toBe(0o600)
    for (const legacy of ['.pi', '.codex', '.genoffice']) {
      expect(await readFile(join(home, legacy, 'canary'), 'utf8')).toBe(`${legacy}-untouched\n`)
    }
  })

  it('is idempotent and preserves the first valid schema identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-resource-idempotent-'))
    const first = await initializeAgentResourceHome({
      rootDirectory: join(home, '.open-genoffice'),
      runtimeVersion: '1.0.0',
      platform: 'darwin',
      randomUUID: () => DEVICE_ID,
    })
    const second = await initializeAgentResourceHome({
      rootDirectory: join(home, '.open-genoffice'),
      runtimeVersion: '2.0.0',
      platform: 'darwin',
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
    })

    expect(second.schema).toEqual(first.schema)
    expect(JSON.parse(await readFile(second.schemaPath, 'utf8'))).toEqual(first.schema)
  })

  it('fails closed on an invalid existing schema or a symlinked Resource Home', async () => {
    const corruptHome = await mkdtemp(join(tmpdir(), 'agent-resource-corrupt-'))
    await mkdir(join(corruptHome, '.open-genoffice'))
    const schemaPath = join(corruptHome, '.open-genoffice', 'schema.json')
    await writeFile(schemaPath, '{"schemaVersion":99}\n')
    await expect(
      initializeAgentResourceHome({
        rootDirectory: join(corruptHome, '.open-genoffice'),
        runtimeVersion: '1.0.0',
        platform: 'linux',
        randomUUID: () => DEVICE_ID,
      }),
    ).rejects.toEqual(new AgentResourceError('resource_home_schema_invalid'))
    expect(await readFile(schemaPath, 'utf8')).toBe('{"schemaVersion":99}\n')
    expect(await readdir(join(corruptHome, '.open-genoffice'))).toEqual(['schema.json'])

    const symlinkHome = await mkdtemp(join(tmpdir(), 'agent-resource-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'agent-resource-outside-'))
    await symlink(outside, join(symlinkHome, '.open-genoffice'))
    await expect(
      initializeAgentResourceHome({
        rootDirectory: join(symlinkHome, '.open-genoffice'),
        runtimeVersion: '1.0.0',
        platform: 'linux',
        randomUUID: () => DEVICE_ID,
      }),
    ).rejects.toEqual(new AgentResourceError('resource_home_symlink_forbidden'))
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects non-directory roots, unsafe schema entries, and invalid generated identity', async () => {
    const fileHome = await mkdtemp(join(tmpdir(), 'agent-resource-file-root-'))
    await writeFile(join(fileHome, '.open-genoffice'), 'not-a-directory\n')
    await expect(
      initializeAgentResourceHome({
        rootDirectory: join(fileHome, '.open-genoffice'),
        runtimeVersion: '1.0.0',
        platform: 'linux',
        randomUUID: () => DEVICE_ID,
      }),
    ).rejects.toEqual(new AgentResourceError('resource_home_not_directory'))

    for (const schemaKind of ['directory', 'symlink'] as const) {
      const home = await mkdtemp(join(tmpdir(), `agent-resource-schema-${schemaKind}-`))
      const root = join(home, '.open-genoffice')
      await mkdir(root)
      if (schemaKind === 'directory') {
        await mkdir(join(root, 'schema.json'))
      } else {
        const outside = join(home, 'outside-schema.json')
        await writeFile(outside, '{}\n')
        await symlink(outside, join(root, 'schema.json'))
      }
      await expect(
        initializeAgentResourceHome({
          rootDirectory: join(home, '.open-genoffice'),
          runtimeVersion: '1.0.0',
          platform: 'linux',
          randomUUID: () => DEVICE_ID,
        }),
      ).rejects.toEqual(new AgentResourceError('resource_home_schema_invalid'))
    }

    const invalidHome = await mkdtemp(join(tmpdir(), 'agent-resource-invalid-id-'))
    await expect(
      initializeAgentResourceHome({
        rootDirectory: join(invalidHome, '.open-genoffice'),
        runtimeVersion: '1.0.0',
        platform: 'linux',
        randomUUID: () => 'invalid-device-id',
      }),
    ).rejects.toEqual(new AgentResourceError('resource_home_schema_invalid'))
  })

  it('does not apply POSIX chmod policy when initialized for Windows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-resource-windows-'))
    const initialized = await initializeAgentResourceHome({
      rootDirectory: join(home, '.open-genoffice'),
      runtimeVersion: '1.0.0',
      platform: 'win32',
      randomUUID: () => DEVICE_ID,
    })

    expect(initialized.schema.deviceId).toBe(DEVICE_ID)
    expect(
      (
        await initializeAgentResourceHome({
          rootDirectory: join(home, '.open-genoffice'),
          runtimeVersion: '2.0.0',
          platform: 'win32',
        })
      ).schema,
    ).toEqual(initialized.schema)
  })

  it('uses secure defaults when optional platform and UUID dependencies are omitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-resource-defaults-'))
    const initialized = await initializeAgentResourceHome({
      rootDirectory: join(home, '.open-genoffice'),
      runtimeVersion: '1.0.0',
    })

    expect(initialized.schema.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
