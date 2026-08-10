import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeHealthProjection } from '@genoffice/agent-runtime-protocol'
import { LegacyCleanupStartup } from '../src/main/legacy-cleanup-startup'

const readyHealth: RuntimeHealthProjection = {
  state: 'ready',
  protocolVersion: '1',
  runtimeVersion: '1.0.0',
  schemaVersion: '1',
}

function report(status: 'completed' | 'incomplete') {
  return {
    migrationId: 'pi-agent-platform-v1-cleanup' as const,
    manifestVersion: 1 as const,
    status,
    results: [
      {
        category: 'project_index' as const,
        status: status === 'completed' ? ('deleted' as const) : ('failed' as const),
        matched: 1,
      },
    ],
  }
}

describe('Shell legacy cleanup startup gate', () => {
  it('uses the production Resource Home and cleanup dependencies on an empty upgrade fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shell-cleanup-startup-'))
    const resourceHome = join(root, '.open-genoffice')
    const userData = join(root, 'user-data')
    await mkdir(userData)
    const startup = new LegacyCleanupStartup({
      resourceHome,
      userData,
      legacyHome: join(root, '.genoffice-absent'),
      platform: 'darwin',
      runtimeVersion: '1.0.0',
    })

    await expect(startup.run()).resolves.toBeUndefined()
    expect(startup.projectHealth(readyHealth)).toBe(readyHealth)
    expect(
      JSON.parse(await readFile(join(resourceHome, 'state', 'migrations.json'), 'utf8')),
    ).toMatchObject({
      completed: [{ id: 'pi-agent-platform-v1-cleanup', manifestVersion: 1 }],
    })
  })

  it('initializes Resource Home, runs once, and keeps completed health unchanged', async () => {
    const lifecycle: string[] = []
    const audit = vi.fn()
    const startup = new LegacyCleanupStartup(
      {
        resourceHome: '/safe/resource-home',
        userData: '/safe/user-data',
        legacyHome: '/safe/legacy-home',
        platform: 'darwin',
        runtimeVersion: '1.0.0',
        audit,
      },
      {
        initializeResourceHome: vi.fn(async () => {
          lifecycle.push('resource-home')
        }),
        cleanup: vi.fn(async (options) => {
          lifecycle.push('cleanup')
          expect(options).toMatchObject({
            resourceHome: '/safe/resource-home',
            userData: '/safe/user-data',
            legacyGenoffice: '/safe/legacy-home',
            platform: 'darwin',
          })
          return report('completed')
        }),
      },
    )

    const first = startup.run()
    const second = startup.run()
    expect(first).toBe(second)
    await first
    expect(lifecycle).toEqual(['resource-home', 'cleanup'])
    expect(audit).toHaveBeenCalledWith({
      event: 'legacy_agent_cleanup',
      status: 'completed',
      results: [{ category: 'project_index', status: 'deleted', matched: 1 }],
    })
    expect(startup.projectHealth(readyHealth)).toBe(readyHealth)
  })

  it('surfaces an incomplete retry state without paths, errors, or blocking Runtime start', async () => {
    const audit = vi.fn(() => {
      throw new Error('audit sink unavailable')
    })
    const startup = new LegacyCleanupStartup(
      {
        resourceHome: '/safe/resource-home',
        userData: '/safe/user-data',
        legacyHome: '/safe/legacy-home',
        platform: 'linux',
        runtimeVersion: '1.0.0',
        audit,
      },
      {
        initializeResourceHome: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => report('incomplete')),
      },
    )

    await expect(startup.run()).resolves.toBeUndefined()
    expect(startup.projectHealth(readyHealth)).toEqual({
      ...readyHealth,
      diagnosticCode: 'legacy_cleanup_incomplete',
    })
    const unavailable = {
      ...readyHealth,
      state: 'unavailable' as const,
      diagnosticCode: 'runtime_bundle_unavailable' as const,
    }
    expect(startup.projectHealth(unavailable)).toBe(unavailable)
    expect(JSON.stringify(audit.mock.calls)).not.toContain('/safe/')
  })

  it('turns structural cleanup errors into the same retryable, redacted state', async () => {
    const audit = vi.fn()
    const startup = new LegacyCleanupStartup(
      {
        resourceHome: '/safe/resource-home',
        userData: '/safe/user-data',
        legacyHome: '/safe/legacy-home',
        platform: 'win32',
        runtimeVersion: '1.0.0',
        audit,
      },
      {
        initializeResourceHome: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => {
          throw new Error('private path and secret')
        }),
      },
    )

    await expect(startup.run()).resolves.toBeUndefined()
    expect(startup.projectHealth(readyHealth)).toMatchObject({
      diagnosticCode: 'legacy_cleanup_incomplete',
    })
    expect(audit).toHaveBeenCalledWith({
      event: 'legacy_agent_cleanup',
      status: 'incomplete',
      results: [],
    })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private')
  })
})
