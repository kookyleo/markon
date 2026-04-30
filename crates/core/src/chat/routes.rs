//! Axum handlers for the chat HTTP surface.
//!
//! Routes (all gated by per-workspace `enable_chat`):
//!   - `POST   /api/chat/{workspace_id}` — SSE stream of [`crate::chat::agent::AgentEvent`]
//!   - `GET    /api/chat/{workspace_id}/files?q=<prefix>` — @-mention completions
//!   - `GET    /api/chat/{workspace_id}/threads` — list of threads + summaries
//!   - `POST   /api/chat/{workspace_id}/threads` — create empty thread
//!   - `GET    /api/chat/{workspace_id}/threads/{thread_id}` — thread + messages
//!   - `DELETE /api/chat/{workspace_id}/threads/{thread_id}` — drop thread

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::chat::agent::{auto_title, Agent, AgentEvent, AgentRequest};
use crate::chat::config::ChatRuntimeConfig;
use crate::chat::message::{ContentBlock, Message, Role};
use crate::chat::prompt::{build_system_blocks, render_mention_block, PromptInputs};
use crate::chat::provider;
use crate::chat::storage::{ChatStorage, StorageError};
use crate::chat::tools::{default_walker, looks_binary, ToolRegistry, MAX_FILE_BYTES};
use crate::server::AppState;
use crate::settings::AppSettings;
use crate::workspace::WorkspaceEntry;

/// Cap how many tool-use rounds the agent will run for a single user turn,
/// independent of the model's `max_tokens`. 8 leaves headroom for "look it
/// up, then verify, then summarize" without letting a confused model burn
/// budget indefinitely.
const MAX_AGENT_STEPS: u8 = 8;
const MAX_TOKENS_PER_TURN: u32 = 4096;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/{workspace_id}", post(chat_stream_handler))
        .route("/api/chat/{workspace_id}/files", get(list_files_handler))
        .route(
            "/api/chat/{workspace_id}/threads",
            get(list_threads_handler).post(create_thread_handler),
        )
        .route(
            "/api/chat/{workspace_id}/threads/{thread_id}",
            get(get_thread_handler).delete(delete_thread_handler),
        )
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn ensure_chat_enabled(
    state: &AppState,
    workspace_id: &str,
) -> Result<Arc<WorkspaceEntry>, ChatHttpError> {
    let ws = state
        .workspace_registry
        .get(workspace_id)
        .ok_or(ChatHttpError::NotFound)?;
    if !ws.enable_chat.load(Ordering::Relaxed) {
        return Err(ChatHttpError::Disabled);
    }
    Ok(ws)
}

fn storage_for(state: &AppState) -> Result<ChatStorage, ChatHttpError> {
    state
        .db
        .clone()
        .map(ChatStorage::new)
        .ok_or(ChatHttpError::Unavailable(
            "chat persistence not initialized",
        ))
}

#[derive(Debug)]
enum ChatHttpError {
    NotFound,
    Disabled,
    BadRequest(String),
    Unavailable(&'static str),
    Storage(StorageError),
}

impl From<StorageError> for ChatHttpError {
    fn from(e: StorageError) -> Self {
        match e {
            StorageError::NotFound => Self::NotFound,
            other => Self::Storage(other),
        }
    }
}

impl IntoResponse for ChatHttpError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            Self::Disabled => (
                StatusCode::FORBIDDEN,
                "chat is not enabled for this workspace".to_string(),
            ),
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m.to_string()),
            Self::Storage(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("storage: {e}")),
        };
        (status, body).into_response()
    }
}

// ── threads ──────────────────────────────────────────────────────────────────

