import { isIP } from 'node:net'
import type { CredentialStore } from '@earendil-works/pi-ai'
import type { ScopedArtifactStore } from '@genoffice/agent-resource'
import { parsePlatformToolInput } from '@genoffice/agent-runtime-protocol/platform-tool-catalog'

const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search'
const SERPER_IMAGES_ENDPOINT = 'https://google.serper.dev/images'
const DUCK_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DUCK_IMAGES_ENDPOINT = 'https://duckduckgo.com/i.js'
const DUCK_HOME_ENDPOINT = 'https://duckduckgo.com/'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const COPYRIGHT_HOSTS = ['gettyimages', 'istockphoto', 'shutterstock', 'corbis']

export type PlatformToolContext = {
  documentId: string
  runId: string
}

type WebResult = { title: string; url: string; snippet: string }
type ImageCandidate = {
  title: string
  imageUrl: string
  sourceUrl: string
  source: string
}
type ArtifactImage = Omit<ImageCandidate, 'imageUrl'> & {
  artifactId: string
  mediaType: 'image/png'
  byteLength: number
  sha256: string
  width: number
  height: number
}

export type PlatformToolDetails =
  | { kind: 'web_search'; provider: 'serper' | 'duckduckgo'; results: WebResult[] }
  | {
      kind: 'image_search'
      provider: 'serper' | 'duckduckgo'
      images: ArtifactImage[]
    }
  | {
      kind: 'artifact_text'
      artifactId: string
      displayName?: string
      offset: number
      nextOffset?: number
      totalCharacters: number
    }

export type PlatformToolResult = { content: string; details: PlatformToolDetails }

export type PlatformToolServiceErrorCode =
  | 'artifact_invalid'
  | 'invalid_tool_arguments'
  | 'platform_tool_aborted'
  | 'search_unavailable'
  | 'tool_not_in_snapshot'

export class PlatformToolServiceError extends Error {
  constructor(readonly code: PlatformToolServiceErrorCode) {
    super(code)
    this.name = 'PlatformToolServiceError'
  }
}

export type PlatformToolServiceOptions = {
  artifactStore: Pick<ScopedArtifactStore, 'readText' | 'registerImage'>
  credentials: Pick<CredentialStore, 'read'>
  fetch?: typeof fetch
  randomUUID?: () => string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boundedString(value: unknown, maximum = 8_192): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').slice(0, maximum).trim() : ''
}

function isPrivateIp(hostname: string): boolean {
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split('.').map(Number)
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase()
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
  }
  return false
}

function safeHttpsUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value))
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      isPrivateIp(hostname)
    ) {
      return undefined
    }
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function webResult(value: unknown): WebResult | undefined {
  const item = record(value)
  const url = safeHttpsUrl(item.link ?? item.url)
  const title = boundedString(item.title, 2_000)
  if (!url || !title) return undefined
  return { title, url, snippet: boundedString(item.snippet, 8_000) }
}

