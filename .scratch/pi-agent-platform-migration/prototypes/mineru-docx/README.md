# Spike 05 — MinerU DOCX contract prototype

This prototype fixes the API, cancellation, credential, archive and measured fidelity boundaries
for the optional MinerU OCR provider. A live run remains fail closed until the user explicitly
approves uploading the synthetic corpus because the input PDF leaves the device and consumes quota.

## Fixed contract

- The provider is disabled by default. Disabled means no token lookup and zero MinerU requests.
- Enabling it requires a one-time, persistent disclosure that the document is sent to a third-party
  cloud OCR provider. OCR actions continue to display a cloud-processing badge.
- A local PDF uses one-item `POST /api/v4/file-urls/batch`, requests `model_version: "vlm"` and
  `extra_formats: ["docx"]`, uploads with PUT to the returned HTTPS URL without adding a
  `Content-Type`, and polls `GET /api/v4/extract-results/batch/{batch_id}`.
- The API token stays in `CredentialStore`. Bearer tokens, signed upload URLs, result URLs and
  document bytes are forbidden in renderer state, Pi sessions, telemetry and logs.
- Local cancellation aborts the current request and prevents later polling/download. The public
  API documentation exposes no remote cancellation endpoint, so the product must say that the
  remote task may continue.
- The result URL must use HTTPS. The download is bounded, ZIP paths are validated, exactly one DOCX
  is accepted, and the DOCX must contain valid WordprocessingML content types and a main document.
  Extraction happens into a private temporary directory in production; this prototype validates
  entirely in memory.
- Pandoc is not part of PDF-to-DOCX. MinerU failure disables only cloud OCR/conversion and never the
  local PDF viewer or Pi Agent Runtime.

## Live fidelity result

The live run uses newly generated, non-sensitive, one-page PDFs only. It covers born-digital
Chinese/English prose, two columns, merged-cell tables, display/inline formulae, an image-heavy page,
and a scanned Chinese/English page. The gate measures text/reading order, editable tables, formula
representation, image completeness and catastrophic overlap. It does not promise page-identical
layout or font preservation.

The user approved the upload on 2026-08-09. The Standard API completed all five uploads,
conversions, downloads and DOCX validations without calling the Agent lightweight API. After fixing
the corpus marker order and making OMML a blocking formula gate, 2/5 documents passed every
automatic gate:

- born-digital bilingual prose preserved editable/searchable text and reading order;
- the merged table remained an editable Word table with its image resource;
- the two-column document flattened to sequential paragraphs and formulas remained plain text, not
  OMML;
- the image-heavy page preserved all six visual assets but reflowed from one page to three, while
  image labels were absent from the Word text layer;
- the scanned page preserved searchable OCR text but omitted the source raster image.

This resolves Spike 05 as a semantic/editability conversion, not a high-fidelity layout conversion.
The original PDF must remain available for side-by-side review.

Generate the five one-page fixtures locally with the bundled document runtime:

```bash
python3 scripts/generate-fixtures.py
```

The generator verifies page counts and proves that only `05-scanned-bilingual.pdf` lacks a PDF text
layer. `fixtures/corpus.json` records non-secret markers and expected structural features. Generated
PDFs are inputs for the consented cloud run; none of them are uploaded by this command.

`scoreDocx()` compares each returned DOCX against its corpus record: marker recall and order,
editable table count, embedded image count and required OMML formula count. Layout, overlap and font
substitution remain explicit human review fields rather than guessed metrics.

After the user explicitly approves uploading these synthetic fixtures and consuming quota, the live
runner has a second fail-closed consent flag:

```bash
# Load MINERU_TOKEN through a non-echoing credential helper before this command.
SPIKE05_UPLOAD_CONFIRMED=YES_I_CONSENT npm run live:fidelity
```

It processes the five files sequentially, never prints token or signed/result URLs, and writes DOCX
plus `report.json` under ignored `live-results/`. Stopping the runner aborts local work only; the
MinerU task already submitted may continue remotely.

## Verify

```bash
npm install
npm run lint
npm run test:coverage
```

Official contract checked on 2026-08-09: <https://mineru.net/apiManage/docs>.
