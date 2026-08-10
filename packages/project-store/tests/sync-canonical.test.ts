import { describe, expect, it } from 'vitest'
import {
  assertCanonicalPathSet,
  canonicalJsonBytes,
  canonicalizeSyncPath,
  sha256Hex,
} from '../src/sync/canonical.js'

describe('sync canonical data', () => {
  it('normalizes safe paths to UTF-8 NFC and hashes canonical JSON deterministically', () => {
    expect(canonicalizeSyncPath('资料/Cafe\u0301.docx')).toBe('资料/Café.docx')
    expect(canonicalJsonBytes({ z: 1, a: { y: true, x: 'ok' } }).toString()).toBe(
      '{"a":{"x":"ok","y":true},"z":1}',
    )
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it.each([
    '',
    '/absolute.docx',
    'C:/absolute.docx',
    'folder\\escape.docx',
    'folder//empty.docx',
    'folder/./dot.docx',
    'folder/../escape.docx',
    'folder/CON.txt',
    'folder/name\0.txt',
  ])('rejects unsafe canonical path %j', (path) => {
    expect(() => canonicalizeSyncPath(path)).toThrow(/sync_path_invalid/)
  })

  it('rejects case and Unicode normalization collisions', () => {
    expect(() => assertCanonicalPathSet(['Docs/Report.docx', 'docs/report.docx'])).toThrow(
      /sync_path_collision/,
    )
    expect(() => assertCanonicalPathSet(['资料/Café.docx', '资料/Cafe\u0301.docx'])).toThrow(
      /sync_path_collision/,
    )
  })

  it('rejects path and object size limits', () => {
    expect(() => canonicalizeSyncPath(`${'a'.repeat(256)}.docx`)).toThrow(/sync_path_invalid/)
    expect(() =>
      assertCanonicalPathSet(Array.from({ length: 10_001 }, (_, index) => `p/${index}`)),
    ).toThrow(/sync_limit_exceeded/)
  })

  it('rejects values that canonical JSON cannot represent exactly', () => {
    expect(() => canonicalJsonBytes(Number.NaN)).toThrow(/sync_canonical_json_invalid/)
    expect(() => canonicalJsonBytes(Symbol('invalid'))).toThrow(/sync_canonical_json_invalid/)
    expect(() => canonicalJsonBytes({ missing: undefined })).toThrow(/sync_canonical_json_invalid/)
    expect(canonicalJsonBytes([1, null, 'ok']).toString()).toBe('[1,null,"ok"]')
  })
})
