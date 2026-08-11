---
title: Viewed progress and folding
description: H2–H6 Viewed state, independent folding, local UI preferences, and section actions.
---

# Viewed progress and folding

<div class="feature-illustration">
  <img src="/illustrations/03-viewed.svg" alt="Section Viewed state" />
</div>

When `Viewed` is enabled, Markon tracks review progress by H2–H6 section. Viewed and folding interact but remain distinct states.

## Viewed

Marking a heading Viewed folds its section; clearing Viewed expands it. H1 shows page progress and bulk actions, the TOC reflects the state, and values are stored in SQLite. Shared workspaces synchronize the same Viewed dataset. Press <kbd>v</kbd> for the focused section.

## Independent folding

Press <kbd>o</kbd> to fold or expand the current section without changing Viewed. Each H2–H6 range is calculated by heading level. Fold state is a browser UI preference, is not written to SQLite, and is not synchronized. Notes temporarily expand their source section.

Print output uses placeholders for folded content by default. `print_collapsed_content` or `--print-collapsed-content` forces inclusion.

## Heading actions

Focused H2–H6 headings offer Viewed, Print, Fold/Expand, and Export Notes with a section count. H1 offers all-viewed/all-unviewed, fold/unfold all, whole-page print, and whole-page export. A section extends until the next heading at the same or a higher level.

## Storage and permissions

| State | Storage | Shared |
|---|---|---|
| Viewed | SQLite `viewed_state` | When Shared is enabled |
| Fold | Browser UI preference | Never |

With Shared off, only an administrator can read and write SQLite Viewed state. See [Shared annotations](/advanced/shared-annotations).
