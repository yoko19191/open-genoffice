import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  PackageLockService,
  ResourceActivationStore,
  createCapabilitySnapshot,
  initializeAgentResourceHome,
} from '@genoffice/agent-resource'
import { createDeterministicPiSession } from '../src/pi-session-factory'
import { ModelMediaProviderError } from '../src/model-media-provider'
import { RunResourceService } from '../src/run-resource-service'
import { OpenGenOfficeMcpConfigResolver } from '../src/mcp-config-resolver'
import { PDF_OFFICE_TOOL_CATALOG_BINDING } from '@genoffice/agent-runtime-protocol/office-tool-catalog'

const roots: string[] = []
const mcpFixture = fileURLToPath(new URL('../fixtures/mcp-stdio-server.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('deterministic Pi Session factory', () => {
  it('pauses ask_user_question until the Runtime receives an explicit user answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-user-action-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-user-action-faux',
      provider: 'genoffice-user-action-faux',
      models: [{ id: 'question-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'ask_user_question',
            { mode: 'confirm', question: 'Apply these changes?' },
            { id: 'question-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Applied after confirmation'),
    ])
    let answer!: (value: { requestId: string; answer: { confirmed: boolean } }) => void
    const requestUserAction = vi.fn(
      () =>
        new Promise<{ requestId: string; answer: { confirmed: boolean } }>((resolve) => {
          answer = resolve
        }),
    )
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
        providerId: 'genoffice-user-action-faux',
        modelId: 'question-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      requestUserAction,
    })
    const prompting = handle.prompt('make the change', new AbortController().signal, {
      runId: '44444444-4444-4444-8444-444444444444',
    })
    await vi.waitFor(() => expect(requestUserAction).toHaveBeenCalledOnce())
    expect(handle.session.getActiveToolNames()).toEqual(['ask_user_question'])
    expect(requestUserAction).toHaveBeenCalledWith({
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      runId: '44444444-4444-4444-8444-444444444444',
      mode: 'confirm',
      question: 'Apply these changes?',
      signal: expect.any(AbortSignal),
    })
    answer({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', answer: { confirmed: true } })
    await prompting
    expect(JSON.stringify(handle.sessionManager.getEntries())).toContain('\\"confirmed\\":true')
    handle.dispose()
  })

  it('registers the three platform aliases once and executes them with run scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-platform-tools-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-platform-faux',
      provider: 'genoffice-platform-faux',
      models: [{ id: 'platform-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'read_attachment',
            { artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            { id: 'read-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Attachment read'),
    ])
    const execute = vi.fn(async () => ({
      content: 'attachment text',
      details: {
        kind: 'artifact_text' as const,
        artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        offset: 0,
        totalCharacters: 15,
      },
    }))
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
        providerId: 'genoffice-platform-faux',
        modelId: 'platform-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      platformTools: { execute },
    })
    const signal = new AbortController().signal
    await handle.prompt('read it', signal, {
      runId: '44444444-4444-4444-8444-444444444444',
    })

    expect(handle.session.getActiveToolNames()).toEqual([
      'web_search',
      'image_search',
      'read_attachment',
    ])
    expect(execute).toHaveBeenCalledWith(
      'platform:artifact:read_text',
      { artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        runId: '44444444-4444-4444-8444-444444444444',
      },
      expect.any(AbortSignal),
    )
    expect(JSON.stringify(handle.sessionManager.getEntries())).toContain(
      'platform:artifact:read_text',
    )
    handle.dispose()
  })

  it('executes Codex image generation inside Runtime and persists only the opaque ArtifactRef', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-image-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-image-faux',
      provider: 'genoffice-image-faux',
      models: [{ id: 'image-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'generate_image',
            { prompt: 'private image prompt' },
            { id: 'image-tool-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Image ready'),
    ])
    const generateImage = vi.fn(async () => ({
      artifact: {
        artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        mediaType: 'image/png',
        byteLength: 68,
        sha256: 'f'.repeat(64),
        displayName: 'generated-image.png',
      },
      width: 1,
      height: 1,
      usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 },
    }))
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
        providerId: 'genoffice-image-faux',
        modelId: 'image-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      generateImage,
    })

    await handle.prompt('create an image', new AbortController().signal, {
      runId: '44444444-4444-4444-8444-444444444444',
    })

    expect(handle.session.getActiveToolNames()).toEqual(['generate_image'])
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        documentId: '22222222-2222-4222-8222-222222222222',
        runId: '44444444-4444-4444-8444-444444444444',
        prompt: 'private image prompt',
      }),
      expect.any(AbortSignal),
    )
    const persisted = await readFile(handle.sessionManager.getSessionFile()!, 'utf8')
    expect(persisted).not.toContain('private image prompt')
    expect(persisted).not.toContain('oauth-secret')
    expect(persisted).not.toContain('base64')
    expect(persisted).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(persisted).toContain('f'.repeat(64))
    handle.dispose()
  })

  it('analyzes only a media ArtifactRef attached to the current run and records provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-media-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-media-faux',
      provider: 'genoffice-media-faux',
      models: [{ id: 'media-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    const artifact = {
      artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mediaType: 'video/mp4' as const,
      byteLength: 24,
      sha256: 'f'.repeat(64),
      displayName: 'clip.mp4',
    }
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'analyze_media',
            { artifactId: artifact.artifactId, requirements: 'Find the key scene.' },
            { id: 'media-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Media analyzed'),
    ])
    const analyze = vi.fn(async (input) => ({
      text: 'The key scene is visible.',
      details: {
        operationId: input.operationId,
        providerId: 'genoffice-media-faux',
        modelId: 'media-model',
        toolId: 'platform:analyze_media' as const,
        inputMode: 'frames' as const,
        sourceArtifactId: artifact.artifactId,
        usageRecorded: true,
      },
    }))
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
        providerId: 'genoffice-media-faux',
        modelId: 'media-model',
        capabilities: ['text-input', 'image-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      mediaProvider: { analyze },
    })
    await handle.prompt('analyze the attached video', new AbortController().signal, {
      runId: '44444444-4444-4444-8444-444444444444',
      artifacts: [artifact],
    })
    expect(handle.session.getActiveToolNames()).toEqual(['analyze_media'])
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: '22222222-2222-4222-8222-222222222222',
        runId: '44444444-4444-4444-8444-444444444444',
        artifact,
        requirements: 'Find the key scene.',
        model: expect.objectContaining({
          providerId: 'genoffice-media-faux',
          modelId: 'media-model',
        }),
      }),
      expect.any(AbortSignal),
    )
    expect(JSON.stringify(handle.sessionManager.getEntries())).toContain('platform:analyze_media')
    handle.dispose()
  })

  it('returns disabled/change-model details when the selected model lacks media capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-media-disabled-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-media-disabled-faux',
      provider: 'genoffice-media-disabled-faux',
      models: [{ id: 'text-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    const artifact = {
      artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mediaType: 'audio/wav' as const,
      byteLength: 44,
      sha256: 'f'.repeat(64),
    }
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'analyze_media',
            { artifactId: artifact.artifactId, requirements: 'Summarize.' },
            { id: 'media-disabled-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Model change required'),
    ])
    const analyze = vi.fn().mockRejectedValue(
      new ModelMediaProviderError('media_capability_unsupported', {
        state: 'disabled',
        action: 'change_model',
        providerId: 'genoffice-media-disabled-faux',
        modelId: 'text-model',
      }),
    )
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
        providerId: 'genoffice-media-disabled-faux',
        modelId: 'text-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      mediaProvider: { analyze },
    })
    await handle.prompt('analyze audio', new AbortController().signal, {
      runId: '44444444-4444-4444-8444-444444444444',
      artifacts: [artifact],
    })
    const entries = JSON.stringify(handle.sessionManager.getEntries())
    expect(entries).toContain('change_model')
    expect(entries).toContain('disabled')
    handle.dispose()
  })

  it('exposes the bound PDF catalog as Pi proxies with run capability provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-office-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-office-faux',
      provider: 'genoffice-office-faux',
      models: [{ id: 'office-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    await expect(
      createDeterministicPiSession({
        cwd: join(root, 'missing-host-cwd'),
        agentDir: join(root, 'missing-host-agent'),
        sessionDir: join(root, 'missing-host-sessions'),
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        officeToolCatalog: PDF_OFFICE_TOOL_CATALOG_BINDING,
        modelRuntime,
        initialModel: provider.getModel(),
        resolveModel: () => provider.getModel(),
        resolveModelMetadata: () => ({
          providerId: 'genoffice-office-faux',
          modelId: 'office-model',
          capabilities: ['text-input', 'tool-use'],
        }),
        runResources: new RunResourceService({
          resourceHome: root,
          deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      }),
    ).rejects.toThrow('office_tool_host_required')
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('read_pages', { start: 1 }, { id: 'pdf-read-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('delete_page', { page: 3 }, { id: 'pdf-delete-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('PDF tools completed'),
    ])
    const invokeOfficeTool = vi.fn(async (input) => ({
      operationId: input.operationId,
      toolCallId: input.toolCallId,
      toolId: input.toolId,
      status: input.toolId.endsWith('fill_form_field')
        ? ('failed' as const)
        : ('completed' as const),
      output: input.toolId.endsWith('read_pages') ? '[Page 1]\nhello' : 'Deleted page 3',
      ...(input.toolId.endsWith('fill_form_field')
        ? {}
        : {
            contextVersionAfter: input.toolId.endsWith('read_pages')
              ? 'pdf-context-7'
              : 'pdf-context-8',
          }),
      ...(input.toolId.endsWith('delete_page') ? { mutationOutcome: 'committed' as const } : {}),
      provenance: {
        actorId: input.actor.actorId,
        runId: input.runId,
        documentId: input.documentId,
      },
    }))
    const handle = await createDeterministicPiSession({
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'agent'),
      sessionDir: join(root, 'sessions'),
      sessionId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      officeToolCatalog: PDF_OFFICE_TOOL_CATALOG_BINDING,
      officeToolHost: { invoke: invokeOfficeTool },
      modelRuntime,
      initialModel: provider.getModel(),
      resolveModel: () => provider.getModel(),
      resolveModelMetadata: () => ({
        providerId: 'genoffice-office-faux',
        modelId: 'office-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
    })
    await handle.prompt('read and edit PDF', new AbortController().signal, {
      runId: 'office-run-1',
    })

    expect(handle.session.getActiveToolNames()).toEqual(
      PDF_OFFICE_TOOL_CATALOG_BINDING.descriptors.map(({ modelAlias }) => modelAlias),
    )
    expect(invokeOfficeTool).toHaveBeenCalledTimes(2)
    expect(invokeOfficeTool.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        sessionId: '11111111-1111-4111-8111-111111111111',
        documentId: '22222222-2222-4222-8222-222222222222',
        runId: 'office-run-1',
        toolCallId: 'pdf-read-call',
        toolId: 'office:pdf:read_pages',
        toolOrder: 0,
        actor: expect.objectContaining({ type: 'parent' }),
        input: { start: 1 },
        permissionSnapshot: expect.objectContaining({
          createdForRunId: 'office-run-1',
          toolIds: PDF_OFFICE_TOOL_CATALOG_BINDING.descriptors.map(({ id }) => id).sort(),
        }),
      }),
      expect.objectContaining({
        toolCallId: 'pdf-delete-call',
        toolId: 'office:pdf:delete_page',
        toolOrder: 1,
        contextVersion: 'pdf-context-7',
        input: { page: 3 },
      }),
    ])
    const entries = JSON.stringify(handle.sessionManager.getEntries())
    expect(entries).toContain('[Page 1]\\nhello')
    expect(entries).toContain('Deleted page 3')
    expect(entries).toContain('committed')

    invokeOfficeTool.mockClear()
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('list_form_fields', {}, { id: 'pdf-list-fields-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'fill_form_field',
            { name: 'customer', value: 'Ada' },
            { id: 'pdf-fill-field-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('PDF form completed'),
    ])
    await handle.prompt('list and fill PDF form', new AbortController().signal, {
      runId: 'office-run-2',
    })
    expect(invokeOfficeTool.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        toolId: 'office:pdf:list_form_fields',
        toolOrder: 0,
      }),
      expect.objectContaining({
        toolId: 'office:pdf:fill_form_field',
        toolOrder: 1,
        contextVersion: 'pdf-context-8',
      }),
    ])
    handle.dispose()
  })

  it('exposes one product-owned Subagent tool with implicit parent authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-subagent-'))
    roots.push(root)
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-subagent-faux',
      provider: 'genoffice-subagent-faux',
      models: [{ id: 'subagent-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent',
            { role: 'researcher', task: 'inspect safely', tools: ['office:docs:replace_blocks'] },
            { id: 'subagent-tool-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('child queued'),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent',
            { role: 'critic', task: 'inspect without optional authority' },
            { id: 'subagent-tool-call-minimal' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('second child queued'),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent',
            {
              role: 'ignored by trusted profile',
              task: 'quality-check selected slides',
              profile: 'slides-qc',
              slideIndexes: [0, 2],
            },
            { id: 'slides-qc-tool-call' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Slides QC awaiting grant'),
    ])
    const spawnSubagent = vi.fn(async (input) => ({
      runId: 'subagent-run-1',
      rootRunId: input.parentRunId,
      parentRunId: input.parentRunId,
      parentSessionId: input.parentSessionId,
      documentId: input.documentId,
      role: input.role,
      depth: 1,
      model: { providerId: 'genoffice-subagent-faux', modelId: 'subagent-model' },
      status: 'running' as const,
      attempt: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 },
      capabilitySnapshotId: 'a'.repeat(64),
      createdAt: '2026-08-10T00:00:00.000Z',
    }))
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
        providerId: 'genoffice-subagent-faux',
        modelId: 'subagent-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources: new RunResourceService({
        resourceHome: root,
        deviceId: '33333333-3333-4333-8333-333333333333',
      }),
      spawnSubagent,
    })
    await handle.prompt('delegate', new AbortController().signal, {
      runId: 'parent-run-1',
      projectRoot: '/trusted/project',
    })

    expect(handle.session.getActiveToolNames()).toEqual(['subagent'])
    expect(spawnSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: 'parent-run-1',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
        documentId: '22222222-2222-4222-8222-222222222222',
        role: 'researcher',
        task: 'inspect safely',
        requestedTools: ['office:docs:replace_blocks'],
        projectRoot: '/trusted/project',
        parentSnapshot: expect.objectContaining({
          createdForRunId: 'parent-run-1',
          toolIds: ['platform:subagent:spawn'],
        }),
      }),
      expect.anything(),
    )
    expect(JSON.stringify(handle.sessionManager.getEntries())).toContain('subagent-run-1')
    spawnSubagent.mockClear()
    await handle.prompt('delegate again', new AbortController().signal, {
      runId: 'parent-run-2',
    })
    expect(spawnSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: 'parent-run-2',
        role: 'critic',
        task: 'inspect without optional authority',
      }),
      expect.anything(),
    )
    expect(spawnSubagent.mock.calls[0]?.[0]).not.toHaveProperty('requestedTools')
    expect(spawnSubagent.mock.calls[0]?.[0]).not.toHaveProperty('projectRoot')
    spawnSubagent.mockClear()
    await handle.prompt('quality check selected slides', new AbortController().signal, {
      runId: 'parent-run-3',
    })
    expect(spawnSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: 'parent-run-3',
        profile: 'slides-qc',
        slideIndexes: [0, 2],
      }),
      expect.anything(),
    )
    handle.dispose()
  })

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

  it('executes an activated Package read tool with canonical provenance and isolated authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-extension-'))
    roots.push(root)
    const deviceId = '33333333-3333-4333-8333-333333333333'
    await initializeAgentResourceHome({
      rootDirectory: root,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    const packageSource = join(root, 'package-source')
    await mkdir(packageSource, { recursive: true })
    await writeFile(
      join(packageSource, 'package.json'),
      `${JSON.stringify({
        name: 'safe-extension',
        version: '1.0.0',
        license: 'MIT',
        pi: { extensions: ['./extension.mjs'] },
        genoffice: {
          capabilities: ['executable'],
          tools: [{ extension: './extension.mjs', name: 'inspect_package', effect: 'read' }],
        },
      })}\n`,
    )
    await writeFile(
      join(packageSource, 'extension.mjs'),
      `export default function (pi) {
        pi.registerTool({
          name: 'inspect_package', label: 'Inspect package', description: 'Read package metadata',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute() {
            let activeToolsMutation = 'unexpected-success'
            try { pi.setActiveTools(['unexpected']) } catch (error) { activeToolsMutation = error.message }
            const credentialKeys = Object.keys(pi).filter((key) => key.toLowerCase().includes('credential'))
            return { content: [{ type: 'text', text: 'package inspected' }], details: { activeToolsMutation, credentialKeys } }
          }
        })
      }\n`,
    )
    const packages = new PackageLockService({ resourceHome: root, deviceId, namespace: 'global' })
    await packages.install({
      operationId: '44444444-4444-4444-8444-444444444444',
      packageId: 'safe-extension',
      source: { type: 'local', path: packageSource },
    })
    await packages.activate('safe-extension')

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-extension-faux',
      provider: 'genoffice-extension-faux',
      models: [{ id: 'extension-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall('inspect_package', {}, { id: 'package-tool-call' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('extension completed'),
    ])
    const runResources = new RunResourceService({ resourceHome: root, deviceId })
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
        providerId: 'genoffice-extension-faux',
        modelId: 'extension-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources,
    })
    await handle.prompt('inspect the package', new AbortController().signal, {
      runId: 'run-extension',
    })

    expect(handle.session.getActiveToolNames()).toEqual(['inspect_package'])
    const entries = JSON.stringify(handle.sessionManager.getEntries())
    expect(entries).toContain('package inspected')
    expect(entries).toContain('extension_runtime_isolated')
    expect(entries).toContain('"credentialKeys":[]')
    expect(entries).toContain('platform:extension:global/safe-extension/inspect_package')
    expect(entries).toContain('"runId":"run-extension"')
    expect(entries).not.toContain('unexpected-success')
    handle.dispose()
  })

  it('executes an activated stdio MCP read tool from the Pi turn with canonical provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pi-session-mcp-'))
    roots.push(root)
    const deviceId = '33333333-3333-4333-8333-333333333333'
    await initializeAgentResourceHome({
      rootDirectory: root,
      runtimeVersion: 'test',
      randomUUID: () => deviceId,
    })
    await mkdir(join(root, 'mcp'), { recursive: true })
    await writeFile(
      join(root, 'mcp', 'servers.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            serverId: 'pi-fixture',
            transport: 'stdio',
            command: process.execPath,
            args: [mcpFixture],
            environment: { inherit: [], credentials: [] },
            enabledToolIds: ['read_fixture'],
            timeoutMs: 2_000,
            enabled: true,
          },
        ],
      })}\n`,
    )
    const resolver = new OpenGenOfficeMcpConfigResolver({ resourceHome: root, deviceId })
    await new ResourceActivationStore({ rootDirectory: root, deviceId }).activate(
      (await resolver.resolve())[0]!.activation,
    )
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
    })
    const provider = fauxProvider({
      api: 'genoffice-mcp-faux',
      provider: 'genoffice-mcp-faux',
      models: [{ id: 'mcp-model', reasoning: false }],
    })
    modelRuntime.registerNativeProvider(provider.provider)
    provider.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('read_fixture', { value: 'from-pi' }, { id: 'mcp-tool-call' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('mcp completed'),
    ])
    const runResources = new RunResourceService({ resourceHome: root, deviceId })
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
        providerId: 'genoffice-mcp-faux',
        modelId: 'mcp-model',
        capabilities: ['text-input', 'tool-use'],
      }),
      runResources,
    })
    await handle.prompt('call the MCP read tool', new AbortController().signal, {
      runId: 'run-mcp-pi',
    })

    expect(handle.session.getActiveToolNames()).toEqual(['read_fixture'])
    const entries = JSON.stringify(handle.sessionManager.getEntries())
    expect(entries).toContain('mcp:from-pi:canary-missing:env-clean')
    expect(entries).toContain('mcp:pi-fixture:read_fixture')
    expect(entries).toContain('"serverId":"pi-fixture"')
    expect(entries).toContain('"runId":"run-mcp-pi"')
    handle.dispose()
    await runResources.shutdown()
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
        extensionTools: [],
        mcpTools: [],
        packageDiagnostics: [],
        mcpDiagnostics: [],
      })),
      verify: vi.fn(async () => {
        controller.abort()
      }),
      callMcpTool: vi.fn(),
      releaseRun: vi.fn(),
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
