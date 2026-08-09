import type { Readable } from 'node:stream'
import {
  MAX_FRAME_BYTES,
  parseBootstrapLine,
  type BootstrapRecord,
} from '@genoffice/agent-runtime-protocol'
import {
  createAuthenticatedRuntimeServer,
  type AuthenticatedRuntimeServer,
} from './authenticated-server'

export const RUNTIME_EXIT_CODES = {
  ok: 0,
  bootstrap: 64,
  crash: 70,
} as const

export type RuntimeDiagnosticCode =
  | 'bootstrap_eof'
  | 'bootstrap_extra_data'
  | 'bootstrap_io_error'
  | 'invalid_bootstrap'
  | 'invalid_parent_pid'
  | 'runtime_start_failed'

export class RuntimeBootstrapError extends Error {
  constructor(
    public readonly code: RuntimeDiagnosticCode,
    public readonly exitCode: number,
  ) {
    super(code)
    this.name = 'RuntimeBootstrapError'
  }
}

export class RuntimeStartError extends Error {
  readonly code = 'runtime_start_failed'
  readonly exitCode = RUNTIME_EXIT_CODES.crash

  constructor() {
    super('runtime_start_failed')
    this.name = 'RuntimeStartError'
  }
}

export type StartRuntimeFromStdinOptions = {
  stdin: Readable
  actualParentPid: number
  instanceId: string
  platform?: NodeJS.Platform
  diagnostic?: (code: RuntimeDiagnosticCode) => void
}

type BootstrapTermination = 'eof' | 'bootstrap_extra_data' | 'bootstrap_io_error'

type BootstrapInput = {
  record: BootstrapRecord
  termination: Promise<BootstrapTermination>
  dispose: () => void
}

function readBootstrapInput(stdin: Readable): Promise<BootstrapInput> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    let recordRead = false
    let resolveTermination!: (reason: BootstrapTermination) => void
    const termination = new Promise<BootstrapTermination>((resolveReason) => {
      resolveTermination = resolveReason
    })

    function dispose() {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
    }

    function terminate(reason: BootstrapTermination) {
      dispose()
      resolveTermination(reason)
    }

    function fail(code: RuntimeDiagnosticCode) {
      dispose()
      reject(new RuntimeBootstrapError(code, RUNTIME_EXIT_CODES.bootstrap))
    }

    function onData(chunk: Buffer | string) {
      if (recordRead) {
        terminate('bootstrap_extra_data')
        return
      }

      try {
        pending +=
          typeof chunk === 'string'
            ? chunk
            : decoder.decode(chunk, {
                stream: true,
              })
      } catch {
        fail('invalid_bootstrap')
        return
      }

      const newline = pending.indexOf('\n')
      if (newline === -1) {
        if (Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES) fail('invalid_bootstrap')
        return
      }

      const line = pending.slice(0, newline)
      const remainder = pending.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        fail('invalid_bootstrap')
        return
      }

      let record: BootstrapRecord
      try {
        record = parseBootstrapLine(line)
      } catch {
        fail('invalid_bootstrap')
        return
      }

      recordRead = true
      resolve({ record, termination, dispose })
      if (remainder.length > 0) terminate('bootstrap_extra_data')
    }

    function onEnd() {
      if (!recordRead) {
        fail('bootstrap_eof')
        return
      }
      terminate('eof')
    }

    function onError() {
      if (!recordRead) {
        fail('bootstrap_io_error')
        return
      }
      terminate('bootstrap_io_error')
    }

    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
  })
}

export async function startRuntimeFromStdin(
  options: StartRuntimeFromStdinOptions,
): Promise<AuthenticatedRuntimeServer> {
  let input: BootstrapInput
  try {
    input = await readBootstrapInput(options.stdin)
  } catch (error) {
    const bootstrapError = error as RuntimeBootstrapError
    options.diagnostic?.(bootstrapError.code)
    throw error
  }

  let runtime: AuthenticatedRuntimeServer
  try {
    runtime = await createAuthenticatedRuntimeServer({
      bootstrap: input.record,
      actualParentPid: options.actualParentPid,
      instanceId: options.instanceId,
      platform: options.platform,
    })
  } catch (error) {
    input.dispose()
    if (error instanceof Error && error.message === 'invalid_parent_pid') {
      const bootstrapError = new RuntimeBootstrapError(
        'invalid_parent_pid',
        RUNTIME_EXIT_CODES.bootstrap,
      )
      options.diagnostic?.(bootstrapError.code)
      throw bootstrapError
    }
    const runtimeError = new RuntimeStartError()
    options.diagnostic?.(runtimeError.code)
    throw runtimeError
  }

  void input.termination.then((reason) => {
    if (reason !== 'eof') options.diagnostic?.(reason)
    void runtime.shutdown()
  })
  return runtime
}