function imageCandidate(value: unknown): ImageCandidate | undefined {
  const item = record(value)
  const imageUrl = safeHttpsUrl(item.imageUrl ?? item.image ?? item.original)
  if (!imageUrl || COPYRIGHT_HOSTS.some((host) => imageUrl.toLowerCase().includes(host))) {
    return undefined
  }
  return {
    title: boundedString(item.title, 2_000) || 'Image',
    imageUrl,
    sourceUrl: safeHttpsUrl(item.link ?? item.url) ?? '',
    source: boundedString(item.source, 512),
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/gu, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .trim()
}

function decodeDuckUrl(value: string): string | undefined {
  try {
    const match = /[?&]uddg=([^&]+)/u.exec(value)
    return safeHttpsUrl(match ? decodeURIComponent(match[1]!) : value)
  } catch {
    return undefined
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export class PlatformToolService {
  private readonly fetch: typeof fetch
  private readonly randomUUID: () => string

  constructor(private readonly options: PlatformToolServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.randomUUID = options.randomUUID ?? crypto.randomUUID
  }

  async execute(
    toolId: string,
    input: unknown,
    context: PlatformToolContext,
    signal: AbortSignal,
  ): Promise<PlatformToolResult> {
    if (signal.aborted) throw new PlatformToolServiceError('platform_tool_aborted')
    try {
      parsePlatformToolInput(toolId, input)
    } catch (error) {
      throw new PlatformToolServiceError(
        error instanceof Error && error.message === 'tool_not_in_snapshot'
          ? 'tool_not_in_snapshot'
          : 'invalid_tool_arguments',
      )
    }
    if (toolId === 'platform:web_search') {
      return this.webSearch(input as { query: string; maxResults?: number }, signal)
    }
    if (toolId === 'platform:image_search') {
      return this.imageSearch(input as { query: string; maxResults?: number }, context, signal)
    }
    return this.readAttachment(input as { artifactId: string; offset?: number }, context, signal)
  }

  private async serperKey(signal: AbortSignal): Promise<string | undefined> {
    try {
      const credential = await this.options.credentials.read('serper', { signal })
      return credential?.type === 'api_key' && credential.key ? credential.key : undefined
    } catch {
      if (signal.aborted) throw new PlatformToolServiceError('platform_tool_aborted')
      throw new PlatformToolServiceError('search_unavailable')
    }
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal })
      if (!response.ok) throw new Error('http_error')
      return response
    } catch (error) {
      if (signal.aborted) throw new PlatformToolServiceError('platform_tool_aborted')
      if (error instanceof PlatformToolServiceError) throw error
      throw new PlatformToolServiceError('search_unavailable')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  private async webSearch(
    input: { query: string; maxResults?: number },
    signal: AbortSignal,
  ): Promise<PlatformToolResult> {
    const maximum = input.maxResults ?? 6
    const key = await this.serperKey(signal)
    if (key) {
      const response = await this.request(
        SERPER_SEARCH_ENDPOINT,
        {
          method: 'POST',
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: input.query, num: maximum, gl: 'us', hl: 'en' }),
        },
        signal,
      )
      const body = record(await response.json())
      const results = (Array.isArray(body.organic) ? body.organic : [])
        .map(webResult)
        .filter((item): item is WebResult => item !== undefined)
        .slice(0, maximum)
      const answerBox = record(body.answerBox)
      const answer = boundedString(
        answerBox.answer ?? answerBox.snippet ?? record(body.knowledgeGraph).description,
        8_000,
      )
      return {
        content: JSON.stringify({ provider: 'serper', ...(answer ? { answer } : {}), results }),
        details: { kind: 'web_search', provider: 'serper', results },
      }
    }

    const response = await this.request(
      `${DUCK_SEARCH_ENDPOINT}?q=${encodeURIComponent(input.query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      signal,
    )
    const html = await response.text()
    const results: WebResult[] = []
    const matches = html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu,
    )
    for (const match of matches) {
      const url = decodeDuckUrl(match[1]!)
      const title = stripHtml(match[2]!)
      if (url && title) results.push({ title: title.slice(0, 2_000), url, snippet: '' })
      if (results.length >= maximum) break
    }
    return {
      content: JSON.stringify({ provider: 'duckduckgo', results }),
      details: { kind: 'web_search', provider: 'duckduckgo', results },
    }
  }

  private async imageSearch(
    input: { query: string; maxResults?: number },
    context: PlatformToolContext,
    signal: AbortSignal,
  ): Promise<PlatformToolResult> {
    const maximum = input.maxResults ?? 8
    const key = await this.serperKey(signal)
    let provider: 'serper' | 'duckduckgo'
    let candidates: ImageCandidate[]
    if (key) {
      provider = 'serper'
      const response = await this.request(
        SERPER_IMAGES_ENDPOINT,
        {
          method: 'POST',
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: input.query, num: maximum, gl: 'us', hl: 'en' }),
        },
        signal,
      )
      const body = record(await response.json())
      candidates = (Array.isArray(body.images) ? body.images : [])
        .map(imageCandidate)
        .filter((item): item is ImageCandidate => item !== undefined)
    } else {
      provider = 'duckduckgo'
      candidates = await this.duckImageCandidates(input.query, maximum, signal)
    }

    const images: ArtifactImage[] = []
    for (const candidate of candidates) {
      if (images.length >= maximum) break
      const image = await this.downloadPng(candidate, context, signal).catch((error: unknown) => {
        if (error instanceof PlatformToolServiceError && error.code === 'platform_tool_aborted') {
          throw error
        }
        return undefined
      })
      if (image) images.push(image)
    }
    return {
      content: JSON.stringify({
        provider,
        images: images.map(({ artifactId, title, sourceUrl, source, width, height }) => ({
          artifactId,
          title,
          sourceUrl,
          source,
          width,
          height,
        })),
      }),
      details: { kind: 'image_search', provider, images },
    }
  }

  private async duckImageCandidates(
    query: string,
    maximum: number,
    signal: AbortSignal,
  ): Promise<ImageCandidate[]> {
    const home = await this.request(
      `${DUCK_HOME_ENDPOINT}?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      signal,
    )
    const token = /vqd=["']?([\d-]+)["']?/u.exec(await home.text())?.[1]
    if (!token) throw new PlatformToolServiceError('search_unavailable')
    const response = await this.request(
      `${DUCK_IMAGES_ENDPOINT}?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${token}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: DUCK_HOME_ENDPOINT } },
      signal,
    )
    const body = record(await response.json())
    return (Array.isArray(body.results) ? body.results : [])
      .map(imageCandidate)
      .filter((item): item is ImageCandidate => item !== undefined)
      .slice(0, maximum)
  }

  private async downloadPng(
    candidate: ImageCandidate,
    context: PlatformToolContext,
    signal: AbortSignal,
  ): Promise<ArtifactImage | undefined> {
    const response = await this.request(candidate.imageUrl, {}, signal)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (
      length > MAX_IMAGE_BYTES ||
      response.headers.get('content-type')?.split(';')[0] !== 'image/png'
    ) {
      return undefined
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) return undefined
    const dimensions = pngDimensions(bytes)
    if (!dimensions) return undefined
    const artifact = await this.options.artifactStore.registerImage({
      artifactId: this.randomUUID(),
      ...context,
      bytes,
      mediaType: 'image/png',
      ...dimensions,
      displayName: 'search-result.png',
    })
    return {
      title: candidate.title,
      sourceUrl: candidate.sourceUrl,
      source: candidate.source,
      ...artifact,
      ...dimensions,
    }
  }

  private async readAttachment(
    input: { artifactId: string; offset?: number },
    context: PlatformToolContext,
    signal: AbortSignal,
  ): Promise<PlatformToolResult> {
    if (signal.aborted) throw new PlatformToolServiceError('platform_tool_aborted')
    try {
      const page = await this.options.artifactStore.readText({ ...input, ...context })
      if (signal.aborted) throw new PlatformToolServiceError('platform_tool_aborted')
      return {
        content: page.text,
        details: {
          kind: 'artifact_text',
          artifactId: page.artifact.artifactId,
          ...(page.artifact.displayName ? { displayName: page.artifact.displayName } : {}),
          offset: page.offset,
          ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
          totalCharacters: page.totalCharacters,
        },
      }
    } catch (error) {
      if (error instanceof PlatformToolServiceError) throw error
      throw new PlatformToolServiceError('artifact_invalid')
    }
  }
}
