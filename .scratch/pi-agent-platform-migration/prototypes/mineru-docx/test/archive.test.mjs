import assert from 'node:assert/strict'
import { test } from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { downloadMineruDocx, selectDocxFromMineruArchive, validateDocx } from '../src/archive.mjs'

const validDocx = () =>
  zipSync({
    '[Content_Types].xml': strToU8(
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8('<w:document><w:body/></w:document>'),
  })

test('selects and validates exactly one DOCX from the MinerU ZIP', () => {
  const docx = validDocx()
  const archive = zipSync({
    'full.md': strToU8('# ignored'),
    'output/result.docx': docx,
  })
  assert.deepEqual(selectDocxFromMineruArchive(archive), docx)
  assert.deepEqual(validateDocx(docx), docx)
})

test('rejects non-bytes, oversized, invalid, missing and duplicate DOCX archives', () => {
  assert.throws(() => selectDocxFromMineruArchive('not bytes'), /download limits/u)
  assert.throws(
    () => selectDocxFromMineruArchive(new Uint8Array([1, 2]), { maxArchiveBytes: 1 }),
    /download limits/u,
  )
  assert.throws(() => selectDocxFromMineruArchive(new Uint8Array([1, 2, 3])), /valid ZIP/u)
  assert.throws(
    () => selectDocxFromMineruArchive(zipSync({ 'full.md': strToU8('x') })),
    /one DOCX/u,
  )
  assert.throws(
    () =>
      selectDocxFromMineruArchive(
        zipSync({ 'one.docx': validDocx(), 'nested/two.DOCX': validDocx() }),
      ),
    /one DOCX/u,
  )
})

test('rejects unsafe paths and extraction limits before returning a DOCX', () => {
  assert.throws(
    () => selectDocxFromMineruArchive(zipSync({ '../escape.docx': validDocx() })),
    /unsafe path/u,
  )
  assert.throws(
    () => selectDocxFromMineruArchive(zipSync({ '/absolute.docx': validDocx() })),
    /unsafe path/u,
  )
  assert.throws(
    () => selectDocxFromMineruArchive(zipSync({ '\\server.docx': validDocx() })),
    /unsafe path/u,
  )
  assert.throws(
    () => selectDocxFromMineruArchive(zipSync({ 'C:/drive.docx': validDocx() })),
    /unsafe path/u,
  )
  assert.throws(
    () =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxEntries: 0,
      }),
    /extraction limits/u,
  )
  assert.throws(
    () =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxEntryBytes: 1,
      }),
    /extraction limits/u,
  )
  assert.throws(
    () =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxExpandedBytes: 1,
      }),
    /extraction limits/u,
  )
})

test('rejects malformed OOXML documents', () => {
  assert.throws(
    () => validateDocx(zipSync({ 'word/document.xml': strToU8('<w:document/>') })),
    /missing required/u,
  )
  assert.throws(
    () =>
      validateDocx(
        zipSync({
          '[Content_Types].xml': strToU8('<Types/>'),
          'word/document.xml': strToU8('<w:document/>'),
        }),
      ),
    /invalid content type/u,
  )
  assert.throws(
    () =>
      validateDocx(
        zipSync({
          '[Content_Types].xml': strToU8('wordprocessingml.document.main+xml'),
          'word/document.xml': strToU8('<not-word/>'),
        }),
      ),
    /invalid main document/u,
  )
})

test('downloads and validates a bounded DOCX result', async () => {
  const docx = validDocx()
  const archive = zipSync({ 'output.docx': docx })
  const result = await downloadMineruDocx('https://cdn.example/result.zip', {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://cdn.example/result.zip')
      assert.equal(init.signal, undefined)
      return new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.byteLength) },
      })
    },
  })
  assert.deepEqual(result, docx)
})

test('rejects failed, retryable and oversized downloads', async () => {
  await assert.rejects(() => downloadMineruDocx('http://cdn.example/result.zip'), /must use HTTPS/u)
  await assert.rejects(
    () =>
      downloadMineruDocx('https://cdn.example/result.zip', {
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    { kind: 'download', retriable: false },
  )
  await assert.rejects(
    () =>
      downloadMineruDocx('https://cdn.example/result.zip', {
        fetchImpl: async () => new Response(null, { status: 503 }),
      }),
    { kind: 'service', retriable: true },
  )
  await assert.rejects(
    () =>
      downloadMineruDocx('https://cdn.example/result.zip', {
        limits: { maxArchiveBytes: 1 },
        fetchImpl: async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 200,
            headers: { 'content-length': '2' },
          }),
      }),
    /download limits/u,
  )
})
