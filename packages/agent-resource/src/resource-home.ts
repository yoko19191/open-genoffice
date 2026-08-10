import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { atomicWriteJson } from './atomic-file'

export const RESOURCE_HOME_DIRECTORIES = Object.freeze([
  '',
  'agent',
  'agent/sessions',
  'agent/skills',
  'agent/extensions',
  'agent/packages',
  'agent/prompts',
  'agent/logs',
  'mcp',
  'assets',
  'projects',
  'sync',
  'sync/manifests',
  'sync/intents',
  'sync/conflicts',
  'state',
  'state/leases',
  'state/secure-store',
  'state/secure-store/blobs',
  'state/secure-store/operation-capsules',
  'state/recovery',
] as const)

export const AgentResourceHomeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    createdByRuntimeVersion: Type.String({ minLength: 1, maxLength: 64 }),
    deviceId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
)

export type AgentResourceHomeSchemaValue = Static<typeof AgentResourceHomeSchema>

export class AgentResourceError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'AgentResourceError'
    this.code = code
  }
}

export type AgentResourceHome = {
  root: string
  schemaPath: string
  agentDirectory: string
  sessionsDirectory: string
  secureStoreDirectory: string
  credentialBlobsDirectory: string
  operationCapsulesDirectory: string
  schema: AgentResourceHomeSchemaValue
}

export type InitializeAgentResourceHomeOptions = {
  rootDirectory: string
  runtimeVersion: string
  platform?: NodeJS.Platform
  randomUUID?: () => string
}

async function existingKind(path: string): Promise<'absent' | 'directory' | 'file' | 'symlink'> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return 'symlink'
    if (metadata.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

function paths(root: string, schema: AgentResourceHomeSchemaValue): AgentResourceHome {
  return Object.freeze({
    root,
    schemaPath: join(root, 'schema.json'),
    agentDirectory: join(root, 'agent'),
    sessionsDirectory: join(root, 'agent', 'sessions'),
    secureStoreDirectory: join(root, 'state', 'secure-store'),
    credentialBlobsDirectory: join(root, 'state', 'secure-store', 'blobs'),
    operationCapsulesDirectory: join(root, 'state', 'secure-store', 'operation-capsules'),
    schema: Object.freeze(schema),
  })
}

export async function initializeAgentResourceHome(
  options: InitializeAgentResourceHomeOptions,
): Promise<AgentResourceHome> {
  const platform = options.platform ?? process.platform
  const root = options.rootDirectory
  const rootKind = await existingKind(root)
  if (rootKind === 'symlink') throw new AgentResourceError('resource_home_symlink_forbidden')
  if (rootKind === 'file') throw new AgentResourceError('resource_home_not_directory')

  const schemaPath = join(root, 'schema.json')
  const schemaKind = rootKind === 'absent' ? 'absent' : await existingKind(schemaPath)
  if (schemaKind === 'symlink' || schemaKind === 'directory') {
    throw new AgentResourceError('resource_home_schema_invalid')
  }

  let schema: AgentResourceHomeSchemaValue
  if (schemaKind === 'file') {
    try {
      const existing: unknown = JSON.parse(await readFile(schemaPath, 'utf8'))
      if (!Value.Check(AgentResourceHomeSchema, existing)) throw new Error('invalid_schema')
      schema = existing as AgentResourceHomeSchemaValue
    } catch {
      throw new AgentResourceError('resource_home_schema_invalid')
    }
  } else {
    schema = {
      schemaVersion: 1,
      createdByRuntimeVersion: options.runtimeVersion,
      deviceId: (options.randomUUID ?? randomUUID)(),
    }
    if (!Value.Check(AgentResourceHomeSchema, schema)) {
      throw new AgentResourceError('resource_home_schema_invalid')
    }
  }

  for (const relativePath of RESOURCE_HOME_DIRECTORIES) {
    const directory = relativePath.length === 0 ? root : join(root, ...relativePath.split('/'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (platform !== 'win32') await chmod(directory, 0o700)
  }

  if (schemaKind === 'file') {
    if (platform !== 'win32') await chmod(schemaPath, 0o600)
    return paths(root, schema)
  }

  await atomicWriteJson(schemaPath, schema, { platform })
  return paths(root, schema)
}
