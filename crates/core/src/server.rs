use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, State, WebSocketUpgrade,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{stream::StreamExt, SinkExt};
use qrcode::render::unicode::Dense1x2;
use qrcode::{EcLevel, QrCode};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tera::Tera;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};

use crate::assets::{CssAssets, IconAssets, JsAssets, Templates};
use crate::i18n;
use crate::markdown::MarkdownRenderer;
use crate::search::{SearchQuery, SearchResult};
use crate::workspace::{
    expand_and_canonicalize, generate_token, ServerLock, WorkspaceConfig, WorkspaceEntry,
    WorkspaceFlags, WorkspaceRegistry,
};

/// Initial workspace for the server (one per CLI path / GUI workspace entry).
pub struct WorkspaceInit {
    pub path: std::path::PathBuf,
    pub flags: WorkspaceFlags,
    /// Path within this workspace to open in the browser (e.g. "notes/file.md").
    pub initial_path: Option<String>,
}

/// Server configuration
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub theme: String,
    pub qr: Option<String>,
    pub open_browser: Option<String>,
    pub shared_annotation: bool,
    /// Random salt for workspace ID generation; None = auto-generate.
    pub salt: Option<String>,
    pub initial_workspaces: Vec<WorkspaceInit>,
    /// Pre-bound listener (GUI mode): server adopts this instead of binding fresh,
    /// eliminating the TOCTOU race between port discovery and actual bind.
    pub bound_listener: Option<std::net::TcpListener>,
    /// Externally-owned registry (GUI mode): share the same registry between
    /// the Tauri commands and the HTTP server so additions are immediately visible.
    pub registry: Option<Arc<WorkspaceRegistry>>,
    /// Management API token. None = auto-generate and write to lock file.
    pub management_token: Option<String>,
    /// UI language override: "zh", "en", or None (auto-detect via sys_locale).
    pub language: Option<String>,
    /// Custom keyboard shortcut overrides (JSON object, injected into browser pages).
    pub shortcuts_json: Option<String>,
    /// Custom CSS variable overrides (rendered as :root { --markon-*: value }).
    pub styles_css: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub theme: Arc<String>,
    pub tera: Arc<Tera>,
    pub shared_annotation: bool,
    pub db: Option<Arc<Mutex<Connection>>>,
    pub tx: Option<broadcast::Sender<String>>,
    pub workspace_registry: Arc<WorkspaceRegistry>,
    pub management_token: Arc<String>,
    /// Pre-built i18n JSON string for injection into templates.
    pub i18n_json: Arc<String>,
    /// Resolved UI language ("zh" or "en").
    pub i18n_lang: Arc<String>,
    /// Keyboard shortcut overrides JSON (empty string if none).
    pub shortcuts_json: Arc<String>,
    /// CSS variable overrides string.
    pub styles_css: Arc<String>,
    /// Shutdown channel.
    pub shutdown_tx: mpsc::Sender<()>,
}

async fn shutdown_handler(State(state): State<AppState>) -> impl IntoResponse {
    let _ = state.shutdown_tx.send(()).await;
    StatusCode::OK
}

fn detect_lang(override_lang: &Option<String>) -> String {
    match override_lang {
        Some(lang) => i18n::resolve_lang(lang).to_string(),
        None => i18n::resolve_lang("auto").to_string(),
    }
}

pub fn workspace_url_path(workspace_id: &str, initial_path: Option<&str>) -> String {
    match initial_path {
        Some(path) => format!("/{workspace_id}/{}", path.trim_start_matches('/')),
        None => format!("/{workspace_id}/"),
    }
}

pub fn build_workspace_url(base: &str, workspace_path: &str) -> String {
    let suffix = if workspace_path.starts_with('/') {
        workspace_path.to_string()
    } else {
        format!("/{workspace_path}")
    };
    format!("{}{}", base.trim_end_matches('/'), suffix)
}

