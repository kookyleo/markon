---
title: Features
description: An overview of Markon's workspaces, reading and review tools, Git integration, collaboration, AI, and permission boundaries.
aside: false
---

# Features

Markon is not a static-site generator or a Markdown preview with different CSS. It builds a workspace around a local file or directory and keeps reading, review, editing, Git comparison, and collaborative following in one workflow.

## Workspace foundation

| Capability | What it provides |
|---|---|
| [Workspaces and files](/features/workspaces) | One `markond` service manages directory and isolated single-file workspaces |
| [Markdown rendering](/features/rendering) | Supramark AST, GFM, KaTeX, server-side diagrams, and controlled local media |
| [Workspace Spotlight](/features/search) | File names, H1 document titles, content search, and keyboard navigation |
| [Git browsing and diffs](/features/git) | Branches, tags, history, working changes, arbitrary refs, and Rendered/Raw views |

## Reading and review

| Capability | What it provides |
|---|---|
| [Annotations and Notes](/features/annotations) | Three highlight colors, strikethrough, cross-block anchors, Notes, undo, and redo |
| [Viewed and folding](/features/viewed) | H2–H6 Viewed state, independent folding, progress, and section actions |
| [Export Notes](/features/export) | Editable Markdown for a page or section, ready to copy or download |
| [Section printing](/features/print) | Print only the active heading range, with configurable collapsed content |
| [Source editing](/features/edit) | Lazy-loaded CodeMirror, source selection, live preview, and protected saving |

## Collaboration, AI, and access

| Capability | What it provides |
|---|---|
| [Live](/features/live) | Broadcast and Follow for the active section, selection, and Viewed state |
| [Shared annotations](/advanced/shared-annotations) | One SQLite authority with WebSocket broadcasts when sharing is enabled |
| [Workspace AI](/features/chat) | Workspace-scoped file tools, citations, threads, and approval-based edits |
| [Access control](/features/access) | Admin sessions, collaborator codes, feature flags, Host allowlists, and same-origin checks |

## Default feature flags

New workspaces inherit global defaults. `Search` and `Viewed` are enabled by default; `Edit`, `Live`, `Chat`, and `Shared` are disabled. Each workspace can then be configured independently by an administrator in the browser, desktop app, or CLI.

## Where to begin

- New to Markon: [Getting started](/guide/getting-started)
- Server deployment: [Runtime architecture](/guide/architecture) and [Reverse proxy](/advanced/reverse-proxy)
- Storage and outbound data: [Data and privacy](/advanced/data-and-privacy)
- Current CLI behavior: [Command-line options](/guide/cli)
