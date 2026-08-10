import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PACKAGE_AUDIT_ENDPOINT_FILE = 'package-audit-endpoint.json'

const TOKEN_PATTERN = /^[0-9a-f]{64}$/

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

function reply(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
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
  userData: string
  collect(): Promise<unknown>
  shutdown(): void
}): Promise<{ close(): Promise<void> }> {
  if (!input.token || !TOKEN_PATTERN.test(input.token)) {
    throw new Error('package_audit_token_invalid')
  }
  const endpointPath = join(input.userData, PACKAGE_AUDIT_ENDPOINT_FILE)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${input.token}`) {
        reply(response, 404, { error: 'not_found' })
        return
      }
      if (request.method === 'GET' && request.url === '/snapshot') {
        reply(response, 200, await input.collect())
        return
      }
      if (request.method === 'POST' && request.url === '/shutdown') {
        await rm(endpointPath, { force: true })
        reply(response, 200, { accepted: true })
        input.shutdown()
        return
      }
      reply(response, 404, { error: 'not_found' })
    })().catch(() => reply(response, 503, { error: 'package_audit_unavailable' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('package_audit_endpoint_invalid')
  }
  await writeFile(endpointPath, `${JSON.stringify({ schemaVersion: 1, port: address.port })}\n`, {
    mode: 0o600,
  })
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(endpointPath, { force: true })
    },
  }
}
