import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createDeterministicPiSession } from '../src/pi-session-factory'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('deterministic Pi Session factory', () => {
  it('uses the shared selected ModelRuntime model without deterministic fixture post-processing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-selected-model-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const selectedProvider = fauxProvider({
      api: 'genoffice-selected-faux',
      provider: 'genoffice-selected-faux',
      models: [{ id: 'selected-model', reasoning: false }],
      tokenSize: { min: 1, max: 1 },
      tokensPerSecond: 64,
    })
    selectedProvider.setResponses([fauxAssistantMessage('selected model response')])
    modelRuntime.registerNativeProvider(selectedProvider.provider)
    const resolveModel = vi.fn(() => selectedProvider.getModel())
    const handle = await createDeterministicPiSession({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      modelRuntime,
      initialModel: selectedProvider.getModel(),
      resolveModel,
    })

    await handle.prompt('use my selected model', new AbortController().signal)

    expect(resolveModel).toHaveBeenCalledOnce()
    expect(handle.session.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: expect.any(Array) }),
      ]),
    )
    expect(JSON.stringify(handle.sessionManager.getEntries())).toContain('selected model response')
    expect(JSON.stringify(handle.sessionManager.getEntries())).not.toContain(
      'genoffice.contract-branch',
    )
    handle.dispose()
  })

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
