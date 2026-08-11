---
name: open-genoffice-slides-authoring
description: Plan and author editable pages in the active Open GenOffice presentation with a constrained SlidePageSpec and the atomic local page renderer. Use for creating a deck, adding a page, inserting a page, or replacing an existing slide from a brief, document context, attachments, research, or approved images.
---

# Open GenOffice Slides Authoring

Build a coherent presentation one page at a time. The live deck, current selection and committed tool receipts are authoritative; prose in the conversation is not proof that a page landed.

## Authoring workflow

1. Call `get_deck_context`, then use `read_slide` for pages whose structure or visual language must be preserved. Never guess the current page count or indexes.
2. Read relevant attachments before planning. Use `web_search` only when external facts are necessary and preserve source attribution in visible slide text or notes when the task calls for it.
3. Write a compact plan in the working context: audience, objective, one Core Hook, visual system, narrative arc, and one purpose per page. Keep the plan as structured text; do not call a hidden planning or generation service.
4. If an image materially helps a page, use `image_search`, select an appropriate result, and obtain its scope-bound `artifactId`. Candidate URLs belong only in tool details. A page spec may contain only the resulting ArtifactRef.
5. Produce exactly one version-1 `SlidePageSpec` for a 1280×720 canvas and call `commit_slide_page` once for that page. Use `append`, `insert` with an index, or `replace` with an index.
6. Treat only a committed receipt as success. Read the landed page when a later page depends on its exact content or composition. Continue page by page until the requested deck is complete.

For a long deck, establish or confirm the requested maximum page count separately from any individual tool call. Never place several pages in one spec, and never silently exceed that limit.

## Page rules

Use only editable text, shapes, ArtifactRef PNG images, charts, tables and SmartArt. Every element needs a stable unique ID and an integer box fully inside the canvas. Prefer registered fonts and an explicit, restrained hierarchy. Keep chart categories and each series the same length; keep tables rectangular; label non-user data with `dataSource`.

An overlap is invalid unless both the design and the spec make it intentional. Put the related element ID in `allowOverlapWith`; do not use the whitelist to conceal clipping, text overflow, or accidental collisions. Full-canvas backgrounds are the exception handled by the renderer.

Use native tools for small surgical edits to an existing page. Use `commit_slide_page` when the task needs a complete new composition or an atomic whole-page replacement.

## Hard boundaries

- Never emit HTML, JavaScript, OOXML, arbitrary XML, a local file path, an external URL, base64 bytes, or an unregistered font in `SlidePageSpec`.
- Never call legacy `generate_deck`, `regenerate_slide`, HTML conversion, or cloud page generation tooling.
- Never claim that a page is complete when `commit_slide_page` fails or reports an unknown mutation outcome. Stop mutating that document until recovery resolves an unknown outcome.
- Never reuse an ArtifactRef from another document or run. The main process validates scope, MIME, dimensions, hash and image bytes again.
- Never flatten a chart, table, SmartArt or text block into an image merely to pass visual review.

The local commit pipeline validates, renders, reopens, audits, applies append/insert/replace on a clone, saves, reopens and audits again. Any failed stage leaves page order, selection, undo history and the source file unchanged.
