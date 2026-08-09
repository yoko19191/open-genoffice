import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadMineruDocx } from '../src/archive.mjs'
import { scoreDocx } from '../src/fidelity-score.mjs'
import { createMineruClient, waitForMineruResult } from '../src/mineru-client.mjs'

if (process.env.SPIKE05_UPLOAD_CONFIRMED !== 'YES_I_CONSENT')
  throw new Error('Set SPIKE05_UPLOAD_CONFIRMED=YES_I_CONSENT only after explicit upload consent')
const token = process.env.MINERU_TOKEN
if (!token) throw new Error('MINERU_TOKEN is required')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(root, 'fixtures')
const outputDir = path.join(root, 'live-results')
const corpus = JSON.parse(await readFile(path.join(fixturesDir, 'corpus.json'), 'utf8'))
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('local fidelity run stopped by user')))
const client = createMineruClient({ token })

await mkdir(outputDir, { recursive: true })
const report = []
for (const document of corpus.documents) {
  const sourcePath = path.join(fixturesDir, path.basename(document.file))
  const pdfBytes = new Uint8Array(await readFile(sourcePath))
  const allocation = await client.requestLocalUpload(document.file, {
    dataId: `spike05-${path.basename(document.file, '.pdf')}`,
    signal: controller.signal,
  })
  await client.upload(allocation.uploadUrl, pdfBytes, { signal: controller.signal })
  const resultUrl = await waitForMineruResult(client, allocation.batchId, document.file, {
    signal: controller.signal,
    wait: () => new Promise((resolve) => setTimeout(resolve, 3000)),
  })
  const docxBytes = await downloadMineruDocx(resultUrl, { signal: controller.signal })
  const outputName = `${path.basename(document.file, '.pdf')}.docx`
  await writeFile(path.join(outputDir, outputName), docxBytes)
  const score = scoreDocx(docxBytes, document)
  report.push({ ...score, text: undefined })
  process.stdout.write(
    `${JSON.stringify({ file: document.file, automaticPass: score.automaticPass, gates: score.gates })}\n`,
  )
}
await writeFile(
  path.join(outputDir, 'report.json'),
  `${JSON.stringify({ schemaVersion: 1, documents: report }, null, 2)}\n`,
)
