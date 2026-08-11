---
name: open-genoffice-sheets-workbook
description: Read and edit the active Open GenOffice spreadsheet through the live workbook context and the atomic 52-operation Workbook DSL. Use for XLSX/CSV analysis, formulas, values, formatting, tables, pivots, charts, filters, validation, sheet structure, and other workbook changes.
---

# Open GenOffice Sheets Workbook

Work against the live editor. Never infer workbook state from an attachment, a previous turn, or a requested range boundary.

## Workflow

1. Call `get_workbook_context`. Treat sheet IDs, data extents, selection, loaded viewport, merge and chart summaries as current only for the returned context version.
2. Read concrete values with `read_range` or `read_cells`. Use `read_formats` before copying or changing existing styles, and `read_sheet_features` before modifying filters, validation, names, panes, protection or visuals.
3. Load only the reference needed for the requested operation:
   - values and formulas: [writing.md](references/writing.md)
   - formats and financial presentation: [formatting.md](references/formatting.md), [financial-formatting.md](references/financial-formatting.md)
   - rows, columns and sheet layout: [layout.md](references/layout.md), [structure.md](references/structure.md)
   - charts, shapes and Artifact images: [charts.md](references/charts.md), [shape-image.md](references/shape-image.md)
   - tables, pivots and data features: [table.md](references/table.md), [pivot.md](references/pivot.md), [data.md](references/data.md)
   - sourced web data: [data-attribution.md](references/data-attribution.md)
4. Send one coherent batch through `propose_operations`. The executor expands and prevalidates every operation before the existing plan/apply transaction runs.
5. Treat the tool receipt as authoritative. Do not claim success until it reports committed. If the outcome is unknown, stop mutating that workbook and explain that the document must recover before retrying.

## Safety rules

- Use sheet IDs returned by `get_workbook_context`, never display names as IDs.
- Keep `read_range` within 2,000 cells, `read_formats` within 200 cells, and `read_cells` within 100 normalized A1 addresses.
- Read affected cells before writing. Use expected values/formulas when the operation supports them.
- Keep structural operations in a separate batch from cell, format and layout operations.
- Keep expanded cell changes within 2,000. Split a larger edit into independently verifiable transactions.
- Insert images only by scope-bound `artifactId`; never pass a URL or local path.
- Use `web_search` only when external facts are required, and preserve source attribution in the workbook.
- After formulas commit, inspect the returned read-back. A formula error or unavailable result is not proof that the transaction failed or succeeded; the mutation receipt remains authoritative.
