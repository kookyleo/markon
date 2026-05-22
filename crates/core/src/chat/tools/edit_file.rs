//! `edit_file` — human-in-the-loop file edit tool for the chat agent.
//!
//! The model produces `{path, old_string, new_string}` like the standard
//! Anthropic / Claude Code edit primitive: exact-string replace, fail loud
//! on ambiguity or drift. The twist is the workflow:
//!
//! 1. We validate (path-sandbox, UTF-8, size cap, exact match, unique
//!    occurrence).
//! 2. We stash the proposal in the workspace-scoped
//!    [`PendingEditStore`](crate::chat::edits::PendingEditStore), keyed by a
//!    fresh id.
//! 3. We emit `AgentEvent::EditPending` to the SSE stream so the client can
//!    render a diff card and switch the chat input area into accept/reject mode.
//! 4. We then **block** on the oneshot the store hands us — the chat agent
//!    cannot continue to the model until the user resolves this proposal.
//! 5. The HTTP `POST /:ws/_/chat/edits/{id}/{apply|reject}` handler re-checks
//!    drift, writes (or refuses) the file, and sends a [`Resolution`] back
//!    through the oneshot.
//! 6. We translate the resolution into a `tool_result` string the model can
//!    reason about.
//!
//! Registration is gated by `enable_chat && enable_edit` at the route layer;
//! the tool itself does not re-check the flags.

