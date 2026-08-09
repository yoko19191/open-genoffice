import { lstat, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteFile, atomicWriteJson } from '../src/index'

describe('atomic Resource Home writes', () => {
  it('commits a private file through same-directory rename and leaves no temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-atomic-file-'))
    const target = join(root, 'state.json')
    await atomicWriteFile(target, 'complete-new-generation\n', {
      platform: 'linux',
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    })

    expect(await readFile(target, 'utf8')).toBe('complete-new-generation\n')
    expect((await lstat(target)).mode & 0o777).toBe(0o600)
    expect(await readdir(root)).toEqual(['state.json'])
  })

  it('exposes a complete old or new generation at every injected crash point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-atomic-crash-'))
    const target = join(root, 'state.json')
    await writeFile(target, 'complete-old-generation\n')

    await expect(
      atomicWriteFile(target, 'complete-new-generation\n', {
        platform: 'linux',
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        failAt: 'before_rename',
      }),
    ).rejects.toThrow('injected_atomic_write_failure')
    expect(await readFile(target, 'utf8')).toBe('complete-old-generation\n')
    expect(await readdir(root)).toEqual(['state.json'])

    await expect(
      atomicWriteFile(target, 'complete-new-generation\n', {
        platform: 'linux',
        randomUUID: () => '33333333-3333-4333-8333-333333333333',
        failAt: 'after_rename',
      }),
    ).rejects.toThrow('injected_atomic_write_failure')
    expect(await readFile(target, 'utf8')).toBe('complete-new-generation\n')
    expect(await readdir(root)).toEqual(['state.json'])
  })

  it('writes canonical newline-terminated JSON and supports Windows commit semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-atomic-json-'))
    const target = join(root, 'index.json')
    await atomicWriteJson(target, { schemaVersion: 1, entries: [] }, { platform: 'win32' })
    await atomicWriteFile(join(root, 'default.bin'), new Uint8Array([1, 2, 3]))

    expect(await readFile(target, 'utf8')).toBe('{\n  "schemaVersion": 1,\n  "entries": []\n}\n')
    expect(await readFile(join(root, 'default.bin'))).toEqual(Buffer.from([1, 2, 3]))
  })
})
