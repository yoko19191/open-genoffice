import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { buildDocContext, countWords } from '../src/renderer/ai/protocol'
import { executeTool } from '../src/renderer/ai/tools'

/**
 * Docs Office executor tests against a real Tiptap editor. Runtime session,
 * freshness, rollback and abort behavior live at the Office host/adapter seam.
 */

interface JsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

const text = (t: string): JsonNode => ({ type: 'text', text: t })
const heading = (t: string, level = 1): JsonNode => ({
  type: 'docHeading',
  attrs: { docxIndex: null, level },
  content: [text(t)],
})
const para = (t: string): JsonNode => ({
  type: 'docParagraph',
  attrs: { docxIndex: null },
  content: [text(t)],
})

/** Editors created during the current test; destroyed in afterEach so ProseMirror's
 * DOMObserver timers can't fire after the JSDOM environment is torn down. */
const liveEditors: Editor[] = []

function createEditor(content: JsonNode[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content },
  })
  liveEditors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

/** 0 h1 | 1 p | 2 h2 | 3 p */
const fixture = () => [
  heading('Chapter 1 Overview', 1),
  para('GenSpark is an AI office suite.'),
  heading('Risk Notes', 2),
  para('This document is for reference only.'),
]

const NUM_IDS = { bullet: null, ordered: null }

describe('word-count stats (answer-style requests)', () => {
  it('each turn context carries full-text stats matching the status bar so the model can quote them directly', async () => {
    const editor = createEditor(fixture())
    const context = buildDocContext(editor)
    const expected = countWords(editor.state.doc.textContent)
    expect(context).toContain(`Full-text stats: words ${expected}`)
    expect(context).toContain('0|h1|Chapter 1 Overview')
    expect(context).toContain('3|p|This document is for reference only.')
  })

  it('get_document_context tool returns the same stats and does not modify the document', async () => {
    const editor = createEditor(fixture())
    const before = JSON.stringify(editor.getJSON())
    const exec = await executeTool(
      editor,
      { id: 't1', name: 'get_document_context', input: {} },
      NUM_IDS,
    )
    expect(exec.mutated).toBe(false)
    expect(exec.output).toContain(`words ${countWords(editor.state.doc.textContent)}`)
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })
})

describe('changing heading colors (formatting-command requests)', () => {
  it('apply_commands turns all headings red with the aiChanged highlight', async () => {
    const editor = createEditor(fixture())
    const exec = await executeTool(
      editor,
      {
        id: 't1',
        name: 'apply_commands',
        input: {
          commands: [
            {
              updateTextStyle: {
                target: { nodeType: 'docHeading' },
                style: { color: 'FF0000' },
                fields: ['color'],
              },
            },
          ],
        },
      },
      NUM_IDS,
    )

    expect(exec.isError).toBeUndefined()
    expect(exec.output).toContain('已更新 2 个块的文字样式')
    for (const blockIndex of [0, 2]) {
      const block = editor.state.doc.child(blockIndex)
      expect(block.attrs.aiChanged).toBe(true)
      const mark = block.child(0).marks.find((m) => m.type.name === 'docTextStyle')
      expect(mark?.attrs.color).toBe('FF0000')
    }
    // Body text is unaffected
    expect(
      editor.state.doc
        .child(1)
        .child(0)
        .marks.some((m) => m.type.name === 'docTextStyle'),
    ).toBe(false)
  })

  it('invalid commands return an error result and leave the document unchanged', async () => {
    const editor = createEditor(fixture())
    const before = JSON.stringify(editor.getJSON())
    const exec = await executeTool(
      editor,
      {
        id: 't1',
        name: 'apply_commands',
        input: { commands: [{ updateTextStyle: { style: {}, fields: [] } }] },
      },
      NUM_IDS,
    )
    expect(exec.isError).toBe(true)
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })
})

