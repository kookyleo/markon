---
title: Workspace AI
description: Anthropic and OpenAI-compatible providers, workspace file tools, citations, threads, and approval-based edits.
---

# Workspace AI

<div class="feature-illustration"><img src="/illustrations/12-chat.svg" alt="Markon Workspace AI" /></div>

Workspace AI is a reading assistant constrained to the current workspace. It can investigate files and return clickable evidence. With Edit enabled, it can propose exact changes that still require user approval.

## Enable it

Configure a Provider, API key, base URL, and model under **Global settings → AI Chat**, then enable `Chat` for a workspace. Enable `Edit` as well to allow proposals. Anthropic and configurable OpenAI-compatible APIs are supported. API keys are stored in plain text in `~/.markon/settings.json`; protect that file like any development credential.

## Ways to open Chat

- Click the Chat orb or press <kbd>c</kbd> for the movable in-page panel.
- Use the popout default or <kbd>Shift</kbd>+<kbd>c</kbd> for the opposite surface.
- Select document text and choose Chat to attach it as a removable reference.
- Type `@` to attach a readable workspace text file.

## Investigation tools

Sessions receive `read_file`, `list_dir`, `glob`, and `grep`. Paths must stay within the workspace capability; binary/non-UTF-8 files are rejected; one file is limited to 1 MiB; one tool result to 64 KiB; and a user turn to eight agent steps. The model cannot execute commands or access the network through these tools.

## Approval-based editing

With Chat and Edit enabled, `edit_file(path, old_string, new_string)` proposes one exact-string replacement. Markon validates the path and unique match, shows an old/new diff, and pauses for **Apply** or **Reject**. Apply rereads the file to detect drift. A successful edit offers Undo with another content check. The tool cannot create, move, or delete files, nor run commands.

## Citations and threads

References such as `path/file.md:42`, `path/file.md:42-58`, and `path/file.md#heading-id` become workspace links. Each workspace can keep multiple persisted threads with titles, messages, tool calls, and edit state in `annotation.sqlite`.

## Privacy and cost

Provider requests may contain the question, thread history, current path, selection, attached files, tool results, and edit results. Enabling Chat does not upload the entire directory automatically, but every file the model requests becomes Provider input. See [Data and privacy](/advanced/data-and-privacy).
