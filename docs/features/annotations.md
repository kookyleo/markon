---
title: Annotations and Notes
description: Cross-block text anchors, three highlight colors, strikethrough, Notes, undo/redo, and SQLite persistence.
---

# Annotations and Notes

<div class="feature-illustration">
  <img src="/illustrations/05-annotate.svg" alt="Markon annotations and Notes" />
</div>

Select text to open the selection toolbar and record a highlight, strikethrough, or Note.

## Annotation types

| Type | Typical use |
|---|---|
| Orange highlight | Important or needs attention |
| Green highlight | Approved or confirmed |
| Yellow highlight | Uncertain or needs confirmation |
| Strikethrough | Outdated or proposed for removal |
| Note | Written feedback attached to any selection |

Selections that cross paragraphs, list items, or table cells are stored as ordered fragments while remaining compatible with older single-fragment anchors.

## Selection toolbar

The toolbar appears after mouse or touch selection. <kbd>a</kbd> temporarily disables it for native selection and copying; <kbd>Esc</kbd> clears the selection. When Edit or Chat is enabled, the toolbar also offers source editing and selection-aware questions.

## Reading and editing Notes

Wide screens use margin cards; narrow screens use source-adjacent popups. Clicking a source highlight locates its Note. Editing happens in place, and a single local quote plus Note can be copied as Markdown. Opening a Note inside a folded section expands it temporarily and restores the fold when closed.

## Undo, redo, and navigation

<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> undoes; <kbd>Shift</kbd>+that shortcut or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Y</kbd> redoes. <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>J</kbd>/<kbd>K</kbd> moves between annotations. The unified undo stack holds up to 50 operations.

## Persistence and permissions

`annotation.sqlite` is the only annotation authority; there is no LocalStorage fallback. With Shared off, an explicit admin session can read and write review state. With Shared on, administrators and unlocked collaborators use the same dataset, and successful HTTP writes are broadcast over WebSocket. Failures remain explicit and the page stays read-only.

Annotations are associated with absolute file paths, so moving a file changes the association.

## Clear, export, and print

The footer can clear a file's annotations after confirmation. H1 and section actions can [export Notes](/features/export), and print output retains highlights, strikethrough, and Notes. Diff pages support the same annotation workflow. See [Shared annotations](/advanced/shared-annotations) and [Data and privacy](/advanced/data-and-privacy).
