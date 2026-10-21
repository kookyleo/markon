---
title: Share
description: Share annotations and section progress markers with collaborators, using SQLite authority and live updates.
---

# Share

<div class="feature-illustration"><img src="/illustrations/07-sync.svg" alt="Share annotations and reading progress" /></div>

**Share** lets collaborators read, edit, and synchronize the same annotations and section progress markers. The data always lives in local SQLite. Personal review works without Share; this switch selects common review data and live updates.

Share is the capability name. Shared names the common review scope, describes an already shared state, or is an ordinary English adjective. Older interfaces may still label this capability Shared. The CLI uses `share` and retains `shared` as an alias; the configuration field `shared_annotation` and this page's URL remain unchanged.

## Enable

Turn on `Share` from an admin workspace page or run:

```bash
markon set <ID|INDEX> share on
```

Three-color highlights, strikethrough, Notes, and H2–H6 section progress markers are shared. Reading-position memory, ordinary folding, and Markdiff's per-file progress remain browser-local. Live provides presentation following separately.

## Data flow

```text
Browser A ── same-origin HTTP command ──▶ SQLite
                                              │
                                              ├── WebSocket event ──▶ Browser B
                                              └── WebSocket event ──▶ Browser C
```

WebSockets broadcast successful changes but do not accept database writes. Reconnecting clients reload authoritative server state rather than merging an offline copy.

## Personal and Shared scopes

Every browser admitted to the workspace can use Annotate, Progress, and Export Notes. Admin is not a prerequisite for these essential capabilities.

| Share | Current scope | Review data |
|---|---|---|
| Off | Personal | Non-admin browsers have isolated Personal records; administrators retain their existing records |
| On | Shared | Everyone in the workspace reads and writes the same common records, with live sync |

Both scopes persist in the same SQLite database. Browser-private records use new private tables; existing administrator/common records retain the original tables. Enabling Share does not automatically publish or merge browser-private Personal data. Turning it off restores Personal access without moving or deleting either dataset. The interface displays Personal or Shared so the active scope is clear.

Administrator Personal data uses the original owner tables, the same legacy dataset that Share exposes as common review. Enabling Share therefore makes those existing owner records available to collaborators. The browser-private Personal tables remain separate and are never automatically imported. API scopes are `owner`, `personal`, and `shared`; the interface labels both owner and browser-private scopes Personal.

A private identity cookie, separate from Admin, gives the browser access to its Personal records. Clearing browser site data loses that access. It is not an account, and there is no account recovery or cross-device synchronization of Personal records. Nicknames and colors do not authenticate the private identity.

Edit and Chat follow their own workspace switches. Share does not grant source editing, AI, or administrative permissions. Live provides presentation following separately and does not publish Personal review data.

## Multiple devices

```bash
markon docs/ \
  --host 0.0.0.0 \
  --public-base-url http://192.168.1.20:6419 \
  --collaborator-access-code guest-secret
```

`markon ls` can copy a collaborator URL only for workspaces with Share enabled; it never includes admin bootstrap credentials.

The database defaults to `~/.markon/annotation.sqlite` or `%USERPROFILE%\.markon\annotation.sqlite` and can be overridden with `MARKON_SQLITE_PATH`.

Share works well for small-team reviews and multi-device reading. Browser-isolated Personal review is available with Share off; it does not provide account-based cross-device private synchronization, RBAC, approval workflows, audit logs, or offline automatic merging. Back up `settings.json` and SQLite while stopped; use `markon cleanup` only after confirming orphaned data is no longer needed. See [Data and privacy](/advanced/data-and-privacy).
