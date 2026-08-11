---
title: Command-line options
description: Markon CLI arguments, subcommands, service behavior, and common deployment examples.
---

# Command-line options

`markon` is the local client for the `markond` background service. It resolves configuration, starts or connects to the service, registers workspaces, and performs management operations through a per-user local control socket.

## Install

```bash
cargo install markon markond
```

Both binaries should be on `PATH`. If `markond` is missing, `markon` serves the workspace in the foreground.

## Syntax

```text
markon [OPTIONS] [FILE]
markon <COMMAND>
```

`FILE` may be a Markdown file or a directory. When omitted, the current directory is used. Passing a path attempts to open the browser by default.

::: tip Desktop users
The desktop **Tips** page includes a CLI command builder for paths, addresses, access codes, and shell aliases.

![CLI command builder in the desktop app](/screenshots/gui-cli-builder.png)
:::

## Main options

| Option | Behavior |
|---|---|
| `-p, --port <PORT>` | Web port, default `6419`; overrides saved settings |
| `--host [IP]` | Bind address; without a value, opens the interface picker |
| `--entry [URL_PREFIX]` | Public URL prefix used for QR codes and the Host/origin allowlist |
| `--qr [URL_PREFIX]` | Alias for `--entry` |
| `--trusted-host <HOST_OR_ORIGIN>` | Additional exact authority; repeatable |
| `-b, --open-browser [BASE_URL]` | Open a browser, using the local URL or the supplied base URL |
| `--collaborator-access-code <CODE>` | Set the workspace collaborator code; an empty string clears it |
| `--print-collapsed-content` | Include collapsed bodies in print output |
| `--salt <SALT>` | Advanced workspace-ID salt override; do not change it on an existing installation |

Feature flags are managed with `markon set`, the desktop app, or the browser admin page.

## Subcommands

### `markon ls`

```bash
markon ls
markon ls --format cards
markon ls --format table
```

With interactive stdin and stdout, the bare command opens a TUI. Otherwise it falls back to cards. Results include workspace ID and path, feature flags, search readiness, local/public addresses, and QR details.

### `markon set`

```bash
markon set <ID|INDEX> <FEATURE> <on|off>
```

Features are `search`, `viewed`, `edit`, `live`, `chat`, and `shared`.

```bash
markon set 1 edit on
markon set a1b2c3d4 chat off
```

### `markon detach`

```bash
markon detach <ID|INDEX>
```

Removes a workspace from the running and persisted registries. It does not delete source files or SQLite history.

### `markon cleanup`

```bash
markon cleanup
markon cleanup --yes
```

Reports and optionally removes annotations, Viewed state, and Chat data that no active workspace owns. Back up the database and read [Data and privacy](/advanced/data-and-privacy) first.

### `markon admin`

```bash
markon admin open
markon admin code
```

`open` launches a one-time URL-fragment nonce valid for 60 seconds. `code` prints a five-minute pairing code for SSH or headless use. Both exchange for the same short-lived `HttpOnly` admin session; loopback requests are not automatically administrators.

### `markon shutdown`

Requests a graceful service shutdown and clears the runtime lock.

### `markon bug`, `idea`, and `ask`

```bash
markon bug  [-t TITLE] [-b BODY]
markon idea [-t TITLE] [-b BODY]
markon ask  [-t TITLE] [-b BODY]
```

These use an authenticated `gh` client to create a GitHub issue or discussion.

## One service, multiple workspaces

```bash
markon project-a/
markon project-b/
markon README.md
markon ls
```

The first call starts `markond`; later calls connect to it. Directory workspaces are persisted and restored. Single-file cleanup follows the global setting. An incompatible service version is refreshed before a newer client sends control commands.

## Addresses and browser behavior

```bash
markon README.md
markon
markon -b
markon -b https://docs.example.com docs/
```

`--open-browser BASE_URL` appends the workspace path to the supplied base URL, which is useful behind a reverse proxy.

## Binding examples

```bash
markon docs/
markon docs/ --host
markon docs/ --host 0.0.0.0
markon docs/ --host 192.168.1.5
```

For a LAN:

```bash
markon docs/ --host 0.0.0.0 \
  --entry http://192.168.1.20:6419 \
  --collaborator-access-code guest-secret
```

Behind a reverse proxy:

```bash
markon docs/ --host 127.0.0.1 \
  --entry https://docs.example.com \
  --trusted-host https://docs.example.com
```

![CLI output with access URLs and QR code](/screenshots/cli-qr.png)

`--entry` describes the external origin; it does not provide TLS. See [Reverse proxy](/advanced/reverse-proxy).

## Setting precedence

The CLI reads `~/.markon/settings.json`. Explicit command-line arguments override saved global settings, which override built-in defaults. Theme, language, custom CSS, shortcuts, providers, workspace registry, and default feature flags are shared with the desktop app.

## Database override

```bash
MARKON_SQLITE_PATH=/srv/markon/annotation.sqlite markon docs/
```

The database stores annotations, Viewed state, and Chat. Shared mode changes collaborator permissions and broadcasting, not the storage location.