describe('content read/write tools', () => {
  it('read_blocks returns the full restricted HTML', async () => {
    const editor = createEditor(fixture())
    const exec = await executeTool(
      editor,
      { id: 't', name: 'read_blocks', input: { startBlockIndex: 0, endBlockIndex: 1 } },
      NUM_IDS,
    )
    expect(exec.output).toContain('<h1>Chapter 1 Overview</h1>')
    expect(exec.output).toContain('<p>GenSpark is an AI office suite.</p>')
  })

  it('read_blocks pages oversized content: offset continuation reassembles the full HTML', async () => {
    // one paragraph well past the 24k read cap
    const long = 'A'.repeat(30_000)
    const editor = createEditor([heading('Long chapter', 1), para(long)])
    const first = await executeTool(
      editor,
      { id: 't1', name: 'read_blocks', input: { startBlockIndex: 0, endBlockIndex: 1 } },
      NUM_IDS,
    )
    expect(first.isError).toBeUndefined()
    const match = first.output.match(/offset=(\d+)/)
    expect(first.output).toContain('truncated')
    expect(match).not.toBeNull()
    const offset = Number(match![1])
    const second = await executeTool(
      editor,
      {
        id: 't2',
        name: 'read_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 1, offset },
      },
      NUM_IDS,
    )
    expect(second.isError).toBeUndefined()
    expect(second.output).toContain('end of range')
    const stitched =
      first.output.slice(0, first.output.lastIndexOf('\n…(truncated')) +
      second.output.slice(0, second.output.lastIndexOf('\n(end of range'))
    expect(stitched).toContain('<h1>Long chapter</h1>')
    expect(stitched).toContain(long)
    // an offset beyond the content is an explicit error, not an empty read
    const beyond = await executeTool(
      editor,
      {
        id: 't3',
        name: 'read_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 1, offset: 10_000_000 },
      },
      NUM_IDS,
    )
    expect(beyond.isError).toBe(true)
  })

  it('replace_blocks rewrites the specified blocks', async () => {
    const editor = createEditor(fixture())
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'replace_blocks',
        input: { startBlockIndex: 1, endBlockIndex: 1, html: '<p>Intro rewritten.</p>' },
      },
      NUM_IDS,
    )
    expect(exec.mutated).toBe(true)
    const block = editor.state.doc.child(1)
    expect(block.textContent).toBe('Intro rewritten.')
    expect(block.attrs.aiChanged).toBe(true)
    expect(editor.state.doc.childCount).toBe(4)
  })

  it('insert_content inserts after the specified block', async () => {
    const editor = createEditor(fixture())
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'insert_content',
        input: { html: '<h2>New Section</h2><p>New content.</p>', afterBlockIndex: 3 },
      },
      NUM_IDS,
    )
    expect(exec.mutated).toBe(true)
    expect(editor.state.doc.childCount).toBe(6)
    expect(editor.state.doc.child(4).textContent).toBe('New Section')
    expect(editor.state.doc.child(5).textContent).toBe('New content.')
  })

  it('an out-of-range end index is an error, not silently clamped', async () => {
    const editor = createEditor(fixture())
    const before = JSON.stringify(editor.getJSON())
    for (const name of ['read_blocks', 'replace_blocks']) {
      const exec = await executeTool(
        editor,
        { id: 't', name, input: { startBlockIndex: 2, endBlockIndex: 9, html: '<p>x</p>' } },
        NUM_IDS,
      )
      expect(exec.isError).toBe(true)
      expect(exec.output).toContain('4 blocks')
    }
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })
})

describe('blank-document detection', () => {
  it('an image-only document is not blank: insert_content appends instead of wiping it', async () => {
    const editor = createEditor([
      {
        type: 'docProtected',
        attrs: { docxIndex: null, blockType: 'image', label: 'Image' },
      },
    ])
    const exec = await executeTool(
      editor,
      { id: 't', name: 'insert_content', input: { html: '<p>caption</p>', afterBlockIndex: 0 } },
      NUM_IDS,
    )
    expect(exec.isError).toBeUndefined()
    expect(editor.state.doc.childCount).toBe(2)
    expect(editor.state.doc.child(0).attrs.blockType).toBe('image')
    expect(buildDocContext(editor)).not.toContain('blank')
  })

  it('a single empty paragraph is still blank: insert_content replaces the template paragraph', async () => {
    const editor = createEditor([{ type: 'docParagraph', attrs: { docxIndex: null } }])
    expect(buildDocContext(editor)).toContain('blank')
    const exec = await executeTool(
      editor,
      { id: 't', name: 'insert_content', input: { html: '<p>hello</p>' } },
      NUM_IDS,
    )
    expect(exec.isError).toBeUndefined()
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.child(0).textContent).toBe('hello')
  })
})

describe('abort during async tools', () => {
  it('insert_image aborted before mutation writes nothing', async () => {
    const editor = createEditor(fixture())
    const before = JSON.stringify(editor.getJSON())
    const ctrl = new AbortController()
    ctrl.abort()
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'insert_image',
        input: { artifactId: '11111111-1111-4111-8111-111111111111' },
      },
      NUM_IDS,
      undefined,
      ctrl.signal,
      {
        bytes: Uint8Array.from([137, 80, 78, 71]),
        mediaType: 'image/png',
        width: 1,
        height: 1,
        sha256: 'a'.repeat(64),
      },
    )
    expect(exec.isError).toBe(true)
    expect(exec.output).toContain('stopped by the user')
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })
})