pub fn print_compact_qr(data: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Use low error correction level for smaller QR codes
    let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::L)?;

    // Render using Dense1x2 (Unicode half-blocks: ▀▄█) for compact display
    // Dense1x2 uses 2 vertical pixels per character (half-block characters)
    // This naturally compensates for terminal fonts where character height > width
    // Note: The aspect ratio depends on the terminal font - it won't be perfect square
    // on all terminals, but Dense1x2 provides the best balance between size and readability
    let string = code
        .render::<Dense1x2>()
        .quiet_zone(false) // No quiet zone to save space
        .build();

    // Add spacing: 4 spaces on the left, blank line below
    for line in string.lines() {
        println!("    {line}"); // 4 spaces on the left
    }
    println!(); // Blank line below

    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum WebSocketMessage {
    #[serde(rename = "all_annotations")]
    AllAnnotations { annotations: Vec<serde_json::Value> },
    #[serde(rename = "new_annotation")]
    NewAnnotation { annotation: serde_json::Value },
    #[serde(rename = "delete_annotation")]
    DeleteAnnotation { id: String },
    #[serde(rename = "clear_annotations")]
    ClearAnnotations,
    #[serde(rename = "viewed_state")]
    ViewedState { state: serde_json::Value },
    #[serde(rename = "update_viewed_state")]
    UpdateViewedState { state: serde_json::Value },
    #[serde(rename = "live_action")]
    LiveAction { data: serde_json::Value },
    /// Sent by the file watcher when a file under a workspace was modified
    /// externally. The browser tab compares `workspace_id` (and `path`) to
    /// what it's currently displaying and reloads if it matches.
    #[serde(rename = "file_changed")]
    FileChanged { workspace_id: String, path: String },
}

