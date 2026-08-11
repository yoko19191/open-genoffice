import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openPptx, savePptx, type TextElement } from '@genoffice/pptx-engine'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { createDeterministicFakeProvider } from '../../pi-agent-runtime/src/fake-provider'
import { executeSlidesNativeTool, type DeckAccess } from '../src/renderer/ai/slides-native-tools'
import { createSlidePageCommitter } from '../src/main/agent-tools/page-renderer'
import type { CommitSlidePageOp, EditParagraph, EditTextOp } from '../src/shared/ipc'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = new Uint8Array(
  readFileSync(
    join(
      here,
      '..',
      '..',
      '..',
      'packages',
      'pptx-engine',
      'tests',
      'fixtures',
      '01_standard_business.pptx',
    ),
  ),
)

describe('Pi fake Provider to real Slides editor', () => {
  it('commits a native text mutation and preserves it across save and reopen', async () => {
    const events = await createDeterministicFakeProvider().run('edit the first title')
    expect(events.some(({ type }) => type === 'tool.requested')).toBe(true)

    const opened = await openPptx(fixture)
    const slideIndex = opened.deck.slides.findIndex((slide) =>
      slide.elements.some(
        (element) =>
          (element.type === 'text' || element.type === 'shape') &&
          Boolean((element as TextElement).text?.paragraphs.length),
      ),
    )
    const engineSlide = opened.deck.slides[slideIndex]!
    const engineElement = engineSlide.elements.find(
      (element) =>
        (element.type === 'text' || element.type === 'shape') &&
        Boolean((element as TextElement).text?.paragraphs.length),
    ) as TextElement
    let slides = opened.deck.slides.map((slide) =>
      buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 1280 }),
    )

    ;(
      window as unknown as {
        slidesApi: {
          editText(op: EditTextOp): Promise<RenderSlide | null>
        }
      }
    ).slidesApi = {
      editText: async (op) => {
        if (op.slideIndex !== slideIndex || op.sourceId !== engineElement.id) return null
        engineElement.text!.paragraphs = op.paragraphs as unknown as NonNullable<
          TextElement['text']
        >['paragraphs']
        engineElement.dirty = true
        return buildRenderSlide(engineSlide, opened.deck.size, { fitWidthPx: 1280 })
      },
    }

    const access: DeckAccess = {
      getSlides: () => slides,
      getCurrent: () => slideIndex,
      getSelectedIds: () => [engineElement.id],
      applySlide: (index, updated) => {
        slides = slides.map((slide, candidate) => (candidate === index ? updated : slide))
      },
      applyDeck: (updated) => (slides = updated),
      fitWidthPx: 1280,
    }
    const paragraphs: EditParagraph[] = [{ runs: [{ text: 'Pi Native 保存重开验证', bold: true }] }]
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'fake-tool-1',
          name: 'set_element_text',
          input: {
            slideIndex,
            sourceId: engineElement.id,
            paragraphs: [{ text: 'Pi Native 保存重开验证', bold: true }],
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ mutated: true })
    expect(engineElement.text?.paragraphs).toEqual(paragraphs)

    const reopened = await openPptx(await savePptx(opened))
    const text = reopened.deck.slides
      .flatMap((slide) => slide.elements)
      .filter((element) => element.type === 'text' || element.type === 'shape')
      .flatMap((element) => (element as TextElement).text?.paragraphs ?? [])
      .flatMap((paragraph) => paragraph.runs)
      .map((run) => run.text)
      .join('')
    expect(text).toContain('Pi Native 保存重开验证')
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  it('commits a whole editable page through the local renderer and reopens it', async () => {
    const events = await createDeterministicFakeProvider().run('append one summary page')
    expect(events.some(({ type }) => type === 'tool.requested')).toBe(true)

    let opened = await openPptx(fixture)
    let slides = opened.deck.slides.map((slide) =>
      buildRenderSlide(slide, opened.deck.size, { fitWidthPx: 1280 }),
    )
    ;(
      window as unknown as {
        slidesApi: {
          commitSlidePage(op: CommitSlidePageOp): Promise<{
            slides: RenderSlide[]
            index: number
            auditIssues: string[]
          }>
        }
      }
    ).slidesApi = {
      commitSlidePage: async (op) => {
        const result = await createSlidePageCommitter().commit({
          opened,
          mode: op.mode,
          ...(op.index === undefined ? {} : { index: op.index }),
          spec: op.spec,
          artifacts: new Map(),
        })
        opened = result.opened
        slides = opened.deck.slides.map((slide) =>
          buildRenderSlide(slide, opened.deck.size, { fitWidthPx: op.fitWidthPx }),
        )
        return { slides, index: result.slideIndex, auditIssues: result.auditIssues }
      },
    }
    const access: DeckAccess = {
      getSlides: () => slides,
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => undefined,
      applyDeck: (updated) => (slides = updated),
      fitWidthPx: 1280,
    }
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'fake-page-1',
          name: 'commit_slide_page',
          input: {
            mode: 'append',
            spec: {
              version: 1,
              title: 'Pi PageSpec 结论',
              canvas: { widthPx: 1280, heightPx: 720 },
              background: { color: '#F7F5EF' },
              elements: [
                {
                  id: 'title',
                  kind: 'text',
                  x: 80,
                  y: 80,
                  w: 1120,
                  h: 100,
                  text: 'Pi PageSpec 结论',
                  fontSizePt: 32,
                  fontFamily: 'Noto Sans CJK SC',
                  color: '#102A43',
                },
              ],
            },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ mutated: true })

    const reopened = await openPptx(await savePptx(opened))
    const text = reopened.deck.slides
      .at(-1)!
      .elements.filter((element) => element.type === 'text' || element.type === 'shape')
      .flatMap((element) => (element as TextElement).text?.paragraphs ?? [])
      .flatMap((paragraph) => paragraph.runs.map((run) => run.text))
      .join('')
    expect(text).toContain('Pi PageSpec 结论')
    expect(events.at(-1)?.type).toBe('run.completed')
  })
})
