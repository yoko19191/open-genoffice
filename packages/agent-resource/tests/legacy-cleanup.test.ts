import { lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_CLEANUP_MANIFEST,
  LEGACY_RENDERER_STORAGE_KEYS,
  LegacyCleanupError,
  runLegacyAgentCleanup,
} from '../src/index'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-cleanup-'))
  const resourceHome = join(root, '.open-genoffice')
  const userData = join(root, 'user-data')
  const legacyGenoffice = join(root, '.genoffice')
  await mkdir(join(resourceHome, 'state'), { recursive: true })
  await mkdir(join(userData, 'projects', 'default', 'chats'), { recursive: true })
  await mkdir(join(userData, 'projects', 'project-2', 'chats'), { recursive: true })
  await mkdir(join(userData, 'autosave'), { recursive: true })
  await mkdir(join(userData, 'recovery'), { recursive: true })
  await mkdir(join(legacyGenoffice, 'bin'), { recursive: true })
  await writeFile(join(userData, 'ai-settings.json'), '{"apiKey":"plaintext-secret"}\n')
  await writeFile(join(userData, 'cloud-projects.json'), '{"projects":[{"secret":"cloud"}]}\n')
  await writeFile(join(userData, 'projects', 'index.json'), '{"chatIdByPath":{"/doc":"old"}}\n')
  await writeFile(join(userData, 'projects', 'default', 'chats', 'one.jsonl'), 'old chat\n')
  await writeFile(join(userData, 'projects', 'project-2', 'chats', 'two.jsonl'), 'old chat\n')
  await writeFile(join(userData, 'projects', 'default', 'chats', 'README.txt'), 'keep sibling\n')
  await writeFile(join(userData, 'projects', 'default', 'project.json'), '{"files":[]}\n')
  await writeFile(join(userData, 'app-settings.json'), '{"language":"zh"}\n')
  await writeFile(join(userData, 'autosave', 'draft.docx'), 'office autosave\n')
  await writeFile(join(userData, 'recovery', 'sheet.xlsx'), 'office recovery\n')
  await writeFile(join(legacyGenoffice, 'auth.json'), '{"api_key":"gsk-secret"}\n')
  await writeFile(join(legacyGenoffice, 'bin', 'electron-compat.js'), 'legacy sidecar\n')
  await writeFile(join(legacyGenoffice, 'user-note.txt'), 'not owned by cleaner\n')
  return { root, resourceHome, userData, legacyGenoffice }
}

