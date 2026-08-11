export type AbortDescendantKind = 'model' | 'office' | 'mcp' | 'subagent' | 'process'
export type MutationOutcome = 'not_started' | 'committed' | 'rolled_back' | 'unknown'

export type AbortDescendantRegistration = {
  id: string
  kind: AbortDescendantKind
  mutation?: boolean
  revoke?: () => Promise<void>
  abort: (signal: AbortSignal) => Promise<{ mutationOutcome?: MutationOutcome } | void>
  forceKill?: () => Promise<void>
}

export type AbortDescendantResult = {
  id: string
  kind: AbortDescendantKind
  state: 'settled' | 'forced' | 'incomplete'
  mutationOutcome?: MutationOutcome
}

export type RunAbortSummary = {
  complete: boolean
  descendants: AbortDescendantResult[]
}

export type RunAbortTreeOptions = {
  cooperativeAbortMs: number
  forceAbortMs: number
}

type TimedResult<T> =
  { state: 'settled'; value: T } | { state: 'rejected' } | { state: 'timed_out' }

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ state: 'timed_out' }), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve({ state: 'settled', value })
      },
      () => {
        clearTimeout(timeout)
        resolve({ state: 'rejected' })
      },
    )
  })
}

export class RunAbortTree {
  private readonly controller = new AbortController()
  private readonly descendants = new Map<string, AbortDescendantRegistration>()
  private abortPromise: Promise<RunAbortSummary> | undefined

  constructor(private readonly options: RunAbortTreeOptions) {
    if (options.cooperativeAbortMs < 1 || options.forceAbortMs < options.cooperativeAbortMs) {
      throw new Error('invalid_abort_deadline')
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  register(descendant: AbortDescendantRegistration): () => void {
    if (this.abortPromise) throw new Error('abort_already_started')
    if (this.descendants.has(descendant.id)) throw new Error('duplicate_abort_descendant')
    this.descendants.set(descendant.id, descendant)
    return () => this.descendants.delete(descendant.id)
  }

  abort(): Promise<RunAbortSummary> {
    this.abortPromise ??= this.abortAll()
    return this.abortPromise
  }

  private async abortAll(): Promise<RunAbortSummary> {
    this.controller.abort()
    const descendants = [...this.descendants.values()]
    const results = await Promise.all(descendants.map((descendant) => this.abortOne(descendant)))
    return {
      complete: results.every(
        (result) => result.state !== 'incomplete' && result.mutationOutcome !== 'unknown',
      ),
      descendants: results,
    }
  }

  private async abortOne(descendant: AbortDescendantRegistration): Promise<AbortDescendantResult> {
    const cooperative = (async () => {
      if (descendant.revoke) await descendant.revoke()
      return descendant.abort(this.signal)
    })()
    const result = await settleWithin(cooperative, this.options.cooperativeAbortMs)
    if (result.state === 'settled') {
      return {
        id: descendant.id,
        kind: descendant.kind,
        state: 'settled',
        ...(descendant.mutation
          ? { mutationOutcome: result.value?.mutationOutcome ?? 'unknown' }
          : {}),
      }
    }

    if (result.state === 'timed_out' && descendant.forceKill) {
      const remaining = this.options.forceAbortMs - this.options.cooperativeAbortMs
      const forced = await settleWithin(descendant.forceKill(), remaining)
      if (forced.state === 'settled') {
        return {
          id: descendant.id,
          kind: descendant.kind,
          state: 'forced',
          ...(descendant.mutation ? { mutationOutcome: 'unknown' as const } : {}),
        }
      }
    }

    return {
      id: descendant.id,
      kind: descendant.kind,
      state: 'incomplete',
      ...(descendant.mutation ? { mutationOutcome: 'unknown' as const } : {}),
    }
  }
}
