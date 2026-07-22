//! Statistics and explicit cleanup for persistent data whose workspace is no
//! longer registered.
//!
//! Annotation and viewed rows intentionally remain keyed by canonical absolute
//! file path (the compatibility invariant in `ARCHITECTURE.md`).  A row is
//! therefore considered active when its path is still reachable through any
//! registered directory or single-file workspace. Chat rows use their existing
//! stable workspace id directly.

use crate::workspace::{WorkspaceInfo, WorkspaceRegistry};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataCleanupStats {
    pub active_workspaces: usize,
    pub database_bytes: u64,
    pub annotations_total: usize,
    pub orphaned_annotations: usize,
    pub annotation_files_total: usize,
    pub orphaned_annotation_files: usize,
    pub viewed_files_total: usize,
    pub orphaned_viewed_files: usize,
    pub chat_threads_total: usize,
    pub orphaned_chat_threads: usize,
    pub chat_messages_total: usize,
    pub orphaned_chat_messages: usize,
    pub orphaned_payload_bytes: u64,
}

impl DataCleanupStats {
    pub fn orphaned_items(&self) -> usize {
        self.orphaned_annotations
            + self.orphaned_viewed_files
            + self.orphaned_chat_threads
            + self.orphaned_chat_messages
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DataCleanupResult {
    pub before: DataCleanupStats,
    pub deleted_annotations: usize,
    pub deleted_viewed_files: usize,
    pub deleted_chat_threads: usize,
    pub deleted_chat_messages: usize,
    pub database_bytes_after: u64,
}

#[derive(Debug, Default)]
struct OrphanKeys {
    annotation_ids: Vec<String>,
    viewed_paths: Vec<String>,
    chat_thread_ids: Vec<String>,
    chat_message_count: usize,
}

fn database_bytes(conn: &Connection) -> u64 {
    let pages = conn
        .query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))
        .unwrap_or(0);
    let page_size = conn
        .query_row("PRAGMA page_size", [], |row| row.get::<_, u64>(0))
        .unwrap_or(0);
    pages.saturating_mul(page_size)
}

fn workspace_file(info: &WorkspaceInfo) -> Option<PathBuf> {
    info.single_file
        .as_deref()
        .map(|name| Path::new(&info.path).join(name))
}

fn file_is_active(path: &str, workspaces: &[WorkspaceInfo]) -> bool {
    let candidate = Path::new(path);
    workspaces.iter().any(|workspace| {
        if let Some(single_file) = workspace_file(workspace) {
            candidate == single_file
        } else {
            candidate.starts_with(Path::new(&workspace.path))
        }
    })
}

fn collect(
    conn: &Connection,
    workspaces: &[WorkspaceInfo],
) -> Result<(DataCleanupStats, OrphanKeys), rusqlite::Error> {
    let mut stats = DataCleanupStats {
        active_workspaces: workspaces.len(),
        database_bytes: database_bytes(conn),
        ..Default::default()
    };
    let mut keys = OrphanKeys::default();
    let mut annotation_files = HashSet::new();
    let mut orphaned_annotation_files = HashSet::new();

    {
        let mut stmt = conn.prepare("SELECT id, file_path, length(data) FROM annotations")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2).unwrap_or(0),
            ))
        })?;
        for row in rows {
            let (id, path, bytes) = row?;
            stats.annotations_total += 1;
            annotation_files.insert(path.clone());
            if !file_is_active(&path, workspaces) {
                stats.orphaned_annotations += 1;
                stats.orphaned_payload_bytes = stats.orphaned_payload_bytes.saturating_add(bytes);
                orphaned_annotation_files.insert(path);
                keys.annotation_ids.push(id);
            }
        }
    }
    stats.annotation_files_total = annotation_files.len();
    stats.orphaned_annotation_files = orphaned_annotation_files.len();

    {
        let mut stmt = conn.prepare("SELECT file_path, length(state) FROM viewed_state")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1).unwrap_or(0)))
        })?;
        for row in rows {
            let (path, bytes) = row?;
            stats.viewed_files_total += 1;
            if !file_is_active(&path, workspaces) {
                stats.orphaned_viewed_files += 1;
                stats.orphaned_payload_bytes = stats.orphaned_payload_bytes.saturating_add(bytes);
                keys.viewed_paths.push(path);
            }
        }
    }

    let active_workspace_ids: HashSet<&str> = workspaces
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect();
    {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.workspace_id, length(t.title),
                    COUNT(m.seq), COALESCE(SUM(length(m.content_json)), 0)
               FROM chat_threads t
               LEFT JOIN chat_messages m ON m.thread_id = t.id
              GROUP BY t.id, t.workspace_id, t.title",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2).unwrap_or(0),
                row.get::<_, usize>(3)?,
                row.get::<_, u64>(4).unwrap_or(0),
            ))
        })?;
        for row in rows {
            let (thread_id, workspace_id, title_bytes, message_count, message_bytes) = row?;
            stats.chat_threads_total += 1;
            stats.chat_messages_total += message_count;
            if !active_workspace_ids.contains(workspace_id.as_str()) {
                stats.orphaned_chat_threads += 1;
                stats.orphaned_chat_messages += message_count;
                stats.orphaned_payload_bytes = stats
                    .orphaned_payload_bytes
                    .saturating_add(title_bytes)
                    .saturating_add(message_bytes);
                keys.chat_message_count += message_count;
                keys.chat_thread_ids.push(thread_id);
            }
        }
    }

    Ok((stats, keys))
}

