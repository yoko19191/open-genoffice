import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthResult } from '@earendil-works/pi-ai'
import type { ArtifactRef } from '@genoffice/agent-runtime-protocol'

const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const OUTER_MODEL = 'gpt-5.4-mini'
const IMAGE_MODEL = 'gpt-image-2'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Fetch = (input: string, init: RequestInit) => Promise<Response>

type ModelRuntimePort = {
  getAuth(
    providerId: string,
    options?: { signal?: AbortSignal; minOAuthValidityMs?: number },
  ): Promise<AuthResult | undefined>
  isUsingOAuth(providerId: string): boolean
}

export type CodexImageGenerateInput = {
  operationId: string
  documentId: string
  runId: string
  prompt: string
}

export type CodexImageUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type CodexImageGenerateResult = {
  artifact: ArtifactRef
  width: number
  height: number
  usage?: CodexImageUsage
}

export type CodexOAuthImageProviderOptions = {
  rootDirectory: string
  modelRuntime: ModelRuntimePort
  fetch?: Fetch
  createId?: () => string
  timeoutMs?: number
}

export type CodexOAuthImageProviderErrorCode =
  | 'artifact_invalid'
  | 'provider_auth_required'
  | 'provider_contract_incompatible'
  | 'provider_partial_image'
  | 'provider_request_aborted'
  | 'provider_unavailable'
  | 'provider_usage_limited'

export class CodexOAuthImageProviderError extends Error {
  constructor(public readonly code: CodexOAuthImageProviderErrorCode) {
    super(code)
    this.name = 'CodexOAuthImageProviderError'
  }
}

type ParsedStream = {
  finalBase64?: string
  partialSeen: boolean
  failed: boolean
  usage?: CodexImageUsage
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function usageFrom(response: Record<string, unknown> | undefined): CodexImageUsage | undefined {
  const imageGen = record(record(response?.tool_usage)?.image_gen)
  if (!imageGen) return undefined
  const usage = {
    inputTokens: finite(imageGen.input_tokens),
    outputTokens: finite(imageGen.output_tokens),
    totalTokens: finite(imageGen.total_tokens),
  }
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

function finalImage(response: Record<string, unknown> | undefined): string | undefined {
  const output = response?.output
  if (!Array.isArray(output)) return undefined
  for (const candidate of output) {
    const item = record(candidate)
    if (item?.type === 'image_generation_call' && typeof item.result === 'string') {
      return item.result
    }
  }
  return undefined
}

async function parseStream(response: Response): Promise<ParsedStream> {
  if (!response.body) throw new CodexOAuthImageProviderError('provider_contract_incompatible')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalBase64: string | undefined
  let partialSeen = false
  let failed = false
  let usage: CodexImageUsage | undefined

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const lines = buffer.split('\n')
    buffer = done ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let event: Record<string, unknown> | undefined
      try {
        event = record(JSON.parse(raw))
      } catch {
        continue
      }
      if (event?.type === 'response.image_generation_call.partial_image') partialSeen = true
      if (event?.type === 'response.output_item.done') {
        const item = record(event.item)
        if (item?.type === 'image_generation_call' && typeof item.result === 'string') {
          finalBase64 = item.result
        }
      }
      if (event?.type === 'response.completed') {
        const completed = record(event.response)
        finalBase64 = finalImage(completed) ?? finalBase64
        usage = usageFrom(completed) ?? usage
      }
      if (event?.type === 'response.failed' || event?.type === 'error') failed = true
    }
    if (done) break
  }
  return {
    ...(finalBase64 ? { finalBase64 } : {}),
    partialSeen,
    failed,
    ...(usage ? { usage } : {}),
  }
}

function decodePng(value: string): { bytes: Buffer; width: number; height: number } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > MAX_IMAGE_BYTES * 2) {
    throw new CodexOAuthImageProviderError('artifact_invalid')
  }
  const bytes = Buffer.from(value, 'base64')
  const canonical = bytes.toString('base64').replace(/=+$/, '')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    canonical !== value.replace(/=+$/, '') ||
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    throw new CodexOAuthImageProviderError('artifact_invalid')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width === 0 || height === 0 || width > 16_384 || height > 16_384) {
    throw new CodexOAuthImageProviderError('artifact_invalid')
  }
  return { bytes, width, height }
}

function assertInput(input: CodexImageGenerateInput): void {
  if (
    !UUID.test(input.operationId) ||
    !UUID.test(input.documentId) ||
    !UUID.test(input.runId) ||
    input.prompt.trim().length === 0 ||
    input.prompt.length > 16_000
  ) {
    throw new CodexOAuthImageProviderError('provider_contract_incompatible')
  }
}

