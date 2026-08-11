import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SLIDES_OFFICE_TOOL_CATALOG_BINDING,
  SLIDES_OFFICE_TOOL_DEFINITIONS,
  parseSlidesOfficeToolInput,
} from '../src/office-tool-catalog'
import { parseSlidePageSpec } from '../src/slide-page-spec-schema'

const imageId = '11111111-1111-4111-8111-111111111111'

const page = {
  version: 1,
  title: '季度复盘',
  canvas: { widthPx: 1280, heightPx: 720 },
  background: { color: '#F7F5EF' },
  elements: [
    {
      id: 'title',
      kind: 'text',
      x: 80,
      y: 60,
      w: 1120,
      h: 80,
      text: '季度复盘',
      fontSizePt: 30,
      fontFamily: 'Noto Sans CJK SC',
      color: '#102A43',
    },
  ],
} as const

describe('SlidePageSpec TypeBox boundary', () => {
  it('accepts one bounded editable page and publishes commit_slide_page after the 23 native tools', () => {
    expect(parseSlidePageSpec(page)).toEqual(page)
    expect(
      parseSlidesOfficeToolInput('office:slides:commit_slide_page', {
        mode: 'append',
        spec: page,
      }),
    ).toEqual({ mode: 'append', spec: page })
    expect(SLIDES_OFFICE_TOOL_DEFINITIONS).toHaveLength(24)
    expect(SLIDES_OFFICE_TOOL_DEFINITIONS.at(-1)).toMatchObject({
      id: 'office:slides:commit_slide_page',
      modelAlias: 'commit_slide_page',
      effect: 'mutation',
    })
    expect(SLIDES_OFFICE_TOOL_CATALOG_BINDING.catalogHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(SLIDES_OFFICE_TOOL_CATALOG_BINDING.descriptors))
        .digest('hex'),
    )
  })

  it('accepts ArtifactRef images, editable chart/table/SmartArt and an explicit overlap whitelist', () => {
    const rich = {
      ...page,
      background: { artifactId: imageId },
      elements: [
        {
          id: 'hero',
          kind: 'image',
          artifactId: imageId,
          x: 0,
          y: 0,
          w: 1280,
          h: 720,
          fit: 'cover',
          allowOverlapWith: ['caption'],
        },
        {
          id: 'caption',
          kind: 'shape',
          shape: 'roundRect',
          x: 80,
          y: 540,
          w: 540,
          h: 100,
          fill: '#102A43',
          text: '范围内叠放',
          fontSizePt: 22,
          color: '#FFFFFF',
          allowOverlapWith: ['hero'],
        },
        {
          id: 'chart',
          kind: 'chart',
          chartType: 'bar',
          x: 650,
          y: 80,
          w: 520,
          h: 220,
          categories: ['A', 'B'],
          series: [{ name: '收入', values: [10, 12] }],
          dataSource: 'document',
        },
        {
          id: 'table',
          kind: 'table',
          x: 650,
          y: 330,
          w: 520,
          h: 140,
          rows: [
            ['指标', '数值'],
            ['收入', '12'],
          ],
        },
        {
          id: 'process',
          kind: 'smartart',
          layout: 'process',
          x: 650,
          y: 500,
          w: 520,
          h: 120,
          items: ['输入', '分析', '结论'],
        },
      ],
    }
    expect(parseSlidePageSpec(rich)).toEqual(rich)
  })

  it.each([
    ['unknown version', { ...page, version: 2 }],
    ['wrong canvas', { ...page, canvas: { widthPx: 1920, heightPx: 1080 } }],
    [
      'unsupported font',
      { ...page, elements: [{ ...page.elements[0], fontFamily: 'PrivateFont' }] },
    ],
    ['out of bounds', { ...page, elements: [{ ...page.elements[0], x: 1200, w: 200 }] }],
    ['duplicate ids', { ...page, elements: [page.elements[0], page.elements[0]] }],
    [
      'self overlap',
      {
        ...page,
        elements: [{ ...page.elements[0], allowOverlapWith: ['title'] }],
      },
    ],
    [
      'unknown overlap target',
      {
        ...page,
        elements: [{ ...page.elements[0], allowOverlapWith: ['missing'] }],
      },
    ],
    [
      'ragged table',
      {
        ...page,
        elements: [
          { id: 't', kind: 'table', x: 1, y: 1, w: 100, h: 100, rows: [['a', 'b'], ['c']] },
        ],
      },
    ],
    [
      'chart cardinality mismatch',
      {
        ...page,
        elements: [
          {
            id: 'c',
            kind: 'chart',
            chartType: 'line',
            x: 1,
            y: 1,
            w: 100,
            h: 100,
            categories: ['a', 'b'],
            series: [{ name: 's', values: [1] }],
            dataSource: 'user',
          },
        ],
      },
    ],
    ['HTML field', { ...page, html: '<h1>unsafe</h1>' }],
    [
      'external URL',
      { ...page, elements: [{ ...page.elements[0], imageUrl: 'https://example.test/a.png' }] },
    ],
    ['local path', { ...page, elements: [{ ...page.elements[0], path: '/tmp/private.png' }] }],
  ])('rejects %s with a stable argument error', (_name, candidate) => {
    expect(() => parseSlidePageSpec(candidate)).toThrowError('invalid_tool_arguments')
  })

  it('requires an index only for insert/replace and rejects unknown page-generation aliases', () => {
    expect(() =>
      parseSlidesOfficeToolInput('office:slides:commit_slide_page', {
        mode: 'append',
        index: 1,
        spec: page,
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() =>
      parseSlidesOfficeToolInput('office:slides:commit_slide_page', {
        mode: 'replace',
        spec: page,
      }),
    ).toThrowError('invalid_tool_arguments')
    expect(() =>
      parseSlidesOfficeToolInput('office:slides:generate_deck', { spec: page }),
    ).toThrowError('tool_not_in_snapshot')
    expect(() =>
      parseSlidesOfficeToolInput('office:slides:regenerate_slide', { spec: page }),
    ).toThrowError('tool_not_in_snapshot')
  })
})
