---
title: Architecture
description: The markond service, GUI and CLI control planes, browser data plane, workspace persistence, and permission boundaries.
---

# Architecture

Markon consists of one long-running background service and several entry points. The desktop app and CLI connect to the same `markond` service instead of starting independent cores.

```text
┌──────────────────┐   privileged local control socket   ┌──────────────────┐
│ Desktop (Tauri 2)│ ───────────────────────────────────▶ │                  │
└──────────────────┘                                      │     markond      │
┌──────────────────┐ ───────────────────────────────────▶ │                  │
│ markon CLI       │                                      │ workspace registry
└──────────────────┘                                      │ HTTP · Git · DB  │
                                                          └────────┬─────────┘
                                                                   │ scoped HTTP /
                                                                   │ WebSocket
                                                          ┌────────▼─────────┐
                                                          │ Browser workspace│
                                                          └──────────────────┘
```

## Crate responsibilities

| Path | Responsibility |
|---|---|
| `crates/core` | HTTP routes, Markdown, search, Git, SQLite, Chat, the control protocol, and browser assets |
| `crates/markond` | The only service that owns core; restores workspaces and serves both Web and local control planes |
| `crates/cli` | The `markon` command; starts or connects to the service and manages workspaces over the control socket |
| `crates/gui` | Tauri 2 desktop shell and settings UI connected to the same control socket |

`crates/xtask` only handles build-time maintenance such as icon generation.

## Service lifecycle

The first `markon <path>` invocation:

1. reads `~/.markon/settings.json` for the listen address, port, and workspace defaults;
2. starts the compatible `markond` found on `PATH` if no service is running;
3. lets `markond` restore persistent directory workspaces and create the Web listener and user-only control socket;
4. registers the supplied path and normally opens a browser for file arguments.

Later CLI calls connect to the running service instead of occupying another port. If `markond` is unavailable, the CLI falls back to foreground service mode. The desktop app shares the same service and workspace registry. Configuration writes merge owned fields so a stale desktop snapshot cannot overwrite service-side workspace updates.

## Workspace model

### Directory workspaces

- Path, alias, feature switches, and the collaborator access-code hash live in `settings.json`.
- The workspace is restored after process restarts.
- Its URL id is derived from a persistent salt and canonical path and must remain stable across upgrades.

### Single-file workspaces

- The full file path is the identity; the parent directory is the service boundary.
- Only the document and explicitly referenced local resources inside that parent are exposed.
- `auto_remove_single_file_workspaces` defaults to `true`; disabling it preserves these workspaces across restarts.

### URL layers

| Space | Example | Purpose |
|---|---|---|
| Document | `/{workspace_id}/path/to/file.md` | Readable URL mapped to the workspace filesystem |
| Workspace features | `/_/{workspace_id}/git/history` | Search, Git, compare, settings, Chat, and WebSocket |
| Global system | `/_/css/...`, `/_/admin` | Assets and administrator bootstrap |
| Browser API | `/api/save`, `/api/chat/...` | Programmatic endpoints protected by capabilities and same-origin checks |

Workspace registration, aliases, and shutdown are local control-socket operations and are not exposed over TCP.

## Permissions are not IP roles

Markon does not treat loopback, LAN origin, or proxy headers as administrator identity:

- **Administrator sessions** come from `markon admin open` or `markon admin code` and can perform structural operations.
- **Collaborators** can only use enabled workspace capabilities such as Edit, Chat, and Shared.
- **Collaborator access codes** gate entry for non-administrator browsers.
- **The Host allowlist** rejects unregistered authorities to prevent DNS rebinding.
- Save, settings, and Git write operations additionally require same-origin or an appropriate workspace capability.

See [Access and permissions](/features/access) for the complete model.

## Persistent data

```text
~/.markon/
├── settings.json          # global settings, salt, workspaces
├── annotation.sqlite      # annotations, Viewed state, Chat
├── server.lock            # port, control socket, service version
└── logs/markond.log       # rolling background-service log
```

`markond.log` is limited to 2 MiB and retains three rotated backups. The database path can be overridden by settings or `MARKON_SQLITE_PATH`. See [Data and privacy](/advanced/data-and-privacy) for backup and cleanup guidance.
