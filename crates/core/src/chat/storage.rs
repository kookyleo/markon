//! SQLite-backed persistence for chat threads and messages.
//!
//! Reuses the existing `~/.markon/annotation.sqlite` connection (see
//! [`crate::server`]) so users with `--shared-annotation` already have it
//! open. When chat is enabled but shared-annotation is not, the server still
//! opens the DB lazily — same path, same code path.
//!
//! Tables:
//! ```sql
//! CREATE TABLE IF NOT EXISTS chat_threads (
//!     id           TEXT PRIMARY KEY,    -- uuid v4
//!     workspace_id TEXT NOT NULL,
//!     title        TEXT NOT NULL DEFAULT '',
//!     created_at   INTEGER NOT NULL,    -- unix ms
//!     updated_at   INTEGER NOT NULL
//! );
//! CREATE INDEX IF NOT EXISTS idx_chat_threads_ws
//!     ON chat_threads(workspace_id, updated_at DESC);
//!
//! CREATE TABLE IF NOT EXISTS chat_messages (
//!     thread_id    TEXT NOT NULL,
//!     seq          INTEGER NOT NULL,    -- monotonic, starts at 0
//!     role         TEXT NOT NULL,       -- 'user' | 'assistant'
//!     content_json TEXT NOT NULL,       -- Vec<ContentBlock> JSON
//!     created_at   INTEGER NOT NULL,
//!     PRIMARY KEY (thread_id, seq),
//!     FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
//! );
//! ```
//!
//! All per-request methods are `async` and offload the synchronous rusqlite
//! work to `tokio::task::spawn_blocking`, so the tokio worker pool never sits
//! on `Mutex<Connection>` across `.await` boundaries. Only [`ChatStorage::init`]
//! stays synchronous: it runs once at boot against an owned `Connection`
//! before the value is wrapped in `Arc<Mutex<…>>`.

use crate::chat::message::{ContentBlock, Role};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredMessage {
    pub thread_id: String,
    pub seq: i64,
    pub role: Role,
    pub content: Vec<ContentBlock>,
    pub created_at: i64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(String),
    #[error("not found")]
    NotFound,
    #[error("serde error: {0}")]
    Serde(String),
    /// Blocking worker panicked or was cancelled — treated as a hard failure
    /// because it means the connection's invariants may no longer hold.
    #[error("blocking task join error: {0}")]
    Join(String),
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e.to_string())
    }
}
impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        Self::Serde(e.to_string())
    }
}
impl From<tokio::task::JoinError> for StorageError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::Join(e.to_string())
    }
}

#[derive(Clone)]
pub(crate) struct ChatStorage {
    db: Arc<Mutex<Connection>>,
}

fn now_ms() -> i64 {
    // A clock reporting before UNIX_EPOCH is a real corruption — every
    // chat row's created_at / updated_at would order against the rest
    // of the timeline incorrectly. Better to fail loudly than to write
    // 0 silently and watch threads sort to the year 1970.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be at or after UNIX_EPOCH")
        .as_millis() as i64
}

