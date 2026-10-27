---
title: Data and privacy
description: Settings, SQLite, logs, browser preferences, AI outbound boundaries, backups, and orphan-data cleanup.
---

# Data and privacy

Reading, rendering, search, Git, and review state stay local by default. AI Chat is the optional capability that sends selected workspace context to an external Provider.

## Storage locations

| Data | Default location |
|---|---|
| Settings, salt, workspace registry, Providers | `~/.markon/settings.json` |
| Annotations, section progress, Chat threads/messages | `~/.markon/annotation.sqlite` |
| Runtime service metadata/control socket | `~/.markon/server.lock` |
| Service logs | `~/.markon/logs/markond.log` with 2 MiB current + 3 backups |
| UI preferences, reading positions, and diff file progress | Current browser storage |

Override the database with `MARKON_SQLITE_PATH=/path/to/annotation.sqlite` or desktop settings.

## SQLite is authoritative

Annotations and section progress never fall back to LocalStorage. Every admitted browser can write its current review scope through same-origin document-state requests. With Share off, non-admin browsers use browser-isolated private tables in the same SQLite; administrator legacy records stay in the original tables. Share selects common records and broadcasts; switching never automatically publishes or merges browser-private Personal records, and turning Share off restores Personal access without moving or deleting data.

Annotations and section progress are associated with absolute file paths; browser-private records additionally use the private browser identity as an isolation key. Chat is keyed by stable workspace ID. Moving a file changes the review association; upgrading or restarting must not. Markdiff's file progress, ordinary folding, and reading-position memory remain browser-local and are outside Share's synchronized dataset.

## What AI sends

Provider requests occur only after a Provider is configured, Chat is enabled for the workspace, and the user sends a message. Input may include the question, current path, selection, `@` attachments, file-tool results, and thread history. Rendering, search, annotations, Progress, Live, and Git do not upload content. API keys are plain text in `settings.json`.

With Edit enabled, AI may propose an exact replacement. Every change requires Apply, checks for drift, and may be undone. It cannot create/move/delete files, run commands, or access the network through Markon tools.

## Browser permissions

Annotate, Progress, and Export Notes require workspace admission, not Admin or Share. Share off provides Personal review; Share on selects common review data. Chat and Edit require explicit switches, while structural and management operations remain admin-only. Loopback is not automatically admin.

The private identity cookie (`markon_personal_review`) is separate from the administrator session. It lasts 365 days and uses HttpOnly, SameSite=Lax, and Secure on explicit HTTPS origins. Clearing browser site data or letting the cookie expire loses the entry to that browser's Personal records, without deleting the SQLite rows. This is browser isolation, not an account; there is no account recovery or cross-device personal synchronization. Backing up SQLite preserves records but does not replace the private identity cookie.

## Backup

Stop the service, then copy both authoritative files:

```bash
markon shutdown
mkdir -p ~/.markon/backup-manual
cp ~/.markon/settings.json ~/.markon/annotation.sqlite ~/.markon/backup-manual/
```

Cold backup keeps the workspace-ID salt and database at one point in time. Uninstalling does not remove `~/.markon`.

## Remove orphaned data

```bash
markon cleanup
markon cleanup --yes
```

The command reports and cleans original and browser-private annotation / Progress records, Chat data, and estimated payload outside every registered workspace. Private rows are selected by absolute-file-path ownership and deleted with their subject-aware compound keys, preserving other browser identities. A full SQLite backup includes both private and original tables.

::: warning
Cleanup is irreversible. Back up the database and re-register any workspace you still need first.
:::

## Before public exposure

Terminate TLS at a reverse proxy, register exact `--public-base-url`/`--trusted-host` origins, consider gateway authentication, enable Edit/Chat/Share only where needed, and protect settings/database permissions. See [Reverse proxy](/advanced/reverse-proxy).