pub async fn start(config: ServerConfig) -> Result<(), String> {
    let ServerConfig {
        host,
        port,
        theme,
        qr,
        open_browser,
        shared_annotation,
        salt,
        initial_workspaces,
        bound_listener,
        registry,
        management_token,
        language,
        shortcuts_json,
        styles_css,
    } = config;

    // Initialize Tera template engine from embedded resources.
    let mut tera = Tera::default();
    for file_name in Templates::iter() {
        if let Some(file) = Templates::get(&file_name) {
            match std::str::from_utf8(&file.data) {
                Ok(content) => {
                    if let Err(e) = tera.add_raw_template(&file_name, content) {
                        return Err(format!("Failed to add template '{file_name}': {e}"));
                    }
                }
                Err(e) => {
                    return Err(format!("Failed to read template '{file_name}': {e}"));
                }
            }
        }
    }

    // A broadcast channel (for WebSocket fan-out) is needed whenever either
    // shared_annotation or Live is active. The SQLite-backed annotation DB is
    // only required by shared_annotation; Live is fire-and-forget broadcast.
    //
    // GUI mode (`registry: Some`) lets the user toggle these flags after the
    // server has started, but axum's Router is immutable once built. To avoid
    // a "404 on /_/ws" the moment the user enables Live or Shared notes from
    // the tray, GUI mode wires the WebSocket route and broadcast channel up
    // front and lazily opens the annotation DB regardless of the initial
    // flag values.
    let is_gui_mode = registry.is_some();
    let has_live = initial_workspaces.iter().any(|w| w.flags.enable_live);
    let needs_ws = is_gui_mode || shared_annotation || has_live;
    let needs_db = is_gui_mode || shared_annotation;
    let db = if needs_db {
        let db_path = std::env::var("MARKON_SQLITE_PATH").unwrap_or_else(|_| {
            let home = dirs::home_dir().expect("Cannot find home directory");
            home.join(".markon/annotation.sqlite")
                .to_string_lossy()
                .to_string()
        });
        let parent_dir = std::path::Path::new(&db_path).parent().unwrap();
        if !parent_dir.exists() {
            fs::create_dir_all(parent_dir).expect("Failed to create database directory");
        }
        let conn = Connection::open(&db_path).expect("Failed to open database");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                data TEXT NOT NULL
            )",
            [],
        )
        .expect("Failed to create annotations table");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS viewed_state (
                file_path TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .expect("Failed to create viewed_state table");
        Some(Arc::new(Mutex::new(conn)))
    } else {
        None
    };
    let tx = needs_ws.then(|| broadcast::channel(100).0);

    // Build workspace registry and register initial workspaces.
    let effective_salt = salt.unwrap_or_else(|| format!("markon:{port}"));
    let registry = registry.unwrap_or_else(|| Arc::new(WorkspaceRegistry::new(effective_salt)));
    // Hand the broadcaster to the registry **before** seeding initial
    // workspaces so single-file watchers spawned from inside `add()` already
    // have it. Watchers read the slot lazily on each event, but doing it now
    // means the first emitted event is delivered.
    registry.set_live_broadcaster(tx.clone());

    // Track first workspace's URL path for browser/QR.
    let mut first_workspace_url_path: Option<String> = None;

    for ws_init in initial_workspaces {
        let path = expand_and_canonicalize(&ws_init.path.to_string_lossy())
            .unwrap_or_else(|_| ws_init.path.clone());
        let id = registry.add(WorkspaceConfig {
            path,
            flags: ws_init.flags,
            single_file: None,
        });
        if first_workspace_url_path.is_none() {
            let url_path = workspace_url_path(&id, ws_init.initial_path.as_deref());
            first_workspace_url_path = Some(url_path);
        }
    }

    let token = Arc::new(management_token.unwrap_or_else(generate_token));

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    let state = AppState {
        theme: Arc::new(theme),
        tera: Arc::new(tera),
        shared_annotation,
        db,
        tx,
        workspace_registry: registry,
        management_token: token.clone(),
        i18n_json: Arc::new(i18n::load_i18n()),
        i18n_lang: Arc::new(detect_lang(&language)),
        // Default to "null" (valid JS literal) so `= {{ shortcuts_json | safe }};`
        // renders as `= null;` when no overrides; an empty string would produce
        // `= ;`, a syntax error that silently breaks i18n and shortcut runtime.
        shortcuts_json: Arc::new(shortcuts_json.unwrap_or_else(|| "null".to_string())),
        styles_css: Arc::new(styles_css.unwrap_or_default()),
        shutdown_tx,
    };

    // Management API: requires loopback source IP + valid token header.
    let mgmt = Router::new()
        .route("/api/workspace", post(add_workspace_handler))
        .route(
            "/api/workspace/{id}",
            delete(remove_workspace_handler).put(update_workspace_handler),
        )
        .route("/api/workspaces", get(list_workspaces_handler))
        .route("/api/save", post(save_file_handler))
        .route("/api/shutdown", post(shutdown_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_and_token,
        ));

    let mut app = Router::new()
        // Static assets (literal prefix beats /{workspace_id}/ param)
        .route("/favicon.ico", get(serve_favicon))
        .route("/_/favicon.ico", get(serve_favicon))
        .route("/_/favicon.svg", get(serve_favicon_svg))
        .route("/_/css/{filename}", get(serve_css))
        .route("/_/js/{*path}", get(serve_js))
        .route("/_/ws/{workspace_id}", get(config_ws_handler))
        // Read-only public APIs
        .route("/search", get(search_handler))
        .route("/api/preview", post(preview_handler))
        // Workspace content routes
        .route("/{workspace_id}/", get(handle_workspace_root))
        .route("/{workspace_id}/{*path}", get(handle_workspace_path))
        // Everything else → 404
        .fallback(|| async { StatusCode::NOT_FOUND })
        .merge(mgmt);

    if needs_ws {
        app = app.route("/_/ws", get(ws_handler));
    }

    let app = app.with_state(state);

    let listener = if let Some(std_listener) = bound_listener {
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking: {e}"))?;
        TcpListener::from_std(std_listener)
            .map_err(|e| format!("Failed to convert listener: {e}"))?
    } else {
        let addr = format!("{}:{}", host, port)
            .parse::<SocketAddr>()
            .map_err(|e| format!("Invalid host address '{}': {}", host, e))?;
        TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind to {addr}: {e}"))?
    };
    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?;
    println!("listening on http://{addr}");
    if let Some(ref p) = first_workspace_url_path {
        println!("workspace: http://{addr}{p}");
    }

    // Write lock file so CLI can discover this server.
    let _lock_guard = {
        if let Err(e) = (ServerLock {
            port: addr.port(),
            token: token.as_ref().clone(),
        })
        .write()
        {
            eprintln!("[server] Failed to write lock file: {e}");
        }
        struct LockGuard;
        impl Drop for LockGuard {
            fn drop(&mut self) {
                ServerLock::remove();
            }
        }
        LockGuard
    };

    // Helper: build a full URL from a base option string.
    let make_url = |base_option: &str, ws_path: &Option<String>| -> String {
        let base = if base_option == "local" {
            format!("http://{addr}")
        } else {
            base_option.to_string()
        };
        match ws_path {
            Some(p) => build_workspace_url(&base, p),
            None => format!("{}/", base.trim_end_matches('/')),
        }
    };

    let custom_base = qr
        .as_ref()
        .filter(|u| u.as_str() != "missing")
        .or_else(|| open_browser.as_ref().filter(|u| u.as_str() != "local"));
    if let Some(base) = custom_base {
        println!(
            "accessible at {}",
            make_url(base, &first_workspace_url_path)
        );
    }

    if let Some(ref qr_option) = qr {
        println!();
        let qr_url = if qr_option == "missing" {
            format!("http://{addr}")
        } else {
            make_url(qr_option, &first_workspace_url_path)
        };
        if let Err(e) = print_compact_qr(&qr_url) {
            eprintln!("Failed to generate QR code: {e}");
        }
    }

    if let Some(ref base_opt) = open_browser {
        let url = make_url(base_opt, &first_workspace_url_path);
        if let Err(e) = open::that(&url) {
            eprintln!("[info] Best-effort browser open failed: {e}");
        }
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_rx.recv().await;
        println!("Shutting down...");
    })
    .await
    .map_err(|e| format!("Server error: {e}"))?;
    Ok(())
}

