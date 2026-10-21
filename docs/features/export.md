---
title: Export Notes
description: Turn page or section Notes into editable, copyable, downloadable Markdown.
---

# Export Notes

Markon exports ordered Markdown, not a screenshot. You can edit the result before copying it or downloading a `.md` file.

**Export Notes** belongs to **Output**, the export-and-print capability group. It exports only written Notes, a subfeature of Annotate.

## Visibility and permissions

The first H1 offers whole-page export whenever that title exists. H2–H6 offer section export when focused. `Export Notes (n)` remains visible but disabled when the scope contains no text Notes. Without H1, no H1 toolbar is mounted.

Every browser admitted to the workspace can export Notes in its current Personal or Shared scope. Share is not required for Personal export; one browser cannot load another browser's Personal records. The controls do not depend on Edit, Chat, or Live; Progress is an essential capability. Export uses a temporary buffer and does not save the source file.

## Export scopes

| Entry | Scope |
|---|---|
| H1 `Export Notes (n)` | All text Notes in the file |
| H2–H6 `Export Notes (n)` | Current heading and descendants, stopping before the next same/higher-level heading |
| Rendered diff `Export Notes (n)` | Notes in the current diff |

The count includes annotations with Note text, not standalone highlights or strikethrough.

## Export editor

Markon opens a temporary CodeMirror buffer. The first line is the editable download name; the rest contains quotes and Notes in document order. You may rearrange the content, copy it, or download it. Export mode never calls the source save API.

Heading controls show a disabled export action with a count of `0` for an empty range. The shortcut does not open an empty editor. A single Note can also copy its local quote plus feedback.

## Export versus print

Notes export is best for issue text or review records. [Section printing](/features/print) retains rendered typography, diagrams, and annotation appearance for PDF or paper. See [Annotate](/features/annotations) and [Data and privacy](/advanced/data-and-privacy).
