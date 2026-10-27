---
title: Progress and folding
description: H2–H6 Progress state, independent folding, local UI preferences, and section actions.
---

# Progress and folding

<div class="feature-illustration">
  <img src="/illustrations/03-viewed.svg" alt="Section Progress state" />
</div>

Progress is an essential capability: Markon tracks review progress by H2–H6 section, subject to review-data permissions. Progress and folding interact but remain distinct states.

Older interfaces may call Progress Viewed. The CLI argument `viewed`, database field `viewed_state`, and this page's URL retain their existing names.

## Progress

The capability remains **Progress**, while the section checkbox is **Read**. Checking it marks the section as read and folds it; unchecking marks it as unread and expands it. The tooltip is **Mark as read** or **Mark as unread** according to the current state. H1 uses **All Read**, with bulk read/unread tooltips. The TOC reflects the read state, and values are stored in SQLite. Workspaces with Share enabled synchronize the same section progress dataset. Press <kbd>v</kbd> for the focused section.

## Outline, Focus, and Resume

Outline navigates headings in the table of contents. Focus follows the current section through scrolling, TOC selection, or `j` / `k`. Resume remembers the reading position in the current browser; it is separate from Progress and is not shared by Share.

## Independent folding

Press <kbd>o</kbd> to fold or expand the current section without changing Progress. Each H2–H6 range is calculated by heading level. Fold state is a browser UI preference, is not written to SQLite, and is not synchronized. Notes temporarily expand their source section.

Print output uses placeholders for folded content by default. `print_collapsed_content` or `--print-collapsed-content` forces inclusion.

## Heading actions

Focused H2–H6 headings offer Read, Print, Export Notes with a section count, then Fold/Unfold. H1 uses the same order: All Read, whole-page print, whole-page export, then fold/unfold all. A section extends until the next heading at the same or a higher level.

Every browser admitted to the workspace can use Progress in its current Personal or Shared scope. Print, Export Notes, and folding are also essential; export reads only the current scope. Export is disabled with a count of `0` when no text Notes are available. A title-only document retains page print and export without empty bulk Progress or folding controls. Documents without H1 have no H1 toolbar.

In the capability catalog, folding belongs to Reading, progress markers to Review, and Export Notes to Output. The `?` panel lists the shortcuts registered for the current page. The `o` shortcut works independently of Progress; `v` operates on the current review scope without requiring an admin session or Share.

## Storage and permissions

| State | Storage | Sharing |
|---|---|---|
| Progress | SQLite; private records use browser-isolated tables, existing/common records retain `viewed_state` | Common scope only when Share is enabled |
| Fold | Browser UI preference | Never |

With Share off, non-admin browsers persist their own isolated Personal section progress; administrators retain their existing records. With Share on, the workspace uses common section progress without automatically merging Personal records. Markdiff's file progress is separate and browser-local. See [Share](/advanced/shared-annotations).
