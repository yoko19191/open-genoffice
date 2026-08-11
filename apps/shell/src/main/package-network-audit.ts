import { appendFileSync } from 'node:fs'

type WebRequestLike = {
  onBeforeRequest(
    filter: { urls: string[] },
    listener: (
      details: { url: string },
      callback: (response: { cancel?: boolean }) => void,
    ) => void,
  ): void
}

export function packageNetworkAuditEnabled(input: {
  isPackaged: boolean
  enabled?: string
  reportPath?: string
  surface?: string
}): input is {
  isPackaged: true
  enabled: '1'
  reportPath: string
  surface: string
} {
  return (
    input.isPackaged &&
    input.enabled === '1' &&
    typeof input.reportPath === 'string' &&
    input.reportPath.length > 0 &&
    typeof input.surface === 'string' &&
    input.surface.length > 0
  )
}

export function installChromiumPackageNetworkAudit(
  webRequest: WebRequestLike,
  reportPath: string,
  surface: string,
): void {
  const append = (event: object) =>
    appendFileSync(
      reportPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, surface, ...event })}\n`,
      { mode: 0o600 },
    )
  append({ kind: 'instrumented', process: 'chromium' })
  webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const hostname = (() => {
      try {
        return new URL(details.url).hostname.toLowerCase()
      } catch {
        return 'invalid'
      }
    })()
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      callback({})
      return
    }
    append({
      kind: 'network_attempt',
      protocol: 'chromium',
      hostname,
      outcome: 'blocked',
    })
    callback({ cancel: true })
  })
}
