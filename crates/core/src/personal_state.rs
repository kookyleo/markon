//! Browser-private review identity and additive SQLite storage.
//!
//! This cookie selects an isolated review dataset. It is neither an
//! administrator credential nor permission to bypass workspace access gates.
//! SameSite=Lax preserves the subject on inbound top-level links without
//! relaxing the document-state same-origin checks or workspace access gate.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::admin_auth;
use crate::workspace::ct_eq;

pub(crate) const COOKIE_NAME: &str = "markon_personal_review";
const IDENTITY_TTL_SECS: u64 = 365 * 24 * 60 * 60;
const COOKIE_DOMAIN: &[u8] = b"markon-personal-review\0";

pub(crate) fn subject_from_cookie(secret: &str, header: Option<&str>, now: u64) -> Option<String> {
    let value = header?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == COOKIE_NAME).then_some(value))?;
    let mut parts = value.split('.');
    let expires = parts.next()?;
    let subject = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some()
        || subject.len() != 64
        || !subject.bytes().all(|byte| byte.is_ascii_hexdigit())
        || expires.parse::<u64>().ok()? <= now
    {
        return None;
    }
    let payload = format!("{expires}.{subject}");
    let expected = admin_auth::auth_tag(secret, COOKIE_DOMAIN, &payload);
    ct_eq(signature.as_bytes(), expected.as_bytes()).then(|| subject.to_owned())
}

pub(crate) fn issue_cookie(
    secret: &str,
    now: u64,
    secure: bool,
) -> Result<(String, String), String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    let subject: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let payload = format!("{}.{subject}", now.saturating_add(IDENTITY_TTL_SECS));
    let signature = admin_auth::auth_tag(secret, COOKIE_DOMAIN, &payload);
    let secure_attribute = if secure { "; Secure" } else { "" };
    let cookie = format!(
        "{COOKIE_NAME}={payload}.{signature}; Path=/; Max-Age={IDENTITY_TTL_SECS}; HttpOnly; SameSite=Lax{secure_attribute}"
    );
    Ok((subject, cookie))
}

pub(crate) fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS personal_annotations (
            subject_id TEXT NOT NULL,
            id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (subject_id, id)
        );
        CREATE INDEX IF NOT EXISTS personal_annotations_subject_file
            ON personal_annotations (subject_id, file_path);
        CREATE TABLE IF NOT EXISTS personal_viewed_state (
            subject_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            state TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (subject_id, file_path)
        );",
    )
}

pub(crate) fn load(
    conn: &Connection,
    subject: &str,
    file_path: &str,
) -> Result<(Vec<Value>, Value), String> {
    let mut statement = conn
        .prepare("SELECT data FROM personal_annotations WHERE subject_id = ?1 AND file_path = ?2")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![subject, file_path], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut annotations = Vec::new();
    for row in rows {
        let data = row.map_err(|error| error.to_string())?;
        annotations.push(serde_json::from_str(&data).map_err(|error| error.to_string())?);
    }
    let viewed = load_viewed_state(conn, subject, file_path)?;
    Ok((annotations, viewed))
}

/// Load one browser-private progress map without reading annotation rows.
/// Callers doing read/modify/write must retain their database mutex throughout.
pub(crate) fn load_viewed_state(
    conn: &Connection,
    subject: &str,
    file_path: &str,
) -> Result<Value, String> {
    let viewed = conn
        .query_row(
            "SELECT state FROM personal_viewed_state WHERE subject_id = ?1 AND file_path = ?2",
            params![subject, file_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| "{}".to_owned());
    serde_json::from_str(&viewed).map_err(|error| error.to_string())
}

pub(crate) fn upsert_annotation(
    conn: &Connection,
    subject: &str,
    id: &str,
    file_path: &str,
    data: &str,
) -> rusqlite::Result<bool> {
    conn.execute(
        "INSERT INTO personal_annotations (subject_id, id, file_path, data)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(subject_id, id) DO UPDATE SET data = excluded.data
         WHERE personal_annotations.file_path = excluded.file_path",
        params![subject, id, file_path, data],
    )
    .map(|changed| changed > 0)
}

pub(crate) fn delete_annotation(
    conn: &Connection,
    subject: &str,
    id: &str,
    file_path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM personal_annotations WHERE subject_id = ?1 AND id = ?2 AND file_path = ?3",
        params![subject, id, file_path],
    )?;
    Ok(())
}