/// Lightweight always-on WebSocket per workspace — pushes a "reload" text frame
/// whenever workspace flags change. No auth required (read-only notification).
async fn config_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws_entry) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut rx = ws_entry.config_tx.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        while let Ok(()) = rx.recv().await {
            if socket
                .send(axum::extract::ws::Message::Text("reload".into()))
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

/// Middleware: management API only accepts loopback source + valid token header.
async fn require_local_and_token(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !addr.ip().is_loopback() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ok = req
        .headers()
        .get("X-Markon-Token")
        .and_then(|v| v.to_str().ok())
        .map(|t| t == state.management_token.as_str())
        .unwrap_or(false);
    if !ok {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

fn load_annotations(db: &Mutex<Connection>, file_path: &str) -> Vec<serde_json::Value> {
    let db = db.lock().unwrap();
    let mut stmt = match db.prepare("SELECT data FROM annotations WHERE file_path = ?1") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[WebSocket] prepare failed: {e}");
            return Vec::new();
        }
    };
    let rows = match stmt.query_map([file_path], |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[WebSocket] query_map failed: {e}");
            return Vec::new();
        }
    };
    rows.filter_map(Result::ok)
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect()
}

fn load_viewed_state(db: &Mutex<Connection>, file_path: &str) -> serde_json::Value {
    let db = db.lock().unwrap();
    let state_json = db
        .query_row(
            "SELECT state FROM viewed_state WHERE file_path = ?1",
            [file_path],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "{}".to_string());
    serde_json::from_str(&state_json).unwrap_or_else(|_| serde_json::json!({}))
}

async fn send_json(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    msg: &WebSocketMessage,
) -> Result<(), ()> {
    let Ok(encoded) = serde_json::to_string(msg) else {
        return Err(());
    };
    sender
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|_| ())
}

fn broadcast_msg(tx: &broadcast::Sender<String>, msg: &WebSocketMessage) {
    if let Ok(encoded) = serde_json::to_string(msg) {
        let _ = tx.send(encoded);
    }
}

