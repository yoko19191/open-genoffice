import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { PROTOCOL_VERSION } from '@genoffice/agent-runtime-protocol'
import { createDeterministicFakeProvider, type FakeProviderEvent } from './fake-provider'

export type DebugStdioWorkspace = {
  root: string
  home: string
  projectStore: string
  credentialStore: { readonly kind: 'fake-credential-store' }
}

type DebugProvider = {
  run: (prompt: string) => Promise<readonly FakeProviderEvent[]>
}

export type DebugStdioDependencies = {
  createWorkspace: () => Promise<DebugStdioWorkspace>
  removeWorkspace: (root: string) => Promise<void>
  createProvider: (workspace: DebugStdioWorkspace) => DebugProvider
  environment?: NodeJS.ProcessEnv
}

export async function createIsolatedDebugWorkspace(): Promise<DebugStdioWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'open-genoffice-pi-debug-'))
  await chmod(root, 0o700)
  const home = join(root, 'home')
  const projectStore = join(root, 'project-store')
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(projectStore, { recursive: true, mode: 0o700 }),
  ])
  return {
    root,
    home,
    projectStore,
    credentialStore: Object.freeze({ kind: 'fake-credential-store' as const }),
  }
}

export async function removeIsolatedDebugWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

function eventFrame(type: string, sequence: number, payload: Record<string, unknown>) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'event',
    eventId: `debug-event-${sequence}`,
    instanceId: 'debug-instance',
    sessionId: 'debug-session',
    documentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    runId: 'debug-run',
    sequence,
    cursor: `debug-cursor-${sequence}`,
    occurredAt: '2000-01-01T00:00:00.000Z',
    type,
    payload,
  }
}

const DEFAULT_DEPENDENCIES: DebugStdioDependencies = {
  createWorkspace: createIsolatedDebugWorkspace,
  removeWorkspace: removeIsolatedDebugWorkspace,
  createProvider: createDeterministicFakeProvider,
}

const ISOLATED_ENVIRONMENT_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'GENOFFICE_RESOURCE_HOME',
  'GENOFFICE_PROJECT_STORE',
] as const

export async function runDebugStdio(
  options: { stdout: Writable },
  dependencies: DebugStdioDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  let workspace: DebugStdioWorkspace | undefined
  let failed = false
  const environment = dependencies.environment ?? process.env
  const previousEnvironment = new Map<string, string | undefined>()
  try {
    workspace = await dependencies.createWorkspace()
    const isolatedEnvironment = {
      HOME: workspace.home,
      USERPROFILE: workspace.home,
      APPDATA: join(workspace.home, 'app-data'),
      LOCALAPPDATA: join(workspace.home, 'local-app-data'),
      XDG_CONFIG_HOME: join(workspace.home, 'xdg-config'),
      XDG_DATA_HOME: join(workspace.home, 'xdg-data'),
      GENOFFICE_RESOURCE_HOME: join(workspace.home, '.open-genoffice'),
      GENOFFICE_PROJECT_STORE: workspace.projectStore,
    }
    for (const key of ISOLATED_ENVIRONMENT_KEYS) {
      previousEnvironment.set(key, environment[key])
      environment[key] = isolatedEnvironment[key]
    }
    const events = await dependencies.createProvider(workspace).run('debug-fake-session')
    const output = [
      eventFrame('session.opened', 1, { mode: 'debug-fake' }),
      ...events.map((event, index) => eventFrame(event.type, index + 2, event.payload)),
    ]
    for (const frame of output) options.stdout.write(`${JSON.stringify(frame)}\n`)
  } catch {
    failed = true
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete environment[key]
      else environment[key] = value
    }
    if (workspace) {
      try {
        await dependencies.removeWorkspace(workspace.root)
      } catch {
        failed = true
      }
    }
  }
  if (failed) throw new Error('debug_runtime_failed')
  return 0
}
