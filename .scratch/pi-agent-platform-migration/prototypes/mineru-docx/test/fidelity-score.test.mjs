import assert from 'node:assert/strict'
import { test } from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { scoreDocx } from '../src/fidelity-score.mjs'

function docx(documentXml, media = {}) {
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    'word/document.xml': strToU8(documentXml),
    ...media,
  })
}

test('scores marker recall/order, editable tables, formulas and images', () => {
  const result = scoreDocx(
    docx(
      '<w:document><w:body><w:p><w:r><w:t>FIRST &amp; 中文</w:t></w:r><w:tab/><w:r><w:t>SECOND</w:t></w:r></w:p><w:tbl><w:tr/></w:tbl><m:oMath><m:r/></m:oMath></w:body></w:document>',
      { 'word/media/image1.png': new Uint8Array([1]) },
    ),
    {
      file: 'fixture.pdf',
      markers: ['FIRST & 中文', 'SECOND'],
      expected: { tables: 1, formulasAtLeast: 1, imagesAtLeast: 1 },
    },
  )
  assert.equal(result.automaticPass, true)
  assert.equal(result.gates.markerOrder, true)
  assert.equal(result.tableCount, 1)
  assert.equal(result.formulaCount, 1)
  assert.equal(result.imageCount, 1)
  assert.match(result.text, /FIRST & 中文\tSECOND/u)
  assert.deepEqual(result.manualReviewRequired, ['page layout', 'overlap', 'font substitution'])
})

test('fails missing, reordered and structurally flattened output', () => {
  const result = scoreDocx(
    docx(
      '<w:document><w:body><w:p><w:r><w:t>SECOND</w:t></w:r><w:br/><w:r><w:t>FIRST</w:t></w:r></w:p></w:body></w:document>',
    ),
    {
      file: 'fixture.pdf',
      markers: ['FIRST', 'SECOND', 'MISSING'],
      expected: { tables: 1, formulasAtLeast: 1, imagesAtLeast: 1 },
    },
  )
  assert.equal(result.automaticPass, false)
  assert.equal(result.gates.markersPresent, false)
  assert.equal(result.gates.markerOrder, false)
  assert.equal(result.gates.editableTables, false)
  assert.equal(result.gates.editableFormulas, false)
  assert.equal(result.gates.imagesPresent, false)
  assert.equal(result.markerResults.MISSING, false)
})

test('defaults optional marker and structural expectations to zero', () => {
  const result = scoreDocx(
    docx(
      '<w:document><w:body><w:p><w:r><w:t>&lt;x&gt; &quot;q&quot; &apos;a&apos;</w:t></w:r></w:p></w:body></w:document>',
    ),
    { file: 'minimal.pdf' },
  )
  assert.equal(result.automaticPass, true)
  assert.equal(result.gates.editableFormulas, true)
  assert.match(result.text, /<x> "q" 'a'/u)
})
