import { describe, expect, it } from 'vitest'
import {
  PLATFORM_TOOL_DEFINITIONS,
  parsePlatformToolDetails,
  parsePlatformToolInput,
  resolvePlatformToolDefinition,
} from '../src/platform-tool-catalog'

describe('frozen platform tool catalog', () => {
  it('publishes the three unique cross-application aliases', () => {
    expect(PLATFORM_TOOL_DEFINITIONS).toMatchObject([
      { id: 'platform:web_search', modelAlias: 'web_search', effect: 'external' },
      { id: 'platform:image_search', modelAlias: 'image_search', effect: 'external' },
      { id: 'platform:artifact:read_text', modelAlias: 'read_attachment', effect: 'read' },
    ])
    expect(new Set(PLATFORM_TOOL_DEFINITIONS.map(({ modelAlias }) => modelAlias)).size).toBe(3)
  })

  it('accepts only bounded search and opaque artifact inputs', () => {
    expect(
      parsePlatformToolInput('platform:web_search', { query: 'Pi Agent', maxResults: 6 }),
    ).toEqual({ query: 'Pi Agent', maxResults: 6 })
    expect(
      parsePlatformToolInput('platform:image_search', { query: 'red panda', maxResults: 4 }),
    ).toEqual({ query: 'red panda', maxResults: 4 })
    expect(
      parsePlatformToolInput('platform:artifact:read_text', {
        artifactId: '11111111-1111-4111-8111-111111111111',
        offset: 24_000,
      }),
    ).toEqual({
      artifactId: '11111111-1111-4111-8111-111111111111',
      offset: 24_000,
    })
  })

  it.each([
    ['platform:web_search', { query: '' }],
    ['platform:web_search', { query: 'x', maxResults: 11 }],
    ['platform:image_search', { query: 'x', imageUrl: 'https://example.test/a.png' }],
    ['platform:artifact:read_text', { artifactId: 'bad' }],
    [
      'platform:artifact:read_text',
      {
        artifactId: '11111111-1111-4111-8111-111111111111',
        path: '/private/attachment.txt',
      },
    ],
  ])('rejects invalid %s arguments', (toolId, input) => {
    expect(() => parsePlatformToolInput(toolId, input)).toThrowError('invalid_tool_arguments')
  })

  it('fails closed for an unknown canonical ID', () => {
    expect(resolvePlatformToolDefinition('platform:unknown')).toBeUndefined()
    expect(() => parsePlatformToolInput('platform:unknown', {})).toThrowError(
      'tool_not_in_snapshot',
    )
  })

  it('projects only renderer-safe platform details', () => {
    expect(
      parsePlatformToolDetails({
        toolId: 'platform:image_search',
        kind: 'image_search',
        provider: 'serper',
        images: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            mediaType: 'image/png',
            byteLength: 68,
            sha256: 'a'.repeat(64),
            title: 'Safe image',
            sourceUrl: 'https://example.test/page',
            source: 'Example',
            width: 1,
            height: 1,
          },
        ],
      }),
    ).toMatchObject({ kind: 'image_search', images: [{ width: 1, height: 1 }] })
    expect(() =>
      parsePlatformToolDetails({
        toolId: 'platform:image_search',
        kind: 'image_search',
        provider: 'serper',
        images: [
          {
            artifactId: '11111111-1111-4111-8111-111111111111',
            mediaType: 'image/png',
            byteLength: 68,
            sha256: 'a'.repeat(64),
            title: 'Unsafe image',
            sourceUrl: 'https://example.test/page',
            source: 'Example',
            width: 1,
            height: 1,
            imageUrl: 'https://cdn.example.test/image.png',
          },
        ],
      }),
    ).toThrowError('invalid_platform_tool_details')
  })

  it('validates completed and disabled media analysis projections as distinct states', () => {
    const shared = {
      toolId: 'platform:analyze_media',
      kind: 'media_analysis',
      operationId: '11111111-1111-4111-8111-111111111111',
      providerId: 'selected-provider',
      modelId: 'selected-model',
      sourceArtifactId: '22222222-2222-4222-8222-222222222222',
    }
    expect(
      parsePlatformToolDetails({
        ...shared,
        state: 'completed',
        inputMode: 'frames',
        usageRecorded: true,
      }),
    ).toMatchObject({ state: 'completed', inputMode: 'frames' })
    expect(
      parsePlatformToolDetails({ ...shared, state: 'disabled', action: 'change_model' }),
    ).toMatchObject({ state: 'disabled', action: 'change_model' })
    for (const invalid of [
      { ...shared, state: 'completed', action: 'change_model' },
      { ...shared, state: 'disabled', inputMode: 'frames', action: 'change_model' },
      { ...shared, state: 'disabled' },
    ]) {
      expect(() => parsePlatformToolDetails(invalid)).toThrowError('invalid_platform_tool_details')
    }
    expect(resolvePlatformToolDefinition('platform:analyze_media')).toMatchObject({
      modelAlias: 'analyze_media',
      effect: 'external',
    })
  })
})
