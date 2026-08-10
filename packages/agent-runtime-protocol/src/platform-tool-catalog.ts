import { Type, type Static, type TObject } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export type PlatformToolDefinition = {
  id: 'platform:web_search' | 'platform:image_search' | 'platform:artifact:read_text'
  modelAlias: 'web_search' | 'image_search' | 'read_attachment'
  effect: 'read' | 'external'
  label: string
  description: string
  parameters: TObject
}

const uuid = () =>
  Type.String({
    pattern:
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  })

const searchInput = (maximum: number) =>
  Type.Object(
    {
      query: Type.String({ minLength: 1, maxLength: 4_096 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum })),
    },
    { additionalProperties: false },
  )

export const PLATFORM_TOOL_DEFINITIONS: readonly PlatformToolDefinition[] = [
  {
    id: 'platform:web_search',
    modelAlias: 'web_search',
    effect: 'external',
    label: 'web search',
    description: 'Search the web for current facts and return source-attributed text results.',
    parameters: searchInput(10),
  },
  {
    id: 'platform:image_search',
    modelAlias: 'image_search',
    effect: 'external',
    label: 'image search',
    description:
      'Search for images and return scope-bound ArtifactRefs that can be passed to an Office image tool.',
    parameters: searchInput(8),
  },
  {
    id: 'platform:artifact:read_text',
    modelAlias: 'read_attachment',
    effect: 'read',
    label: 'read attachment',
    description: 'Read the next 24,000 characters from a scope-bound text attachment.',
    parameters: Type.Object(
      {
        artifactId: uuid(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
      },
      { additionalProperties: false },
    ),
  },
]

const provider = Type.Union([Type.Literal('serper'), Type.Literal('duckduckgo')])
const webResult = Type.Object(
  {
    title: Type.String({ maxLength: 2_000 }),
    url: Type.String({ pattern: '^https://', maxLength: 4_096 }),
    snippet: Type.String({ maxLength: 8_000 }),
  },
  { additionalProperties: false },
)
const imageResult = Type.Object(
  {
    artifactId: uuid(),
    mediaType: Type.Literal('image/png'),
    byteLength: Type.Integer({ minimum: 1, maximum: 20 * 1024 * 1024 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    title: Type.String({ minLength: 1, maxLength: 2_000 }),
    sourceUrl: Type.Union([
      Type.Literal(''),
      Type.String({ pattern: '^https://', maxLength: 4_096 }),
    ]),
    source: Type.String({ maxLength: 512 }),
    width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    height: Type.Integer({ minimum: 1, maximum: 16_384 }),
  },
  { additionalProperties: false },
)

export const PlatformToolDetailsSchema = Type.Union([
  Type.Object(
    {
      toolId: Type.Literal('platform:web_search'),
      kind: Type.Literal('web_search'),
      provider,
      results: Type.Array(webResult, { maxItems: 10 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      toolId: Type.Literal('platform:image_search'),
      kind: Type.Literal('image_search'),
      provider,
      images: Type.Array(imageResult, { maxItems: 8 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      toolId: Type.Literal('platform:artifact:read_text'),
      kind: Type.Literal('artifact_text'),
      artifactId: uuid(),
      displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
      offset: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }),
      nextOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000 })),
      totalCharacters: Type.Integer({ minimum: 0, maximum: 1_000_000_000 }),
    },
    { additionalProperties: false },
  ),
])

export type PlatformToolDetails = Static<typeof PlatformToolDetailsSchema>

export function parsePlatformToolDetails(value: unknown): PlatformToolDetails {
  if (!Value.Check(PlatformToolDetailsSchema, value)) {
    throw new Error('invalid_platform_tool_details')
  }
  return structuredClone(value) as PlatformToolDetails
}

export function resolvePlatformToolDefinition(
  canonicalToolId: string,
): PlatformToolDefinition | undefined {
  return PLATFORM_TOOL_DEFINITIONS.find(({ id }) => id === canonicalToolId)
}

export function parsePlatformToolInput(toolId: string, value: unknown): unknown {
  const definition = resolvePlatformToolDefinition(toolId)
  if (!definition) throw new Error('tool_not_in_snapshot')
  if (Value.Check(definition.parameters, value)) return value
  throw new Error('invalid_tool_arguments')
}
