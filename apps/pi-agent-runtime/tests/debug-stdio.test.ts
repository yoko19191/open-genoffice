import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseProtocolFrame } from '@genoffice/agent-runtime-protocol'
import {
  RUNTIME_EXIT_CODES,
  runDebugStdio,
  runRuntimeEntrypoint,
  type DebugStdioWorkspace,
} from '../src'

function output(stream: PassThrough): () => string {
  let value = ''
  stream.on('data', (chunk) => {
    value += chunk.toString('utf8')
  })
  return () => value
}

describe('isolated debug stdio mode', () => {
  it('runs the deterministic fake Session and removes its one-time workspace', async () => {
    const stdout = new PassThrough()
    const readOutput = output(stdout)
    const workspace: DebugStdioWorkspace = {
      root: '/isolated/debug-root',
      home: '/isolated/debug-root/home',
      projectStore: '/isolated/debug-root/project-store',
      credentialStore: { kind: 'fake-credential-store' },
    }
    const removeWorkspace = vi.fn(async () => undefined)
    const environment: NodeJS.ProcessEnv = { HOME: '/real/home', KEEP: 'untouched' }
    const providerRun = vi.fn(async () => [
      { type: 'message.delta', sequence: 1, payload: { text: 'fake only' } },
      { type: 'run.completed', sequence: 2, payload: {} },
    ])

    await expect(
      runDebugStdio(
        { stdout },
        {
          createWorkspace: async () => workspace,
          removeWorkspace,
          createProvider: (actualWorkspace) => {
            expect(actualWorkspace.credentialStore.kind).toBe('fake-credential-store')
            expect(environment.HOME).toBe(workspace.home)
            expect(environment.GENOFFICE_RESOURCE_HOME).toBe(
              join(workspace.home, '.open-genoffice'),
            )
            expect(environment.GENOFFICE_PROJECT_STORE).toBe(workspace.projectStore)
            return { run: providerRun }
          },
          environment,
        },
      ),
    ).resolves.toBe(0)

    expect(providerRun).toHaveBeenCalledWith('debug-fake-session')
    expect(removeWorkspace).toHaveBeenCalledWith(workspace.root)
    expect(environment).toEqual({ HOME: '/real/home', KEEP: 'untouched' })
    const frames = readOutput().trim().split('\n').map(parseProtocolFrame)
    expect(frames.map((frame) => (frame.kind === 'event' ? frame.type : frame.kind))).toEqual([
      'session.opened',
      'message.delta',
      'run.completed',
    ])
    expect(readOutput()).not.toContain(workspace.root)
  })

  it('creates only temporary private directories and can remove them', async () => {
    const { createIsolatedDebugWorkspace, removeIsolatedDebugWorkspace } = await import('../src')
    const workspace = await createIsolatedDebugWorkspace()
    expect(workspace.home.startsWith(workspace.root)).toBe(true)
    expect(workspace.projectStore.startsWith(workspace.root)).toBe(true)
    expect(workspace.credentialStore).toEqual({ kind: 'fake-credential-store' })
    await Promise.all([mkdir(workspace.home, { recursive: true }), access(workspace.projectStore)])
    await removeIsolatedDebugWorkspace(workspace.root)
    await expect(access(workspace.root)).rejects.toMatchObject({ code: 'ENOENT' })

    const stdout = new PassThrough()
    const readOutput = output(stdout)
    await expect(runDebugStdio({ stdout })).resolves.toBe(RUNTIME_EXIT_CODES.ok)
    const frames = readOutput().trim().split('\n').map(parseProtocolFrame)
    expect(frames).toHaveLength(9)
    expect(frames.at(-1)).toMatchObject({ kind: 'event', type: 'run.completed' })
  })

  it('routes only the exact debug flag and rejects real-home or unknown arguments', async () => {
    const runDebug = vi.fn(async () => RUNTIME_EXIT_CODES.ok)
    const runProduction = vi.fn(async () => RUNTIME_EXIT_CODES.ok)
    const stderr = new PassThrough()
    const readError = output(stderr)

    await expect(
      runRuntimeEntrypoint(['--debug-stdio'], { stderr, runDebug, runProduction }),
    ).resolves.toBe(RUNTIME_EXIT_CODES.ok)
    expect(runDebug).toHaveBeenCalledOnce()
    expect(runProduction).not.toHaveBeenCalled()

    for (const args of [['--debug-stdio', '--use-real-home'], ['--use-real-home'], ['--unknown']]) {
      await expect(runRuntimeEntrypoint(args, { stderr, runDebug, runProduction })).resolves.toBe(
        RUNTIME_EXIT_CODES.bootstrap,
      )
    }
    expect(readError().trim().split('\n')).toEqual([
      '{"code":"runtime_arguments_invalid"}',
      '{"code":"runtime_arguments_invalid"}',
      '{"code":"runtime_arguments_invalid"}',
    ])

    await expect(
      runRuntimeEntrypoint(['--debug-stdio'], {
        stderr,
        runDebug: async () => {
          throw new Error('private debug failure')
        },
        runProduction,
      }),
    ).resolves.toBe(RUNTIME_EXIT_CODES.crash)
    expect(readError()).toContain('{"code":"debug_runtime_failed"}')
  })

  it('cleans the workspace and emits only a stable error if fake execution fails', async () => {
    const stdout = new PassThrough()
    const workspace: DebugStdioWorkspace = {
      root: '/isolated/failure-root',
      home: '/isolated/failure-root/home',
      projectStore: '/isolated/failure-root/project-store',
      credentialStore: { kind: 'fake-credential-store' },
    }
    const removeWorkspace = vi.fn(async () => undefined)

    await expect(
      runDebugStdio(
        { stdout },
        {
          createWorkspace: async () => workspace,
          removeWorkspace,
          createProvider: () => ({
            run: async () => {
              throw new Error('real home and credential detail')
            },
          }),
        },
      ),
    ).rejects.toThrowError('debug_runtime_failed')
    expect(removeWorkspace).toHaveBeenCalledWith(workspace.root)

    await expect(
      runDebugStdio(
        { stdout },
        {
          createWorkspace: async () => workspace,
          removeWorkspace: async () => {
            throw new Error('private cleanup detail')
          },
          createProvider: () => ({ run: async () => [] }),
        },
      ),
    ).rejects.toThrowError('debug_runtime_failed')

    await expect(
      runDebugStdio(
        { stdout },
        {
          createWorkspace: async () => {
            throw new Error('private workspace detail')
          },
          removeWorkspace,
          createProvider: () => ({ run: async () => [] }),
        },
      ),
    ).rejects.toThrowError('debug_runtime_failed')
  })
})
