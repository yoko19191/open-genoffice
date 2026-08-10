import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import PptxGenJS from 'pptxgenjs'
import { PNG } from 'pngjs'
import { openPptx, savePptx, type OpenedPptx } from '@genoffice/pptx-engine'
import {
  parseSlidePageSpec,
  type SlidePageSpec,
} from '@genoffice/agent-runtime-protocol/office-tool-catalog'
import {
  createSlidePageCommitter,
  type SlidePageArtifact,
  type SlidePageCommitDependencies,
} from '../src/main/agent-tools/page-renderer'

const imageId = '11111111-1111-4111-8111-111111111111'
const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'page-spec')
const png = new PNG({ width: 1, height: 1 })
png.data = Buffer.from([255, 0, 0, 255])
const redPng = PNG.sync.write(png)

async function onePage(text: string): Promise<OpenedPptx> {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W', width: 13.333333, height: 7.5 })
  pptx.layout = 'W'
  pptx.addSlide().addText(text, { x: 1, y: 1, w: 8, h: 1, fontSize: 28 })
  return openPptx((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
}

function archiveHash(opened: OpenedPptx): string {
  const hash = createHash('sha256')
  for (const [name, bytes] of [...opened.archive.entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name)
    hash.update(bytes)
  }
  hash.update(JSON.stringify(opened.deck.slides))
  return hash.digest('hex')
}

function textSpec(title = '增长复盘'): SlidePageSpec {
  return {
    version: 1,
    title,
    canvas: { widthPx: 1280, heightPx: 720 },
    background: { color: '#F7F5EF' },
    elements: [
      {
        id: 'title',
        kind: 'text',
        x: 80,
        y: 60,
        w: 1120,
        h: 100,
        text: title,
        fontSizePt: 32,
        fontFamily: 'Noto Sans CJK SC',
        color: '#102A43',
      },
      {
        id: 'body',
        kind: 'shape',
        shape: 'roundRect',
        x: 80,
        y: 220,
        w: 520,
        h: 180,
        fill: '#D9EAF7',
        text: '正文仍是可编辑文字',
        fontSizePt: 20,
        color: '#102A43',
      },
    ],
  }
}

function artifact(): SlidePageArtifact {
  return {
    artifactId: imageId,
    bytes: redPng,
    mediaType: 'image/png',
    width: 1,
    height: 1,
    sha256: createHash('sha256').update(redPng).digest('hex'),
  }
}

function editableText(elements: OpenedPptx['deck']['slides'][number]['elements']): string {
  const text: string[] = []
  const visit = (element: (typeof elements)[number]) => {
    if (element.type === 'text' || element.type === 'shape') {
      text.push(
        ...(element.text?.paragraphs.flatMap((paragraph) =>
          paragraph.runs.map((run) => run.text),
        ) ?? []),
      )
    } else if (element.type === 'table') {
      for (const row of element.rows) {
        for (const cell of row) {
          text.push(
            ...(cell.text?.paragraphs.flatMap((paragraph) =>
              paragraph.runs.map((run) => run.text),
            ) ?? []),
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

describe('local SlidePageSpec renderer', () => {
  it('renders every accepted fixture to its reopened editable golden structure', async () => {
    const golden = JSON.parse(
      await readFile(join(fixtureRoot, 'golden', 'structure.json'), 'utf8'),
    ) as Record<
      string,
      { pictures: number; charts: number; tables: number; groups: number; text: string[] }
    >
    const names = (await readdir(join(fixtureRoot, 'accepted'))).sort()
    expect(names).toEqual(Object.keys(golden).sort())
    for (const name of names) {
      const spec = parseSlidePageSpec(
        JSON.parse(await readFile(join(fixtureRoot, 'accepted', name), 'utf8')),
      )
      const result = await createSlidePageCommitter().commit({
        opened: await onePage('ORIGINAL'),
        mode: 'append',
        spec,
        artifacts: new Map([[imageId, artifact()]]),
      })
      const elements = result.opened.deck.slides[result.slideIndex]!.elements
      const expected = golden[name]!
      expect(elements.filter(({ type }) => type === 'picture')).toHaveLength(expected.pictures)
      expect(elements.filter(({ type }) => type === 'chart')).toHaveLength(expected.charts)
      expect(elements.filter(({ type }) => type === 'table')).toHaveLength(expected.tables)
      expect(elements.filter(({ type }) => type === 'group')).toHaveLength(expected.groups)
      const text = editableText(elements)
      for (const fragment of expected.text) expect(text).toContain(fragment)
      expect(result.auditIssues).toEqual([])
    }
  })

  it('rejects every isolated invalid fixture at the TypeBox boundary', async () => {
    const names = (await readdir(join(fixtureRoot, 'rejected'))).sort()
    expect(names.length).toBeGreaterThanOrEqual(7)
    for (const name of names) {
      const candidate = JSON.parse(await readFile(join(fixtureRoot, 'rejected', name), 'utf8'))
      expect(() => parseSlidePageSpec(candidate), name).toThrow('invalid_tool_arguments')
    }
  })

  it('appends, inserts and replaces one editable page only after save/reopen/audit', async () => {
    const committer = createSlidePageCommitter()

    const appended = await committer.commit({
      opened: await onePage('ORIGINAL'),
      mode: 'append',
      spec: textSpec('追加页'),
      artifacts: new Map(),
    })
    expect(appended.slideIndex).toBe(1)
    expect(appended.opened.deck.slides).toHaveLength(2)

    const inserted = await committer.commit({
      opened: appended.opened,
      mode: 'insert',
      index: 0,
      spec: textSpec('插入页'),
      artifacts: new Map(),
    })
    expect(inserted.slideIndex).toBe(0)
    expect(inserted.opened.deck.slides).toHaveLength(3)

    const replaced = await committer.commit({
      opened: inserted.opened,
      mode: 'replace',
      index: 1,
      spec: textSpec('替换页'),
      artifacts: new Map(),
    })
    expect(replaced.slideIndex).toBe(1)
    expect(replaced.opened.deck.slides).toHaveLength(3)
    const final = await openPptx(await savePptx(replaced.opened))
    const text = final.deck.slides[1]!.elements.flatMap((element) =>
      element.type === 'text' || element.type === 'shape'
        ? (element.text?.paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.text)) ??
          [])
        : [],
    ).join(' ')
    expect(text).toContain('替换页')
    expect(text).toContain('正文仍是可编辑文字')
  })

  it('renders a full-bleed ArtifactRef plus editable chart, table and SmartArt', async () => {
    const spec: SlidePageSpec = {
      version: 1,
      title: '图文页',
      canvas: { widthPx: 1280, heightPx: 720 },
      background: { color: '#FFFFFF' },
      elements: [
        {
          id: 'hero',
          kind: 'image',
          artifactId: imageId,
          x: 0,
          y: 0,
          w: 320,
          h: 720,
          fit: 'cover',
        },
        {
          id: 'chart',
          kind: 'chart',
          chartType: 'bar',
          x: 360,
          y: 40,
          w: 390,
          h: 250,
          categories: ['A', 'B'],
          series: [{ name: '收入', values: [10, 12] }],
          dataSource: 'document',
        },
        {
          id: 'table',
          kind: 'table',
          x: 790,
          y: 40,
          w: 410,
          h: 250,
          rows: [
            ['指标', '数值'],
            ['收入', '12'],
          ],
        },
        {
          id: 'flow',
          kind: 'smartart',
          layout: 'process',
          x: 360,
          y: 380,
          w: 840,
          h: 180,
          items: ['输入', '分析', '结论'],
        },
      ],
    }
    const result = await createSlidePageCommitter().commit({
      opened: await onePage('ORIGINAL'),
      mode: 'append',
      spec,
      artifacts: new Map([[imageId, artifact()]]),
    })
    const slide = result.opened.deck.slides[1]!
    expect(slide.elements.some(({ type }) => type === 'picture')).toBe(true)
    expect(slide.elements.some(({ type }) => type === 'chart')).toBe(true)
    expect(slide.elements.some(({ type }) => type === 'table')).toBe(true)
    expect(slide.elements.some(({ type }) => type === 'group')).toBe(true)
    expect(result.auditIssues).toEqual([])
  })

  it('renders contain, vertical-cover and stretch image geometry from verified bytes', async () => {
    const spec: SlidePageSpec = {
      ...textSpec('图片适配'),
      elements: [
        {
          id: 'contain',
          kind: 'image',
          artifactId: imageId,
          x: 20,
          y: 20,
          w: 240,
          h: 100,
          fit: 'contain',
        },
        {
          id: 'cover',
          kind: 'image',
          artifactId: imageId,
          x: 360,
          y: 20,
          w: 240,
          h: 100,
          fit: 'cover',
        },
        {
          id: 'stretch',
          kind: 'image',
          artifactId: imageId,
          x: 700,
          y: 20,
          w: 240,
          h: 100,
          fit: 'stretch',
        },
      ],
    }
    const result = await createSlidePageCommitter().commit({
      opened: await onePage('ORIGINAL'),
      mode: 'append',
      spec,
      artifacts: new Map([[imageId, artifact()]]),
    })
    const pictures = result.opened.deck.slides[result.slideIndex]!.elements.filter(
      (element) => element.type === 'picture',
    )
    expect(pictures).toHaveLength(3)
    expect(pictures[0]!.transform.offset.cx).toBe(pictures[0]!.transform.offset.cy)
    expect(pictures[1]!.type === 'picture' ? pictures[1]!.srcRect?.t : undefined).toBeGreaterThan(0)
    expect(pictures[2]!.transform.offset.cx).toBeGreaterThan(pictures[2]!.transform.offset.cy)
  })

  it('preserves explicit text style and shape stroke defaults as editable properties', async () => {
    const spec = textSpec('样式页')
    const title = spec.elements[0]
    if (!title || title.kind !== 'text') throw new Error('fixture_missing_title')
    spec.elements[0] = {
      ...title,
      bold: true,
      italic: false,
      align: 'center',
    }
    spec.elements.push(
      {
        id: 'outline',
        kind: 'shape',
        shape: 'rect',
        x: 700,
        y: 220,
        w: 480,
        h: 180,
        stroke: '#102A43',
      },
      {
        id: 'outline-wide',
        kind: 'shape',
        shape: 'rect',
        x: 700,
        y: 460,
        w: 480,
        h: 120,
        stroke: '#102A43',
        strokeWidthPt: 2,
      },
    )
    await expect(
      createSlidePageCommitter().commit({
        opened: await onePage('ORIGINAL'),
        mode: 'append',
        spec,
        artifacts: new Map(),
      }),
    ).resolves.toMatchObject({ auditIssues: [] })
  })

  it('honors an explicit overlap whitelist but rejects undeclared overlap and overflow', async () => {
    const allowed: SlidePageSpec = {
      ...textSpec(),
      elements: [
        {
          id: 'card',
          kind: 'shape',
          shape: 'rect',
          x: 80,
          y: 80,
          w: 600,
          h: 300,
          fill: '#102A43',
          allowOverlapWith: ['label'],
        },
        {
          id: 'label',
          kind: 'text',
          x: 120,
          y: 120,
          w: 400,
          h: 80,
          text: '合法叠放',
          fontSizePt: 26,
          color: '#FFFFFF',
          allowOverlapWith: ['card'],
        },
      ],
    }
    await expect(
      createSlidePageCommitter().commit({
        opened: await onePage('ORIGINAL'),
        mode: 'append',
        spec: allowed,
        artifacts: new Map(),
      }),
    ).resolves.toMatchObject({ auditIssues: [] })

    const overlap = structuredClone(allowed)
    overlap.elements.forEach((element) => delete element.allowOverlapWith)
    await expect(
      createSlidePageCommitter().commit({
        opened: await onePage('ORIGINAL'),
        mode: 'append',
        spec: overlap,
        artifacts: new Map(),
      }),
    ).rejects.toThrow('slide_page_audit_failed')

    const overflow = textSpec()
    overflow.elements[0]!.h = 20
    await expect(
      createSlidePageCommitter().commit({
        opened: await onePage('ORIGINAL'),
        mode: 'append',
        spec: overflow,
        artifacts: new Map(),
      }),
    ).rejects.toThrow('slide_page_audit_failed')
  })

  it('rejects missing, mismatched or malformed image artifacts before rendering', async () => {
    const spec: SlidePageSpec = {
      ...textSpec(),
      elements: [{ id: 'image', kind: 'image', artifactId: imageId, x: 0, y: 0, w: 200, h: 200 }],
    }
    const committer = createSlidePageCommitter()
    await expect(
      committer.commit({ opened: await onePage('A'), mode: 'append', spec, artifacts: new Map() }),
    ).rejects.toThrow('artifact_invalid')
    await expect(
      committer.commit({
        opened: await onePage('A'),
        mode: 'append',
        spec,
        artifacts: new Map([[imageId, { ...artifact(), sha256: '0'.repeat(64) }]]),
      }),
    ).rejects.toThrow('artifact_invalid')
    await expect(
      committer.commit({
        opened: await onePage('A'),
        mode: 'append',
        spec,
        artifacts: new Map([
          [imageId, { ...artifact(), bytes: Buffer.from('not-png'), width: 9, height: 9 }],
        ]),
      }),
    ).rejects.toThrow('artifact_invalid')
  })

  it('rejects every invalid append/insert/replace index before touching the source', async () => {
    for (const input of [
      { mode: 'append' as const, index: 0 },
      { mode: 'insert' as const },
      { mode: 'insert' as const, index: -1 },
      { mode: 'insert' as const, index: 0.5 },
      { mode: 'insert' as const, index: 2 },
      { mode: 'replace' as const, index: 1 },
    ]) {
      const original = await onePage('UNCHANGED')
      const before = archiveHash(original)
      await expect(
        createSlidePageCommitter().commit({
          opened: original,
          ...input,
          spec: textSpec(),
          artifacts: new Map(),
        }),
      ).rejects.toThrow('invalid_tool_arguments')
      expect(archiveHash(original)).toBe(before)
    }
  })

  it('detects incomplete elements, missing editable text and damaged image relationships', async () => {
    const audit = createSlidePageCommitter().dependencies.audit
    await expect(audit(await onePage('OTHER'), 9, textSpec(), new Map())).rejects.toThrow(
      'slide_page_audit_failed',
    )
    await expect(audit(await onePage('OTHER'), 0, textSpec(), new Map())).rejects.toThrow(
      'slide_page_audit_failed',
    )
    const missingText = textSpec('EXPECTED')
    missingText.elements = [missingText.elements[0]!]
    expect(await audit(await onePage('OTHER'), 0, missingText, new Map())).toContain(
      'Editable text audit failed',
    )

    const imageSpec: SlidePageSpec = {
      ...textSpec('图片'),
      elements: [{ id: 'image', kind: 'image', artifactId: imageId, x: 20, y: 20, w: 100, h: 100 }],
    }
    const artifacts = new Map([[imageId, artifact()]])
    const committed = await createSlidePageCommitter().commit({
      opened: await onePage('ORIGINAL'),
      mode: 'append',
      spec: imageSpec,
      artifacts,
    })
    const slide = committed.opened.deck.slides[committed.slideIndex]!
    const picture = slide.elements.find((element) => element.type === 'picture')
    if (!picture || picture.type !== 'picture') throw new Error('fixture_missing_picture')
    committed.opened.archive.entries.set(picture.mediaRef, Buffer.from('different'))
    const damaged = await audit(committed.opened, committed.slideIndex, imageSpec, artifacts)
    expect(damaged).toContain('Image completeness audit failed')

    const relsPath = slide.path.replace(/([^/]+)$/, '_rels/$1.rels')
    const rels = committed.opened.archive.readText(relsPath)!
    committed.opened.archive.entries.set(
      relsPath,
      Buffer.from(rels.replace(/<Relationship[^>]+\/image[^>]+\/>/, '')),
    )
    expect(await audit(committed.opened, committed.slideIndex, imageSpec, artifacts)).toContain(
      'Image relationship audit failed',
    )

    const noPicture = await onePage('OTHER')
    expect(await audit(noPicture, 0, imageSpec, artifacts)).toEqual(
      expect.arrayContaining([
        'Image relationship audit failed',
        'Image completeness audit failed',
      ]),
    )

    slide.elements.push(structuredClone(picture))
    expect(await audit(committed.opened, committed.slideIndex, imageSpec, artifacts)).toContain(
      'Image relationship audit failed',
    )
  })

  it('audits elements whose optional editable text bodies are absent after reopen', async () => {
    const dependencies = createSlidePageCommitter().dependencies
    const audit = dependencies.audit
    const noSlide = await onePage('OTHER')
    noSlide.deck.slides = []
    await expect(dependencies.renderInto(noSlide, 0, textSpec(), new Map())).rejects.toThrow(
      'slide_page_render_failed',
    )
    const noTextSpec: SlidePageSpec = {
      ...textSpec('无文字形状'),
      elements: [{ id: 'shape', kind: 'shape', shape: 'rect', x: 20, y: 20, w: 200, h: 100 }],
    }
    const noText = await onePage('OTHER')
    const first = noText.deck.slides[0]!.elements[0]
    if (!first || (first.type !== 'text' && first.type !== 'shape')) {
      throw new Error('fixture_missing_text')
    }
    first.text = undefined
    expect(await audit(noText, 0, noTextSpec, new Map())).toEqual([])

    const tableSpec: SlidePageSpec = {
      ...textSpec('表格'),
      elements: [{ id: 'table', kind: 'table', x: 20, y: 20, w: 400, h: 200, rows: [['A']] }],
    }
    const tableCommit = await createSlidePageCommitter().commit({
      opened: await onePage('ORIGINAL'),
      mode: 'append',
      spec: tableSpec,
      artifacts: new Map(),
    })
    const table = tableCommit.opened.deck.slides[tableCommit.slideIndex]!.elements.find(
      (element) => element.type === 'table',
    )
    if (!table || table.type !== 'table') throw new Error('fixture_missing_table')
    table.rows[0]![0]!.text = undefined
    expect(await audit(tableCommit.opened, tableCommit.slideIndex, tableSpec, new Map())).toContain(
      'Editable text audit failed',
    )
  })

  it.each([
    'render',
    'candidate-open',
    'candidate-audit',
    'candidate-audit-result',
    'source-save',
    'clone-open',
    'clone-open-empty',
    'target-render',
    'target-move',
    'final-save',
    'final-open',
    'final-audit',
    'final-audit-result',
  ] as const)('leaves the original deck byte/model hash unchanged when %s fails', async (stage) => {
    const original = await onePage('UNCHANGED')
    const before = archiveHash(original)
    const baseline = createSlidePageCommitter().dependencies
    let openCalls = 0
    let saveCalls = 0
    let auditCalls = 0
    const dependencies: SlidePageCommitDependencies = {
      ...baseline,
      renderCandidate: async (...args) => {
        if (stage === 'render') throw new Error('injected')
        return baseline.renderCandidate(...args)
      },
      open: async (...args) => {
        openCalls += 1
        if (
          (stage === 'candidate-open' && openCalls === 1) ||
          (stage === 'clone-open' && openCalls === 2) ||
          (stage === 'final-open' && openCalls === 3)
        ) {
          throw new Error('injected')
        }
        const opened = await baseline.open(...args)
        if (stage === 'clone-open-empty' && openCalls === 2) opened.deck.slides = []
        return opened
      },
      save: async (...args) => {
        saveCalls += 1
        if (
          (stage === 'source-save' && saveCalls === 1) ||
          (stage === 'final-save' && saveCalls === 2)
        ) {
          throw new Error('injected')
        }
        return baseline.save(...args)
      },
      renderInto: async (...args) => {
        if (stage === 'target-render') throw new Error('injected')
        await baseline.renderInto(...args)
        if (stage === 'target-move') args[0].deck.slides.pop()
      },
      audit: async (...args) => {
        auditCalls += 1
        if (
          (stage === 'candidate-audit' && auditCalls === 1) ||
          (stage === 'final-audit' && auditCalls === 2)
        ) {
          throw new Error('injected')
        }
        if (
          (stage === 'candidate-audit-result' && auditCalls === 1) ||
          (stage === 'final-audit-result' && auditCalls === 2)
        ) {
          return ['injected issue']
        }
        return baseline.audit(...args)
      },
    }
    await expect(
      createSlidePageCommitter(dependencies).commit({
        opened: original,
        ...(stage === 'target-move'
          ? { mode: 'insert' as const, index: 0 }
          : { mode: 'append' as const }),
        spec: textSpec(),
        artifacts: new Map(),
      }),
    ).rejects.toThrow()
    expect(archiveHash(original)).toBe(before)
    expect(original.deck.slides).toHaveLength(1)
  })
})