fn role_to_str(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

fn role_from_str(s: &str) -> Result<Role, StorageError> {
    match s {
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        other => Err(StorageError::Sqlite(format!("unknown role: {other}"))),
    }
}

impl ChatStorage {
    pub(crate) fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self { db }
    }

    /// Run `f` on the blocking pool with an exclusive `&Connection`. Keeps
    /// the lock-and-unlock boilerplate out of every method body and ensures
    /// the `MutexGuard` never crosses an `.await`.
    async fn with_conn<F, R>(&self, f: F) -> Result<R, StorageError>
    where
        F: FnOnce(&Connection) -> Result<R, StorageError> + Send + 'static,
        R: Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let conn = db
                .lock()
                .map_err(|e| StorageError::Sqlite(format!("mutex poisoned: {e}")))?;
            f(&conn)
        })
        .await?
    }

    /// Like [`with_conn`] but hands `f` an exclusive `&mut Connection`, which
    /// `rusqlite::Connection::transaction*` requires.
    async fn with_conn_mut<F, R>(&self, f: F) -> Result<R, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<R, StorageError> + Send + 'static,
        R: Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = db
                .lock()
                .map_err(|e| StorageError::Sqlite(format!("mutex poisoned: {e}")))?;
            f(&mut conn)
        })
        .await?
    }

    /// Idempotent table creation — invoked once at server startup if either
    /// `shared_annotation` or any workspace's `enable_chat` is set. Runs
    /// synchronously because boot owns the `Connection` outright; only the
    /// per-request paths (which share the connection through `Arc<Mutex<…>>`)
    /// need to hop onto the blocking pool.
    pub(crate) fn init(conn: &Connection) -> Result<(), StorageError> {
        // Enable FK enforcement for cascade-delete on chat_messages.
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_threads (
                id           TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                title        TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_threads_ws
                ON chat_threads(workspace_id, updated_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_messages (
                thread_id    TEXT NOT NULL,
                seq          INTEGER NOT NULL,
                role         TEXT NOT NULL,
                content_json TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                PRIMARY KEY (thread_id, seq),
                FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
            )",
            [],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) async fn list_threads(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<Thread>, StorageError> {
        let workspace_id = workspace_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, workspace_id, title, created_at, updated_at
                   FROM chat_threads
                  WHERE workspace_id = ?1
                  ORDER BY updated_at DESC",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(Thread {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
        .await
    }

    pub(crate) async fn create_thread(
        &self,
        workspace_id: &str,
        title: &str,
    ) -> Result<Thread, StorageError> {
        let workspace_id = workspace_id.to_string();
        let title = title.to_string();
        self.with_conn(move |conn| {
            let id = uuid::Uuid::new_v4().to_string();
            let now = now_ms();
            conn.execute(
                "INSERT INTO chat_threads (id, workspace_id, title, created_at, updated_at)
                      VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, workspace_id, title, now],
            )?;
            Ok(Thread {
                id,
                workspace_id,
                title,
                created_at: now,
                updated_at: now,
            })
        })
        .await
    }

    pub(crate) async fn get_thread(&self, thread_id: &str) -> Result<Thread, StorageError> {
        let thread_id = thread_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, workspace_id, title, created_at, updated_at
                   FROM chat_threads
                  WHERE id = ?1",
            )?;
            let mut rows = stmt.query(params![thread_id])?;
            match rows.next()? {
                Some(row) => Ok(Thread {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                }),
                None => Err(StorageError::NotFound),
            }
        })
        .await
    }

    #[allow(dead_code)]
    pub(crate) async fn rename_thread(
        &self,
        thread_id: &str,
        title: &str,
    ) -> Result<(), StorageError> {
        let thread_id = thread_id.to_string();
        let title = title.to_string();
        self.with_conn(move |conn| {
            let now = now_ms();
            let n = conn.execute(
                "UPDATE chat_threads SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, now, thread_id],
            )?;
            if n == 0 {
                return Err(StorageError::NotFound);
            }
            Ok(())
        })
        .await
    }

    pub(crate) async fn delete_thread(&self, thread_id: &str) -> Result<(), StorageError> {
        let thread_id = thread_id.to_string();
        self.with_conn(move |conn| {
            // Ensure FK cascade is on for this connection — `init` set it, but
            // `PRAGMA foreign_keys` is per-connection and cheap to re-assert.
            conn.execute_batch("PRAGMA foreign_keys = ON;")?;
            let n = conn.execute("DELETE FROM chat_threads WHERE id = ?1", params![thread_id])?;
            if n == 0 {
                return Err(StorageError::NotFound);
            }
            Ok(())
        })
        .await
    }

    pub(crate) async fn list_messages(
        &self,
        thread_id: &str,
    ) -> Result<Vec<StoredMessage>, StorageError> {
        let thread_id = thread_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT thread_id, seq, role, content_json, created_at
                   FROM chat_messages
                  WHERE thread_id = ?1
                  ORDER BY seq ASC",
            )?;
            let rows = stmt.query_map(params![thread_id], |row| {
                let thread_id: String = row.get(0)?;
                let seq: i64 = row.get(1)?;
                let role_s: String = row.get(2)?;
                let content_json: String = row.get(3)?;
                let created_at: i64 = row.get(4)?;
                Ok((thread_id, seq, role_s, content_json, created_at))
            })?;
            let mut out = Vec::new();
            for r in rows {
                let (thread_id, seq, role_s, content_json, created_at) = r?;
                let role = role_from_str(&role_s)?;
                let content: Vec<ContentBlock> = serde_json::from_str(&content_json)?;
                out.push(StoredMessage {
                    thread_id,
                    seq,
                    role,
                    content,
                    created_at,
                });
            }
            Ok(out)
        })
        .await
    }

    pub(crate) async fn append_message(
        &self,
        thread_id: &str,
        role: Role,
        content: &[ContentBlock],
    ) -> Result<StoredMessage, StorageError> {
        let thread_id = thread_id.to_string();
        let content_vec = content.to_vec();
        let content_json = serde_json::to_string(content)?;
        let role_s = role_to_str(role);

        self.with_conn_mut(move |conn| {
            let now = now_ms();

            // IMMEDIATE so SELECT MAX(seq)+INSERT is atomic against concurrent
            // appends in other transactions on the same DB.
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

            // Confirm the thread exists — otherwise we'd insert orphan rows
            // that would only be caught at FK check time, and we want a clean
            // error.
            let exists: i64 = tx.query_row(
                "SELECT COUNT(1) FROM chat_threads WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(StorageError::NotFound);
            }

            let next_seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq) + 1, 0) FROM chat_messages WHERE thread_id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?;

            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO chat_messages (thread_id, seq, role, content_json, created_at)
                          VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                stmt.execute(params![thread_id, next_seq, role_s, content_json, now])?;
            }

            tx.execute(
                "UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2",
                params![now, thread_id],
            )?;

            tx.commit()?;

            Ok(StoredMessage {
                thread_id,
                seq: next_seq,
                role,
                content: content_vec,
                created_at: now,
            })
        })
        .await
    }

    /// Joins thread + COUNT(messages); ordered by `updated_at DESC`.
    /// This is what GET /api/chat/threads returns.
    pub(crate) async fn list_thread_summaries(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ThreadSummary>, StorageError> {
        let workspace_id = workspace_id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT t.id, t.title, t.created_at, t.updated_at,
                        COALESCE(COUNT(m.seq), 0) AS message_count
                   FROM chat_threads t
                   LEFT JOIN chat_messages m ON m.thread_id = t.id
                  WHERE t.workspace_id = ?1
                  GROUP BY t.id
                  ORDER BY t.updated_at DESC",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(ThreadSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    message_count: row.get(4)?,
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        })
        .await
    }
}

