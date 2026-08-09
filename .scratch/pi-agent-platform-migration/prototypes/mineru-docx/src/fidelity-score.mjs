import { strFromU8, unzipSync } from 'fflate'

import { validateDocx } from './archive.mjs'

function decodeXmlText(value) {
  return value
    .replace(/<w:tab\b[^>]*\/>/gu, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function ordered(text, markers) {
  let cursor = -1
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1)
    if (next < 0) return false
    cursor = next
  }
  return true
}

export function scoreDocx(docxBytes, corpusDocument) {
  validateDocx(docxBytes)
  const files = unzipSync(docxBytes)
  const documentXml = strFromU8(files['word/document.xml'])
  const text = decodeXmlText(documentXml)
  const markers = corpusDocument.markers ?? []
  const markerResults = Object.fromEntries(markers.map((marker) => [marker, text.includes(marker)]))
  const tableCount = (documentXml.match(/<w:tbl(?:\s|>)/gu) ?? []).length
  const formulaCount = (documentXml.match(/<m:oMath(?:\s|>)/gu) ?? []).length
  const imageCount = Object.keys(files).filter(
    (name) => name.startsWith('word/media/') && !name.endsWith('/'),
  ).length
  const expectedTables = corpusDocument.expected?.tables ?? 0
  const expectedFormulas = corpusDocument.expected?.formulasAtLeast ?? 0
  const expectedImages = corpusDocument.expected?.imagesAtLeast ?? 0
  const gates = {
    markersPresent: Object.values(markerResults).every(Boolean),
    markerOrder: ordered(text, markers),
    editableTables: tableCount >= expectedTables,
    editableFormulas: formulaCount >= expectedFormulas,
    imagesPresent: imageCount >= expectedImages,
  }
  return {
    file: corpusDocument.file,
    text,
    markerResults,
    tableCount,
    formulaCount,
    imageCount,
    gates,
    automaticPass: Object.values(gates).every(Boolean),
    manualReviewRequired: ['page layout', 'overlap', 'font substitution'],
  }
}
