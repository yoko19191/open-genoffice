import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'
import {
  buildSlidesNativeContext,
  executeSlidesNativeTool,
  type DeckAccess,
} from '../src/renderer/ai/slides-native-tools'

const artifactId = '11111111-1111-4111-8111-111111111111'
const artifactImage = {
  base64: 'iVBORw==',
  ext: 'png' as const,
  mediaType: 'image/png' as const,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
}

function slide(index: number): RenderSlide {
  return {
    widthPx: 1280,
    heightPx: 720,
    nodes: [
      {
        type: 'shape',
        sourceId: `shape-${index}`,
        box: { x: 10, y: 20, w: 100, h: 50, rotationDeg: 0 },
        fill: { kind: 'none' },
        text: { lines: [] },
      },
    ],
  } as unknown as RenderSlide
}

function harness(count = 1) {
  let slides = Array.from({ length: count }, (_, index) => slide(index))
  const applySlide = vi.fn((index: number, updated: RenderSlide) => {
    slides = slides.map((item, itemIndex) => (index === itemIndex ? updated : item))
  })
  const applyDeck = vi.fn((updated: RenderSlide[]) => (slides = updated))
  const access: DeckAccess = {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => ['shape-0'],
    applySlide,
    applyDeck,
    fitWidthPx: 1280,
  }
  return { access, applySlide, applyDeck }
}

