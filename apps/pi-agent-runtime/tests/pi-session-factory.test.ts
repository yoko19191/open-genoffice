import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeterministicPiSession } from '../src/pi-session-factory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('deterministic Pi Session factory', () => {
  it('skips compaction and branching after the run signal is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-factory-'))
    roots.push(root)
    const handle = await createDeterministicPiSession({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
    })
    const controller = new AbortController()
    controller.abort()

    await expect(handle.prompt('do not run post-processing', controller.signal)).resolves.toBe(
      undefined,
    )
    handle.dispose()
  })

  it('preserves a complete unterminated entry and rejects corruption before the tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-jsonl-'))
    roots.push(root)
    const options = {
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
    }
    const created = await createDeterministicPiSession(options)
    const sessionFile = created.session.sessionFile!
    created.dispose()
    await writeFile(sessionFile, (await readFile(sessionFile, 'utf8')).trimEnd())

    const reopened = await createDeterministicPiSession({ ...options, sessionFile })
    reopened.dispose()
    expect(await readFile(sessionFile, 'utf8')).toContain('genoffice.document-binding')
    expect((await readFile(sessionFile, 'utf8')).endsWith('\n')).toBe(true)

    await appendFile(sessionFile, '{invalid-complete-line}\n')
    await expect(createDeterministicPiSession({ ...options, sessionFile })).rejects.toThrowError(
      'session_jsonl_invalid',
    )
  })

  it('fails closed when a persisted fork has no source file or active leaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-fork-invalid-'))
    roots.push(root)
    const options = {
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
    }
    const handle = await createDeterministicPiSession(options)
    const targetEntryId = handle.sessionManager.getLeafId()!
    vi.spyOn(handle.session, 'navigateTree')
      .mockResolvedValueOnce({ cancelled: true, aborted: false })
      .mockResolvedValueOnce({ cancelled: false, aborted: true })
    await expect(handle.navigate(targetEntryId)).rejects.toThrowError('branch_navigation_cancelled')
    await expect(handle.navigate(targetEntryId)).rejects.toThrowError('branch_navigation_cancelled')
    const sourceFile = vi.spyOn(handle.sessionManager, 'getSessionFile').mockReturnValue(undefined)
    await expect(
      handle.fork('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrowError('session_fork_unavailable')
    sourceFile.mockRestore()
    handle.sessionManager.resetLeaf()
    await expect(
      handle.fork('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrowError('session_fork_unavailable')
    handle.dispose()

    const invalidFile = join(options.sessionDir, 'invalid.jsonl')
    await writeFile(invalidFile, '{invalid')
    await expect(
      createDeterministicPiSession({ ...options, sessionFile: invalidFile }),
    ).rejects.toThrowError('session_jsonl_invalid')
  })
})
