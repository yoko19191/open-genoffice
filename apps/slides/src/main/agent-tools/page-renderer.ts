import { createHash } from 'node:crypto'
import {
  parseSlidePageSpec,
  type SlidePageElement,
  type SlidePageSpec,
} from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import {
  addChart,
  addElement,
  addPicture,
  addSmartArt,
  addTable,
  deleteSlide,
  editPictureSrcRect,
  editTableCellText,
  insertBlankSlide,
  moveSlide,
  openPptx,
  savePptx,
  setSlideBackground,
  type OpenedPptx,
  type NewChartKind,
  type Paragraph,
  type SlideElement,
  type SmartArtLayout,
} from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { PNG } from 'pngjs'
import PptxGenJS from 'pptxgenjs'
import { auditSlideLayout } from '../../renderer/ai/layout-audit'

const EMU_PER_PX = 9_525
const EMU_PER_PT = 12_700
const PAGE_WIDTH = 1_280
const PAGE_HEIGHT = 720

export interface SlidePageArtifact {
  artifactId: string
  bytes: Uint8Array
  mediaType: 'image/png'
  width: number
  height: number
  sha256: string
}

export interface SlidePageCommitRequest {
  opened: OpenedPptx
  mode: 'append' | 'insert' | 'replace'
  index?: number
  spec: SlidePageSpec
  artifacts: ReadonlyMap<string, SlidePageArtifact>
}

export interface SlidePageCommitResult {
  opened: OpenedPptx
  slideIndex: number
  auditIssues: string[]
}

export interface SlidePageCommitDependencies {
  renderCandidate(
    spec: SlidePageSpec,
    artifacts: ReadonlyMap<string, SlidePageArtifact>,
  ): Promise<Uint8Array>
  open(bytes: Uint8Array): Promise<OpenedPptx>
  save(opened: OpenedPptx): Promise<Uint8Array>
  renderInto(
    opened: OpenedPptx,
    slideIndex: number,
    spec: SlidePageSpec,
    artifacts: ReadonlyMap<string, SlidePageArtifact>,
  ): Promise<void>
  audit(
    opened: OpenedPptx,
    slideIndex: number,
    spec: SlidePageSpec,
    artifacts: ReadonlyMap<string, SlidePageArtifact>,
  ): Promise<string[]>
}

function px(value: number): number {
  return Math.round(value * EMU_PER_PX)
}

function offset(element: Pick<SlidePageElement, 'x' | 'y' | 'w' | 'h'>) {
  return { x: px(element.x), y: px(element.y), cx: px(element.w), cy: px(element.h) }
}

function paragraph(element: {
  text?: string
  fontSizePt?: number
  fontFamily?: string
  color?: string
  bold?: boolean
  italic?: boolean
  align?: 'left' | 'center' | 'right' | 'justify'
}): Paragraph[] {
  return [
    {
      runs: [
        {
          text: element.text ?? '',
          fontSize: element.fontSizePt ?? 18,
          ...(element.fontFamily ? { fontFamily: element.fontFamily } : {}),
          ...(element.color ? { color: element.color } : {}),
          ...(element.bold === undefined ? {} : { bold: element.bold }),
          ...(element.italic === undefined ? {} : { italic: element.italic }),
        },
      ],
      ...(element.align ? { align: element.align } : {}),
    },
  ]
}

function requiredArtifactIds(spec: SlidePageSpec): string[] {
  const ids = new Set<string>()
  if ('artifactId' in spec.background) ids.add(spec.background.artifactId)
  for (const element of spec.elements) {
    if (element.kind === 'image') ids.add(element.artifactId)
  }
  return [...ids]
}

