import { chmod, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLeaseError, SessionLeaseStore } from '../src/index'

const sessionId = '11111111-1111-4111-8111-111111111111'

function clock(initial = Date.parse('2026-08-10T00:00:00.000Z')) {
  let value = initial
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => {
      value += milliseconds
    },
  }
}

describe('Session writer lease', () => {
  it('creates a private lease, heartbeats it, and releases only its own token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-'))
    const time = clock()
    const store = new SessionLeaseStore({
      leasesDirectory: root,
      instanceId: 'runtime-a',
      pid: 101,
      ttlMs: 9_000,
      now: time.now,
      randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      platform: 'linux',
    })

    const lease = await store.acquire(sessionId)
    const leasePath = join(root, `session-${sessionId}.json`)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(leasePath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      sessionId,
      instanceId: 'runtime-a',
      pid: 101,
      ownerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generation: 1,
    })

    time.advance(3_000)
    await expect(lease.heartbeat()).resolves.toMatchObject({ generation: 2 })
    await lease.release()
    await expect(readFile(leasePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a second Runtime while active, then atomically takes over an expired lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-takeover-'))
    const time = clock()
    let token = 0
    const options = {
      leasesDirectory: root,
      ttlMs: 6_000,
      now: time.now,
      randomUUID: () => `${String(++token).padStart(8, '0')}-0000-4000-8000-000000000000`,
      platform: 'linux' as const,
    }
    const first = await new SessionLeaseStore({
      ...options,
      instanceId: 'runtime-a',
      pid: 101,
    }).acquire(sessionId)
    const secondStore = new SessionLeaseStore({ ...options, instanceId: 'runtime-b', pid: 202 })

    await expect(secondStore.acquire(sessionId)).rejects.toMatchObject({
      code: 'session_in_use',
    })
    time.advance(6_001)
    const second = await secondStore.acquire(sessionId)
    await expect(first.heartbeat()).rejects.toMatchObject({ code: 'session_lease_lost' })
    await first.release()
    await expect(second.heartbeat()).resolves.toMatchObject({
      instanceId: 'runtime-b',
      generation: 3,
    })
    await second.release()
  })

  it('serializes simultaneous takeover so exactly one Runtime owns the expired lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-race-'))
    const time = clock()
    let token = 0
    const options = {
      leasesDirectory: root,
      ttlMs: 2_000,
      now: time.now,
      randomUUID: () => `${String(++token).padStart(8, '0')}-0000-4000-8000-000000000000`,
      platform: 'linux' as const,
    }
    await new SessionLeaseStore({ ...options, instanceId: 'runtime-a', pid: 101 }).acquire(
      sessionId,
    )
    time.advance(2_001)

    const attempts = await Promise.allSettled([
      new SessionLeaseStore({ ...options, instanceId: 'runtime-b', pid: 202 }).acquire(sessionId),
      new SessionLeaseStore({ ...options, instanceId: 'runtime-c', pid: 303 }).acquire(sessionId),
    ])

    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const losers = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'session_in_use' })
    await (
      winners[0] as PromiseFulfilledResult<Awaited<ReturnType<SessionLeaseStore['acquire']>>>
    ).value.release()
  })

  it('loses ownership after TTL or removal and creates a missing lease directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-lost-'))
    const leasesDirectory = join(root, 'state', 'leases')
    const time = clock()
    const store = new SessionLeaseStore({
      leasesDirectory,
      instanceId: 'runtime-a',
      pid: 101,
      ttlMs: 1_000,
      now: time.now,
    })
    const lease = await store.acquire(sessionId)
    time.advance(1_001)
    await expect(lease.heartbeat()).rejects.toMatchObject({ code: 'session_lease_lost' })

    await unlink(join(leasesDirectory, `session-${sessionId}.json`))
    await expect(lease.heartbeat()).rejects.toMatchObject({ code: 'session_lease_lost' })
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it('uses platform defaults without applying POSIX permission changes on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-win32-'))
    const lease = await new SessionLeaseStore({
      leasesDirectory: root,
      instanceId: 'runtime-a',
      pid: 101,
      platform: 'win32',
    }).acquire(sessionId)
    expect(lease.ownerToken).toMatch(/^[0-9a-f-]{36}$/)
    await lease.release()
  })

  it('does not silently release a corrupted lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-release-invalid-'))
    const store = new SessionLeaseStore({
      leasesDirectory: root,
      instanceId: 'runtime-a',
      pid: 101,
    })
    const lease = await store.acquire(sessionId)
    await writeFile(join(root, `session-${sessionId}.json`), '{}')
    await expect(lease.release()).rejects.toEqual(new SessionLeaseError('session_lease_invalid'))
  })

  it('fails closed on malformed, symlink, and invalid session lease inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-session-lease-invalid-'))
    const store = new SessionLeaseStore({
      leasesDirectory: root,
      instanceId: 'runtime-a',
      pid: 101,
      ttlMs: 5_000,
    })
    await writeFile(join(root, `session-${sessionId}.json`), '{}')
    await chmod(root, 0o755)

    await expect(store.acquire(sessionId)).rejects.toEqual(
      new SessionLeaseError('session_lease_invalid'),
    )
    await expect(store.acquire('../escape')).rejects.toEqual(
      new SessionLeaseError('session_lease_invalid'),
    )

    await writeFile(
      join(root, `session-${sessionId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        sessionId,
        instanceId: 'runtime-a',
        pid: 101,
        ownerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        generation: 1,
        heartbeatAt: 'xxxxxxxxxxxxxxxxxxxx',
        expiresAt: 'xxxxxxxxxxxxxxxxxxxx',
      }),
    )
    await expect(store.acquire(sessionId)).rejects.toEqual(
      new SessionLeaseError('session_lease_invalid'),
    )

    const leasePath = join(root, `session-${sessionId}.json`)
    const targetPath = join(root, 'lease-target.json')
    await unlink(leasePath)
    await writeFile(targetPath, '{}')
    await symlink(targetPath, leasePath)
    await expect(store.acquire(sessionId)).rejects.toEqual(
      new SessionLeaseError('session_lease_invalid'),
    )

    const linkedRoot = `${root}-link`
    await symlink(root, linkedRoot)
    await expect(
      new SessionLeaseStore({
        leasesDirectory: linkedRoot,
        instanceId: 'runtime-a',
        pid: 101,
      }).acquire(sessionId),
    ).rejects.toEqual(new SessionLeaseError('session_lease_invalid'))
  })
})