async fn list_threads_handler(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<impl IntoResponse, ChatHttpError> {
    ensure_chat_enabled(&state, &workspace_id)?;
    let storage = storage_for(&state)?;
    let summaries = storage.list_thread_summaries(&workspace_id)?;
    Ok(Json(summaries))
}

#[derive(Debug, Deserialize)]
struct CreateThreadBody {
    #[serde(default)]
    title: String,
}

async fn create_thread_handler(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(body): Json<CreateThreadBody>,
) -> Result<impl IntoResponse, ChatHttpError> {
    ensure_chat_enabled(&state, &workspace_id)?;
    let storage = storage_for(&state)?;
    let title = if body.title.trim().is_empty() {
        "New chat"
    } else {
        body.title.trim()
    };
    let thread = storage.create_thread(&workspace_id, title)?;
    Ok(Json(thread))
}

#[derive(Debug, Serialize)]
struct ThreadDetail {
    thread: crate::chat::storage::Thread,
    messages: Vec<MessageView>,
}

#[derive(Debug, Serialize)]
struct MessageView {
    seq: i64,
    role: Role,
    content: Vec<crate::chat::message::ContentBlock>,
    created_at: i64,
}

async fn get_thread_handler(
    State(state): State<AppState>,
    AxumPath((workspace_id, thread_id)): AxumPath<(String, String)>,
) -> Result<impl IntoResponse, ChatHttpError> {
    ensure_chat_enabled(&state, &workspace_id)?;
    let storage = storage_for(&state)?;
    let thread = storage.get_thread(&thread_id)?;
    if thread.workspace_id != workspace_id {
        return Err(ChatHttpError::NotFound);
    }
    let messages = storage
        .list_messages(&thread_id)?
        .into_iter()
        .map(|m| MessageView {
            seq: m.seq,
            role: m.role,
            content: m.content,
            created_at: m.created_at,
        })
        .collect();
    Ok(Json(ThreadDetail { thread, messages }))
}

async fn delete_thread_handler(
    State(state): State<AppState>,
    AxumPath((workspace_id, thread_id)): AxumPath<(String, String)>,
) -> Result<impl IntoResponse, ChatHttpError> {
    ensure_chat_enabled(&state, &workspace_id)?;
    let storage = storage_for(&state)?;
    let thread = storage.get_thread(&thread_id)?;
    if thread.workspace_id != workspace_id {
        return Err(ChatHttpError::NotFound);
    }
    storage.delete_thread(&thread_id)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── file autocomplete (@-mention) ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct FileQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct FileSuggestion {
    path: String,
    /// Higher = better match. Used for client-side stable sort if the server
    /// later returns multiple sources.
    score: i32,
}

async fn list_files_handler(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<FileQuery>,
) -> Result<impl IntoResponse, ChatHttpError> {
    let ws = ensure_chat_enabled(&state, &workspace_id)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let needle = query.q.trim().to_lowercase();

    let walker = default_walker(&ws.root).build();
    let root = ws.root.clone();
    let mut suggestions: Vec<FileSuggestion> = Vec::new();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let rel = match path.strip_prefix(&root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = crate::chat::tools::path_to_forward_slash(rel);

        // Skip likely-binary files cheaply: by extension and by metadata size,
        // then a NUL-byte sniff for the survivors. The autocomplete must stay
        // fast — don't open every file.
        if BINARY_EXT.iter().any(|ext| rel_str.ends_with(ext)) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > MAX_FILE_BYTES {
                // Big files can be referenced by typing the path explicitly,
                // but we keep them out of autocomplete to discourage accidents.
                continue;
            }
        }
        let score = match score_match(&needle, &rel_str) {
            Some(s) => s,
            None => continue,
        };

        // Only sniff the file if the user hasn't filtered it down — we want
        // every visible suggestion to be readable.
        if needle.is_empty() && suggestions.len() >= limit * 4 {
            // Keep the worker bounded when the user hasn't typed anything.
            // We still score & sort below to surface the best limit entries.
        }
        if !is_text_file_quick(path) {
            continue;
        }
        suggestions.push(FileSuggestion {
            path: rel_str,
            score,
        });
    }

    suggestions.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    suggestions.truncate(limit);
    Ok(Json(suggestions))
}

const BINARY_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".heic", ".avif", ".mp3",
    ".mp4", ".mov", ".webm", ".ogg", ".wav", ".flac", ".m4a", ".pdf", ".zip", ".tar", ".gz",
    ".bz2", ".7z", ".rar", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".so", ".dylib", ".dll",
    ".exe", ".class", ".jar", ".wasm", ".pyc",
];