fn handle_client_msg(
    db: Option<&Mutex<Connection>>,
    tx: &broadcast::Sender<String>,
    file_path: &str,
    msg: WebSocketMessage,
) {
    // LiveAction is pure broadcast — no DB needed. Handle it before the DB
    // short-circuit so Live works in workspaces where shared_annotation is off.
    if let WebSocketMessage::LiveAction { data } = msg {
        broadcast_msg(tx, &WebSocketMessage::LiveAction { data });
        return;
    }
    let Some(db) = db else { return };
    let db = db.lock().unwrap();
    match msg {
        WebSocketMessage::NewAnnotation { annotation } => {
            let Some(id) = annotation["id"].as_str().map(str::to_owned) else {
                return;
            };
            let Ok(data) = serde_json::to_string(&annotation) else {
                return;
            };
            if let Err(e) = db.execute(
                "INSERT OR REPLACE INTO annotations (id, file_path, data) VALUES (?1, ?2, ?3)",
                [id.as_str(), file_path, data.as_str()],
            ) {
                eprintln!("[WebSocket] insert annotation failed: {e}");
                return;
            }
            broadcast_msg(tx, &WebSocketMessage::NewAnnotation { annotation });
        }
        WebSocketMessage::DeleteAnnotation { id } => {
            if let Err(e) = db.execute(
                "DELETE FROM annotations WHERE id = ?1 AND file_path = ?2",
                [id.as_str(), file_path],
            ) {
                eprintln!("[WebSocket] delete annotation failed: {e}");
                return;
            }
            broadcast_msg(tx, &WebSocketMessage::DeleteAnnotation { id });
        }
        WebSocketMessage::ClearAnnotations => {
            eprintln!("[WebSocket] Clearing annotations for file_path: {file_path}");
            if let Err(e) = db.execute("DELETE FROM annotations WHERE file_path = ?1", [file_path])
            {
                eprintln!("[WebSocket] clear annotations failed: {e}");
            }
            if let Err(e) = db.execute("DELETE FROM viewed_state WHERE file_path = ?1", [file_path])
            {
                eprintln!("[WebSocket] clear viewed_state failed: {e}");
            }
            broadcast_msg(tx, &WebSocketMessage::ClearAnnotations);
            broadcast_msg(
                tx,
                &WebSocketMessage::ViewedState {
                    state: serde_json::Value::Object(serde_json::Map::new()),
                },
            );
        }
        WebSocketMessage::UpdateViewedState { state: viewed } => {
            let Ok(state_json) = serde_json::to_string(&viewed) else {
                return;
            };
            if let Err(e) = db.execute(
                "INSERT OR REPLACE INTO viewed_state (file_path, state, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                [file_path, state_json.as_str()],
            ) {
                eprintln!("[WebSocket] update viewed_state failed: {e}");
                return;
            }
            broadcast_msg(tx, &WebSocketMessage::ViewedState { state: viewed });
        }
        _ => {}
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // tx is required (broadcast fan-out). db is optional — only present when
    // shared_annotation is on; absent when only Live is active.
    let Some(tx) = state.tx.clone() else {
        return;
    };
    let db = state.db.clone();
    let mut rx = tx.subscribe();

    let file_path = match receiver.next().await {
        Some(Ok(Message::Text(text))) => text.to_string(),
        _ => {
            eprintln!("[WebSocket] Failed to receive file path from client");
            return;
        }
    };

    // Only send initial annotation/viewed state when a persistence layer exists.
    if let Some(db) = db.as_ref() {
        let annotations = load_annotations(db, &file_path);
        eprintln!(
            "[WebSocket] Sending {} annotations for file_path: {}",
            annotations.len(),
            file_path
        );
        if send_json(
            &mut sender,
            &WebSocketMessage::AllAnnotations { annotations },
        )
        .await
        .is_err()
        {
            return;
        }
        let viewed = load_viewed_state(db, &file_path);
        if send_json(
            &mut sender,
            &WebSocketMessage::ViewedState { state: viewed },
        )
        .await
        .is_err()
        {
            return;
        }
    }

    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            let Ok(msg) = serde_json::from_str::<WebSocketMessage>(&text) else {
                continue;
            };
            handle_client_msg(db.as_deref(), &tx, &file_path, msg);
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}

// ── Workspace content handlers ────────────────────────────────────────────────

async fn handle_workspace_root(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Single-file workspace: there's no listing, just the one document.
    // 302 to the file URL so the user lands directly on the rendered .md.
    if let Some(only) = &ws.single_file {
        return Redirect::to(&format!("/{workspace_id}/{only}")).into_response();
    }
    render_directory_listing(&workspace_id, &ws, None, &state)
}

async fn handle_workspace_path(
    State(state): State<AppState>,
    AxumPath((workspace_id, path)): AxumPath<(String, String)>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let decoded = urlencoding::decode(&path).unwrap_or_else(|_| path.clone().into());
    let rel = decoded.trim_start_matches('/');
    // Single-file gate: reject anything outside the pinned file and the
    // assets it currently references. Directory listings are not allowed
    // either — `allows()` is false for everything else.
    if ws.is_ephemeral() && !ws.allows(rel) {
        return (StatusCode::NOT_FOUND, "Path not found").into_response();
    }
    let full_path = ws.root.join(rel);

    let canonical = match full_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::NOT_FOUND, format!("Path not found: {decoded}")).into_response()
        }
    };

    if !canonical.starts_with(&ws.root) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    if canonical.is_file() {
        if canonical
            .extension()
            .is_some_and(|e| e.to_string_lossy().to_lowercase() == "md")
        {
            render_markdown_file(&canonical.to_string_lossy(), &workspace_id, &ws, &state)
        } else {
            serve_file(&canonical)
        }
    } else if canonical.is_dir() {
        if ws.is_ephemeral() {
            // Defense in depth: `allows()` already rejects directories, but
            // be explicit so a future change to `allows()` can't accidentally
            // expose a sibling listing.
            return (StatusCode::NOT_FOUND, "Path not found").into_response();
        }
        render_directory_listing(&workspace_id, &ws, Some(&decoded), &state)
    } else {
        (StatusCode::NOT_FOUND, "Path not found").into_response()
    }
}

// ── Workspace management API ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct AddWorkspaceRequest {
    path: String,
    #[serde(flatten)]
    flags: WorkspaceFlags,
}

