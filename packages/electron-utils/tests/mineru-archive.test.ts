import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  downloadMineruDocx,
  selectDocxFromMineruArchive,
  validateDocx,
} from '../src/mineru-archive'

function validDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8('<w:document><w:body/></w:document>'),
  })
}

function mutateCentralDirectory(
  archive: Uint8Array,
  mutate: (view: DataView, end: number, central: number) => void,
): Uint8Array {
  const bytes = new Uint8Array(archive)
  const view = new DataView(bytes.buffer)
  let end = bytes.byteLength - 22
  while (view.getUint32(end, true) !== 0x06054b50) end -= 1
  mutate(view, end, view.getUint32(end + 16, true))
  return bytes
}

describe('bounded MinerU DOCX archive validation', () => {
  it('selects exactly one DOCX and validates required WordprocessingML parts', () => {
    const docx = validDocx()
    expect(
      selectDocxFromMineruArchive(
        zipSync({ 'ignored.md': strToU8('ignored'), 'output/result.docx': docx }),
      ),
    ).toEqual(docx)
    expect(validateDocx(docx)).toEqual(docx)
  })

  it.each([
    ['parent traversal', '../escape.docx'],
    ['absolute POSIX path', '/absolute.docx'],
    ['absolute Windows path', 'C:/absolute.docx'],
    ['UNC path', '\\server.docx'],
  ])('rejects unsafe archive entry: %s', (_case, name) => {
    expect(() => selectDocxFromMineruArchive(zipSync({ [name]: validDocx() }))).toThrow(
      'mineru_archive_path_invalid',
    )
  })

  it('rejects Unix symlink entries before extraction', () => {
    const archive = zipSync({
      'linked.docx': [strToU8('target.docx'), { os: 3, attrs: 0o120777 * 65_536 }],
    })
    expect(() => selectDocxFromMineruArchive(archive)).toThrow('mineru_archive_path_invalid')
  })

  it('rejects inconsistent central directory structures before extraction', () => {
    const archive = zipSync({ 'one.docx': validDocx() })
    const malformed = [
      mutateCentralDirectory(archive, (view, end) => {
        view.setUint32(end + 12, view.getUint32(end + 12, true) + 1, true)
      }),
      mutateCentralDirectory(archive, (view, _end, central) => {
        view.setUint32(central, 0, true)
      }),
      mutateCentralDirectory(archive, (view, _end, central) => {
        view.setUint16(central + 28, 0xffff, true)
      }),
      mutateCentralDirectory(archive, (view, end) => {
        view.setUint16(end + 10, 0, true)
      }),
      mutateCentralDirectory(archive, (view, _end, central) => {
        view.setUint16(central + 10, 99, true)
      }),
    ]
    for (const bytes of malformed) {
      expect(() => selectDocxFromMineruArchive(bytes)).toThrow('mineru_archive_invalid')
    }
  })

  it('rejects invalid ZIP, duplicate DOCX, extraction bombs and malformed OOXML', () => {
    expect(() => selectDocxFromMineruArchive(new Uint8Array([1, 2, 3]))).toThrow(
      'mineru_archive_invalid',
    )
    expect(() =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx(), 'two.docx': validDocx() })),
    ).toThrow('mineru_docx_count_invalid')
    expect(() =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), { maxEntries: 0 }),
    ).toThrow('mineru_archive_limit_exceeded')
    expect(() =>
      validateDocx(
        zipSync({
          '[Content_Types].xml': strToU8('<Types/>'),
          'word/document.xml': strToU8('<not-word/>'),
        }),
      ),
    ).toThrow('mineru_docx_content_type_invalid')
    expect(() => validateDocx(zipSync({ 'word/document.xml': strToU8('<w:document/>') }))).toThrow(
      'mineru_docx_parts_missing',
    )
    expect(() =>
      validateDocx(
        zipSync({
          '[Content_Types].xml': strToU8('wordprocessingml.document.main+xml'),
          'word/document.xml': strToU8('<not-word/>'),
        }),
      ),
    ).toThrow('mineru_docx_main_invalid')
    expect(() => selectDocxFromMineruArchive('not-bytes' as never)).toThrow(
      'mineru_archive_limit_exceeded',
    )
    expect(() =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxArchiveBytes: 1,
      }),
    ).toThrow('mineru_archive_limit_exceeded')
    expect(() =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxEntryBytes: 1,
      }),
    ).toThrow('mineru_archive_limit_exceeded')
    expect(() =>
      selectDocxFromMineruArchive(zipSync({ 'one.docx': validDocx() }), {
        maxExpandedBytes: 1,
      }),
    ).toThrow('mineru_archive_limit_exceeded')
  })

  it('downloads only HTTPS bounded archives and never exposes the result URL in errors', async () => {
    const docx = validDocx()
    const archive = zipSync({ 'output.docx': docx })
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(new Uint8Array(archive), {
          status: 200,
          headers: { 'content-length': String(archive.byteLength) },
        }),
      ),
    )
    await expect(
      downloadMineruDocx('https://result.example/archive.zip?private=result', { fetch }),
    ).resolves.toEqual(docx)
    await expect(
      downloadMineruDocx('http://unsafe.example/archive.zip', { fetch }),
    ).rejects.toThrow('mineru_url_invalid')
    expect(fetch).toHaveBeenCalledOnce()

    const failed = downloadMineruDocx('https://result.example/private.zip', {
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    })
    await expect(failed).rejects.toMatchObject({
      message: 'mineru_download_failed',
      kind: 'service',
      retriable: true,
    })
    await expect(
      downloadMineruDocx('https://result.example/private.zip', {
        fetch: vi.fn(async () => new Response(null, { status: 403 })),
      }),
    ).rejects.toMatchObject({ kind: 'download', retriable: true })
    await expect(
      downloadMineruDocx('https://result.example/private.zip', {
        fetch: vi.fn(async () => new Response(null, { status: 400 })),
      }),
    ).rejects.toMatchObject({ kind: 'download', retriable: false })
    await expect(
      downloadMineruDocx('https://result.example/private.zip', {
        limits: { maxArchiveBytes: 1 },
        fetch: vi.fn(
          async () =>
            new Response(new Uint8Array([1]), {
              status: 200,
              headers: { 'content-length': '2' },
            }),
        ),
      }),
    ).rejects.toThrow('mineru_archive_limit_exceeded')
  })
})
