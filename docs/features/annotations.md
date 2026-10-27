---
title: Annotate
description: Cross-block text anchors, three highlight colors, strikethrough, Notes, undo/redo, and SQLite persistence.
---

# Annotate

<div class="feature-illustration">
  <img src="/illustrations/05-annotate.svg" alt="Markon annotations and Notes" />
</div>

Select text to open the selection toolbar and record a highlight, strikethrough, or Note.

## Naming and scope

**Annotate** is the capability that includes Highlight, Strike, and Note. A **Note** is written feedback attached to source text; highlights and strikethrough without written feedback are also part of Annotate. Notes is the plural of Note. `Annotation` is the technical record type used by the implementation.

Use Annotate for the capability and Note for written feedback. **Export Notes** exports only records with nonempty written feedback; clearing all annotations also removes standalone highlights and strikethrough. Replies to existing Notes remain a planned capability.

## Ways to annotate

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

`annotation.sqlite` is the only annotation authority; there is no LocalStorage fallback. Every browser admitted to the workspace can use Annotate, Progress, and Export Notes without an admin session or Share.

| Scope | Review data |
|---|---|
| Personal (Share off) | Non-admin browsers use an isolated private identity; existing administrator data keeps its original storage |
| Shared (Share on) | Everyone in the workspace reads and writes the same common dataset, with live updates |

Both scopes persist in the same SQLite database. Browser-private records use new private tables; existing administrator/common records keep the original tables. Switching scopes does not automatically publish or merge browser-private Personal data; turning Share off returns to Personal. The interface identifies the current scope.

The private identity cookie is separate from Admin. Clearing browser site data loses access to that browser's Personal records; this is not an account system or cross-device personal synchronization. A nickname and color are attribution, not identity credentials. Source-file paths remain absolute association keys. Changes use same-origin HTTP; Shared changes broadcast over WebSocket. Service failures are explicit and never fall back to browser storage.

## Clear, export, and print

The footer can clear a file's annotations after confirmation. Clearing annotations preserves section progress; use the All Read checkbox to manage read/unread section progress separately. H1 and section actions can [export Notes](/features/export), and print output retains highlights, strikethrough, and Notes. Diff pages support the same annotation workflow. See [Share](/advanced/shared-annotations) and [Data and privacy](/advanced/data-and-privacy).
