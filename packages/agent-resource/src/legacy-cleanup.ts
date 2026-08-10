import { chmod, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson, type AtomicWriteOptions } from './atomic-file'
import { lock } from './proper-lockfile'

export const LEGACY_CLEANUP_MIGRATION_ID = 'pi-agent-platform-v1-cleanup'
export const LEGACY_CLEANUP_MANIFEST_VERSION = 1
export const LEGACY_RENDERER_STORAGE_KEYS = Object.freeze(['ai-excel-chat-history'] as const)

export type LegacyCleanupManifestRule = Readonly<{
  category: LegacyCleanupCategory
  root: 'electron_user_data' | 'legacy_genoffice'
  relativePath: readonly string[]
  owner: 'open-genoffice-agent'
  introducedBefore: 'pi-agent-platform-v1'
  action: 'delete_file' | 'delete_owned_project_chat_files'
  expectedType: 'file' | 'directory'
  preserveSiblings: true
}>

export const LEGACY_CLEANUP_MANIFEST: readonly LegacyCleanupManifestRule[] = Object.freeze([
  Object.freeze({
    category: 'project_index',
    root: 'electron_user_data',
    relativePath: Object.freeze(['projects', 'index.json']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_file',
    expectedType: 'file',
    preserveSiblings: true,
  }),
  Object.freeze({
    category: 'project_chats',
    root: 'electron_user_data',
    relativePath: Object.freeze(['projects']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_owned_project_chat_files',
    expectedType: 'directory',
    preserveSiblings: true,
  }),
  Object.freeze({
    category: 'ai_settings',
    root: 'electron_user_data',
    relativePath: Object.freeze(['ai-settings.json']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_file',
    expectedType: 'file',
    preserveSiblings: true,
  }),
  Object.freeze({
    category: 'cloud_projects',
    root: 'electron_user_data',
    relativePath: Object.freeze(['cloud-projects.json']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_file',
    expectedType: 'file',
    preserveSiblings: true,
  }),
  Object.freeze({
    category: 'genoffice_auth',
    root: 'legacy_genoffice',
    relativePath: Object.freeze(['auth.json']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_file',
    expectedType: 'file',
    preserveSiblings: true,
  }),
  Object.freeze({
    category: 'cli_sidecar',
    root: 'legacy_genoffice',
    relativePath: Object.freeze(['bin', 'electron-compat.js']),
    owner: 'open-genoffice-agent',
    introducedBefore: 'pi-agent-platform-v1',
    action: 'delete_file',
    expectedType: 'file',
    preserveSiblings: true,
  }),
])

const MigrationRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    manifestVersion: Type.Integer({ minimum: 1 }),
    completedAt: Type.String({ minLength: 20, maxLength: 32 }),
  },
  { additionalProperties: false },
)

export const MigrationJournalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generation: Type.Integer({ minimum: 1 }),
    completed: Type.Array(MigrationRecordSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
)

export type MigrationJournal = Static<typeof MigrationJournalSchema>
export type LegacyCleanupCategory =
  | 'project_index'
  | 'project_chats'
  | 'ai_settings'
  | 'cloud_projects'
  | 'genoffice_auth'
  | 'cli_sidecar'
export type LegacyCleanupItemStatus = 'deleted' | 'absent' | 'failed' | 'rejected'
export type LegacyCleanupResult = {
  category: LegacyCleanupCategory
  status: LegacyCleanupItemStatus
  matched: number
}
export type LegacyCleanupReport = {
  migrationId: typeof LEGACY_CLEANUP_MIGRATION_ID
  manifestVersion: typeof LEGACY_CLEANUP_MANIFEST_VERSION
  status: 'completed' | 'incomplete'
  results: readonly LegacyCleanupResult[]
}
export type LegacyCleanupErrorCode = 'cleanup_root_invalid' | 'migration_journal_invalid'

export class LegacyCleanupError extends Error {
  constructor(public readonly code: LegacyCleanupErrorCode) {
    super(code)
    this.name = 'LegacyCleanupError'
  }
}

export type RunLegacyAgentCleanupOptions = {
  resourceHome: string
  userData: string
  legacyGenoffice: string
  platform?: NodeJS.Platform
  now?: () => Date
  removeFile?: (path: string) => Promise<void>
  migrationAtomicWriteOptions?: AtomicWriteOptions
}

type MutableResult = LegacyCleanupResult & { deleted: number }

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path)
    if (!(await lstat(canonical)).isDirectory()) throw new Error('not_directory')
    return canonical
  } catch {
    throw new LegacyCleanupError('cleanup_root_invalid')
  }
}

async function optionalDirectory(path: string): Promise<string | undefined | null> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null
    return path
  } catch (error) {
    if (missing(error)) return undefined
    return null
  }
}

async function cleanupFile(
  category: LegacyCleanupCategory,
  path: string,
  removeFile: (path: string) => Promise<void>,
): Promise<LegacyCleanupResult> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    return {
      category,
      status: missing(error) ? 'absent' : 'failed',
      matched: missing(error) ? 0 : 1,
    }
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return { category, status: 'rejected', matched: 1 }
  }
  try {
    await removeFile(path)
    try {
      await lstat(path)
      return { category, status: 'failed', matched: 1 }
    } catch (error) {
      return { category, status: missing(error) ? 'deleted' : 'failed', matched: 1 }
    }
  } catch {
    return { category, status: 'failed', matched: 1 }
  }
}

function projectEntryNameAllowed(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)
}

