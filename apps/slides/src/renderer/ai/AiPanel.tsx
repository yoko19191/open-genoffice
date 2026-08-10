import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
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

function isBusy(projection: AgentSessionProjection | undefined): boolean {
  const state = projection?.activeRun?.state
  return state === 'queued' || state === 'running' || state === 'cancelling'
}

export function AiPanel({
  open,
  preset,
  onExpand,
  onCollapse,
}: {
  open: boolean
  preset?: { text: string; nonce: number }
  onExpand: () => void
  onCollapse: () => void
}): ReactElement {
  const { t } = useI18n()
  const [prompt, setPrompt] = useState('')
  const [projection, setProjection] = useState<AgentSessionProjection>()
  const [connectionError, setConnectionError] = useState<string>()
  const chatRef = useRef<HTMLDivElement>(null)
  const presetNonceRef = useRef<number | undefined>(undefined)
  const controllerRef = useRef<AgentSessionController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new AgentSessionController(window.agentSession)
  }
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
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight })
  }, [projection, busy])

  const send = (text: string): void => {
    const instruction = text.trim()
    if (!instruction || busy) return
    setPrompt('')
    setConnectionError(undefined)
    void controller.prompt(instruction).catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'agent_prompt_failed')
    })
  }

  useEffect(() => {
    if (!preset || presetNonceRef.current === preset.nonce) return
    presetNonceRef.current = preset.nonce
    send(preset.text)
  })

  const stop = (): void => {
    if (!busy) return
    void controller.abort().catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'agent_abort_failed')
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
    <aside className="copilot">
      <header className="ai-panel-header">
        <span className="ai-panel-title">
          <AgentMark size={22} /> AI
        </span>
        <button className="ai-header-btn" onClick={onCollapse} title={t('aiCollapsePanel')}>
          <IconCollapse />
        </button>
      </header>

      <div className="ai-chat" ref={chatRef}>
        {messages.length === 0 && !errorCode && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">{t('aiEmptyTitle')}</div>
            <div className="ai-chat-empty-body">{t('aiEmptyBody1')}</div>
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
          <div className="ai-work-group" data-testid="office-tool-status">
            {projection!.tools.map((tool) => (
              <div key={tool.toolCallId} className="ai-step-row">
                <span className={`ai-step-icon ${tool.state}`} aria-hidden>
                  ·
                </span>
                <span className="ai-step-title">{tool.toolName}</span>
                <span className="ai-step-desc">{tool.state}</span>
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
                <span className="ai-step-title">{run.role}</span>
                <span className="ai-step-desc">{run.status}</span>
                {run.status === 'resumable' && (
                  <button className="ai-header-btn" onClick={() => resumeSubagent(run.runId)}>
                    Retry
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
                <span className={`ai-step-icon ${grant.status}`} aria-hidden>
                  ·
                </span>
                <span className="ai-step-title">{grant.role}</span>
                <span className="ai-step-desc">{grant.exactToolIds.join(', ')}</span>
                {grant.status === 'pending' && (
                  <>
                    <button
                      className="ai-header-btn"
                      onClick={() => decideMutationGrant('grant', grant.requestId)}
                    >
                      Allow
                    </button>
                    <button
                      className="ai-header-btn"
                      onClick={() => decideMutationGrant('deny', grant.requestId)}
                    >
                      Deny
                    </button>
                  </>
                )}
                {grant.status === 'active' && grant.grantId && (
                  <button
                    className="ai-header-btn"
                    onClick={() => decideMutationGrant('revoke', grant.grantId!)}
                  >
                    Revoke
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
            ↶ Undo · {projection.rollbackRunId}
          </button>
        )}
        {errorCode && <div className="ai-msg ai-msg-assistant ai-msg-error">{errorCode}</div>}
        {busy && <AiTypingIndicator label={t('aiThinking')} />}
      </div>

      <div className="ai-composer">
        <AiComposer
          value={prompt}
          busy={busy}
          placeholder={t('aiInputPlaceholder')}
          hintIdle=""
          hintBusy=""
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly
          sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
          sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
          stopIcon={<img src={sendStop} alt="" aria-hidden />}
          onChange={setPrompt}
          onSend={() => send(prompt)}
          onStop={stop}
        />
      </div>
    </aside>
  )
}

function IconCollapse(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10.5 3.5 6 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function AgentMark({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2.4 14.55 8l5.55 2.55-5.55 2.55L12 18.7l-2.55-5.6-5.55-2.55L9.45 8 12 2.4Z"
        fill="currentColor"
      />
    </svg>
  )
}
