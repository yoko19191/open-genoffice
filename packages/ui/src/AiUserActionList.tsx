import { useState, type ReactElement } from 'react'
import type { UserActionProjection, UserActionAnswer } from '@genoffice/agent-runtime-protocol'

export function AiUserActionList({
  actions,
  onAnswer,
}: {
  actions: readonly UserActionProjection[]
  onAnswer: (requestId: string, answer: UserActionAnswer) => void
}): ReactElement {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  return (
    <div className="ai-work-group" data-testid="user-action-list">
      {actions.map((action) => (
        <div key={action.requestId} className="ai-step-entry" data-testid="user-action-card">
          <div className="ai-step-row">
            <span className="ai-step-icon pending" aria-hidden>
              ?
            </span>
            <span className="ai-step-title">{action.question}</span>
          </div>
          {action.mode === 'confirm' ? (
            <div className="ai-step-row">
              <button
                type="button"
                className="ai-header-btn"
                onClick={() => onAnswer(action.requestId, { confirmed: true })}
              >
                {action.confirmLabel ?? 'Confirm'}
              </button>
              <button
                type="button"
                className="ai-header-btn"
                onClick={() => onAnswer(action.requestId, { confirmed: false })}
              >
                {action.cancelLabel ?? 'Cancel'}
              </button>
            </div>
          ) : (
            <form
              className="ai-step-row"
              onSubmit={(event) => {
                event.preventDefault()
                onAnswer(action.requestId, { text: inputs[action.requestId] ?? '' })
              }}
            >
              <input
                aria-label={action.question}
                className="ai-user-action-input"
                maxLength={action.maxLength ?? 4_000}
                placeholder={action.placeholder}
                value={inputs[action.requestId] ?? ''}
                onChange={(event) =>
                  setInputs((current) => ({
                    ...current,
                    [action.requestId]: event.currentTarget.value,
                  }))
                }
              />
              <button type="submit" className="ai-header-btn">
                Submit
              </button>
            </form>
          )}
        </div>
      ))}
    </div>
  )
}
