import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createCapabilitySnapshot } from '@genoffice/agent-resource'
import { createDeterministicPiSession } from '../src/pi-session-factory'
import { RunResourceService } from '../src/run-resource-service'

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
    modelRuntime.registerNativeProvider(selectedProvider.provider)
    const resolveModel = vi.fn(() => selectedProvider.getModel())
    const skillRoot = join(root, 'agent', 'skills', 'global-skill')
    const skillPath = join(skillRoot, 'SKILL.md')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      skillPath,
      '---\nname: global-skill\ndescription: global skill\n---\nGlobal instructions\n',
    )
    selectedProvider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('read', { path: skillPath }, { id: 'read-default' }),
          fauxToolCall('read', { path: skillPath, offset: 1, limit: 2 }, { id: 'read-bounded' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('selected model response'),
    ])
    const runResources = new RunResourceService({
      resourceHome: root,
      deviceId: '33333333-3333-4333-8333-333333333333',
    })
    const handle = await createDeterministicPiSession({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      modelRuntime,
      initialModel: selectedProvider.getModel(),
      resolveModel,
      resolveModelMetadata: () => ({
        providerId: 'genoffice-selected-faux',
        modelId: 'selected-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources,
    })

    await handle.prompt('use my selected model', new AbortController().signal, {
      runId: 'run-1',
      projectRoot: join(root, 'missing-project'),
    })

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
    expect(handle.session.resourceLoader.getSkills().skills.map(({ name }) => name)).toEqual([
      'global-skill',
    ])
    const capabilityEntry = handle.sessionManager
      .getEntries()
      .find(
        (entry) => entry.type === 'custom' && entry.customType === 'genoffice.capability-snapshot',
      )
    expect(capabilityEntry).toMatchObject({
      data: {
        createdForRunId: 'run-1',
        model: { providerId: 'genoffice-selected-faux', modelId: 'selected-model' },
        resourceHashes: { 'skill:global/global-skill': expect.stringMatching(/^[0-9a-f]{64}$/) },
        toolIds: ['platform:resource:read'],
        permissionVersion: 'agent-permission-v1',
      },
    })
    expect(JSON.stringify(capabilityEntry)).not.toContain('Global instructions')
    handle.dispose()
  })

  it('requires a run context, skips an already aborted run, and rechecks abort after prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-run-guards-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-guard-faux',
      provider: 'genoffice-guard-faux',
      models: [{ id: 'guard-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    const snapshot = createCapabilitySnapshot({
      createdForRunId: 'run-guard',
      model: { providerId: 'genoffice-guard-faux', modelId: 'guard-model', capabilities: [] },
      resources: [],
      toolIds: ['platform:resource:read'],
      permissionVersion: 'agent-permission-v1',
    })
    const controller = new AbortController()
    const runResources = {
      prepare: vi.fn(async () => ({
        catalog: { catalogId: 'catalog', resources: [] },
        snapshot,
        skillPaths: [],
        promptPaths: [],
      })),
      verify: vi.fn(async () => {
        controller.abort()
      }),
    }
    const handle = await createDeterministicPiSession({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      modelRuntime,
      initialModel: provider.getModel(),
      resolveModel: () => provider.getModel(),
      resolveModelMetadata: () => ({
        providerId: 'genoffice-guard-faux',
        modelId: 'guard-model',
        capabilities: [],
      }),
      runResources,
    })
    await expect(handle.prompt('missing context', new AbortController().signal)).rejects.toThrow(
      'run_context_required',
    )
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(
      handle.prompt('already aborted', alreadyAborted.signal, { runId: 'run-aborted' }),
    ).resolves.toBeUndefined()
    await expect(
      handle.prompt('abort after prepare', controller.signal, { runId: 'run-guard' }),
    ).resolves.toBeUndefined()
    expect(runResources.prepare).toHaveBeenCalledOnce()
    expect(handle.session.getActiveToolNames()).toEqual([])
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
