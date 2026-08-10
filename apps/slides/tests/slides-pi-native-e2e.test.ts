import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openPptx, savePptx, type TextElement } from '@genoffice/pptx-engine'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { createDeterministicFakeProvider } from '../../pi-agent-runtime/src/fake-provider'
import { executeSlidesNativeTool, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { EditParagraph, EditTextOp } from '../src/shared/ipc'

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
})