pub(crate) fn clear_annotations(
    conn: &Connection,
    subject: &str,
    file_path: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM personal_annotations WHERE subject_id = ?1 AND file_path = ?2",
        params![subject, file_path],
    )?;
    Ok(())
}

pub(crate) fn save_viewed_state(
    conn: &Connection,
    subject: &str,
    file_path: &str,
    state: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO personal_viewed_state (subject_id, file_path, state)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(subject_id, file_path) DO UPDATE SET
            state = excluded.state, updated_at = CURRENT_TIMESTAMP",
        params![subject, file_path, state],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_random_signed_persistent_and_separate_from_admin() {
        let (subject_a, cookie_a) = issue_cookie("persistent-salt", 100, false).unwrap();
        let (subject_b, _) = issue_cookie("persistent-salt", 100, false).unwrap();
        assert_ne!(subject_a, subject_b);
        assert_eq!(subject_a.len(), 64);
        assert_eq!(
            subject_from_cookie("persistent-salt", Some(&cookie_a), 101),
            Some(subject_a.clone())
        );
        // A new process retaining the installation salt accepts the same cookie.
        assert_eq!(
            subject_from_cookie("persistent-salt", Some(&cookie_a), 1000),
            Some(subject_a)
        );
        assert!(subject_from_cookie("another-salt", Some(&cookie_a), 101).is_none());
        assert!(subject_from_cookie("persistent-salt", Some(&cookie_a), u64::MAX).is_none());
        assert!(subject_from_cookie("persistent-salt", None, 101).is_none());
        assert!(
            subject_from_cookie("persistent-salt", Some("markon_personal_review="), 101).is_none()
        );
        assert!(cookie_a.contains("HttpOnly; SameSite=Lax"));
        assert!(!cookie_a.contains("; Secure"));
        assert!(issue_cookie("persistent-salt", 100, true)
            .unwrap()
            .1
            .ends_with("; Secure"));
        assert!(!admin_auth::admin_cookie_valid(
            "persistent-salt",
            Some(&cookie_a),
            101
        ));
        let forged = cookie_a.replacen("markon_personal_review=", "markon_personal_review=0", 1);
        assert!(subject_from_cookie("persistent-salt", Some(&forged), 101).is_none());
    }

    #[test]
    fn subjects_are_isolated_and_annotation_ids_stay_bound_to_their_document() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        init(&conn).unwrap();
        assert!(upsert_annotation(&conn, "a", "anno-same", "/w/a.md", r#"{"note":"A"}"#).unwrap());
        assert!(upsert_annotation(&conn, "b", "anno-same", "/w/a.md", r#"{"note":"B"}"#).unwrap());
        assert!(
            !upsert_annotation(&conn, "a", "anno-same", "/w/b.md", r#"{"note":"moved"}"#).unwrap()
        );
        save_viewed_state(&conn, "a", "/w/a.md", r#"{"first":true}"#).unwrap();
        assert_eq!(load(&conn, "a", "/w/a.md").unwrap().0[0]["note"], "A");
        assert_eq!(load(&conn, "b", "/w/a.md").unwrap().0[0]["note"], "B");
        assert_eq!(
            load(&conn, "b", "/w/a.md").unwrap().1,
            serde_json::json!({})
        );
        delete_annotation(&conn, "a", "anno-same", "/w/b.md").unwrap();
        assert_eq!(load(&conn, "a", "/w/a.md").unwrap().0.len(), 1);
        clear_annotations(&conn, "a", "/w/a.md").unwrap();
        assert!(load(&conn, "a", "/w/a.md").unwrap().0.is_empty());
        assert_eq!(load(&conn, "b", "/w/a.md").unwrap().0.len(), 1);
        assert_eq!(
            load(&conn, "a", "/w/a.md").unwrap().1,
            serde_json::json!({"first":true})
        );
    }
}