/// Rough relevance score. Returns `None` if `needle` doesn't match at all.
/// Higher = better. Scoring tiers:
///   100 — needle == basename
///    80 — basename starts with needle
///    60 — basename contains needle
///    40 — full path contains needle
///     0 — empty needle (everything matches at score 0)
fn score_match(needle: &str, rel: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let lower = rel.to_lowercase();
    let basename = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    if basename == needle {
        return Some(100);
    }
    if basename.starts_with(needle) {
        return Some(80);
    }
    if basename.contains(needle) {
        return Some(60);
    }
    if lower.contains(needle) {
        return Some(40);
    }
    None
}

/// Open the first 4 KiB and check for NUL bytes. Cheap enough for an
/// autocomplete handler that returns up to a few dozen entries.
fn is_text_file_quick(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).unwrap_or(0);
    !looks_binary(&buf[..n])
}

// ── chat stream (SSE) — stub ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ChatStreamRequest {
    /// `None` → start a new thread (server creates and reports the id back via
    /// the first `thread_assigned` SSE event).
    #[serde(default)]
    pub thread_id: Option<String>,
    pub user_message: String,
    /// Optional quoted text from the reading view's selection.
    #[serde(default)]
    pub selection: Option<String>,
    /// Path of the document the user is currently looking at, workspace-relative.
    #[serde(default)]
    pub current_doc: Option<String>,
    /// `@`-mentioned files. Server reads them with the same guards as the
    /// `read_file` tool and inlines into the system prompt.
    #[serde(default)]
    pub mentions: Vec<MentionRef>,
}

#[derive(Debug, Deserialize)]
pub struct MentionRef {
    pub path: String,
}

async fn chat_stream_handler(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(body): Json<ChatStreamRequest>,
) -> Response {
    let ws = match ensure_chat_enabled(&state, &workspace_id) {
        Ok(w) => w,
        Err(e) => return e.into_response(),
    };
    let storage = match storage_for(&state) {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };

    // Re-read settings on every request so a key update from the GUI is
    // picked up immediately. Trivial cost compared to the LLM call.
    let app_settings = AppSettings::load();
    let runtime_cfg = match ChatRuntimeConfig::from_settings(&app_settings.chat) {
        Ok(c) => c,
        Err(msg) => return ChatHttpError::BadRequest(msg.to_string()).into_response(),
    };

    let user_text = body.user_message.trim();
    if user_text.is_empty() {
        return ChatHttpError::BadRequest("empty user_message".into()).into_response();
    }

    // Resolve / create thread.
    let thread = match body.thread_id.as_deref() {
        Some(id) => match storage.get_thread(id) {
            Ok(t) if t.workspace_id == workspace_id => t,
            Ok(_) => return ChatHttpError::NotFound.into_response(),
            Err(StorageError::NotFound) => return ChatHttpError::NotFound.into_response(),
            Err(e) => return ChatHttpError::Storage(e).into_response(),
        },
        None => {
            let title = auto_title(user_text);
            match storage.create_thread(&workspace_id, &title) {
                Ok(t) => t,
                Err(e) => return ChatHttpError::Storage(e).into_response(),
            }
        }
    };

    // Load prior history and rehydrate as Message objects.
    let history: Vec<Message> = match storage.list_messages(&thread.id) {
        Ok(msgs) => msgs
            .into_iter()
            .map(|m| Message {
                role: m.role,
                content: m.content,
            })
            .collect(),
        Err(e) => return ChatHttpError::Storage(e).into_response(),
    };

    // The persisted user turn just carries their text; selection / mentions
    // live in the per-turn system prompt block so re-played history stays
    // clean and small.
    let user_blocks = vec![ContentBlock::Text {
        text: user_text.to_string(),
    }];
    if let Err(e) = storage.append_message(&thread.id, Role::User, &user_blocks) {
        return ChatHttpError::Storage(e).into_response();
    }

    // Inline `@`-mentioned files (subject to the read_file size/binary guards).
    let mention_blocks = body
        .mentions
        .iter()
        .filter_map(|m| inline_mention(&ws, &m.path))
        .collect();

    // Workspace outline for tier-2 cache layer — top-level dirs/files.
    let outline = workspace_outline(&ws.root);
    let workspace_label = display_workspace_label(&ws.root);

    let system = build_system_blocks(&PromptInputs {
        workspace_label,
        workspace_outline: outline,
        current_doc: body.current_doc.clone(),
        selection: body.selection.clone(),
        mention_blocks,
    });

    // Build agent.
    let provider = provider::build(runtime_cfg.clone());
    let tools = Arc::new(ToolRegistry::with_default_tools());
    let agent = Agent::new(provider, tools, storage);

    let agent_req = AgentRequest {
        thread_id: thread.id.clone(),
        thread_title: thread.title.clone(),
        workspace_id: workspace_id.clone(),
        workspace_root: ws.root.clone(),
        history,
        user_message: Message {
            role: Role::User,
            content: user_blocks,
        },
        system,
        model: runtime_cfg.model.clone(),
        max_steps: MAX_AGENT_STEPS,
        max_tokens: MAX_TOKENS_PER_TURN,
    };

    let (tx, rx) = mpsc::channel::<AgentEvent>(64);
    tokio::spawn(async move {
        agent.run(agent_req, tx).await;
    });

    let stream = ReceiverStream::new(rx).map(|ev| {
        let event = Event::default().json_data(&ev).unwrap_or_else(|e| {
            Event::default().data(format!(
                "{{\"type\":\"error\",\"message\":\"sse encode: {e}\"}}"
            ))
        });
        Ok::<_, Infallible>(event)
    });

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

// ── helpers for chat stream handler ──────────────────────────────────────────

fn display_workspace_label(root: &std::path::Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rel) = root.strip_prefix(&home) {
            return if rel.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rel.display())
            };
        }
    }
    root.display().to_string()
}