function finishAggregate(result: MutableResult): LegacyCleanupResult {
  if (result.status === 'failed' || result.status === 'rejected') {
    return { category: result.category, status: result.status, matched: result.matched }
  }
  return {
    category: result.category,
    status: result.deleted > 0 ? 'deleted' : 'absent',
    matched: result.matched,
  }
}

async function cleanupProjectChats(
  userData: string,
  removeFile: (path: string) => Promise<void>,
): Promise<LegacyCleanupResult> {
  const result: MutableResult = {
    category: 'project_chats',
    status: 'absent',
    matched: 0,
    deleted: 0,
  }
  const projects = await optionalDirectory(join(userData, 'projects'))
  if (projects === undefined) return finishAggregate(result)
  if (projects === null) return { category: result.category, status: 'rejected', matched: 1 }
  let projectEntries
  try {
    projectEntries = await readdir(projects, { withFileTypes: true })
  } catch {
    return { category: result.category, status: 'failed', matched: 1 }
  }
  for (const project of projectEntries) {
    if (!projectEntryNameAllowed(project.name)) continue
    if (project.isSymbolicLink()) {
      result.status = 'rejected'
      result.matched += 1
      continue
    }
    if (!project.isDirectory()) continue
    const chats = await optionalDirectory(join(projects, project.name, 'chats'))
    if (chats === undefined) continue
    if (chats === null) {
      result.status = 'rejected'
      result.matched += 1
      continue
    }
    let chatEntries
    try {
      chatEntries = await readdir(chats, { withFileTypes: true })
    } catch {
      result.status = 'failed'
      result.matched += 1
      continue
    }
    for (const chat of chatEntries) {
      if (!chat.name.endsWith('.jsonl')) continue
      result.matched += 1
      if (chat.isSymbolicLink() || !chat.isFile()) {
        if (result.status !== 'failed') result.status = 'rejected'
        continue
      }
      const item = await cleanupFile('project_chats', join(chats, chat.name), removeFile)
      if (item.status === 'deleted') result.deleted += 1
      else result.status = 'failed'
    }
  }
  return finishAggregate(result)
}

async function readJournal(path: string): Promise<MigrationJournal | undefined> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw new LegacyCleanupError('migration_journal_invalid')
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new LegacyCleanupError('migration_journal_invalid')
  }
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !Value.Check(MigrationJournalSchema, value) ||
      value.completed.some((record) => !Number.isFinite(Date.parse(record.completedAt)))
    ) {
      throw new Error('invalid')
    }
    return value as MigrationJournal
  } catch {
    throw new LegacyCleanupError('migration_journal_invalid')
  }
}

function completed(journal: MigrationJournal | undefined): boolean {
  return (
    journal?.completed.some(
      (record) =>
        record.id === LEGACY_CLEANUP_MIGRATION_ID &&
        record.manifestVersion === LEGACY_CLEANUP_MANIFEST_VERSION,
    ) ?? false
  )
}

export async function runLegacyAgentCleanup(
  options: RunLegacyAgentCleanupOptions,
): Promise<LegacyCleanupReport> {
  const platform = options.platform ?? process.platform
  const resourceHome = await canonicalDirectory(options.resourceHome)
  const userData = await canonicalDirectory(options.userData)
  const legacyGenoffice = await optionalDirectory(options.legacyGenoffice)
  const stateDirectory = join(resourceHome, 'state')
  const leasesDirectory = join(stateDirectory, 'leases')
  await mkdir(leasesDirectory, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') await chmod(leasesDirectory, 0o700)
  const release = await lock(join(leasesDirectory, 'legacy-agent-cleanup'), {
    realpath: false,
    stale: 15_000,
    retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 50 },
  })
  try {
    const journalPath = join(stateDirectory, 'migrations.json')
    const journal = await readJournal(journalPath)
    const removeFile = options.removeFile ?? unlink
    const legacyRootRejected = legacyGenoffice === null
    const results: LegacyCleanupResult[] = []
    for (const rule of LEGACY_CLEANUP_MANIFEST) {
      if (rule.action === 'delete_owned_project_chat_files') {
        results.push(await cleanupProjectChats(userData, removeFile))
        continue
      }
      if (rule.root === 'legacy_genoffice' && legacyRootRejected) {
        results.push({ category: rule.category, status: 'rejected', matched: 1 })
        continue
      }
      const root =
        rule.root === 'electron_user_data' ? userData : (legacyGenoffice ?? options.legacyGenoffice)
      results.push(await cleanupFile(rule.category, join(root, ...rule.relativePath), removeFile))
    }
    const status = results.every(
      (result) => result.status === 'deleted' || result.status === 'absent',
    )
      ? 'completed'
      : 'incomplete'
    if (status === 'completed' && !completed(journal)) {
      const next: MigrationJournal = {
        schemaVersion: 1,
        generation: (journal?.generation ?? 0) + 1,
        completed: [
          ...(journal?.completed ?? []),
          {
            id: LEGACY_CLEANUP_MIGRATION_ID,
            manifestVersion: LEGACY_CLEANUP_MANIFEST_VERSION,
            completedAt: (options.now ?? (() => new Date()))().toISOString(),
          },
        ],
      }
      await atomicWriteJson(journalPath, next, {
        platform,
        ...options.migrationAtomicWriteOptions,
      })
    }
    return Object.freeze({
      migrationId: LEGACY_CLEANUP_MIGRATION_ID,
      manifestVersion: LEGACY_CLEANUP_MANIFEST_VERSION,
      status,
      results: Object.freeze(results),
    })
  } finally {
    await release()
  }
}
