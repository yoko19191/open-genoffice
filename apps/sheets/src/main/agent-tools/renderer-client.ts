import { randomUUID } from 'node:crypto'
import type {
  SheetsOfficeToolRequest,
  SheetsOfficeToolResponse,
} from '../../shared/sheets-office-tools'

type RequestInput = SheetsOfficeToolRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never

type PendingRequest = {
  timer: ReturnType<typeof setTimeout>
  resolve(response: SheetsOfficeToolResponse): void
  reject(error: Error): void
}

export interface SheetsOfficeToolRendererClientOptions {
  webContentsId: number
  isDestroyed(): boolean
  send(request: SheetsOfficeToolRequest): void
  timeoutMs?: number
}

export class SheetsOfficeToolRendererClient {
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(private readonly options: SheetsOfficeToolRendererClientOptions) {}

  request(input: RequestInput): Promise<SheetsOfficeToolResponse> {
    if (this.closed || this.options.isDestroyed()) {
      return Promise.reject(new Error('executor_unavailable'))
    }
    const request = { ...input, requestId: randomUUID() } as SheetsOfficeToolRequest
    return new Promise<SheetsOfficeToolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('executor_unavailable'))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(request.requestId, { timer, resolve, reject })
      this.options.send(request)
    })
  }

  accept(webContentsId: number, response: SheetsOfficeToolResponse): boolean {
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
