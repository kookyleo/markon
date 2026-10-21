---
title: Features
description: An overview of Markon's workspaces, reading and review tools, Git integration, collaboration, AI, and permission boundaries.
aside: false
---

# Features

Markon is not a static-site generator or a Markdown preview with different CSS. It builds a workspace around a local file or directory and keeps reading, review, editing, Git comparison, and collaborative following in one workflow.

## Workspace

| Capability | What it provides |
|---|---|
| [Workspace / Files](/features/workspaces) | Directory and isolated single-file workspaces managed by one service |
| [Spotlight / Search](/features/search) | File names, H1 titles, full-text results, and keyboard navigation; content results require a ready index |

## Reading

| Capability | What it provides |
|---|---|
| [Markdown](/features/rendering) | GFM, KaTeX, Diagrams, Media, Viewer, and Zoom |
| [Outline / Focus / Fold / Resume](/features/viewed) | Heading navigation, section focus, independent folding, and browser-local reading positions |

## Review

| Capability | What it provides |
|---|---|
| [Annotate](/features/annotations) | Highlight, Strike, Note, Navigate, and Undo / Redo |
| [Progress](/features/viewed) | Read / All Read controls track document section progress; Markdiff file read state is separate and browser-local |
| [Git / Markdiff](/features/git) | Branches, tags, history, working changes, arbitrary ref comparison, and Rendered / Raw views |

## Edit

[Edit](/features/edit) is optional and provides Edit Here, Preview, and Save Guard.

## Workspace AI

[Workspace AI](/features/chat) uses the Chat advanced switch. It provides Mentions, Citations, Threads, Suggestions, and Approval; file writes also require Edit.

## Team

| Capability | What it provides |
|---|---|
| [Live](/features/live) | Present / Follow for page navigation, reading positions, focus, and selections; section progress synchronizes through Share |
| [Share](/advanced/shared-annotations) | Common annotations and document section progress; Personal review works with Share off; excludes local diff file progress, folds, and reading positions |

## Output

| Capability | What it provides |
|---|---|
| [Export Notes](/features/export) | Editable Markdown from page or section Notes, with Copy and Download; disabled at zero |
| [Print](/features/print) | Print a page or section, including browser Save as PDF |

## Settings

[Access](/features/access), [Privacy](/advanced/data-and-privacy), [Theme / Typography](/advanced/custom-styles), and [Actions / Shortcuts](/advanced/shortcuts) belong to management and preferences. Administrative operations still require an administrator.

## Essentials and Advanced

Essential capabilities come with the workspace. Advanced capabilities are enabled deliberately:

| Tier | Capabilities | Controls |
|---|---|---|
| Essentials | Workspace, Files, Spotlight, Search; Markdown, Viewer, Outline, Fold, Resume; Annotate, Progress, Git, Markdiff; Export Notes, Print; themes and shortcuts | Available according to content, context, and permissions |
| Advanced | Edit, Chat, Live, Share | Enabled per workspace by an administrator; off by default |

The advanced control row is `Edit · Chat · Live · Share`. New workspaces inherit these defaults from global settings; all four are off in a new installation. Administrators can change them independently in the browser, desktop app, or CLI. Search and Progress have no switches.

Every browser admitted to the workspace can use Personal Annotate, Progress, and Export Notes. Share off isolates non-admin browser records in the same SQLite; Share on selects common review data without automatically publishing or merging browser-private Personal records. Git and Viewer depend on repository and media context. Source writes, administrative actions, and AI requests retain their own authorization requirements.

## Availability and compatibility

The feature overview describes the complete product. Advanced switches select optional workflows. The `?` Actions panel lists shortcuts registered for the current page; heading controls also offer actions without dedicated shortcuts, such as printing and bulk folding.

| Capability | Availability |
|---|---|
| Files, Spotlight, Search | Essential; full-text results require a ready index |
| Section Progress | Essential; current Personal / Shared scope |
| Fold and Print | Essential; according to headings and page content |
| Annotate and Export Notes | Essential; current Personal / Shared scope; export requires text Notes in scope |
| Edit | Edit enabled; structural file operations additionally require an administrator |
| Chat | Chat enabled; file changes also require Edit and approval |
| Live | Live enabled; does not publish Personal data or enable Share |
| Share | Share enabled; selects common annotations and section progress, preserving Personal records |

H1 offers page actions and H2–H6 offer section actions. Print, Fold, and Export Notes have the same availability rules in both places. Export stays visible but disabled with a count of `0`. See [Progress / Fold](/features/viewed).

Existing workspace fields `enable_search` / `enable_viewed` and global default fields `default_search` / `default_viewed` remain readable for compatibility, but legacy `false` values no longer disable these essential capabilities. Workspace IDs, document URLs, annotations, and saved progress are preserved. Technical names such as `viewed_state`, `shared_annotation`, and existing documentation URLs retain their names. See [CLI compatibility](/guide/cli#markon-set).

## Where to begin

- New to Markon: [Getting started](/guide/getting-started)
- Server deployment: [Runtime architecture](/guide/architecture) and [Reverse proxy](/advanced/reverse-proxy)
- Storage and outbound data: [Data and privacy](/advanced/data-and-privacy)
- Current CLI behavior: [Command-line options](/guide/cli)