#[derive(Serialize)]
struct AddWorkspaceResponse {
    id: String,
}

async fn add_workspace_handler(
    State(state): State<AppState>,
    Json(req): Json<AddWorkspaceRequest>,
) -> impl IntoResponse {
    let path = match expand_and_canonicalize(&req.path) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid path: {e}")).into_response(),
    };
    let id = state.workspace_registry.add(WorkspaceConfig {
        path,
        flags: req.flags,
        single_file: None,
    });
    Json(AddWorkspaceResponse { id }).into_response()
}

async fn remove_workspace_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> impl IntoResponse {
    if state.workspace_registry.remove(&id) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn update_workspace_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(flags): Json<WorkspaceFlags>,
) -> impl IntoResponse {
    if state.workspace_registry.update_flags(&id, flags) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn list_workspaces_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.workspace_registry.info_list())
}

// ── Search handler ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WorkspaceSearchQuery {
    ws: String,
    #[serde(flatten)]
    q: SearchQuery,
}

async fn search_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<WorkspaceSearchQuery>,
) -> impl IntoResponse {
    if query.q.q.is_empty() {
        return Json(Vec::<SearchResult>::new());
    }
    let Some(ws) = state.workspace_registry.get(&query.ws) else {
        return Json(Vec::new());
    };
    if !ws.enable_search.load(std::sync::atomic::Ordering::Relaxed) {
        return Json(Vec::new());
    }
    let Some(idx) = ws.search_index.load_full() else {
        return Json(Vec::new()); // still indexing
    };
    let results = idx.search(&query.q.q, 20).unwrap_or_else(|e| {
        eprintln!("[search] error: {e}");
        Vec::new()
    });
    Json(results)
}

fn render_markdown_file(
    file_path: &str,
    workspace_id: &str,
    ws: &WorkspaceEntry,
    state: &AppState,
) -> Response {
    match fs::read_to_string(file_path) {
        Ok(markdown_input) => {
            let renderer = MarkdownRenderer::new(&state.theme);
            let (html_content, has_mermaid, toc) = renderer.render(&markdown_input);

            let title = std::path::Path::new(file_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| file_path.to_string());

            let mut context = tera::Context::new();
            context.insert("title", &format!("markon - {title}"));
            context.insert("file_path", file_path);
            context.insert("workspace_id", workspace_id);
            context.insert("theme", state.theme.as_str());
            context.insert("content", &html_content);
            // Back link: parent dir of this file within the workspace.
            let back_link = std::path::Path::new(file_path)
                .parent()
                .and_then(|p| p.strip_prefix(&ws.root).ok())
                .map(|rel| {
                    let rel_str = rel.to_string_lossy();
                    if rel_str.is_empty() {
                        format!("/{workspace_id}/")
                    } else {
                        format!("/{workspace_id}/{}/", rel_str)
                    }
                })
                .unwrap_or_else(|| format!("/{workspace_id}/"));
            context.insert("back_link", &back_link);
            context.insert("show_back_link", &true);
            context.insert("has_mermaid", &has_mermaid);
            context.insert("toc", &toc);
            let flags = ws.flags();
            context.insert("shared_annotation", &flags.shared_annotation);
            context.insert("enable_viewed", &flags.enable_viewed);
            context.insert("enable_search", &flags.enable_search);
            context.insert("enable_edit", &flags.enable_edit);
            context.insert("enable_live", &flags.enable_live);

            if flags.enable_edit {
                // JSON-encode and HTML-escape so </script> in content can't break the page.
                let json = serde_json::to_string(&markdown_input)
                    .unwrap_or_default()
                    .replace('<', "\\u003c")
                    .replace('>', "\\u003e")
                    .replace('&', "\\u0026");
                context.insert("markdown_content_json", &json);
                context.insert("management_token", state.management_token.as_str());
            }

            context.insert("i18n_json", state.i18n_json.as_str());
            context.insert("i18n_lang", state.i18n_lang.as_str());
            context.insert("shortcuts_json", state.shortcuts_json.as_str());
            context.insert("styles_css", state.styles_css.as_str());

            match state.tera.render("layout.html", &context) {
                Ok(html) => Html(html).into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Template error: {e}"),
                )
                    .into_response(),
            }
        }
        Err(e) => {
            let mut context = tera::Context::new();
            context.insert("title", "Error");
            context.insert("theme", state.theme.as_str());
            context.insert(
                "content",
                &format!(
                    r#"<p style="color: red;">Error reading file '{file_path}': {e}</p>
                       <a href="/">← Back to file list</a>"#
                ),
            );
            context.insert("show_back_link", &false);
            context.insert("has_mermaid", &false);
            context.insert("i18n_json", state.i18n_json.as_str());
            context.insert("i18n_lang", state.i18n_lang.as_str());
            context.insert("shortcuts_json", state.shortcuts_json.as_str());
            context.insert("styles_css", state.styles_css.as_str());

            match state.tera.render("layout.html", &context) {
                Ok(html) => Html(html).into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Template error: {e}"),
                )
                    .into_response(),
            }
        }
    }
}

