---
title: Source editing
description: Lazy-loaded CodeMirror editing, rendered selection mapping, live preview, saving, and workspace boundaries.
---

# Source editing

<div class="feature-illustration"><img src="/illustrations/04-edit.svg" alt="Markon Markdown source editor" /></div>

When `Edit` is enabled, you can change the current Markdown in its reading context. CodeMirror is loaded as a separate chunk only when the editor opens.

## Open the editor

| Entry | Behavior |
|---|---|
| <kbd>e</kbd> | Open the current file |
| Select text → Edit | Open and select the corresponding source |
| File/line citation | Jump to a 1-based line number |

The renderer keeps source positions and falls back to finding selected text when an exact line mapping is unavailable.

## Editing interface

The editor provides Markdown highlighting, line numbers, Edit/Preview views, synchronized scrolling, a resizable split, dirty/saving state, and shared theme tokens. Preview is rendered by a server endpoint with body and workspace limits. Notes export reuses the editor in a non-saving `export` mode.

## Save

Use <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd>. The workspace must enable Edit; the Markdown path must remain within the workspace; the request must be same-origin and carry the workspace save capability. A successful request establishes a new baseline without marking text typed during the request as saved. Closing with unsaved changes requires confirmation.

## External changes and conflicts

Markon watches workspace files and refreshes pages and indexes, but the editor does not provide OT, CRDT, or automatic Git merging. Concurrent saves may overwrite one another. AI edits perform drift checks before Apply; human editors should coordinate or use Git. Review written changes in [Git Working diff](/features/git).

## Permissions

Administrators and collaborators can save only when Edit is enabled. Chat without Edit has read-only tools; Chat plus Edit registers the approval-based `edit_file` tool.
