import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export type PlatformToolDefinition = {
  id:
    | 'platform:web_search'
    | 'platform:image_search'
    | 'platform:artifact:read_text'
    | 'platform:analyze_media'
    | 'platform:ask_user_question'
  modelAlias:
    'web_search' | 'image_search' | 'read_attachment' | 'analyze_media' | 'ask_user_question'
  effect: 'read' | 'external' | 'interactive'
  label: string
  description: string
  parameters: TSchema
}

export const MEDIA_ANALYSIS_TOOL_DEFINITION = {
  id: 'platform:analyze_media',
  modelAlias: 'analyze_media',
  effect: 'external',
  label: 'analyze media',
  description:
    'Analyze one attached image, audio, or video ArtifactRef with the currently selected model only. Unsupported inputs stay disabled; writing the result requires a separate Office mutation tool.',
  parameters: Type.Object(
    {
      artifactId: Type.String({
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      }),
      requirements: Type.String({ minLength: 1, maxLength: 16_000 }),
    },
    { additionalProperties: false },
  ),
} as const satisfies PlatformToolDefinition

export const ASK_USER_QUESTION_TOOL_DEFINITION = {
  id: 'platform:ask_user_question',
  modelAlias: 'ask_user_question',
  effect: 'interactive',
  label: 'ask user question',
  description:
    'Pause the current run for one explicit user confirmation or short text answer. This tool does not authorize Office mutations.',
  parameters: Type.Union([
    Type.Object(
      {
        mode: Type.Literal('confirm'),
        question: Type.String({ minLength: 1, maxLength: 8_000 }),
        confirmLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        cancelLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal('input'),
        question: Type.String({ minLength: 1, maxLength: 8_000 }),
        placeholder: Type.Optional(Type.String({ maxLength: 256 })),
        maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 4_000 })),
      },
      { additionalProperties: false },
    ),
  ]),
} as const satisfies PlatformToolDefinition

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
  Type.Object(
    {
      toolId: Type.Literal('platform:ask_user_question'),
      kind: Type.Literal('user_action'),
      requestId: uuid(),
      mode: Type.Union([Type.Literal('confirm'), Type.Literal('input')]),
      state: Type.Literal('answered'),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      toolId: Type.Literal('platform:analyze_media'),
      kind: Type.Literal('media_analysis'),
      state: Type.Union([Type.Literal('completed'), Type.Literal('disabled')]),
      providerId: Type.String({ minLength: 1, maxLength: 128 }),
      modelId: Type.String({ minLength: 1, maxLength: 256 }),
      sourceArtifactId: uuid(),
      inputMode: Type.Optional(
        Type.Union([
          Type.Literal('image'),
          Type.Literal('frames'),
          Type.Literal('native-audio'),
          Type.Literal('native-video'),
        ]),
      ),
      operationId: Type.Optional(uuid()),
      usageRecorded: Type.Optional(Type.Boolean()),
      action: Type.Optional(Type.Literal('change_model')),
    },
    { additionalProperties: false },
  ),
])

export type PlatformToolDetails = Static<typeof PlatformToolDetailsSchema>

export function parsePlatformToolDetails(value: unknown): PlatformToolDetails {
  if (!Value.Check(PlatformToolDetailsSchema, value)) {
    throw new Error('invalid_platform_tool_details')
  }
  const details = value as PlatformToolDetails
  if (details.kind === 'media_analysis') {
    const validCompleted =
      details.state === 'completed' &&
      details.operationId !== undefined &&
      details.inputMode !== undefined &&
      details.usageRecorded !== undefined &&
      details.action === undefined
    const validDisabled =
      details.state === 'disabled' &&
      details.operationId !== undefined &&
      details.action === 'change_model' &&
      details.inputMode === undefined &&
      details.usageRecorded === undefined
    if (!validCompleted && !validDisabled) throw new Error('invalid_platform_tool_details')
  }
  return structuredClone(details)
}

export function resolvePlatformToolDefinition(
  canonicalToolId: string,
): PlatformToolDefinition | undefined {
  return [
    ...PLATFORM_TOOL_DEFINITIONS,
    MEDIA_ANALYSIS_TOOL_DEFINITION,
    ASK_USER_QUESTION_TOOL_DEFINITION,
  ].find(({ id }) => id === canonicalToolId)
}

export function parsePlatformToolInput(toolId: string, value: unknown): unknown {
  const definition = PLATFORM_TOOL_DEFINITIONS.find(({ id }) => id === toolId)
  if (!definition) throw new Error('tool_not_in_snapshot')
  if (Value.Check(definition.parameters, value)) return value
  throw new Error('invalid_tool_arguments')
}
