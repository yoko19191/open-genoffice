import { CodexOAuthImageProvider } from '../src/codex-oauth-image-provider'
import { ModelMediaProvider } from '../src/model-media-provider'
import { PlatformToolService } from '../src/platform-tool-service'
import { createMineruClient } from '@genoffice/electron-utils/mineru-client'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const ids = {
  operationId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  artifactId: '44444444-4444-4444-8444-444444444444',
}

type Route = {
  surface: 'ocr' | 'search' | 'image' | 'media' | 'slide' | 'project'
  mode: 'fetch-intercepted' | 'local-only'
  hosts: string[]
}

const hosts = new Map<Route['surface'], Set<string>>()
function record(surface: Route['surface'], input: string): void {
  const hostname = new URL(input).hostname.toLowerCase()
  const values = hosts.get(surface) ?? new Set<string>()
  values.add(hostname)
  hosts.set(surface, values)
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const platformService = new PlatformToolService({
  artifactStore: {
    readText: async () => ({ text: '', totalCharacters: 0 }),
    registerImage: async () => {
      throw new Error('network_smoke_unexpected_image_download')
    },
  },
  credentials: {
    read: async () => ({ type: 'api_key', key: 'network-smoke-key' }),
  },
  fetch: async (input) => {
    const url = String(input)
    const surface = new URL(url).pathname.endsWith('/images') ? 'image' : 'search'
    record(surface, url)
    return surface === 'image' ? json({ images: [] }) : json({ organic: [] })
  },
})
const signal = new AbortController().signal
await platformService.execute(
  'platform:web_search',
  { query: 'network smoke', maxResults: 1 },
  { documentId: ids.documentId, runId: ids.runId },
  signal,
)
await platformService.execute(
  'platform:image_search',
  { query: 'network smoke', maxResults: 1 },
  { documentId: ids.documentId, runId: ids.runId },
  signal,
)

const imageProvider = new CodexOAuthImageProvider({
  rootDirectory: process.cwd(),
  modelRuntime: {
    isUsingOAuth: () => true,
    getAuth: async () => ({
      auth: {
        headers: {
          Authorization: 'Bearer network-smoke-token',
          'chatgpt-account-id': 'network-smoke-account',
        },
      },
      source: 'OAuth',
    }),
  },
  artifactStore: {
    registerImage: async (input) => ({
      artifactId: input.artifactId,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      sha256: '0'.repeat(64),
      displayName: input.displayName,
    }),
  },
  fetch: async (input) => {
    record('image', input)
    const event = {
      type: 'response.completed',
      response: { output: [{ type: 'image_generation_call', result: PNG_BASE64 }] },
    }
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  },
  createId: () => ids.artifactId,
})
await imageProvider.generate({ ...ids, prompt: 'network smoke' })

const mineru = createMineruClient({
  token: 'network-smoke-token',
  fetch: async (input) => {
    record('ocr', String(input))
    return json({
      code: 0,
      data: { batch_id: 'network-smoke-batch', file_urls: ['https://upload.invalid/input'] },
    })
  },
})
await mineru.requestLocalUpload('network-smoke.pdf')

let mediaGeneration = 0
const mediaProvider = new ModelMediaProvider({
  operationStore: {
    commit: async (value) => {
      mediaGeneration = value.generation
      return value
    },
  },
  prepare: async (input) => ({
    operationId: input.operationId,
    inputKind: 'image',
    strategy: 'image',
    artifacts: [ids],
  }),
  client: {
    supportsNative: () => false,
    analyzeImages: async () => ({ text: 'network smoke', usageRecorded: true }),
    analyzeNative: async () => {
      throw new Error('network_smoke_unexpected_native_media')
    },
  },
})
await mediaProvider.analyze(
  {
    ...ids,
    requirements: 'network smoke',
    artifact: {
      artifactId: ids.artifactId,
      mediaType: 'image/png',
      byteLength: 1,
      sha256: '0'.repeat(64),
    },
    model: { providerId: 'fake', modelId: 'fake', capabilities: ['image-input'] },
  },
  signal,
)
if (mediaGeneration !== 4) throw new Error('network_smoke_media_incomplete')

const routes: Route[] = [
  ...(['ocr', 'search', 'image'] as const).map((surface) => ({
    surface,
    mode: 'fetch-intercepted' as const,
    hosts: [...(hosts.get(surface) ?? [])].sort(),
  })),
  { surface: 'media', mode: 'local-only', hosts: [] },
  { surface: 'slide', mode: 'local-only', hosts: [] },
  { surface: 'project', mode: 'local-only', hosts: [] },
]
if (routes.some((route) => route.mode === 'fetch-intercepted' && route.hosts.length === 0)) {
  throw new Error('network_smoke_route_missing')
}
process.stdout.write(`${JSON.stringify({ status: 'passed', routes })}\n`)