describe('legacy Agent cleanup', () => {
  it('exposes only reviewed relative rules with ownership and sibling-preservation metadata', () => {
    expect(LEGACY_CLEANUP_MANIFEST).toHaveLength(6)
    expect(LEGACY_CLEANUP_MANIFEST.map((rule) => rule.category)).toEqual([
      'project_index',
      'project_chats',
      'ai_settings',
      'cloud_projects',
      'genoffice_auth',
      'cli_sidecar',
    ])
    for (const rule of LEGACY_CLEANUP_MANIFEST) {
      expect(rule).toMatchObject({
        owner: 'open-genoffice-agent',
        introducedBefore: 'pi-agent-platform-v1',
        preserveSiblings: true,
      })
      expect(rule.relativePath.length).toBeGreaterThan(0)
      for (const segment of rule.relativePath) {
        for (const forbidden of ['/', '\\', '~', '*', '?', '[', ']', '{', '}', '(', ')']) {
          expect(segment).not.toContain(forbidden)
        }
        expect(segment).not.toBe('..')
      }
    }
  })

  it('deletes only the reviewed Agent/Genspark targets and preserves Office/autosave siblings', async () => {
    const { resourceHome, userData, legacyGenoffice } = await fixture()
    const report = await runLegacyAgentCleanup({ resourceHome, userData, legacyGenoffice })

    expect(report.status).toBe('completed')
    expect(report.results).toEqual([
      { category: 'project_index', status: 'deleted', matched: 1 },
      { category: 'project_chats', status: 'deleted', matched: 2 },
      { category: 'ai_settings', status: 'deleted', matched: 1 },
      { category: 'cloud_projects', status: 'deleted', matched: 1 },
      { category: 'genoffice_auth', status: 'deleted', matched: 1 },
      { category: 'cli_sidecar', status: 'deleted', matched: 1 },
    ])
    for (const path of [
      join(userData, 'projects', 'index.json'),
      join(userData, 'projects', 'default', 'chats', 'one.jsonl'),
      join(userData, 'projects', 'project-2', 'chats', 'two.jsonl'),
      join(userData, 'ai-settings.json'),
      join(userData, 'cloud-projects.json'),
      join(legacyGenoffice, 'auth.json'),
      join(legacyGenoffice, 'bin', 'electron-compat.js'),
    ]) {
      expect(await exists(path)).toBe(false)
    }
    expect(await readFile(join(userData, 'app-settings.json'), 'utf8')).toContain('language')
    expect(await readFile(join(userData, 'autosave', 'draft.docx'), 'utf8')).toBe(
      'office autosave\n',
    )
    expect(await readFile(join(userData, 'recovery', 'sheet.xlsx'), 'utf8')).toBe(
      'office recovery\n',
    )
    expect(await readFile(join(userData, 'projects', 'default', 'project.json'), 'utf8')).toContain(
      'files',
    )
    expect(
      await readFile(join(userData, 'projects', 'default', 'chats', 'README.txt'), 'utf8'),
    ).toBe('keep sibling\n')
    expect(await readFile(join(legacyGenoffice, 'user-note.txt'), 'utf8')).toBe(
      'not owned by cleaner\n',
    )

    const journal = JSON.parse(
      await readFile(join(resourceHome, 'state', 'migrations.json'), 'utf8'),
    )
    expect(journal).toMatchObject({
      schemaVersion: 1,
      generation: 1,
      completed: [{ id: 'pi-agent-platform-v1-cleanup', manifestVersion: 1 }],
    })
    expect(JSON.stringify(journal)).not.toMatch(/secret|user-data|legacy-cleanup/)
  })

  it('is idempotent and does not advance the completed migration generation twice', async () => {
    const options = await fixture()
    const first = await runLegacyAgentCleanup(options)
    const firstJournal = await readFile(
      join(options.resourceHome, 'state', 'migrations.json'),
      'utf8',
    )
    const second = await runLegacyAgentCleanup(options)
    const secondJournal = await readFile(
      join(options.resourceHome, 'state', 'migrations.json'),
      'utf8',
    )

    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(second.results.every((result) => result.status === 'absent')).toBe(true)
    expect(secondJournal).toBe(firstJournal)
  })

  it('continues after one deletion failure, omits completion, and succeeds on retry', async () => {
    const options = await fixture()
    const failed = await runLegacyAgentCleanup({
      ...options,
      removeFile: async (path) => {
        if (basename(path) === 'cloud-projects.json') throw new Error('locked')
        const { unlink } = await import('node:fs/promises')
        await unlink(path)
      },
    })

    expect(failed.status).toBe('incomplete')
    expect(failed.results).toContainEqual({
      category: 'cloud_projects',
      status: 'failed',
      matched: 1,
    })
    expect(await exists(join(options.userData, 'cloud-projects.json'))).toBe(true)
    expect(await exists(join(options.resourceHome, 'state', 'migrations.json'))).toBe(false)
    expect(JSON.stringify(failed)).not.toContain('locked')

    const retried = await runLegacyAgentCleanup(options)
    expect(retried.status).toBe('completed')
    expect(await exists(join(options.userData, 'cloud-projects.json'))).toBe(false)
  })

  it('rejects symlink targets without following them or recording completion', async () => {
    const options = await fixture()
    const outside = join(options.root, 'outside-secret.json')
    await writeFile(outside, 'outside stays\n')
    const target = join(options.userData, 'ai-settings.json')
    const { unlink } = await import('node:fs/promises')
    await unlink(target)
    await symlink(outside, target)

    const report = await runLegacyAgentCleanup(options)
    expect(report.status).toBe('incomplete')
    expect(report.results).toContainEqual({
      category: 'ai_settings',
      status: 'rejected',
      matched: 1,
    })
    expect(await readFile(outside, 'utf8')).toBe('outside stays\n')
    expect(await lstat(target)).toMatchObject({})
    expect(await exists(join(options.resourceHome, 'state', 'migrations.json'))).toBe(false)
  })

  it('fails closed before deletion when the migration journal is corrupt', async () => {
    const options = await fixture()
    const journal = join(options.resourceHome, 'state', 'migrations.json')
    await writeFile(journal, '{corrupt')
    await expect(runLegacyAgentCleanup(options)).rejects.toEqual(
      new LegacyCleanupError('migration_journal_invalid'),
    )
    expect(await exists(join(options.userData, 'ai-settings.json'))).toBe(true)
    expect(await readFile(journal, 'utf8')).toBe('{corrupt')
  })

  it('rejects unsafe structural variants while ignoring unrelated project entries', async () => {
    const options = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'legacy-cleanup-outside-'))

    const settings = join(options.userData, 'ai-settings.json')
    const movedSettings = `${settings}.old`
    await rename(settings, movedSettings)
    await mkdir(settings)

    await symlink(outside, join(options.userData, 'projects', 'linked-project'))
    await mkdir(join(options.userData, 'projects', 'empty-project'))
    await writeFile(join(options.userData, 'projects', 'plain-project'), 'not a directory\n')
    await mkdir(join(options.userData, 'projects', '.ignored', 'chats'), { recursive: true })
    await writeFile(
      join(options.userData, 'projects', '.ignored', 'chats', 'ignored.jsonl'),
      'preserve\n',
    )
    await mkdir(join(options.userData, 'projects', 'bad-chats'))
    await writeFile(join(options.userData, 'projects', 'bad-chats', 'chats'), 'not a directory\n')
    await symlink(outside, join(options.userData, 'projects', 'default', 'chats', 'linked.jsonl'))
    await mkdir(join(options.userData, 'projects', 'default', 'chats', 'directory.jsonl'))

    const legacyLink = join(options.root, 'legacy-link')
    await symlink(options.legacyGenoffice, legacyLink)
    const report = await runLegacyAgentCleanup({ ...options, legacyGenoffice: legacyLink })

    expect(report.status).toBe('incomplete')
    expect(report.results).toContainEqual({
      category: 'project_chats',
      status: 'rejected',
      matched: 6,
    })
    expect(report.results).toContainEqual({
      category: 'ai_settings',
      status: 'rejected',
      matched: 1,
    })
    expect(report.results).toContainEqual({
      category: 'genoffice_auth',
      status: 'rejected',
      matched: 1,
    })
    expect(await readFile(movedSettings, 'utf8')).toContain('plaintext-secret')
    expect(
      await readFile(
        join(options.userData, 'projects', '.ignored', 'chats', 'ignored.jsonl'),
        'utf8',
      ),
    ).toBe('preserve\n')
  })

  it('handles absent legacy roots/projects and Windows policy without creating them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-cleanup-minimal-'))
    const resourceHome = join(root, '.open-genoffice')
    const userData = join(root, 'user-data')
    const legacyGenoffice = join(root, '.genoffice-absent')
    await mkdir(join(resourceHome, 'state'), { recursive: true })
    await mkdir(userData)
    const report = await runLegacyAgentCleanup({
      resourceHome,
      userData,
      legacyGenoffice,
      platform: 'win32',
      now: () => new Date('2026-08-10T01:02:03.000Z'),
    })
    expect(report.status).toBe('completed')
    expect(report.results.every((result) => result.status === 'absent')).toBe(true)
    expect(await exists(legacyGenoffice)).toBe(false)
    expect(
      JSON.parse(await readFile(join(resourceHome, 'state', 'migrations.json'), 'utf8')),
    ).toMatchObject({
      completed: [{ completedAt: '2026-08-10T01:02:03.000Z' }],
    })
  })

  it('reports failed verification and failed chat deletion without leaking errors', async () => {
    const options = await fixture()
    const report = await runLegacyAgentCleanup({
      ...options,
      removeFile: async (path) => {
        if (path.endsWith('.jsonl')) throw new Error(`secret failure at ${path}`)
        if (basename(path) === 'ai-settings.json') return
        const { unlink } = await import('node:fs/promises')
        await unlink(path)
      },
    })
    expect(report.status).toBe('incomplete')
    expect(report.results).toContainEqual({
      category: 'project_chats',
      status: 'failed',
      matched: 2,
    })
    expect(report.results).toContainEqual({
      category: 'ai_settings',
      status: 'failed',
      matched: 1,
    })
    expect(JSON.stringify(report)).not.toMatch(/secret failure|legacy-cleanup-/)
  })

  it('rejects invalid roots and non-file migration journals before cleanup', async () => {
    const options = await fixture()
    await expect(
      runLegacyAgentCleanup({ ...options, userData: join(options.root, 'missing') }),
    ).rejects.toEqual(new LegacyCleanupError('cleanup_root_invalid'))
    const fileRoot = join(options.root, 'file-root')
    await writeFile(fileRoot, 'not a directory\n')
    await expect(runLegacyAgentCleanup({ ...options, userData: fileRoot })).rejects.toEqual(
      new LegacyCleanupError('cleanup_root_invalid'),
    )

    const journal = join(options.resourceHome, 'state', 'migrations.json')
    await mkdir(journal)
    await expect(runLegacyAgentCleanup(options)).rejects.toEqual(
      new LegacyCleanupError('migration_journal_invalid'),
    )
  })

  it('rejects a symlink migration journal and an invalid completed timestamp', async () => {
    const symlinkOptions = await fixture()
    const outside = join(symlinkOptions.root, 'outside-journal.json')
    await writeFile(outside, '{}\n')
    await symlink(outside, join(symlinkOptions.resourceHome, 'state', 'migrations.json'))
    await expect(runLegacyAgentCleanup(symlinkOptions)).rejects.toEqual(
      new LegacyCleanupError('migration_journal_invalid'),
    )

    const dateOptions = await fixture()
    await writeFile(
      join(dateOptions.resourceHome, 'state', 'migrations.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        completed: [{ id: 'other', manifestVersion: 1, completedAt: '2026-99-99T99:99:99.000Z' }],
      }),
    )
    await expect(runLegacyAgentCleanup(dateOptions)).rejects.toEqual(
      new LegacyCleanupError('migration_journal_invalid'),
    )
  })

  it('rejects a non-directory projects root and an inaccessible legacy root shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-cleanup-projects-file-'))
    const resourceHome = join(root, '.open-genoffice')
    const userData = join(root, 'user-data')
    await mkdir(join(resourceHome, 'state'), { recursive: true })
    await mkdir(userData)
    await writeFile(join(userData, 'projects'), 'not a directory\n')
    const parentFile = join(root, 'legacy-parent-file')
    await writeFile(parentFile, 'not a directory\n')

    const report = await runLegacyAgentCleanup({
      resourceHome,
      userData,
      legacyGenoffice: join(parentFile, 'child'),
    })
    expect(report.status).toBe('incomplete')
    expect(report.results).toContainEqual({
      category: 'project_index',
      status: 'failed',
      matched: 1,
    })
    expect(report.results).toContainEqual({
      category: 'project_chats',
      status: 'rejected',
      matched: 1,
    })
    expect(report.results).toContainEqual({
      category: 'genoffice_auth',
      status: 'rejected',
      matched: 1,
    })
  })

  it('preserves unrelated migration records and fails atomically before journal rename', async () => {
    const options = await fixture()
    const journal = join(options.resourceHome, 'state', 'migrations.json')
    await writeFile(
      journal,
      `${JSON.stringify({
        schemaVersion: 1,
        generation: 4,
        completed: [
          {
            id: 'other-migration',
            manifestVersion: 2,
            completedAt: '2026-08-09T00:00:00.000Z',
          },
        ],
      })}\n`,
    )
    await expect(
      runLegacyAgentCleanup({
        ...options,
        migrationAtomicWriteOptions: { failAt: 'before_rename' },
      }),
    ).rejects.toThrow('injected_atomic_write_failure')
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({
      generation: 4,
      completed: [{ id: 'other-migration' }],
    })
  })

  it('publishes only reviewed renderer storage keys for removal during app cutover', () => {
    expect(LEGACY_RENDERER_STORAGE_KEYS).toEqual(['ai-excel-chat-history'])
  })
})