describe('Slides Pi native tool lane', () => {
  beforeEach(() => {
    ;(window as unknown as { slidesApi: unknown }).slidesApi = {
      addImageBytes: vi.fn(async (input: { slideIndex: number }) => ({
        slide: slide(input.slideIndex),
        sourceId: `picture-${input.slideIndex}`,
      })),
      reorderElement: vi.fn(async (input: { slideIndex: number }) => slide(input.slideIndex)),
      editBackground: vi.fn(async () => [slide(0)]),
      commitSlidePage: vi.fn(async () => ({
        slides: [slide(0), slide(1)],
        index: 1,
        auditIssues: [],
      })),
    }
  })

  it('reads live deck context through the restricted native allowlist', async () => {
    const { access } = harness()
    expect(buildSlidesNativeContext(access)).toMatch(/shape-0/)
    await expect(
      executeSlidesNativeTool(
        access,
        { id: 'read', name: 'get_deck_context', input: {} },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ mutated: false, output: expect.stringMatching(/shape-0/) })
  })

  it('rejects the unregistered layout alias and an already-aborted call', async () => {
    const { access } = harness()
    await expect(
      executeSlidesNativeTool(
        access,
        { id: 'legacy', name: 'execute_layout_script', input: {} },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, mutated: false })
    const controller = new AbortController()
    controller.abort()
    await expect(
      executeSlidesNativeTool(
        access,
        { id: 'read', name: 'get_deck_context', input: {} },
        controller.signal,
      ),
    ).rejects.toThrow('Aborted')
  })

  it('inserts only a renderer-validated ArtifactRef payload', async () => {
    const { access, applySlide } = harness()
    const artifacts = new Map([[artifactId, artifactImage]])
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'image',
          name: 'insert_image',
          input: { slideIndex: 0, artifactId, x: 1, y: 2, w: 3, h: 4 },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ mutated: true })
    expect(window.slidesApi.addImageBytes).toHaveBeenCalledWith(
      expect.objectContaining({ base64: 'iVBORw==', ext: 'png', name: `artifact-${artifactId}` }),
    )
    expect(applySlide).toHaveBeenCalledOnce()

    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'missing',
          name: 'insert_image',
          input: { slideIndex: 0, artifactId: 'missing', x: 1, y: 2, w: 3, h: 4 },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, output: 'artifact_invalid' })
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'range',
          name: 'insert_image',
          input: { slideIndex: 9, artifactId, x: 1, y: 2, w: 3, h: 4 },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ isError: true })
  })

  it('creates an image background for one or all slides and sends it behind content', async () => {
    const { access, applySlide } = harness(2)
    const artifacts = new Map([[artifactId, artifactImage]])
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'background',
          name: 'set_slide_background',
          input: { slideIndex: -1, artifactId },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ mutated: true })
    expect(window.slidesApi.addImageBytes).toHaveBeenCalledTimes(2)
    expect(window.slidesApi.reorderElement).toHaveBeenCalledTimes(2)
    expect(applySlide).toHaveBeenCalledTimes(2)

    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'background-range',
          name: 'set_slide_background',
          input: { slideIndex: 9, artifactId },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ isError: true })
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'background-missing',
          name: 'set_slide_background',
          input: { slideIndex: 0, artifactId: 'missing' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, output: 'artifact_invalid' })
  })

  it('keeps the existing solid-background executor in the native lane', async () => {
    const { access, applyDeck } = harness()
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'solid',
          name: 'set_slide_background',
          input: { slideIndex: 0, color: '#112233' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ mutated: true })
    expect(window.slidesApi.editBackground).toHaveBeenCalledOnce()
    expect(applyDeck).toHaveBeenCalledOnce()
  })

  it('commits one audited SlidePageSpec with only its scoped ArtifactRefs', async () => {
    const { access, applyDeck } = harness()
    const spec = {
      version: 1 as const,
      title: '图文页',
      canvas: { widthPx: 1280 as const, heightPx: 720 as const },
      background: { color: '#FFFFFF' },
      elements: [
        {
          id: 'hero',
          kind: 'image' as const,
          artifactId,
          x: 0,
          y: 0,
          w: 320,
          h: 720,
        },
      ],
    }
    await expect(
      executeSlidesNativeTool(
        access,
        { id: 'page', name: 'commit_slide_page', input: { mode: 'append', spec } },
        new AbortController().signal,
        new Map([[artifactId, artifactImage]]),
      ),
    ).resolves.toMatchObject({ mutated: true, output: expect.stringMatching(/page 2/) })
    expect(window.slidesApi.commitSlidePage).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'append',
        fitWidthPx: 1280,
        images: [expect.objectContaining({ artifactId, width: 1, height: 1 })],
      }),
    )
    expect(applyDeck).toHaveBeenCalledWith(expect.any(Array), 1)

    await expect(
      executeSlidesNativeTool(
        access,
        { id: 'missing-page', name: 'commit_slide_page', input: { mode: 'append', spec } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, output: 'artifact_invalid' })
  })

  it('reports an atomic main-process page commit failure without applying a deck', async () => {
    const { access, applyDeck } = harness()
    vi.mocked(window.slidesApi.commitSlidePage).mockResolvedValueOnce({
      error: 'slide_page_audit_failed',
    })
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'page-failed',
          name: 'commit_slide_page',
          input: {
            mode: 'append',
            spec: {
              version: 1,
              title: '失败页',
              canvas: { widthPx: 1280, heightPx: 720 },
              background: { color: '#FFFFFF' },
              elements: [],
            },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ isError: true, output: 'slide_page_audit_failed' })
    expect(applyDeck).not.toHaveBeenCalled()
  })

  it('reports main-process image insertion and ordering failures', async () => {
    const { access } = harness()
    const artifacts = new Map([[artifactId, artifactImage]])
    vi.mocked(window.slidesApi.addImageBytes).mockResolvedValueOnce(null)
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'image-failed',
          name: 'insert_image',
          input: { slideIndex: 0, artifactId, x: 1, y: 2, w: 3, h: 4 },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ isError: true })

    vi.mocked(window.slidesApi.reorderElement).mockResolvedValueOnce(null)
    await expect(
      executeSlidesNativeTool(
        access,
        {
          id: 'background-failed',
          name: 'set_slide_background',
          input: { slideIndex: 0, artifactId },
        },
        new AbortController().signal,
        artifacts,
      ),
    ).resolves.toMatchObject({ isError: true })
  })
})