function mapHttpError(status: number): CodexOAuthImageProviderError {
  if (status === 401 || status === 403)
    return new CodexOAuthImageProviderError('provider_auth_required')
  if (status === 429) return new CodexOAuthImageProviderError('provider_usage_limited')
  if (status === 400 || status === 422)
    return new CodexOAuthImageProviderError('provider_contract_incompatible')
  return new CodexOAuthImageProviderError('provider_unavailable')
}

export class CodexOAuthImageProvider {
  private readonly fetch: Fetch
  private readonly createId: () => string
  private readonly assetDirectory: string

  constructor(private readonly options: CodexOAuthImageProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.createId = options.createId ?? randomUUID
    this.assetDirectory = join(options.rootDirectory, 'assets', 'provider', 'codex-image')
  }

  artifactPath(artifactId: string): string {
    if (!UUID.test(artifactId)) throw new CodexOAuthImageProviderError('artifact_invalid')
    return join(this.assetDirectory, `${artifactId}.png`)
  }

  async generate(
    input: CodexImageGenerateInput,
    callerSignal?: AbortSignal,
  ): Promise<CodexImageGenerateResult> {
    assertInput(input)
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 300_000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    try {
      signal.throwIfAborted()
      if (!this.options.modelRuntime.isUsingOAuth('openai-codex')) {
        throw new CodexOAuthImageProviderError('provider_auth_required')
      }
      let auth = await this.options.modelRuntime.getAuth('openai-codex', { signal })
      let response = await this.request(input, auth, signal)
      if (response.status === 401) {
        auth = await this.options.modelRuntime.getAuth('openai-codex', {
          signal,
          minOAuthValidityMs: 24 * 60 * 60 * 1000,
        })
        response = await this.request(input, auth, signal)
      }
      if (!response.ok) throw mapHttpError(response.status)
      const parsed = await parseStream(response)
      if (!parsed.finalBase64) {
        if (parsed.partialSeen) throw new CodexOAuthImageProviderError('provider_partial_image')
        throw new CodexOAuthImageProviderError(
          parsed.failed ? 'provider_unavailable' : 'provider_contract_incompatible',
        )
      }
      const image = decodePng(parsed.finalBase64)
      const artifactId = this.createId()
      const path = this.artifactPath(artifactId)
      await mkdir(this.assetDirectory, { recursive: true })
      const temporary = `${path}.${input.operationId}.tmp`
      try {
        await writeFile(temporary, image.bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        try {
          await unlink(temporary)
        } catch {
          // The temporary may not exist when exclusive creation itself failed.
        }
        throw error
      }
      return {
        artifact: {
          artifactId,
          mediaType: 'image/png',
          byteLength: image.bytes.length,
          sha256: createHash('sha256').update(image.bytes).digest('hex'),
          displayName: 'generated-image.png',
        },
        width: image.width,
        height: image.height,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      }
    } catch (error) {
      if (callerSignal?.aborted || (error as { name?: unknown }).name === 'AbortError') {
        throw new CodexOAuthImageProviderError('provider_request_aborted')
      }
      if (error instanceof CodexOAuthImageProviderError) throw error
      throw new CodexOAuthImageProviderError('provider_unavailable')
    }
  }

  private request(
    input: CodexImageGenerateInput,
    auth: AuthResult | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = auth?.auth.headers
    const authorization = headers?.Authorization ?? headers?.authorization
    const accountId = headers?.['chatgpt-account-id']
    if (!authorization || !accountId || auth?.source !== 'OAuth') {
      throw new CodexOAuthImageProviderError('provider_auth_required')
    }
    return this.fetch(RESPONSES_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...headers,
        Authorization: authorization,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': `pi (${process.platform}; ${process.arch})`,
        originator: 'pi',
        'x-client-request-id': input.operationId,
        'session-id': input.runId,
      },
      body: JSON.stringify({
        instructions: '',
        stream: true,
        reasoning: { effort: 'medium', summary: 'auto' },
        parallel_tool_calls: true,
        include: ['reasoning.encrypted_content'],
        model: OUTER_MODEL,
        store: false,
        tool_choice: { type: 'image_generation' },
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: input.prompt }],
          },
        ],
        tools: [
          {
            type: 'image_generation',
            action: 'generate',
            model: IMAGE_MODEL,
            size: '1024x1024',
            quality: 'low',
            output_format: 'png',
          },
        ],
      }),
      signal,
    })
  }
}
