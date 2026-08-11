---
title: Workspaces and file browsing
description: Markon multi-workspace management, single-file isolation, directory browsing, file operations, and Spotlight entry points.
---

# Workspaces and file browsing

A **workspace** is Markon's basic unit. It can be a directory or a strictly scoped single file.

## Directory dashboard

A directory workspace provides:

- a GitHub-style file tree with recent commit summaries;
- inline directory expansion saved in the URL hash;
- All files and Markdown filters;
- file-name, H1-title, and content results in Workspace Spotlight;
- branch, tag, commit, and working-tree information for Git repositories;
- six workspace feature flags and Git status;
- copyable aliases, absolute paths, workspace IDs, and URLs.

Column widths are resizable and saved in the browser. Narrow screens use a single-column layout.

## File and directory operations

With an admin session, you can create Markdown files and directories, delete files, rename the workspace alias, and change `Search`, `Viewed`, `Edit`, `Live`, `Chat`, and `Shared`. Every endpoint rechecks the admin role, same origin, and workspace path; collaborators cannot gain structural write access by constructing requests manually.

## Workspace Spotlight

Press <kbd>/</kbd> or <kbd>g</kbd> to search file names, paths, top-level H1 titles, and indexed content. Arrow keys move, Enter opens, and Esc closes. File navigation remains available when Search is disabled. See [Workspace Spotlight](/features/search).

## Directory persistence

Directory workspaces are stored in `~/.markon/settings.json`. Paths, aliases, flags, and stable workspace IDs survive a service restart. Registering the same path updates the existing entry. `markon detach <id|index>` unregisters it without deleting files or review history.

## Single-file isolation

Opening one `.md` or `.markdown` file creates a single-file workspace:

- search covers only that file;
- unrelated sibling files are inaccessible;
- explicitly referenced images, styles, audio, and video may be read only within the parent directory;
- escaping `../`, absolute paths, and out-of-bound symlinks are rejected.

`auto_remove_single_file_workspaces` controls whether these workspaces are removed from the registry on the next service start and defaults to enabled.

## One shared registry

```bash
markon docs/
markon README.md
markon ls
markon set 1 edit on
markon detach 1
```

The desktop app, CLI, and browser admin page all observe the same service registry. See [Command-line options](/guide/cli).
