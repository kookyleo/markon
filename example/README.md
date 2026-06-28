# Markon E2E Workspace

This workspace is a compact project for manual review and end-to-end tests. It is intentionally written in English and uses stable, local assets so it can run offline.

<link rel="stylesheet" href="assets/workspace.css">

![Sample architecture](assets/sample-architecture.svg)

## What This Workspace Covers

| Area | File | Expected behavior |
| --- | --- | --- |
| Markdown rendering | [Markdown Kitchen Sink](docs/markdown-kitchen-sink.md) | CommonMark, GFM tables, task lists, alerts, footnotes, definition lists, images, links, breaks, code, raw HTML, and core Markdown features render without errors. |
| Math and extensions | [Math and Extension Coverage](docs/math-and-extensions.md) | Inline and display math render through KaTeX; opaque Supramark extensions show labeled source fallback. |
| Diagrams | [Diagram Gallery](docs/diagrams.md) | Supramark renders Mermaid, PlantUML, D2, DOT/Graphviz, Vega-Lite/Vega/chart, ECharts, and Chart.js/chart.js diagrams; unsupported engines show labeled source fallback blocks. |
| Navigation | [Long Document](docs/long-document.md) | The table of contents, heading sections, viewed tracking, and scroll behavior have enough headings to exercise state changes. |
| Search | [Search Targets](docs/search-targets.md) | Unique tokens can be found through the workspace search index. |
| Edit and save | [Edit Save Target](docs/edit-save-target.md) | E2E tests can replace stable marker values and verify persistence. |
| Git status and diff | [Git Diff Target](docs/git-diff-target.md) | E2E tests can create a baseline commit, mutate this file, and verify status plus visual/source diff. |
| Raw assets | [HTML and Assets](docs/html-and-assets.md) | Local images and CSS referenced from Markdown are allowlisted and served. |

## Suggested E2E Setup

1. Copy this directory to a temporary location.
2. Run `git init`, `git add .`, and `git commit -m "baseline"`.
3. Open the copied directory as a Markon workspace.
4. Use `e2e-manifest.json` for stable paths, search tokens, and expected text.
5. Mutate `docs/git-diff-target.md` according to the manifest and verify git status plus Markdown visual diff.

## Quick Smoke Checklist

- The workspace root opens as a directory listing.
- `README.md` renders a local SVG image and local CSS.
- The diagram page displays server-rendered diagram SVGs for every registered Supramark diagram engine and alias plus unsupported engine fallback blocks.
- The Math page renders inline and display formulas with KaTeX.
- The Markdown page shows GitHub alerts, task lists, footnotes, code highlighting, tables, and raw HTML.
- Search finds `MARKON_E2E_UNIQUE_SEARCH_TOKEN_ALPHA`.
- Editing `docs/edit-save-target.md` changes the file on disk.
- After a baseline commit, changing `docs/git-diff-target.md` appears in workspace git status and diff views.