fn render_directory_listing(
    workspace_id: &str,
    ws: &WorkspaceEntry,
    dir_param: Option<&str>,
    state: &AppState,
) -> Response {
    use std::path::PathBuf;

    let current_dir = if let Some(dir_str) = dir_param {
        let p = PathBuf::from(dir_str);
        if p.is_absolute() {
            p
        } else {
            ws.root.join(&p)
        }
    } else {
        ws.root.clone()
    };

    let current_dir = match current_dir.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("Invalid directory: {e}")).into_response()
        }
    };

    #[derive(serde::Serialize)]
    struct Entry {
        name: String,
        is_dir: bool,
        link: String,
    }

    let mut entries: Vec<Entry> = match fs::read_dir(&current_dir) {
        Ok(dir_entries) => dir_entries
            .filter_map(|e| e.ok())
            .filter_map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    return None;
                }
                // Use file_type() — avoids stat() syscall that can block on AutoFS mount points.
                let file_type = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => return None,
                };
                let is_dir = file_type.is_dir();
                let rel = path
                    .strip_prefix(&ws.root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                if is_dir {
                    Some(Entry {
                        name,
                        is_dir: true,
                        link: format!("/{workspace_id}/{rel}/"),
                    })
                } else {
                    let is_md = path
                        .extension()
                        .is_some_and(|e| e.to_string_lossy().to_lowercase() == "md");
                    if is_md {
                        Some(Entry {
                            name,
                            is_dir: false,
                            link: format!("/{workspace_id}/{rel}"),
                        })
                    } else {
                        None
                    }
                }
            })
            .collect(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Error reading directory: {e}"),
            )
                .into_response()
        }
    };

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    let show_parent = current_dir != ws.root;
    let parent_link: Option<String> = if show_parent {
        current_dir.parent().map(|parent| {
            let rel = parent
                .strip_prefix(&ws.root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if rel.is_empty() {
                format!("/{workspace_id}/")
            } else {
                format!("/{workspace_id}/{rel}/")
            }
        })
    } else {
        None
    };

    let mut context = tera::Context::new();
    context.insert("theme", state.theme.as_str());
    context.insert("workspace_id", workspace_id);
    context.insert("current_dir", &current_dir.display().to_string());
    context.insert("entries", &entries);
    context.insert("show_parent", &show_parent);
    context.insert("parent_link", &parent_link);
    context.insert(
        "enable_search",
        &ws.enable_search.load(std::sync::atomic::Ordering::Relaxed),
    );
    context.insert("i18n_json", state.i18n_json.as_str());
    context.insert("i18n_lang", state.i18n_lang.as_str());
    context.insert("shortcuts_json", state.shortcuts_json.as_str());
    context.insert("styles_css", state.styles_css.as_str());

    match state.tera.render("directory.html", &context) {
        Ok(html) => Html(html).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Template error: {e}"),
        )
            .into_response(),
    }
}

async fn serve_favicon() -> impl IntoResponse {
    // Redirect /_/favicon.ico to /_/favicon.svg
    (
        StatusCode::MOVED_PERMANENTLY,
        [(header::LOCATION, "/_/favicon.svg")],
    )
        .into_response()
}

async fn serve_favicon_svg() -> impl IntoResponse {
    serve_static_file("favicon.svg", IconAssets::get, "image/svg+xml")
}

async fn serve_css(AxumPath(filename): AxumPath<String>) -> impl IntoResponse {
    serve_static_file(&filename, CssAssets::get, "text/css")
}

async fn serve_js(AxumPath(path): AxumPath<String>) -> impl IntoResponse {
    serve_static_file(&path, JsAssets::get, "application/javascript")
}

