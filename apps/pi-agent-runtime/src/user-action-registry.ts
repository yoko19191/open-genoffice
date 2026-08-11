import { randomUUID } from 'node:crypto'
import { Value } from '@sinclair/typebox/value'
import {
  UserActionAnswerSchema,
  UserActionProjectionSchema,
  type UserActionAnswer,
  type UserActionProjection,
} from '@genoffice/agent-runtime-protocol'

type RequestInput = {
  sessionId: string
  documentId: string
  runId: string
  mode: 'confirm' | 'input'
  question: string
  confirmLabel?: string
  cancelLabel?: string
  placeholder?: string
  maxLength?: number
  signal?: AbortSignal
}

type PendingAction = {
  sessionId: string
  documentId: string
  projection: UserActionProjection
  resolve: (value: { requestId: string; answer: UserActionAnswer }) => void
  reject: (error: UserActionRegistryError) => void
  removeAbortListener: () => void
}

export type UserActionRegistryEvent = {
  sessionId: string
  documentId: string
  projection: UserActionProjection
}

export type UserActionRegistryErrorCode =
  | 'user_action_request_invalid'
  | 'user_action_answer_invalid'
  | 'user_action_binding_invalid'
  | 'user_action_not_found'
  | 'user_action_cancelled'
  | 'user_action_limit_exceeded'

export class UserActionRegistryError extends Error {
  constructor(readonly code: UserActionRegistryErrorCode) {
    super(code)
    this.name = 'UserActionRegistryError'
  }
}

export class UserActionRegistry {
  private readonly randomUUID: () => string
  private readonly now: () => Date
  private readonly pending = new Map<string, PendingAction>()
  private readonly listeners = new Set<(event: UserActionRegistryEvent) => void>()

  constructor(options: { randomUUID?: () => string; now?: () => Date } = {}) {
    this.randomUUID = options.randomUUID ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  onEvent(listener: (event: UserActionRegistryEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listForSession(sessionId: string): UserActionProjection[] {
    return [...this.pending.values()]
      .filter((action) => action.sessionId === sessionId)
      .map(({ projection }) => structuredClone(projection))
  }

  request(input: RequestInput): Promise<{ requestId: string; answer: UserActionAnswer }> {
    const projection: UserActionProjection = {
      requestId: this.randomUUID(),
      runId: input.runId,
      mode: input.mode,
      question: input.question,
      ...(input.confirmLabel === undefined ? {} : { confirmLabel: input.confirmLabel }),
      ...(input.cancelLabel === undefined ? {} : { cancelLabel: input.cancelLabel }),
      ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
      ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
      requestedAt: this.now().toISOString(),
      status: 'pending',
    }
    const validModeFields =
      input.mode === 'confirm'
        ? input.placeholder === undefined && input.maxLength === undefined
        : input.confirmLabel === undefined && input.cancelLabel === undefined
    if (
      !validModeFields ||
      !Value.Check(UserActionProjectionSchema, projection) ||
      this.pending.has(projection.requestId)
    ) {
      return Promise.reject(new UserActionRegistryError('user_action_request_invalid'))
    }
    if (this.listForSession(input.sessionId).length >= 16) {
      return Promise.reject(new UserActionRegistryError('user_action_limit_exceeded'))
    }
    if (input.signal?.aborted) {
      return Promise.reject(new UserActionRegistryError('user_action_cancelled'))
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => this.cancel(projection.requestId)
      input.signal?.addEventListener('abort', onAbort, { once: true })
      const action: PendingAction = {
        sessionId: input.sessionId,
        documentId: input.documentId,
        projection,
        resolve,
        reject,
        removeAbortListener: () => input.signal?.removeEventListener('abort', onAbort),
      }
      this.pending.set(projection.requestId, action)
      this.emit(action, projection)
    })
  }

  async answer(input: {
    sessionId: string
    documentId: string
    requestId: string
    userActionId: string
    answer: UserActionAnswer
  }): Promise<UserActionProjection> {
    const action = this.pending.get(input.requestId)
    if (!action) throw new UserActionRegistryError('user_action_not_found')
    if (action.sessionId !== input.sessionId || action.documentId !== input.documentId) {
      throw new UserActionRegistryError('user_action_binding_invalid')
    }
    const validAnswer =
      Value.Check(UserActionAnswerSchema, input.answer) &&
      input.userActionId.length > 0 &&
      (action.projection.mode === 'confirm'
        ? 'confirmed' in input.answer
        : 'text' in input.answer &&
          input.answer.text.length <= (action.projection.maxLength ?? 4_000))
    if (!validAnswer) throw new UserActionRegistryError('user_action_answer_invalid')
    const projection = { ...action.projection, status: 'answered' as const }
    this.pending.delete(input.requestId)
    action.removeAbortListener()
    this.emit(action, projection)
    action.resolve({ requestId: input.requestId, answer: structuredClone(input.answer) })
    return structuredClone(projection)
  }

  cancelForRun(runId: string): number {
    return this.cancelWhere(({ projection }) => projection.runId === runId)
  }

  cancelForSession(sessionId: string): number {
    return this.cancelWhere((action) => action.sessionId === sessionId)
  }

  private cancelWhere(predicate: (action: PendingAction) => boolean): number {
    const requestIds = [...this.pending.entries()]
      .filter(([, action]) => predicate(action))
      .map(([requestId]) => requestId)
    for (const requestId of requestIds) this.cancel(requestId)
    return requestIds.length
  }

  private cancel(requestId: string): void {
    const action = this.pending.get(requestId)!
    this.pending.delete(requestId)
    action.removeAbortListener()
    this.emit(action, { ...action.projection, status: 'cancelled' })
    action.reject(new UserActionRegistryError('user_action_cancelled'))
  }

  private emit(action: PendingAction, projection: UserActionProjection): void {
    const event = {
      sessionId: action.sessionId,
      documentId: action.documentId,
      projection: structuredClone(projection),
    }
    for (const listener of this.listeners) listener(event)
  }
}
