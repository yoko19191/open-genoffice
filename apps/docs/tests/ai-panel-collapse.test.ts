// The AI panel stays mounted while collapsed (rail only),
// so the conversation, draft, and in-flight runs survive collapse/expand.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AiPanel } from '../src/renderer/ai/AiPanel'

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
  window.agentSession = {
    documentId: async () => {
      throw new Error('agent_session_unavailable')
    },
    connect: vi.fn(),
    command: vi.fn(),
    disconnect: vi.fn(),
    onEvent: () => () => {},
  }
  window.agentArtifacts = { pickText: vi.fn(async () => null) }
})

describe('AiPanel collapse', () => {
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

  it('sends a picked text attachment only as an opaque ArtifactRef', async () => {
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
    window.agentArtifacts = {
      pickText: vi.fn(async () => ({
        artifactId: '11111111-1111-4111-8111-111111111111',
        mediaType: 'text/plain' as const,
        byteLength: 12,
        sha256: 'a'.repeat(64),
        displayName: 'notes.txt',
      })),
    }
    const { container, cleanup } = mount(createElement(AiPanel, panelProps()))
    await act(async () => {})
    const attach = container.querySelector<HTMLButtonElement>('.ai-attach-btn')!
    await act(async () => attach.click())
    expect(
      container.querySelector('[data-testid="agent-text-attachments"]')?.textContent,
    ).toContain('notes.txt')
    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')!
    typeInto(textarea, 'read it')
    await act(async () => container.querySelector<HTMLButtonElement>('.ai-send-btn')!.click())
    expect(command).toHaveBeenCalledWith({
      type: 'prompt',
      operationId: expect.any(String),
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      text: 'read it',
      artifacts: [
        expect.objectContaining({
          artifactId: '11111111-1111-4111-8111-111111111111',
          displayName: 'notes.txt',
        }),
      ],
    })
    expect(JSON.stringify(command.mock.calls)).not.toContain('/private/')
    cleanup()
  })
})
