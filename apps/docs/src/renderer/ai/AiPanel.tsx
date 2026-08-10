import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  AgentSessionController,
  AiComposer,
  AiTypingIndicator,
  Markdown,
  type AgentSessionProjection,
} from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import sendStop from '../assets/send-stop.png'
import attachIcon from '../assets/attach-icon.png'
import fileIcon from '../assets/file-document.png'
import type { DocsTextArtifact } from '../../shared/agent-artifacts'

const PANEL_WIDTH_KEY = 'docs-ai-panel-width'
const PANEL_WIDTH_DEFAULT = 360
const PANEL_WIDTH_MIN = 280

function clampPanelWidth(width: number): number {
  return Math.min(
    Math.max(width, PANEL_WIDTH_MIN),
    Math.min(720, Math.round(window.innerWidth * 0.6)),
  )
}

function loadPanelWidth(): number {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(saved) && saved > 0 ? clampPanelWidth(saved) : PANEL_WIDTH_DEFAULT
}

function isBusy(projection: AgentSessionProjection | undefined): boolean {
  const state = projection?.activeRun?.state
  return state === 'queued' || state === 'running' || state === 'cancelling'
}

interface AiPanelProps {
  preset?: { text: string; nonce: number; autoRun?: boolean } | null
  open?: boolean
  onExpand?: () => void
  onCollapse?: () => void
}