/// One-level workspace listing used as cacheable system-prompt context.
/// Capped so a giant repo doesn't blow out the prefix.
fn workspace_outline(root: &std::path::Path) -> String {
    use std::fmt::Write;
    let walker = default_walker(root).max_depth(Some(1)).build();
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let Some(name) = entry.path().file_name() else {
            continue;
        };
        let n = name.to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            dirs.push(format!("{n}/"));
        } else {
            files.push(n);
        }
    }
    dirs.sort();
    files.sort();
    let mut out = String::new();
    for d in dirs.iter().take(40) {
        let _ = writeln!(out, "{d}");
    }
    for f in files.iter().take(40) {
        let _ = writeln!(out, "{f}");
    }
    out
}

/// Read an `@`-mentioned file with the same guards as the `read_file` tool
/// (workspace containment, size cap, binary sniff) and wrap it in a tagged
/// block. Silently skips files that fail any check — better than a hard
/// failure, since the user just typed `@` and the model can still answer.
fn inline_mention(ws: &WorkspaceEntry, rel_path: &str) -> Option<String> {
    let abs = ws.root.join(rel_path);
    let canon = dunce::canonicalize(&abs).ok()?;
    if !canon.starts_with(&ws.root) {
        return None;
    }
    let meta = std::fs::metadata(&canon).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(&canon).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    Some(render_mention_block(rel_path, &text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::storage::ChatStorage;
    use crate::workspace::{WorkspaceConfig, WorkspaceFlags, WorkspaceRegistry};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use rusqlite::Connection;
    use std::sync::Mutex;
    use tempfile::TempDir;
    use tera::Tera;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    struct TestEnv {
        _tmp: TempDir,
        _db_tmp: tempfile::NamedTempFile,
        state: AppState,
        workspace_id: String,
        storage: ChatStorage,
    }

    fn build_env(enable_chat: bool) -> TestEnv {
        let tmp = TempDir::new().expect("workspace tmpdir");
        let registry = Arc::new(WorkspaceRegistry::new("salt".into()));
        let workspace_id = registry.add(WorkspaceConfig {
            path: tmp.path().to_path_buf(),
            flags: WorkspaceFlags {
                enable_chat,
                ..Default::default()
            },
            single_file: None,
        });

        let db_tmp = tempfile::NamedTempFile::new().expect("sqlite tmpfile");
        let conn = Connection::open(db_tmp.path()).expect("open db");
        ChatStorage::init(&conn).expect("init schema");
        let db = Arc::new(Mutex::new(conn));
        let storage = ChatStorage::new(db.clone());

        let (shutdown_tx, _) = mpsc::channel(1);
        let state = AppState {
            theme: Arc::new("dark".into()),
            tera: Arc::new(Tera::default()),
            shared_annotation: false,
            db: Some(db),
            tx: None,
            workspace_registry: registry,
            management_token: Arc::new("token".into()),
            i18n_json: Arc::new("{}".into()),
            i18n_lang: Arc::new("zh".into()),
            shortcuts_json: Arc::new("null".into()),
            styles_css: Arc::new(String::new()),
            default_chat_mode: Arc::new("in_page".into()),
            shutdown_tx,
            #[cfg(debug_assertions)]
            dev_reload_tx: Arc::new(broadcast::channel::<()>(1).0),
        };
        TestEnv {
            _tmp: tmp,
            _db_tmp: db_tmp,
            state,
            workspace_id,
            storage,
        }
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
        })
    }

    fn json_body(value: serde_json::Value) -> Body {
        Body::from(serde_json::to_vec(&value).unwrap())
    }

    #[tokio::test]
    async fn list_threads_returns_403_when_chat_disabled() {
        let env = build_env(false);
        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/chat/{}/threads", env.workspace_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn list_threads_returns_empty_then_populated() {
        let env = build_env(true);
        let app = router().with_state(env.state.clone());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/chat/{}/threads", env.workspace_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v.as_array().unwrap().len(), 0);

        env.storage.create_thread(&env.workspace_id, "t1").unwrap();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/chat/{}/threads", env.workspace_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v.as_array().unwrap().len(), 1);
        assert_eq!(v[0]["title"], "t1");
    }

    #[tokio::test]
    async fn create_thread_uses_default_title_when_blank() {
        let env = build_env(true);
        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/chat/{}/threads", env.workspace_id))
                    .header("content-type", "application/json")
                    .body(json_body(serde_json::json!({})))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], "New chat");
        assert_eq!(v["workspace_id"], env.workspace_id);
    }

    #[tokio::test]
    async fn create_thread_trims_custom_title() {
        let env = build_env(true);
        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/chat/{}/threads", env.workspace_id))
                    .header("content-type", "application/json")
                    .body(json_body(serde_json::json!({"title": "  hello  "})))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["title"], "hello");
    }

    #[tokio::test]
    async fn get_thread_returns_404_for_unknown() {
        let env = build_env(true);
        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/chat/{}/threads/nope", env.workspace_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_thread_returns_messages_in_order() {
        let env = build_env(true);
        let thread = env.storage.create_thread(&env.workspace_id, "t").unwrap();
        env.storage
            .append_message(
                &thread.id,
                Role::User,
                &[ContentBlock::Text { text: "hi".into() }],
            )
            .unwrap();
        env.storage
            .append_message(
                &thread.id,
                Role::Assistant,
                &[ContentBlock::Text {
                    text: "hello".into(),
                }],
            )
            .unwrap();

        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/chat/{}/threads/{}",
                        env.workspace_id, thread.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let msgs = v["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
    }

    #[tokio::test]
    async fn delete_thread_removes_it() {
        let env = build_env(true);
        let thread = env.storage.create_thread(&env.workspace_id, "t").unwrap();
        let app = router().with_state(env.state.clone());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/chat/{}/threads/{}",
                        env.workspace_id, thread.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/chat/{}/threads/{}",
                        env.workspace_id, thread.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn list_files_returns_only_text_files() {
        let env = build_env(true);
        std::fs::write(env._tmp.path().join("a.md"), "hello").unwrap();
        std::fs::write(env._tmp.path().join("b.txt"), "world").unwrap();
        std::fs::write(env._tmp.path().join("img.png"), [0u8; 16]).unwrap();

        let app = router().with_state(env.state.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/chat/{}/files", env.workspace_id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let paths: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["path"].as_str().unwrap().to_string())
            .collect();
        assert!(paths.contains(&"a.md".to_string()));
        assert!(paths.contains(&"b.txt".to_string()));
        assert!(!paths.contains(&"img.png".to_string()));
    }
}
