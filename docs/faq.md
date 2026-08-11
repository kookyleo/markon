---
title: Frequently asked questions
description: Answers about installation, workspaces, data, access, rendering, collaboration, and performance.
---

# Frequently asked questions

## Installation and startup

### Why install both `markon` and `markond`?

`markon` is the local control client; `markond` is the long-running service. Install both with `cargo install markon markond`. Without `markond` on `PATH`, the CLI falls back to foreground service mode and keeps the terminal occupied.

### macOS cannot verify the developer

The current package uses an ad-hoc signature. After the first attempt, open **System Settings → Privacy & Security** and choose **Open Anyway**. On older macOS, Control-click Markon.app in Applications and choose Open.

### Windows SmartScreen blocks the installer

Choose **More info → Run anyway**. The current NSIS installer does not use a commercial signing certificate.

### How do I inspect or stop the service?

Use `markon ls` (or `markon ls --format table` in scripts) and `markon shutdown`.

## Workspaces

### Can I open multiple files or directories?

Yes. One `markond` manages many workspaces. Directory workspaces survive restarts; single-file registry cleanup follows `auto_remove_single_file_workspaces` and is enabled by default.

### Does a single-file workspace expose sibling files?

No. It exposes the Markdown file and explicitly referenced assets that remain inside its parent directory. Unreferenced siblings, escaping paths, and escaping symlinks are rejected.

### Does detach delete files or annotations?

No. It removes the workspace registration only. SQLite history remains until you intentionally run `markon cleanup`.

### Why must workspace URLs remain stable?

The workspace ID participates in URLs and Chat associations and derives from a persistent salt plus canonical identity path. Do not casually replace the salt or expect moved files to keep path-based associations.

## Annotations, Viewed, and data

### Where is data stored?

Settings are in `~/.markon/settings.json`, review and Chat data in `~/.markon/annotation.sqlite`, runtime metadata in `~/.markon/server.lock`, and logs in `~/.markon/logs/markond.log`. Uninstalling does not delete them.

### Do annotations fall back to LocalStorage?

No. SQLite is authoritative for annotations and Viewed. On permission or service failure the page becomes explicitly read-only. Pure UI preferences such as folding or panel positions may remain browser-local.

### Does turning Shared off move data?

No. Shared controls collaborator access and broadcasts, not the storage location.

### How should I back up?

Stop the service and copy both `settings.json` and `annotation.sqlite` so the workspace-ID salt and database come from the same point in time.

## Access and remote use

### Is a local browser automatically admin?

No. Use `markon admin open` or `markon admin code`. Loopback, LAN source, and proxy headers never grant admin identity.

### How do I gate collaborators?

Run `markon docs/ --collaborator-access-code guest-secret`. Only a salted hash persists. A workspace code overrides the global code. This does not replace TLS.

### Can I expose Markon directly to the internet?

Put it behind an HTTPS reverse proxy, register exact `--entry`/`--trusted-host` origins, and consider gateway authentication. See [Reverse proxy](/advanced/reverse-proxy).

## Editing, Git, and AI

### Does concurrent editing merge automatically?

No OT/CRDT merge is provided; a later save may overwrite an earlier one. AI Apply performs drift detection, but normal editing still needs coordination or Git.

### Does Markon push Git changes?

No. It reads local history/diffs and lets admins checkout or make a local commit. It never fetches, pulls, pushes, merges, or rebases.

### Does AI upload the entire workspace?

Not automatically. Messages, selections, `@` files, thread history, and file-tool results are sent to the configured Provider as used. Enable Chat only where that boundary is acceptable.

### Can AI modify files directly?

With Chat and Edit enabled, it can propose an exact replacement. Every proposal waits for Apply/Reject and checks drift. It cannot create, move, delete, or execute commands.

## Rendering and performance

### Which extensions are supported?

GFM, footnotes, GitHub Alerts, emoji shortcodes, syntax highlighting, KaTeX, Mermaid, PlantUML, D2, Graphviz, Vega/Vega-Lite, ECharts, and Chart.js.

### What if a diagram or image is too large?

Open the full-screen viewer for zoom, pan, pinch, box zoom, and fit-to-window controls.

### Does a large workspace duplicate all text in memory?

Search uses a temporary memory-mapped index; content is indexed but not duplicated as a stored field. Initial reads are batched in groups of 64, and watcher updates are coalesced.

### Can Markon export HTML or PDF?

There is no static HTML exporter. Print a full page or section and choose Save as PDF. Notes export produces editable Markdown.

## Product scope

### How is this different from GitHub Markdown?

Markon adds local workspaces, full-text search, annotations, Viewed progress, editing, rendered Git diffs, Live, Workspace AI, and custom themes.

### Is Markon a static-site generator or Obsidian replacement?

No. It does not publish a generated site and does not target backlinks, graphs, or a plugin ecosystem. Its focus is reading and reviewing local Markdown/Git workspaces.