function validateArtifact(artifact: SlidePageArtifact | undefined): SlidePageArtifact {
  if (!artifact || artifact.mediaType !== 'image/png' || artifact.bytes.byteLength === 0) {
    throw new Error('artifact_invalid')
  }
  const hash = createHash('sha256').update(artifact.bytes).digest('hex')
  let png: { width: number; height: number }
  try {
    png = PNG.sync.read(Buffer.from(artifact.bytes))
  } catch {
    throw new Error('artifact_invalid')
  }
  if (
    hash !== artifact.sha256 ||
    png.width !== artifact.width ||
    png.height !== artifact.height ||
    png.width < 1 ||
    png.height < 1 ||
    png.width > 16_384 ||
    png.height > 16_384
  ) {
    throw new Error('artifact_invalid')
  }
  return artifact
}

function imagePlacement(
  element: Extract<SlidePageElement, { kind: 'image' }>,
  artifact: SlidePageArtifact,
): { placement: ReturnType<typeof offset>; crop?: { l: number; t: number; r: number; b: number } } {
  if (element.fit === 'contain') {
    const scale = Math.min(element.w / artifact.width, element.h / artifact.height)
    const w = artifact.width * scale
    const h = artifact.height * scale
    return {
      placement: {
        x: px(element.x + (element.w - w) / 2),
        y: px(element.y + (element.h - h) / 2),
        cx: px(w),
        cy: px(h),
      },
    }
  }
  if (element.fit === 'cover') {
    const sourceRatio = artifact.width / artifact.height
    const boxRatio = element.w / element.h
    if (sourceRatio > boxRatio) {
      const kept = boxRatio / sourceRatio
      const crop = (1 - kept) / 2
      return { placement: offset(element), crop: { l: crop, t: 0, r: crop, b: 0 } }
    }
    const kept = sourceRatio / boxRatio
    const crop = (1 - kept) / 2
    return { placement: offset(element), crop: { l: 0, t: crop, r: 0, b: crop } }
  }
  return { placement: offset(element) }
}