use crate::chat::agent::AgentEvent;
use crate::chat::edits::Resolution;
use crate::chat::tools::{
    looks_binary, path_to_forward_slash, Tool, ToolContext, ToolError, MAX_FILE_BYTES,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::path::Path;

pub(crate) struct EditFileTool;

#[derive(Deserialize)]
struct EditFileInput {
    path: String,
    old_string: String,
    new_string: String,
}

#[async_trait]
impl Tool for EditFileTool {
    fn name(&self) -> &'static str {
        "edit_file"
    }

    fn description(&self) -> &'static str {
        "Propose an exact-string edit to a workspace file. The user must \
        approve the change in the chat panel before it is written to disk. \
        `old_string` must appear EXACTLY ONCE in the file (whitespace and \
        newlines included); ambiguous matches or mismatches return an error \
        and the model should retry with more surrounding context. UTF-8 \
        files only; capped at 1 MiB. Returns a short status string once the \
        user has accepted or rejected the proposal."
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative path to the file to edit."
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact substring to replace. Must occur exactly once."
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement string. Pass an empty string to delete `old_string`."
                }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }

    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError> {
        let args: EditFileInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidArgument(format!("malformed input: {e}")))?;

        if args.old_string.is_empty() {
            return Err(ToolError::InvalidArgument(
                "old_string must not be empty (use a separate write_file tool for new files)"
                    .into(),
            ));
        }
        if args.old_string == args.new_string {
            return Err(ToolError::InvalidArgument(
                "old_string and new_string are identical — no-op".into(),
            ));
        }

        // 1. Path sandbox + existence check (`resolve` rejects `..`, absolute
        //    paths, and symlinks out of the workspace).
        let abs = ctx.resolve(&args.path)?;

        // 2. Size cap before we read into memory.
        let metadata = std::fs::metadata(&abs).map_err(|e| ToolError::Io(e.to_string()))?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(ToolError::TooLarge);
        }

        // 3. Read + UTF-8 + binary guard.
        let bytes = std::fs::read(&abs).map_err(|e| ToolError::Io(e.to_string()))?;
        if looks_binary(&bytes) {
            return Err(ToolError::Binary);
        }
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| ToolError::Binary)?
            .to_string();

        // 4. Exact-match uniqueness — if `old_string` appears 0 or >1 times
        //    the edit is ambiguous; tell the model so it can retry with more
        //    surrounding context.
        let matches = content.matches(&args.old_string).count();
        if matches == 0 {
            return Err(ToolError::InvalidArgument(
                "old_string not found in file (drift? check casing, whitespace, newlines)".into(),
            ));
        }
        if matches > 1 {
            return Err(ToolError::InvalidArgument(format!(
                "old_string occurs {matches} times — add surrounding context so it matches exactly once"
            )));
        }

        let byte_offset = content
            .find(&args.old_string)
            .expect("just verified matches == 1");
        let line = 1 + content[..byte_offset]
            .bytes()
            .filter(|b| *b == b'\n')
            .count();

        // 5. Stash + emit + await. If the agent didn't wire up the chat
        //    state (unit tests, weird embedding), bail with a clear error
        //    rather than silently auto-applying.
        let store = ctx
            .pending_edits
            .as_ref()
            .ok_or_else(|| ToolError::Internal("pending-edit store unavailable".into()))?;
        let sink = ctx
            .event_sink
            .as_ref()
            .ok_or_else(|| ToolError::Internal("agent event sink unavailable".into()))?;

        let edit_id = uuid::Uuid::new_v4().to_string();
        // Tool-use id is not threaded through ToolContext today; the agent
        // loop owns it. We surface the edit_id alone, which is what the
        // resolve endpoint keys on; the client can still correlate via
        // ordering relative to the preceding ToolStart event.
        let rel = path_to_forward_slash(Path::new(&args.path));
        let rx = store.insert(
            edit_id.clone(),
            rel.clone(),
            args.old_string.clone(),
            args.new_string.clone(),
            line,
        );
        let _ = sink
            .send(AgentEvent::EditPending {
                id: edit_id.clone(),
                tool_use_id: String::new(),
                path: rel,
                line,
                old_string: args.old_string.clone(),
                new_string: args.new_string.clone(),
            })
            .await;

        // 6. Wait for the user. If the receiver errors (sender dropped without
        //    sending — possible during shutdown), treat as abandonment.
        let resolution = rx.await.unwrap_or(Resolution::Abandoned);

        // 7. Translate to a tool_result the model can reason about.
        match resolution {
            Resolution::Applied { line } => Ok(format!(
                "applied: {} (1 occurrence replaced at line {line}); the file now reflects new_string",
                args.path
            )),
            Resolution::Rejected => Err(ToolError::InvalidArgument(format!(
                "user rejected the edit to {}; do not propose the same change again unless asked",
                args.path
            ))),
            Resolution::Drifted => Err(ToolError::InvalidArgument(format!(
                "edit dropped: {} changed between proposal and apply, so old_string no longer matches exactly; \
                re-read the file and propose a fresh edit if still wanted",
                args.path
            ))),
            Resolution::Abandoned => Err(ToolError::InvalidArgument(format!(
                "edit abandoned: the user closed the chat panel before resolving the edit to {}",
                args.path
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::edits::PendingEditStore;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    fn ctx_with_state() -> (
        TempDir,
        ToolContext,
        Arc<PendingEditStore>,
        mpsc::Receiver<AgentEvent>,
    ) {
        let td = TempDir::new().unwrap();
        let store = Arc::new(PendingEditStore::new());
        let (tx, rx) = mpsc::channel::<AgentEvent>(8);
        let ctx = ToolContext::new(td.path())
            .unwrap()
            .with_chat_state(store.clone(), tx);
        (td, ctx, store, rx)
    }

    #[tokio::test]
    async fn rejects_empty_old_string() {
        let (_td, ctx, _store, _rx) = ctx_with_state();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "x.md", "old_string": "", "new_string": "y" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn rejects_identical_strings() {
        let (_td, ctx, _store, _rx) = ctx_with_state();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "x.md", "old_string": "same", "new_string": "same" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let (_td, ctx, _store, _rx) = ctx_with_state();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "../escape.md", "old_string": "a", "new_string": "b" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::OutsideWorkspace));
    }

    #[tokio::test]
    async fn rejects_missing_file() {
        let (_td, ctx, _store, _rx) = ctx_with_state();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "no-such.md", "old_string": "a", "new_string": "b" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn rejects_ambiguous_match() {
        let (td, ctx, _store, _rx) = ctx_with_state();
        std::fs::write(td.path().join("doc.md"), b"foo bar foo baz").unwrap();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "doc.md", "old_string": "foo", "new_string": "FOO" }),
            )
            .await
            .unwrap_err();
        match err {
            ToolError::InvalidArgument(msg) => assert!(msg.contains("2 times"), "got {msg}"),
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_missing_match() {
        let (td, ctx, _store, _rx) = ctx_with_state();
        std::fs::write(td.path().join("doc.md"), b"foo bar baz").unwrap();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "doc.md", "old_string": "QUUX", "new_string": "X" }),
            )
            .await
            .unwrap_err();
        match err {
            ToolError::InvalidArgument(msg) => assert!(msg.contains("not found"), "got {msg}"),
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_binary_file() {
        let (td, ctx, _store, _rx) = ctx_with_state();
        std::fs::write(td.path().join("bin"), b"\0\0\0").unwrap();
        let err = EditFileTool
            .run(
                &ctx,
                json!({ "path": "bin", "old_string": "abc", "new_string": "x" }),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Binary));
    }

    #[tokio::test]
    async fn happy_path_applied_returns_success_string() {
        let (td, ctx, store, mut rx) = ctx_with_state();
        std::fs::write(td.path().join("doc.md"), b"hello world\nfoo bar\n").unwrap();

        // Spawn the tool — it will block on the resolver.
        let ctx2 = ctx.clone();
        let join = tokio::spawn(async move {
            EditFileTool
                .run(
                    &ctx2,
                    json!({ "path": "doc.md", "old_string": "foo bar", "new_string": "FOO" }),
                )
                .await
        });

        // Pull the EditPending event so we know the id.
        let evt = rx.recv().await.unwrap();
        let id = match evt {
            AgentEvent::EditPending { id, line, .. } => {
                assert_eq!(line, 2, "old_string sits on line 2 of the test file");
                id
            }
            other => panic!("expected EditPending, got {other:?}"),
        };

        // Simulate the HTTP handler resolving as Applied.
        store.resolve(&id, Resolution::Applied { line: 2 }).unwrap();

        let out = join.await.unwrap().unwrap();
        assert!(out.starts_with("applied: doc.md"), "got: {out}");
    }

    #[tokio::test]
    async fn rejected_returns_invalid_argument_error() {
        let (td, ctx, store, mut rx) = ctx_with_state();
        std::fs::write(td.path().join("doc.md"), b"foo bar").unwrap();

        let ctx2 = ctx.clone();
        let join = tokio::spawn(async move {
            EditFileTool
                .run(
                    &ctx2,
                    json!({ "path": "doc.md", "old_string": "foo", "new_string": "FOO" }),
                )
                .await
        });

        let id = match rx.recv().await.unwrap() {
            AgentEvent::EditPending { id, .. } => id,
            other => panic!("expected EditPending, got {other:?}"),
        };
        store.resolve(&id, Resolution::Rejected).unwrap();

        let err = join.await.unwrap().unwrap_err();
        match err {
            ToolError::InvalidArgument(msg) => assert!(msg.contains("user rejected"), "got {msg}"),
            other => panic!("unexpected error {other:?}"),
        }
    }
}
