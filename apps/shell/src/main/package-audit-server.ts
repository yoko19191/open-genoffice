import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createServer, type Socket } from 'node:net'

const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\genoffice-package-audit-[0-9a-f]{32}$/
const REQUEST_LIMIT = 1_024

const PACKAGE_AUDIT_RENDERER_SCRIPT = `
(async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const deadline = Date.now() + 30000
  const skip = document.querySelector('.onb-skip')
  if (skip instanceof HTMLElement && skip.offsetParent !== null) skip.click()
  while (!document.querySelector('.quick-cards') && Date.now() < deadline) await delay(100)
  if (!document.querySelector('.quick-cards')) throw new Error('package_shell_routes_timeout')
  let health
  while (Date.now() < deadline) {
    health = await globalThis.aiOfficeAgent.health()
    if (['ready', 'crashed', 'unavailable'].includes(health.state)) break
    await delay(100)
  }
  const [mineru, models, mcp, packages, resources] = await Promise.all([
    globalThis.aiOfficeMineruOcr.status(),
    globalThis.aiOfficeAgent.modelCatalog(),
    globalThis.aiOfficeAgent.mcpCatalog(),
    globalThis.aiOfficeAgent.packageCatalog('global'),
    globalThis.aiOfficeAgent.resourceCatalog(),
  ])
  return {
    health,
    quickActions: [...document.querySelectorAll('.quick-card')].map((button) => ({
      label: button.querySelector('.quick-title')?.textContent?.trim() ?? '',
      disabled: button instanceof HTMLButtonElement && button.disabled,
    })),
    bodyText: document.body.innerText,
    mineru,
    models,
    mcp,
    packages,
    resources,
  }
})()
`

function send(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`)
}

export function asPackageAuditEndpoint(
  value: string | undefined,
  platform = process.platform,
): string {
  const valid =
    platform === 'win32'
      ? typeof value === 'string' && WINDOWS_PIPE_PATTERN.test(value)
      : typeof value === 'string' && isAbsolute(value) && value.endsWith('.sock')
  if (!valid) throw new Error('package_audit_endpoint_invalid')
  return value as string
}

export function packageAuditSocketNeedsCleanup(platform = process.platform): boolean {
  return platform !== 'win32'
}

export async function collectPackageAuditSnapshot(input: {
  isPackaged: boolean
  userData: string
  expectedUserData: string
  executeJavaScript(script: string): Promise<unknown>
  capturePage(): Promise<{ toPNG(): Buffer }>
}): Promise<Record<string, unknown>> {
  const renderer = await input.executeJavaScript(PACKAGE_AUDIT_RENDERER_SCRIPT)
  if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) {
    throw new Error('package_audit_snapshot_invalid')
  }
  const screenshot = (await input.capturePage()).toPNG()
  return {
    ...renderer,
    installed: input.isPackaged,
    userDataIsolated: input.userData === input.expectedUserData,
    screenshotBase64: screenshot.toString('base64'),
  }
}

export async function startPackageAuditServer(input: {
  token: string | undefined
  endpoint: string | undefined
  collect(): Promise<unknown>
  shutdown(): void
}): Promise<{ close(): Promise<void> }> {
  if (!input.token || !TOKEN_PATTERN.test(input.token)) {
    throw new Error('package_audit_token_invalid')
  }
  const endpoint = asPackageAuditEndpoint(input.endpoint)
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let requestBody = ''
    let handled = false
    socket.on(
      'error',
      /* v8 ignore next -- client disconnects have no observable audit result */ () => undefined,
    )
    socket.on('data', (chunk: string) => {
      if (handled) return
      requestBody += chunk
      if (requestBody.length > REQUEST_LIMIT) {
        handled = true
        send(socket, { status: 'not_found' })
        return
      }
      const newline = requestBody.indexOf('\n')
      if (newline < 0) return
      handled = true
      void (async () => {
        let request: unknown
        try {
          request = JSON.parse(requestBody.slice(0, newline))
        } catch {
          send(socket, { status: 'not_found' })
          return
        }
        if (
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          Object.keys(request).sort().join(',') !== 'operation,schemaVersion,token' ||
          (request as { schemaVersion?: unknown }).schemaVersion !== 1 ||
          (request as { token?: unknown }).token !== input.token
        ) {
          send(socket, { status: 'not_found' })
          return
        }
        const operation = (request as { operation?: unknown }).operation
        if (operation === 'snapshot') {
          send(socket, { status: 'ok', snapshot: await input.collect() })
          return
        }
        if (operation === 'shutdown') {
          socket.once('finish', input.shutdown)
          send(socket, { status: 'ok', accepted: true })
          return
        }
        send(socket, { status: 'not_found' })
      })().catch(() => send(socket, { status: 'unavailable' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (packageAuditSocketNeedsCleanup()) await rm(endpoint, { force: true })
    },
  }
}