async function blankPage(): Promise<OpenedPptx> {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'GENOFFICE_PAGE_SPEC', width: 13.333333, height: 7.5 })
  pptx.layout = 'GENOFFICE_PAGE_SPEC'
  pptx.addSlide()
  return openPptx((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
}

async function renderInto(
  opened: OpenedPptx,
  slideIndex: number,
  spec: SlidePageSpec,
  artifacts: ReadonlyMap<string, SlidePageArtifact>,
): Promise<void> {
  for (const artifactId of requiredArtifactIds(spec)) validateArtifact(artifacts.get(artifactId))
  const slide = opened.deck.slides[slideIndex]
  if (!slide) throw new Error('slide_page_render_failed')

  if ('color' in spec.background) {
    setSlideBackground(slide, spec.background.color)
  } else {
    const artifact = validateArtifact(artifacts.get(spec.background.artifactId))
    if (
      !addPicture(opened, slide, {
        bytes: artifact.bytes,
        ext: 'png',
        offset: { x: 0, y: 0, cx: px(PAGE_WIDTH), cy: px(PAGE_HEIGHT) },
        name: `page-background-${spec.background.artifactId}`,
        descr: spec.title,
      })
    ) {
      throw new Error('slide_page_render_failed')
    }
  }

  for (const element of spec.elements) {
    if (element.kind === 'text' || element.kind === 'shape') {
      addElement(slide, {
        kind: element.kind === 'text' ? 'textbox' : element.shape,
        offset: offset(element),
        paragraphs: paragraph({
          ...element,
          align: element.align as 'left' | 'center' | 'right' | 'justify' | undefined,
        }),
        ...(element.kind === 'shape' && element.fill ? { fillColor: element.fill } : {}),
        ...(element.kind === 'shape' && element.stroke
          ? {
              stroke: {
                color: element.stroke,
                widthEmu: Math.round((element.strokeWidthPt ?? 1) * EMU_PER_PT),
              },
            }
          : {}),
      })
      continue
    }
    if (element.kind === 'image') {
      const artifact = validateArtifact(artifacts.get(element.artifactId))
      const placed = imagePlacement(element, artifact)
      const picture = addPicture(opened, slide, {
        bytes: artifact.bytes,
        ext: 'png',
        offset: placed.placement,
        name: `page-image-${element.id}`,
        descr: element.altText ?? element.id,
      })
      if (!picture) throw new Error('slide_page_render_failed')
      if (placed.crop) editPictureSrcRect(slide, picture.id, placed.crop)
      continue
    }
    if (element.kind === 'chart') {
      if (
        !addChart(opened, slideIndex, {
          kind: element.chartType as NewChartKind,
          title: element.title,
          categories: [...element.categories],
          series: element.series.map((series) => ({
            name: series.name,
            values: [...series.values],
          })),
          offset: offset(element),
        })
      ) {
        throw new Error('slide_page_render_failed')
      }
      continue
    }
    if (element.kind === 'table') {
      const table = addTable(opened, slideIndex, {
        rows: element.rows.length,
        cols: element.rows[0]!.length,
        offset: offset(element),
      })
      if (!table) throw new Error('slide_page_render_failed')
      for (const [rowIndex, row] of element.rows.entries()) {
        for (const [columnIndex, text] of row.entries()) {
          if (
            !editTableCellText(
              table.slide,
              table.elementId,
              rowIndex,
              columnIndex,
              paragraph({ text }),
            )
          ) {
            throw new Error('slide_page_render_failed')
          }
        }
      }
      continue
    }
    if (
      !addSmartArt(opened, slideIndex, {
        layout: element.layout as SmartArtLayout,
        items: [...element.items],
        offset: offset(element),
      })
    ) {
      throw new Error('slide_page_render_failed')
    }
  }
}

async function renderCandidate(
  spec: SlidePageSpec,
  artifacts: ReadonlyMap<string, SlidePageArtifact>,
): Promise<Uint8Array> {
  const opened = await blankPage()
  await renderInto(opened, 0, spec, artifacts)
  return savePptx(opened)
}

function collectText(elements: readonly SlideElement[]): string {
  const text: string[] = []
  const visit = (element: SlideElement) => {
    if (element.type === 'text' || element.type === 'shape') {
      text.push(
        ...(element.text?.paragraphs.flatMap((item) => item.runs.map((run) => run.text)) ?? []),
      )
    } else if (element.type === 'table') {
      for (const row of element.rows) {
        for (const cell of row) {
          text.push(
            ...(cell.text?.paragraphs.flatMap((item) => item.runs.map((run) => run.text)) ?? []),
          )
        }
      }
    } else if (element.type === 'group') {
      for (const child of element.children) visit(child)
    }
  }
  for (const element of elements) visit(element)
  return text.join('\n')
}

function expectedText(spec: SlidePageSpec): string[] {
  return spec.elements.flatMap((element) => {
    if (element.kind === 'text') return [element.text]
    if (element.kind === 'shape' && element.text) return [element.text]
    if (element.kind === 'table') return element.rows.flat()
    if (element.kind === 'smartart') return [...element.items]
    return []
  })
}

async function auditPage(
  opened: OpenedPptx,
  slideIndex: number,
  spec: SlidePageSpec,
  artifacts: ReadonlyMap<string, SlidePageArtifact>,
): Promise<string[]> {
  const slide = opened.deck.slides[slideIndex]
  if (!slide) throw new Error('slide_page_audit_failed')
  const backgroundOffset = 'artifactId' in spec.background ? 1 : 0
  if (slide.elements.length < spec.elements.length + backgroundOffset) {
    throw new Error('slide_page_audit_failed')
  }
  const idMap = new Map(
    spec.elements.map((element, index) => [
      element.id,
      slide.elements[index + backgroundOffset]!.id,
    ]),
  )
  const allowedOverlaps = new Set<string>()
  for (const element of spec.elements) {
    for (const other of element.allowOverlapWith ?? []) {
      allowedOverlaps.add([idMap.get(element.id)!, idMap.get(other)!].sort().join(':'))
    }
  }
  const render = buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx: PAGE_WIDTH,
    slideNo: slideIndex + 1,
  })
  const issues = auditSlideLayout(render, { allowedOverlaps, includeAllElements: true })
  const text = collectText(slide.elements)
  if (expectedText(spec).some((expected) => !text.includes(expected))) {
    issues.push('Editable text audit failed')
  }

  const expectedImages = [
    ...('artifactId' in spec.background ? [spec.background.artifactId] : []),
    ...spec.elements.flatMap((element) => (element.kind === 'image' ? [element.artifactId] : [])),
  ]
  const pictures = slide.elements.filter((element) => element.type === 'picture')
  if (pictures.length !== expectedImages.length) issues.push('Image relationship audit failed')
  for (const [index, artifactId] of expectedImages.entries()) {
    const picture = pictures[index]
    const bytes =
      picture?.type === 'picture' ? opened.archive.readBytes(picture.mediaRef) : undefined
    const artifact = artifacts.get(artifactId)
    if (
      !bytes ||
      !artifact ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      issues.push('Image completeness audit failed')
    }
  }
  const imageRelationships = [...opened.archive.readRels(slide.path).values()].filter(
    (relationship) => relationship.type.endsWith('/image'),
  )
  if (imageRelationships.length < expectedImages.length)
    issues.push('Image relationship audit failed')
  return [...new Set(issues)]
}

