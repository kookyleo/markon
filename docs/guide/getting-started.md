---
title: Getting started
description: Create your first Markon Workspace with the desktop app or CLI, then learn the administrator session and feature switches.
---

# Getting started

This guide takes the shortest path to a directory workspace. To open only one Markdown file, pass that file directly to Markon.

## Desktop app

### 1. Install

<DownloadButton />

Packages are available for Apple Silicon and Intel Macs, Windows x64 and ARM64, and Linux amd64 and arm64. See [Installation](/guide/installation) for first-launch security prompts.

### 2. Add a directory

Start Markon, select the **Workspaces** page, click `+` in the lower-left corner, and choose a directory containing Markdown files.

You can also enter through the system file manager:

- **macOS:** drag Markon.app into the Finder toolbar, then click it in the target directory;
- **Windows:** use Open with Markon from a directory or Markdown file's context menu.

Directory workspaces are recorded in `~/.markon/settings.json` and restored after the service restarts.

### 3. Open the browser workspace

Click the workspace card's open button. The workspace page contains:

- an expandable file tree;
- workspace path, alias, and id;
- Search, Viewed, Edit, Live, Chat, and Shared switches;
- branch, history, and working-tree information for Git repositories;
- search and current-version entry points.

A browser opened by the desktop app is guided through an administrator session, so it can change features, manage files, check out branches, and commit. A browser does not become an administrator merely because it accesses a localhost URL.

### 4. Choose a workflow

**Read and search**

1. Enable Search.
2. Open a Markdown file.
3. Press <kbd>/</kbd> or <kbd>g</kbd> to search files and content.
4. Press <kbd>?</kbd> to see the shortcuts available on the current page.

**Review a long document**

1. Enable Viewed.
2. Select text and create a highlight, strikeout, or Note.
3. Focus an H2–H6 heading; press <kbd>v</kbd> to mark it Viewed or <kbd>o</kbd> to fold it independently.
4. Use heading actions to export Notes or print that section.

**Review Git changes**

1. Return to the workspace root.
2. Open **Working diff** or a commit.
3. Switch between Rendered and Raw; Raw also supports Split and Unified layouts.
4. Use Viewed to process files and <kbd>j</kbd>/<kbd>k</kbd> to focus changes.

## CLI and servers

### 1. Install both binaries

```bash
cargo install markon markond
```

`markon` is the local control client and `markond` is the background service. Both should be on `PATH`. If the CLI cannot find `markond`, it falls back to foreground service mode.

### 2. Open a file or directory

```bash
markon README.md  # path arguments open the browser by default
markon docs/      # directory workspace
markon -b         # current directory, explicitly open the browser
```

The first command starts the background service. Later commands add paths to the same service.

### 3. Manage workspaces

```bash
markon ls
markon set 1 edit on
markon set 1 shared on
markon detach 1
markon shutdown
```

Bare `markon ls` opens a TUI in an interactive terminal and prints static cards when piped or redirected. Use `--format cards|table` to choose explicitly.

### 4. SSH and administrator sessions

On a headless server:

```bash
markon admin code
```

Enter the one-time pairing code on the browser's administrator bootstrap page. Administrator sessions remain separate from ordinary collaborator sessions.

### 5. LAN or reverse proxy

```bash
# LAN
markon docs/ --host 0.0.0.0 --entry http://192.168.1.20:6419

# HTTPS reverse proxy
markon docs/ --host 127.0.0.1 \
  --entry https://docs.example.com \
  --trusted-host https://docs.example.com
```

`--entry` supplies the displayed/QR-code address and registers its Host and origin. Public deployments still need TLS at the reverse proxy; see [Reverse proxy](/advanced/reverse-proxy).

## Single-file workspaces

```bash
markon path/to/README.md
```

A single-file workspace:

- searches only that file;
- exposes only the document and explicitly referenced local resources that remain inside its parent directory;
- is removed automatically on the next service start by default;
- can be retained by disabling automatic removal in desktop global settings.

## Next steps

- [Feature overview](/features/)
- [Architecture](/guide/architecture)
- [Access and permissions](/features/access)
- [Data and privacy](/advanced/data-and-privacy)
- [Complete CLI reference](/guide/cli)
