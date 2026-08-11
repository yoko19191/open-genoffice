import { randomUUID } from 'node:crypto'
import type { PdfOfficeToolRequest, PdfOfficeToolResponse } from '../../shared/ipc'

type PdfOfficeToolRequestInput = PdfOfficeToolRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never

type PendingRequest = {
  timer: ReturnType<typeof setTimeout>
  resolve(response: PdfOfficeToolResponse): void
  reject(error: Error): void
}

export interface PdfOfficeToolRendererClientOptions {
  webContentsId: number
  isDestroyed(): boolean
  send(request: PdfOfficeToolRequest): void
  timeoutMs?: number
}

export class PdfOfficeToolRendererClient {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(private readonly options: PdfOfficeToolRendererClientOptions) {}

  request(input: PdfOfficeToolRequestInput): Promise<PdfOfficeToolResponse> {
    if (this.closed || this.options.isDestroyed()) {
      return Promise.reject(new Error('executor_unavailable'))
    }
    const request = { ...input, requestId: randomUUID() } as PdfOfficeToolRequest
    return new Promise<PdfOfficeToolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('executor_unavailable'))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(request.requestId, { timer, resolve, reject })
      this.options.send(request)
    })
  }

  accept(webContentsId: number, response: PdfOfficeToolResponse): boolean {
    if (
      webContentsId !== this.options.webContentsId ||
      typeof response.requestId !== 'string' ||
      response.requestId.length === 0
    ) {
      return false
    }
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
