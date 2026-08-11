---
title: Export Notes
description: Turn page or section Notes into editable, copyable, downloadable Markdown.
---

# Export Notes

Markon exports ordered Markdown, not a screenshot. You can edit the result before copying it or downloading a `.md` file.

## Export scopes

| Entry | Scope |
|---|---|
| H1 `Export Notes (n)` | All text Notes in the file |
| H2–H6 `Export Notes (n)` | Current heading through the next same/higher-level heading |
| Rendered diff `Export Notes (n)` | Notes in the current diff |

The count includes annotations with Note text, not standalone highlights or strikethrough.

## Export editor

Markon opens a temporary CodeMirror buffer. The first line is the editable download name; the rest contains quotes and Notes in document order. You may rearrange the content, copy it, or download it. Export mode never calls the source save API.

An empty range shows a brief message rather than opening an empty editor. A single Note can also copy its local quote plus feedback.

## Export versus print

Notes export is best for issue text or review records. [Section printing](/features/print) retains rendered typography, diagrams, and annotation appearance for PDF or paper. See [Annotations and Notes](/features/annotations) and [Data and privacy](/advanced/data-and-privacy).