pub fn data_cleanup_stats(
    conn: &Connection,
    registry: &WorkspaceRegistry,
) -> Result<DataCleanupStats, String> {
    collect(conn, &registry.info_list())
        .map(|(stats, _)| stats)
        .map_err(|error| error.to_string())
}

pub fn cleanup_orphaned_data(
    conn: &mut Connection,
    registry: &WorkspaceRegistry,
) -> Result<DataCleanupResult, String> {
    let workspaces = registry.info_list();
    let (before, keys) = collect(conn, &workspaces).map_err(|error| error.to_string())?;
    if before.orphaned_items() == 0 {
        return Ok(DataCleanupResult {
            database_bytes_after: before.database_bytes,
            before,
            ..Default::default()
        });
    }

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for id in &keys.annotation_ids {
        tx.execute("DELETE FROM annotations WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    for path in &keys.viewed_paths {
        tx.execute(
            "DELETE FROM viewed_state WHERE file_path = ?1",
            params![path],
        )
        .map_err(|error| error.to_string())?;
    }
    // Delete messages explicitly instead of relying on a connection-local
    // foreign_keys pragma, then remove their owning threads.
    for thread_id in &keys.chat_thread_ids {
        tx.execute(
            "DELETE FROM chat_messages WHERE thread_id = ?1",
            params![thread_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM chat_threads WHERE id = ?1", params![thread_id])
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    // Reclaim free pages immediately so the before/after storage figure shown
    // by both management UIs reflects the cleanup the user just requested.
    conn.execute_batch("PRAGMA optimize; VACUUM;")
        .map_err(|error| error.to_string())?;

    Ok(DataCleanupResult {
        deleted_annotations: keys.annotation_ids.len(),
        deleted_viewed_files: keys.viewed_paths.len(),
        deleted_chat_threads: keys.chat_thread_ids.len(),
        deleted_chat_messages: keys.chat_message_count,
        database_bytes_after: database_bytes(conn),
        before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::storage::ChatStorage;
    use crate::workspace::{WorkspaceConfig, WorkspaceFlags};

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE annotations (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, data TEXT NOT NULL);
             CREATE TABLE viewed_state (file_path TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);",
        )
        .unwrap();
        ChatStorage::init(conn).unwrap();
    }

    #[test]
    fn reports_and_cleans_only_data_outside_registered_workspaces() {
        let active = tempfile::TempDir::new().unwrap();
        let closed = tempfile::TempDir::new().unwrap();
        let active_file = active.path().join("active.md");
        let closed_file = closed.path().join("closed.md");
        std::fs::write(&active_file, "# active").unwrap();
        std::fs::write(&closed_file, "# closed").unwrap();

        let registry = WorkspaceRegistry::new("cleanup-test".into());
        let active_id = registry.add(WorkspaceConfig {
            path: active.path().to_path_buf(),
            flags: WorkspaceFlags::default(),
            single_file: None,
            collaborator_access_code_hash: String::new(),
            alias: String::new(),
        });
        let mut conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO annotations VALUES (?1, ?2, ?3)",
            params!["keep", active_file.to_string_lossy(), r#"{"id":"keep"}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotations VALUES (?1, ?2, ?3)",
            params!["drop", closed_file.to_string_lossy(), r#"{"id":"drop"}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO viewed_state(file_path, state) VALUES (?1, '{}'), (?2, '{}')",
            params![active_file.to_string_lossy(), closed_file.to_string_lossy()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_threads VALUES ('keep-thread', ?1, '', 1, 1), ('drop-thread', 'closed-id', '', 1, 1)",
            params![active_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages VALUES ('drop-thread', 0, 'user', '[]', 1)",
            [],
        )
        .unwrap();

        let stats = data_cleanup_stats(&conn, &registry).unwrap();
        assert_eq!(stats.annotations_total, 2);
        assert_eq!(stats.orphaned_annotations, 1);
        assert_eq!(stats.orphaned_viewed_files, 1);
        assert_eq!(stats.orphaned_chat_threads, 1);
        assert_eq!(stats.orphaned_chat_messages, 1);

        let result = cleanup_orphaned_data(&mut conn, &registry).unwrap();
        assert_eq!(result.deleted_annotations, 1);
        assert_eq!(result.deleted_viewed_files, 1);
        assert_eq!(result.deleted_chat_threads, 1);
        assert_eq!(result.deleted_chat_messages, 1);
        let after = data_cleanup_stats(&conn, &registry).unwrap();
        assert_eq!(after.annotations_total, 1);
        assert_eq!(after.viewed_files_total, 1);
        assert_eq!(after.chat_threads_total, 1);
        assert_eq!(after.orphaned_items(), 0);
    }

    #[test]
    fn single_file_workspace_keeps_only_its_pinned_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let kept = dir.path().join("kept.md");
        let sibling = dir.path().join("sibling.md");
        std::fs::write(&kept, "# kept").unwrap();
        std::fs::write(&sibling, "# sibling").unwrap();
        let registry = WorkspaceRegistry::new("single-file-cleanup".into());
        registry.add(WorkspaceConfig {
            path: dir.path().to_path_buf(),
            flags: WorkspaceFlags::default(),
            single_file: Some("kept.md".into()),
            collaborator_access_code_hash: String::new(),
            alias: String::new(),
        });
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        conn.execute(
            "INSERT INTO annotations VALUES ('kept', ?1, '{}'), ('sibling', ?2, '{}')",
            params![kept.to_string_lossy(), sibling.to_string_lossy()],
        )
        .unwrap();
        let stats = data_cleanup_stats(&conn, &registry).unwrap();
        assert_eq!(stats.orphaned_annotations, 1);
    }
}
