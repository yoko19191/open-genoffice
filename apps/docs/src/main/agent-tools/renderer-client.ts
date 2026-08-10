import { randomUUID } from 'node:crypto'
import type { DocsOfficeToolRequest, DocsOfficeToolResponse } from '../../shared/docs-office-tools'

type RequestInput = DocsOfficeToolRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never

type PendingRequest = {
  timer: ReturnType<typeof setTimeout>
  resolve(response: DocsOfficeToolResponse): void
  reject(error: Error): void
}

export interface DocsOfficeToolRendererClientOptions {
  webContentsId: number
  isDestroyed(): boolean
  send(request: DocsOfficeToolRequest): void
  timeoutMs?: number
}

export class DocsOfficeToolRendererClient {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(private readonly options: DocsOfficeToolRendererClientOptions) {}

  request(input: RequestInput): Promise<DocsOfficeToolResponse> {
    if (this.closed || this.options.isDestroyed()) {
      return Promise.reject(new Error('executor_unavailable'))
    }
    const request = { ...input, requestId: randomUUID() } as DocsOfficeToolRequest
    return new Promise<DocsOfficeToolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('executor_unavailable'))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(request.requestId, { timer, resolve, reject })
      this.options.send(request)
    })
  }

  accept(webContentsId: number, response: DocsOfficeToolResponse): boolean {
    if (webContentsId !== this.options.webContentsId || !response.requestId) return false
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    pending.resolve(response)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('executor_unavailable')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
