---
title: Git browsing and diffs
description: Branches, tags, history, working and commit diffs, arbitrary ref comparison, and admin-only writes.
---

# Git browsing and diffs

For directory workspaces inside a Git repository, Markon adds read-only repository context and a small set of admin-only local writes.

## Workspace page

The root page shows the current branch or detached HEAD, branch/tag/commit counts, recent commit details, Clean/Dirty state, HEAD-to-parent diff, Working diff, and per-file recent commits. Collaborators may browse refs; checkout remains admin-only.

## History, branches, and tags

History filters by branch, author, and time and opens complete Markdown diffs. Branches show current/default status and ahead/behind information; tags are ordered by time. These pages read only the local repository.

## Three diff scopes

| Entry | Comparison |
|---|---|
| Working diff | HEAD versus the worktree, including untracked Markdown |
| Commit diff | A commit versus its parent |
| Compare | Any valid base and compare ref, optionally the worktree |

Raw and Rendered views share structured backend data.

## Rendered and Raw

Rendered compares Markdown AST blocks and marks word-level changes while folding unchanged context. Raw shows source lines in Split or Unified layout. Both support file/status filtering, per-file Viewed state, `j`/`k` change navigation, `n`/`p` file navigation, `m` view switching, annotations, Notes export, and links back to the workspace version.

## Admin operations

Checkout, local commit creation, and structural file operations require an explicit admin session and same-origin checks. Markon never fetches, pulls, pushes, merges, rebases, or stores remote credentials; it is a Markdown review surface, not a full Git client.

Refs are validated by Git rather than interpolated into a shell, repository reads remain scoped to the workspace repository, and file reads still pass through WorkspaceFs. For remote use, configure [Access control](/features/access) and a [Reverse proxy](/advanced/reverse-proxy).
