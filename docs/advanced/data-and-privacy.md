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
| Annotations, Viewed, Chat threads/messages | `~/.markon/annotation.sqlite` |
| Runtime service metadata/control socket | `~/.markon/server.lock` |
| Service logs | `~/.markon/logs/markond.log` with 2 MiB current + 3 backups |
| Pure UI preferences | Current browser storage |

Override the database with `MARKON_SQLITE_PATH=/path/to/annotation.sqlite` or desktop settings.

## SQLite is authoritative

Annotations and Viewed never fall back to LocalStorage. Same-origin document-state requests write SQLite; unauthorized pages remain read-only; Shared adds collaborator access and broadcasting without changing databases; turning Shared off does not move or delete records.

Annotations and Viewed are keyed by absolute file path, while Chat is keyed by stable workspace ID. Moving a file changes the review association; upgrading or restarting must not.

## What AI sends

Provider requests occur only after a Provider is configured, Chat is enabled for the workspace, and the user sends a message. Input may include the question, current path, selection, `@` attachments, file-tool results, and thread history. Rendering, search, annotations, Viewed, Live, and Git do not upload content. API keys are plain text in `settings.json`.

With Edit enabled, AI may propose an exact replacement. Every change requires Apply, checks for drift, and may be undone. It cannot create/move/delete files, run commands, or access the network through Markon tools.

## Browser permissions

With Shared off, review state requires an admin session. With Shared on, unlocked collaborators use the same SQLite dataset. Chat and Edit require explicit workspace flags, while structural operations remain admin-only. Loopback is not automatically admin.

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

The command reports annotations, Viewed state, Chat threads/messages, and estimated payload outside every registered workspace before deletion.

::: warning
Cleanup is irreversible. Back up the database and re-register any workspace you still need first.
:::

## Before public exposure

Terminate TLS at a reverse proxy, register exact `--entry`/`--trusted-host` origins, consider gateway authentication, enable Edit/Chat/Shared only where needed, and protect settings/database permissions. See [Reverse proxy](/advanced/reverse-proxy).