/// Returned to the frontend by GET /api/chat/threads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::message::ContentBlock;
    use std::sync::{Arc, Mutex};
    use tempfile::NamedTempFile;

    fn fresh_storage() -> (ChatStorage, NamedTempFile) {
        let tmp = NamedTempFile::new().expect("tempfile");
        let conn = Connection::open(tmp.path()).expect("open db");
        ChatStorage::init(&conn).expect("init");
        (ChatStorage::new(Arc::new(Mutex::new(conn))), tmp)
    }

    #[tokio::test]
    async fn create_list_and_delete_cascades() {
        let (store, _tmp) = fresh_storage();

        let t1 = store.create_thread("ws1", "first").await.unwrap();
        // Sleep a millisecond so updated_at differs deterministically.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let t2 = store.create_thread("ws1", "second").await.unwrap();
        let _other = store.create_thread("ws2", "other-ws").await.unwrap();

        let listed = store.list_threads("ws1").await.unwrap();
        assert_eq!(listed.len(), 2);
        // updated_at DESC — most recent first.
        assert_eq!(listed[0].id, t2.id);
        assert_eq!(listed[1].id, t1.id);

        // Append a couple of messages, then delete the thread and confirm the
        // FK cascade dropped them.
        store
            .append_message(
                &t1.id,
                Role::User,
                &[ContentBlock::Text { text: "hi".into() }],
            )
            .await
            .unwrap();
        store
            .append_message(
                &t1.id,
                Role::Assistant,
                &[ContentBlock::Text {
                    text: "hello".into(),
                }],
            )
            .await
            .unwrap();
        assert_eq!(store.list_messages(&t1.id).await.unwrap().len(), 2);

        store.delete_thread(&t1.id).await.unwrap();
        assert_eq!(store.list_messages(&t1.id).await.unwrap().len(), 0);
        assert!(matches!(
            store.get_thread(&t1.id).await,
            Err(StorageError::NotFound)
        ));
        assert!(matches!(
            store.delete_thread(&t1.id).await,
            Err(StorageError::NotFound)
        ));

        // Sibling thread untouched.
        assert!(store.get_thread(&t2.id).await.is_ok());

        // Summary view reflects message counts.
        let summaries = store.list_thread_summaries("ws1").await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, t2.id);
        assert_eq!(summaries[0].message_count, 0);
    }

    #[tokio::test]
    async fn append_and_list_messages_roundtrip_mixed_blocks() {
        let (store, _tmp) = fresh_storage();
        let t = store.create_thread("ws", "tools").await.unwrap();

        let user_blocks = vec![ContentBlock::Text {
            text: "use the search tool".into(),
        }];
        let assistant_blocks = vec![
            ContentBlock::Text {
                text: "ok, calling".into(),
            },
            ContentBlock::ToolUse {
                id: "tu_1".into(),
                name: "search".into(),
                input: serde_json::json!({"q": "rust sqlite"}),
            },
        ];
        let tool_result_blocks = vec![ContentBlock::ToolResult {
            tool_use_id: "tu_1".into(),
            content: "found 42 results".into(),
            is_error: false,
        }];

        let m0 = store
            .append_message(&t.id, Role::User, &user_blocks)
            .await
            .unwrap();
        let m1 = store
            .append_message(&t.id, Role::Assistant, &assistant_blocks)
            .await
            .unwrap();
        let m2 = store
            .append_message(&t.id, Role::User, &tool_result_blocks)
            .await
            .unwrap();

        assert_eq!(m0.seq, 0);
        assert_eq!(m1.seq, 1);
        assert_eq!(m2.seq, 2);

        let listed = store.list_messages(&t.id).await.unwrap();
        assert_eq!(listed.len(), 3);

        // Roundtrip preserves block variants.
        match &listed[0].content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "use the search tool"),
            _ => panic!("expected Text block"),
        }
        match &listed[1].content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "search");
                assert_eq!(input["q"], "rust sqlite");
            }
            _ => panic!("expected ToolUse block"),
        }
        match &listed[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert_eq!(content, "found 42 results");
                assert!(!*is_error);
            }
            _ => panic!("expected ToolResult block"),
        }

        // Summary count matches.
        let summaries = store.list_thread_summaries("ws").await.unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].message_count, 3);

        // updated_at bumped past created_at by appends.
        let refreshed = store.get_thread(&t.id).await.unwrap();
        assert!(refreshed.updated_at >= refreshed.created_at);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_appends_produce_contiguous_seqs() {
        let (store, _tmp) = fresh_storage();
        let t = store.create_thread("ws", "race").await.unwrap();
        let thread_id = t.id.clone();

        const WORKERS: usize = 4;
        const PER_WORKER: usize = 5;

        let mut handles = Vec::with_capacity(WORKERS);
        for w in 0..WORKERS {
            let store = store.clone();
            let tid = thread_id.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..PER_WORKER {
                    let blocks = vec![ContentBlock::Text {
                        text: format!("worker {w} msg {i}"),
                    }];
                    store
                        .append_message(&tid, Role::User, &blocks)
                        .await
                        .expect("append");
                }
            }));
        }
        for h in handles {
            h.await.expect("worker panic");
        }

        let messages = store.list_messages(&thread_id).await.unwrap();
        let total = WORKERS * PER_WORKER;
        assert_eq!(messages.len(), total);
        for (i, m) in messages.iter().enumerate() {
            assert_eq!(m.seq, i as i64, "seqs must be contiguous 0..N");
        }
    }
}