export function AiPanel({ preset, open = true, onExpand, onCollapse }: AiPanelProps): ReactElement {
  const { t } = useI18n()
  const [prompt, setPrompt] = useState('')
  const [projection, setProjection] = useState<AgentSessionProjection>()
  const [connectionError, setConnectionError] = useState<string>()
  const [artifacts, setArtifacts] = useState<DocsTextArtifact[]>([])
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [resizing, setResizing] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const stickToBottomRef = useRef(true)
  const presetNonceRef = useRef<number | undefined>(undefined)
  const controllerRef = useRef<AgentSessionController | null>(null)
  if (!controllerRef.current)
    controllerRef.current = new AgentSessionController(window.agentSession)
  const controller = controllerRef.current
  const busy = isBusy(projection)

  useEffect(() => {
    const unsubscribe = controller.subscribe(setProjection)
    void controller.connect().catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'agent_session_unavailable')
    })
    return () => {
      unsubscribe()
      controller.disconnect()
    }
  }, [controller])

  useEffect(() => {
    const dock = asideRef.current?.closest('.ai-dock') as HTMLElement | null
    dock?.style.setProperty('--ai-panel-width', `${panelWidth}px`)
  }, [panelWidth])

  useEffect(() => {
    if (stickToBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight })
    }
  }, [projection, busy])

  const send = (text: string): void => {
    const instruction = text.trim()
    if (!instruction || busy) return
    stickToBottomRef.current = true
    setPrompt('')
    setConnectionError(undefined)
    void controller
      .prompt(instruction, artifacts)
      .then(() => setArtifacts([]))
      .catch((error: unknown) => {
        setConnectionError(error instanceof Error ? error.message : 'agent_prompt_failed')
      })
  }

  useEffect(() => {
    if (!preset || presetNonceRef.current === preset.nonce) return
    presetNonceRef.current = preset.nonce
    if (preset.autoRun) send(preset.text)
    else setPrompt(preset.text)
  })

  const stop = (): void => {
    if (!busy) return
    void controller.abort().catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'agent_abort_failed')
    })
  }

  const pickAttachment = (): void => {
    if (busy || artifacts.length >= 16) return
    setConnectionError(undefined)
    void window.agentArtifacts
      .pickText()
      .then((artifact) => {
        if (artifact) setArtifacts((current) => [...current, artifact].slice(0, 16))
      })
      .catch((error: unknown) => {
        setConnectionError(error instanceof Error ? error.message : 'artifact_invalid')
      })
  }

  const rollbackRun = (): void => {
    if (busy || !projection?.rollbackRunId) return
    setConnectionError(undefined)
    void controller.rollbackLastRun().catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'office_rollback_failed')
    })
  }

  const resumeSubagent = (runId: string): void => {
    setConnectionError(undefined)
    void controller.resumeSubagent(runId).catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'subagent_resume_failed')
    })
  }

  const decideMutationGrant = (action: 'grant' | 'deny' | 'revoke', id: string): void => {
    setConnectionError(undefined)
    const operation =
      action === 'grant'
        ? controller.grantMutation(id)
        : action === 'deny'
          ? controller.denyMutation(id)
          : controller.revokeMutation(id)
    void operation.catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'mutation_grant_failed')
    })
  }

  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])
  useEffect(() => {
    const onResize = (): void => setPanelWidth((width) => clampPanelWidth(width))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const resizer = event.currentTarget
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: PointerEvent): void =>
      setPanelWidth(clampPanelWidth(moveEvent.clientX))
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      setPanelWidth((width) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
        return width
      })
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(event.pointerId)
  }

  if (!open) {
    return (
      <button className="ai-rail" title={t('aiOpenAssistant')} onClick={onExpand}>
        <AgentMark size={22} />
      </button>
    )
  }

  const messages = projection?.messages.filter((message) => message.role !== 'toolResult') ?? []
  const errorCode = projection?.error?.code ?? connectionError

  return (
    <aside
      ref={asideRef}
      className={`copilot${resizing ? ' ai-panel-resizing' : ''}`}
      style={{ width: '100%' }}
    >
      <div
        className="ai-panel-resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="AI assistant"
      />
      <header className="ai-panel-header">
        <span className="ai-panel-title">
          <AgentMark size={22} /> AI
        </span>
        <button className="ai-header-btn" onClick={onCollapse} title={t('aiCollapseTitle')}>
          <IconCollapse />
        </button>
      </header>

      <div
        className="ai-chat"
        ref={chatRef}
        onScroll={() => {
          const element = chatRef.current
          if (element)
            stickToBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
      >
        {messages.length === 0 && !errorCode && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">{t('aiEmptyTitle')}</div>
            <div className="ai-chat-empty-body">
              {t('aiEmptyBody1')} {t('aiEmptyBody2')}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`ai-msg ai-msg-${message.role === 'user' ? 'user' : 'assistant'}`}
          >
            {message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}
          </div>
        ))}
        {(projection?.tools.length ?? 0) > 0 && (
          <div className="ai-work-group">
            {projection!.tools.map((tool) => (
              <div key={tool.toolCallId} className="ai-step-entry">
                <div className="ai-step-row">
                  <span className={`ai-step-icon ${tool.state}`} aria-hidden>
                    ·
                  </span>
                  <span className="ai-step-title">{tool.toolName}</span>
                </div>
                {tool.details && <PlatformToolDetails details={tool.details} />}
              </div>
            ))}
          </div>
        )}
        {(projection?.subagents.length ?? 0) > 0 && (
          <div className="ai-work-group" data-testid="subagent-run-tree">
            {projection!.subagents.map((run) => (
              <div key={run.runId} className="ai-step-row">
                <span className={`ai-step-icon ${run.status}`} aria-hidden>
                  ·
                </span>
                <span className="ai-step-title">
                  {run.role} · {run.status}
                </span>
                {run.status === 'resumable' && (
                  <button className="ai-header-btn" onClick={() => resumeSubagent(run.runId)}>
                    ↻
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {(projection?.mutationGrants.length ?? 0) > 0 && (
          <div className="ai-work-group" data-testid="mutation-grant-list">
            {projection!.mutationGrants.map((grant) => (
              <div key={grant.requestId} className="ai-step-row">
                <span className="ai-step-title">{grant.exactToolIds.join(', ')}</span>
                {grant.status === 'pending' && (
                  <>
                    <button
                      className="ai-header-btn"
                      onClick={() => decideMutationGrant('grant', grant.requestId)}
                    >
                      ✓
                    </button>
                    <button
                      className="ai-header-btn"
                      onClick={() => decideMutationGrant('deny', grant.requestId)}
                    >
                      ×
                    </button>
                  </>
                )}
                {grant.status === 'active' && grant.grantId && (
                  <button
                    className="ai-header-btn"
                    onClick={() => decideMutationGrant('revoke', grant.grantId!)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {projection?.rollbackRunId && !busy && (
          <button
            type="button"
            className="ai-quick-btn"
            data-testid="office-run-rollback"
            onClick={rollbackRun}
          >
            ↶ {t('aiRollback')} · {projection.rollbackRunId}
          </button>
        )}
        {errorCode && <div className="ai-msg ai-msg-assistant ai-msg-error">{errorCode}</div>}
        {busy && <AiTypingIndicator label={t('aiWorking')} />}
      </div>

      <div className="ai-composer">
        <AiComposer
          value={prompt}
          busy={busy}
          placeholder={t('aiInputPlaceholder')}
          hintIdle={t('aiHintIdle')}
          hintBusy={t('aiHintBusy')}
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly
          sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
          sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
          stopIcon={<img src={sendStop} alt="" aria-hidden />}
          header={
            artifacts.length > 0 ? (
              <div className="ai-attachments" data-testid="agent-text-attachments">
                {artifacts.map((artifact) => (
                  <span className="ai-attachment-chip" key={artifact.artifactId}>
                    <img src={fileIcon} width={16} height={16} alt="" aria-hidden />
                    {artifact.displayName}
                    <button
                      type="button"
                      className="ai-attachment-remove"
                      title={t('aiRemoveAttachmentTitle')}
                      onClick={() =>
                        setArtifacts((current) =>
                          current.filter(({ artifactId }) => artifactId !== artifact.artifactId),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : undefined
          }
          footerStart={
            <button
              type="button"
              className="ai-attach-btn"
              title={t('aiAttachTitle')}
              aria-label={t('aiAttachTitle')}
              disabled={busy || artifacts.length >= 16}
              onClick={pickAttachment}
            >
              <img src={attachIcon} alt="" aria-hidden />
            </button>
          }
          onChange={setPrompt}
          onSend={() => send(prompt)}
          onStop={stop}
        />
      </div>
    </aside>
  )
}

function PlatformToolDetails({
  details,
}: {
  details: NonNullable<AgentSessionProjection['tools'][number]['details']>
}): ReactElement {
  if (details.kind === 'artifact_text') {
    return (
      <div className="ai-tool-details" data-testid="artifact-text-details">
        {details.displayName ?? details.artifactId} · {details.offset}–
        {details.nextOffset ?? details.totalCharacters} / {details.totalCharacters}
      </div>
    )
  }
  if (details.kind === 'web_search') {
    return (
      <div className="ai-tool-details" data-testid="web_search-details">
        {details.results.map((item) => (
          <a key={item.url} href={item.url} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        ))}
      </div>
    )
  }
  return (
    <div className="ai-tool-details" data-testid="image_search-details">
      {details.images.map((item) => (
        <a
          key={item.artifactId}
          href={item.sourceUrl || undefined}
          target="_blank"
          rel="noreferrer"
        >
          {item.title}
        </a>
      ))}
    </div>
  )
}

function IconCollapse(): ReactElement {
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M5.5 2.5v11M12.5 8H8.1M9.8 5.9 7.7 8l2.1 2.1" />
    </svg>
  )
}

function AgentMark({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect width="24" height="24" rx="7" fill="currentColor" opacity="0.12" />
      <path
        d="M12 4.8c.65 3.65 2.55 5.55 6.2 6.2-3.65.65-5.55 2.55-6.2 6.2-.65-3.65-2.55-5.55-6.2-6.2 3.65-.65 5.55-2.55 6.2-6.2Z"
        fill="currentColor"
      />
    </svg>
  )
}
