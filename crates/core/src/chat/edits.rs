//! Pending-edit queue for the `edit_file` chat tool.
//!
//! When the AI calls `edit_file`, the tool does not write to disk on its own.
//! It validates the request, stashes a [`PendingEdit`] in the workspace-scoped
//! [`PendingEditStore`] keyed by a fresh id, emits an `AgentEvent::EditPending`
//! to the SSE stream, and then blocks on a oneshot channel waiting for the
//! user to resolve it via `POST /:ws/_/chat/edits/{id}/{apply|reject}`. The
//! HTTP handler removes the entry, sends a [`Resolution`] through the
//! oneshot, and the tool returns the appropriate `tool_result` to the model.
//!
//! Drift detection: between the time the model emits `edit_file` and the user
//! clicks "Apply" the file might have changed (shared-mode broadcast, manual
//! editor save). On apply we re-read the file and re-verify `old_string`
//! still matches exactly; on mismatch we auto-reject with [`Resolution::Drifted`].

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// User decision (or automatic rejection) for a single pending edit.
#[derive(Debug)]
pub(crate) enum Resolution {
    /// User accepted. The HTTP handler has already verified drift and written
    /// the new content to disk; the tool just needs to report success to the
    /// model.
    Applied { line: usize },
    /// User clicked the reject button.
    Rejected,
    /// File changed under us between propose-time and apply-time and the new
    /// content no longer contains `old_string` exactly. Surfaced separately
    /// from `Rejected` so the model can react ("retry with the latest text").
    Drifted,
    /// The chat panel closed (or the channel got dropped some other way)
    /// before the user resolved this edit. Treated as rejection.
    Abandoned,
}

/// One row in the per-workspace pending queue. The oneshot sender lives here
/// until either the user resolves the edit or the channel is dropped.
pub(crate) struct PendingEdit {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    /// 1-based line number of `old_string`'s first character in the file at
    /// propose-time. Used only for display.
    pub line: usize,
    /// Used by the HTTP handler to send the resolution back to the awaiting
    /// tool. `None` once the resolution has been sent (avoids double-send).
    pub resolver: Option<oneshot::Sender<Resolution>>,
}

#[derive(Default)]
pub(crate) struct PendingEditStore {
    inner: Mutex<HashMap<String, PendingEdit>>,
}

impl PendingEditStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Stash a pending edit and hand back the receiver the tool will await.
    pub(crate) fn insert(
        &self,
        id: String,
        path: String,
        old_string: String,
        new_string: String,
        line: usize,
    ) -> oneshot::Receiver<Resolution> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self
            .inner
            .lock()
            .expect("pending-edit store mutex poisoned");
        guard.insert(
            id,
            PendingEdit {
                path,
                old_string,
                new_string,
                line,
                resolver: Some(tx),
            },
        );
        rx
    }

    /// Look up a pending edit by id without removing it. Used by HTTP
    /// handlers to read `old_string`/`new_string`/`path` before deciding what
    /// to do.
    pub(crate) fn snapshot(&self, id: &str) -> Option<PendingEditSnapshot> {
        let guard = self
            .inner
            .lock()
            .expect("pending-edit store mutex poisoned");
        guard.get(id).map(|e| PendingEditSnapshot {
            path: e.path.clone(),
            old_string: e.old_string.clone(),
            new_string: e.new_string.clone(),
            line: e.line,
        })
    }

    /// Resolve a pending edit. Removes the entry and sends `res` through the
    /// stashed oneshot. Returns `Ok(())` on success; `Err` if the id was
    /// unknown or already resolved.
    pub(crate) fn resolve(&self, id: &str, res: Resolution) -> Result<(), ResolveError> {
        let mut guard = self
            .inner
            .lock()
            .expect("pending-edit store mutex poisoned");
        let entry = guard.remove(id).ok_or(ResolveError::Unknown)?;
        let resolver = entry.resolver.ok_or(ResolveError::AlreadyResolved)?;
        resolver.send(res).map_err(|_| ResolveError::ReceiverGone)?;
        Ok(())
    }

    /// Resolve every still-pending edit with `Resolution::Abandoned`. Used by
    /// shutdown / panel-close paths so awaiting tools wake up cleanly.
    #[allow(dead_code)] // wired up by the panel-close path in a later patch
    pub(crate) fn abandon_all(&self) {
        let mut guard = self
            .inner
            .lock()
            .expect("pending-edit store mutex poisoned");
        for (_, entry) in guard.drain() {
            if let Some(tx) = entry.resolver {
                let _ = tx.send(Resolution::Abandoned);
            }
        }
    }
}

/// Read-only view of a [`PendingEdit`] returned by [`PendingEditStore::snapshot`].
pub(crate) struct PendingEditSnapshot {
    pub path: String,
    pub old_string: String,
    pub new_string: String,
    #[allow(dead_code)] // surfaced on the wire later
    pub line: usize,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ResolveError {
    #[error("no pending edit with that id")]
    Unknown,
    #[error("pending edit already resolved")]
    AlreadyResolved,
    #[error("awaiting tool dropped its receiver")]
    ReceiverGone,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn insert_then_resolve_delivers_decision() {
        let store = PendingEditStore::new();
        let rx = store.insert(
            "edit-1".into(),
            "docs/x.md".into(),
            "old".into(),
            "new".into(),
            7,
        );
        store
            .resolve("edit-1", Resolution::Applied { line: 7 })
            .unwrap();
        let res = rx.await.unwrap();
        assert!(matches!(res, Resolution::Applied { line: 7 }));
    }

    #[tokio::test]
    async fn resolve_unknown_id_is_error() {
        let store = PendingEditStore::new();
        let err = store.resolve("nope", Resolution::Rejected).unwrap_err();
        assert!(matches!(err, ResolveError::Unknown));
    }

    #[tokio::test]
    async fn double_resolve_is_error() {
        let store = PendingEditStore::new();
        let _rx = store.insert("e".into(), "p".into(), "o".into(), "n".into(), 1);
        store.resolve("e", Resolution::Rejected).unwrap();
        let err = store.resolve("e", Resolution::Rejected).unwrap_err();
        assert!(matches!(err, ResolveError::Unknown));
    }

    #[tokio::test]
    async fn abandon_all_wakes_awaiters() {
        let store = PendingEditStore::new();
        let rx = store.insert("e".into(), "p".into(), "o".into(), "n".into(), 1);
        store.abandon_all();
        let res = rx.await.unwrap();
        assert!(matches!(res, Resolution::Abandoned));
    }

    #[tokio::test]
    async fn snapshot_returns_inserted_data_without_removing() {
        let store = PendingEditStore::new();
        let _rx = store.insert(
            "e".into(),
            "docs/x.md".into(),
            "old".into(),
            "new".into(),
            4,
        );
        let snap = store.snapshot("e").unwrap();
        assert_eq!(snap.path, "docs/x.md");
        assert_eq!(snap.old_string, "old");
        assert_eq!(snap.new_string, "new");
        assert_eq!(snap.line, 4);
        // Still resolvable after a snapshot.
        store.resolve("e", Resolution::Rejected).unwrap();
    }
}