fn serve_static_file<F>(filename: &str, getter: F, content_type: &str) -> Response
where
    F: FnOnce(&str) -> Option<rust_embed::EmbeddedFile>,
{
    match getter(filename) {
        Some(file) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

fn serve_file(path: &std::path::Path) -> Response {
    match fs::read(path) {
        Ok(content) => {
            let mime_type = mime_guess::from_path(path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            (StatusCode::OK, [(header::CONTENT_TYPE, mime_type)], content).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Error reading file: {e}"),
        )
            .into_response(),
    }
}

// ── File editing API ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SaveFileRequest {
    workspace_id: String,
    file_path: String,
    content: String,
}

#[derive(Serialize)]
struct SaveFileResponse {
    success: bool,
    message: String,
}

async fn save_file_handler(
    State(state): State<AppState>,
    Json(payload): Json<SaveFileRequest>,
) -> impl IntoResponse {
    let ws = match state.workspace_registry.get(&payload.workspace_id) {
        Some(w) => w,
        None => {
            return Json(SaveFileResponse {
                success: false,
                message: "Workspace not found".into(),
            })
            .into_response()
        }
    };

    if !ws.enable_edit.load(std::sync::atomic::Ordering::Relaxed) {
        return Json(SaveFileResponse {
            success: false,
            message: "Edit feature is not enabled".into(),
        })
        .into_response();
    }

    let decoded = match urlencoding::decode(&payload.file_path) {
        Ok(p) => p,
        Err(_) => {
            return Json(SaveFileResponse {
                success: false,
                message: "Invalid file path encoding".into(),
            })
            .into_response()
        }
    };

    let decoded_path = std::path::Path::new(decoded.as_ref());
    let full_path = if decoded_path.is_absolute() {
        decoded_path.to_path_buf()
    } else {
        ws.root.join(decoded.trim_start_matches('/'))
    };
    let canonical = match full_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Json(SaveFileResponse {
                success: false,
                message: format!("File not found: {decoded}"),
            })
            .into_response()
        }
    };

    if !canonical.starts_with(&ws.root) {
        return Json(SaveFileResponse {
            success: false,
            message: "Access denied".into(),
        })
        .into_response();
    }
    if !canonical.is_file() {
        return Json(SaveFileResponse {
            success: false,
            message: "Path is not a file".into(),
        })
        .into_response();
    }
    if canonical
        .extension()
        .is_none_or(|e| e.to_string_lossy().to_lowercase() != "md")
    {
        return Json(SaveFileResponse {
            success: false,
            message: "Only .md files can be edited".into(),
        })
        .into_response();
    }
    match fs::write(&canonical, &payload.content) {
        Ok(_) => Json(SaveFileResponse {
            success: true,
            message: "File saved successfully".into(),
        })
        .into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Json(SaveFileResponse {
            success: false,
            message: "File is read-only".into(),
        })
        .into_response(),
        Err(e) => Json(SaveFileResponse {
            success: false,
            message: format!("Failed to save: {e}"),
        })
        .into_response(),
    }
}

// ── Markdown preview API ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PreviewRequest {
    content: String,
}

#[derive(Serialize)]
struct PreviewResponse {
    html: String,
    has_mermaid: bool,
}

async fn preview_handler(
    State(state): State<AppState>,
    Json(payload): Json<PreviewRequest>,
) -> impl IntoResponse {
    let renderer = MarkdownRenderer::new(&state.theme);
    let (html, has_mermaid, _toc) = renderer.render(&payload.content);
    Json(PreviewResponse { html, has_mermaid }).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_websocket_message_serialization() {
        let msg = WebSocketMessage::LiveAction {
            data: json!({
                "clientId": "test-id",
                "action": "scroll_to",
                "xpath": "/p[1]",
                "offset": 0.5
            }),
        };
        let serialized = serde_json::to_string(&msg).unwrap();
        assert!(serialized.contains("\"type\":\"live_action\""));
        assert!(serialized.contains("\"clientId\":\"test-id\""));
    }

    #[test]
    fn test_app_state_identity() {
        let (tx, _) = tokio::sync::mpsc::channel(1);
        let registry = Arc::new(crate::workspace::WorkspaceRegistry::new("salt".into()));
        let state = AppState {
            theme: Arc::new("dark".into()),
            tera: Arc::new(Tera::default()),
            shared_annotation: true,
            db: None,
            tx: None,
            workspace_registry: registry,
            management_token: Arc::new("token".into()),
            i18n_json: Arc::new("{}".into()),
            i18n_lang: Arc::new("zh".into()),
            shortcuts_json: Arc::new("{}".into()),
            styles_css: Arc::new("".into()),
            shutdown_tx: tx,
        };
        assert_eq!(state.management_token.as_str(), "token");
    }
}
