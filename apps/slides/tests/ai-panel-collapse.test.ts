// Slides: the AI panel stays mounted while collapsed (rail only),
// so the conversation, draft, and in-flight runs survive collapse/expand.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// react-konva's node entry requires the native 'canvas' package; nothing here draws
vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

import { AiPanel } from '../src/renderer/ai/AiPanel'
import { isSlidesMediaArtifact } from '../src/shared/agent-media-artifacts'

function mount(element: React.ReactElement): {
  container: HTMLElement
  root: Root
  cleanup: () => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function panelProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    onExpand: () => {},
    onCollapse: () => {},
    ...overrides,
  }
}

/** Simulate typing into React's controlled textarea */
function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no scrollTo; the panel auto-scrolls its chat log
  Element.prototype.scrollTo ??= () => {}
  ;(window as Window & { agentSession: unknown }).agentSession = {
    documentId: async () => {
      throw new Error('offline')
    },
    connect: vi.fn(),
    command: vi.fn(),
    disconnect: vi.fn(),
    onEvent: () => () => {},
  }
  window.agentMediaArtifacts = { pick: vi.fn(async () => null), openModelSettings: vi.fn() }
})

describe('AiPanel collapse (slides)', () => {
  it('keeps the draft input across a collapse/expand cycle', () => {
    const { container, root, cleanup } = mount(createElement(AiPanel, panelProps()))

    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(textarea).not.toBeNull()
    typeInto(textarea!, 'unsent draft')
    expect(textarea!.value).toBe('unsent draft')

    // collapse: only the rail is rendered, but the component stays mounted
    act(() => root.render(createElement(AiPanel, panelProps({ open: false }))))
    expect(container.querySelector('.ai-input-box textarea')).toBeNull()
    expect(container.querySelector('.ai-rail')).not.toBeNull()

    // expand: the draft is still there
    act(() => root.render(createElement(AiPanel, panelProps({ open: true }))))
    const restored = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(restored).not.toBeNull()
    expect(restored!.value).toBe('unsent draft')

    cleanup()
  })

  it('expands back through the rail button', () => {
    const onExpand = vi.fn()
    const { container, cleanup } = mount(
      createElement(AiPanel, panelProps({ open: false, onExpand })),
    )

    const rail = container.querySelector<HTMLButtonElement>('.ai-rail')
    expect(rail).not.toBeNull()
    act(() => rail!.click())
    expect(onExpand).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('sends a picked media attachment only as an opaque ArtifactRef', async () => {
    const command = vi.fn(async () => ({ runId: 'run-1', acceptedCursor: 'cursor-1' }))
    window.agentSession = {
      documentId: async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connect: async () => ({
        connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resetRequired: false,
        snapshot: {
          sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          messages: [],
          lastSequence: 0,
          cursor: 'cursor-0',
        },
        events: [],
      }),
      command,
      disconnect: vi.fn(),
      onEvent: () => () => {},
    }
    const artifact = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      mediaType: 'video/mp4' as const,
      byteLength: 24,
      sha256: 'a'.repeat(64),
      displayName: 'clip.mp4',
    }
    window.agentMediaArtifacts = {
      pick: vi.fn(async () => artifact),
      openModelSettings: vi.fn(),
    }
    const { container, cleanup } = mount(createElement(AiPanel, panelProps()))
    await act(async () => {})
    await act(async () => container.querySelector<HTMLButtonElement>('.ai-attach-btn')!.click())
    expect(
      container.querySelector('[data-testid="agent-media-attachments"]')?.textContent,
    ).toContain('clip.mp4')
    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!
    typeInto(textarea, 'find the key scene')
    await act(async () => container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
    expect(command).toHaveBeenCalledWith({
      type: 'prompt',
      operationId: expect.any(String),
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: 'find the key scene',
      artifacts: [artifact],
    })
    expect(JSON.stringify(command.mock.calls)).not.toContain('/private/')
    cleanup()
  })

  it('renders disabled media provenance and opens model settings', async () => {
    const openModelSettings = vi.fn(async () => undefined)
    window.agentMediaArtifacts = { pick: vi.fn(async () => null), openModelSettings }
    window.agentSession = {
      documentId: async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connect: async () => ({
        connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        resetRequired: false,
        snapshot: {
          sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          messages: [],
          lastSequence: 0,
          cursor: 'cursor-0',
        },
        events: [
          {
            protocolVersion: '1',
            kind: 'event',
            eventId: 'event-1',
            instanceId: 'runtime-1',
            sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            runId: 'run-1',
            sequence: 1,
            cursor: 'cursor-1',
            occurredAt: '2026-08-10T00:00:00.000Z',
            type: 'tool.requested',
            payload: { toolCallId: 'media-call', toolName: 'analyze_media' },
          },
          {
            protocolVersion: '1',
            kind: 'event',
            eventId: 'event-2',
            instanceId: 'runtime-1',
            sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            runId: 'run-1',
            sequence: 2,
            cursor: 'cursor-2',
            occurredAt: '2026-08-10T00:00:00.000Z',
            type: 'tool.completed',
            payload: {
              toolCallId: 'media-call',
              toolName: 'analyze_media',
              platformTool: {
                toolId: 'platform:analyze_media',
                kind: 'media_analysis',
                state: 'disabled',
                operationId: '11111111-1111-4111-8111-111111111111',
                providerId: 'selected-provider',
                modelId: 'text-only-model',
                sourceArtifactId: '22222222-2222-4222-8222-222222222222',
                action: 'change_model',
              },
            },
          },
        ],
      }),
      command: vi.fn(),
      disconnect: vi.fn(),
      onEvent: () => () => {},
    }
    const { container, cleanup } = mount(createElement(AiPanel, panelProps()))
    await act(async () => {})
    expect(container.querySelector('[data-testid="media-analysis-status"]')?.textContent).toContain(
      'selected-provider / text-only-model',
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="media-analysis-status"] button')!
        .click(),
    )
    expect(openModelSettings).toHaveBeenCalledOnce()
    cleanup()
  })

  it('accepts only exact bounded WAV and MP4 artifact projections', () => {
    const valid = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      mediaType: 'audio/wav',
      byteLength: 44,
      sha256: 'a'.repeat(64),
      displayName: 'clip.wav',
    }
    expect(isSlidesMediaArtifact(null)).toBe(false)
    expect(isSlidesMediaArtifact([])).toBe(false)
    expect(isSlidesMediaArtifact(valid)).toBe(true)
    expect(isSlidesMediaArtifact({ ...valid, path: '/private/clip.wav' })).toBe(false)
    expect(isSlidesMediaArtifact({ ...valid, mediaType: 'audio/mpeg' })).toBe(false)
    expect(isSlidesMediaArtifact({ ...valid, byteLength: 0 })).toBe(false)
  })
})