export const DEFAULT_SLIDE_PAGE_COMMIT_DEPENDENCIES: SlidePageCommitDependencies = {
  renderCandidate,
  renderInto,
  open: openPptx,
  save: savePptx,
  audit: auditPage,
}

function assertIndex(request: SlidePageCommitRequest): number {
  const count = request.opened.deck.slides.length
  if (request.mode === 'append') {
    if (request.index !== undefined) throw new Error('invalid_tool_arguments')
    return count
  }
  if (
    request.index === undefined ||
    !Number.isInteger(request.index) ||
    request.index < 0 ||
    request.index > (request.mode === 'insert' ? count : count - 1)
  ) {
    throw new Error('invalid_tool_arguments')
  }
  return request.index
}

export class SlidePageCommitter {
  constructor(
    readonly dependencies: SlidePageCommitDependencies = DEFAULT_SLIDE_PAGE_COMMIT_DEPENDENCIES,
  ) {}

  async commit(request: SlidePageCommitRequest): Promise<SlidePageCommitResult> {
    const spec = parseSlidePageSpec(request.spec)
    const slideIndex = assertIndex(request)
    const candidateBytes = await this.dependencies.renderCandidate(spec, request.artifacts)
    const candidate = await this.dependencies.open(candidateBytes)
    const candidateIssues = await this.dependencies.audit(candidate, 0, spec, request.artifacts)
    if (candidateIssues.length > 0) throw new Error('slide_page_audit_failed')

    const sourceBytes = await this.dependencies.save(request.opened)
    const next = await this.dependencies.open(sourceBytes)
    if (!insertBlankSlide(next, next.deck.slides.length - 1))
      throw new Error('slide_page_merge_failed')
    const appendedIndex = next.deck.slides.length - 1
    await this.dependencies.renderInto(next, appendedIndex, spec, request.artifacts)
    if (request.mode !== 'append' && appendedIndex !== slideIndex) {
      if (!moveSlide(next, appendedIndex, slideIndex)) throw new Error('slide_page_merge_failed')
    }
    if (request.mode === 'replace' && !deleteSlide(next, slideIndex + 1)) {
      throw new Error('slide_page_merge_failed')
    }

    const finalBytes = await this.dependencies.save(next)
    const reopened = await this.dependencies.open(finalBytes)
    const finalIssues = await this.dependencies.audit(reopened, slideIndex, spec, request.artifacts)
    if (finalIssues.length > 0) throw new Error('slide_page_audit_failed')
    return { opened: reopened, slideIndex, auditIssues: finalIssues }
  }
}

export function createSlidePageCommitter(
  dependencies: SlidePageCommitDependencies = DEFAULT_SLIDE_PAGE_COMMIT_DEPENDENCIES,
): SlidePageCommitter {
  return new SlidePageCommitter(dependencies)
}
