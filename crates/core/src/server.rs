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
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use tera::Tera;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};

use crate::assets::{CssAssets, IconAssets, JsAssets, Templates};
use crate::i18n;
use crate::markdown::MarkdownRenderer;
use crate::search::{SearchQuery, SearchResult};
use crate::workspace::{
    ct_eq, expand_and_canonicalize, generate_token, ServerLock, WorkspaceConfig, WorkspaceEntry,
    WorkspaceFlags, WorkspaceRegistry,
};

/// Public wire-format types served by the (non-chat) HTTP surface.
///
/// Everything re-exported here is part of the JSON contract that the browser
/// and external API consumers read. The types live in their implementation
/// modules; this submodule lifts them back into the public API so callers
/// don't have to chase across modules to know what is and isn't a wire
/// contract.
pub mod api {
    pub use crate::workspace::WorkspaceInfo;
}

/// Initial workspace for the server (one per CLI path / GUI workspace entry).
pub struct WorkspaceInit {
    pub path: std::path::PathBuf,
    pub flags: WorkspaceFlags,
    /// Path within this workspace to open in the browser (e.g. "notes/file.md").
    pub initial_path: Option<String>,
    /// Per-workspace access-code hash (empty = inherit the server code).
    pub access_code_hash: String,
}

/// Server configuration
pub struct ServerConfig {
    pub host: String,
    /// Preferred address to feature when bound to a wildcard (0.0.0.0/::):
    /// the LAN IP used for the headline URL, QR code, and browser auto-open.
    /// Empty = no preference (fall back to the first interface).
    pub advertised_host: String,
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
    /// Custom CSS variable overrides for `--markon-*` design tokens.
    /// Pre-rendered by `AppSettings::render_styles_css` as a complete CSS
    /// block carrying its own selectors (`:root { ... }` for light/single-
    /// value tokens, `html[data-theme="dark"] { ... }` for dark overrides),
    /// so templates inject it verbatim — no wrapping selector.
    pub styles_css: Option<String>,
    /// Default chat surface: "in_page" or "popout". Surfaced to the browser
    /// via the `default-chat-mode` meta tag.
    pub default_chat_mode: String,
    /// Source-editor colour preset: "follow" (track page theme) or
    /// "vscode-dark". Mirrored to the browser as the `data-editor-theme`
    /// attribute on <html>; resolved by the --mk-editor-* token layer.
    pub editor_theme: String,
    /// Server-level access-code hash (salted SHA-256; empty = no gate). A
    /// workspace's own code overrides this for that workspace.
    pub access_code_hash: String,
    /// When true, collapsed sections are forced visible during print so their
    /// content ends up on paper. When false (default) the content stays hidden
    /// and a small placeholder marks the position of the collapsed section.
    pub print_collapsed_content: bool,
}

/// Per-IP failed-unlock state for the access-code brute-force cooldown.
#[derive(Default)]
pub(crate) struct AccessAttempts {
    /// Consecutive failures since the last success / reset.
    pub fails: u32,
    /// If set, unlock attempts are rejected until this instant.
    pub locked_until: Option<std::time::Instant>,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub theme: Arc<String>,
    pub tera: Arc<Tera>,
    pub db: Option<Arc<Mutex<Connection>>>,
    pub tx: Option<broadcast::Sender<String>>,
    pub workspace_registry: Arc<WorkspaceRegistry>,
    pub management_token: Arc<String>,
    /// Save-scoped token embedded in the edit UI (served to every viewer of an
    /// edit-enabled page). Authorizes ONLY `/api/save`, never the privileged
    /// management routes (add workspace / shutdown), so a leaked page token
    /// can't be escalated to full management control.
    pub save_token: Arc<String>,
    /// Pre-built i18n JSON string for injection into templates.
    pub i18n_json: Arc<String>,
    /// Resolved UI language ("zh" or "en").
    pub i18n_lang: Arc<String>,
    /// Keyboard shortcut overrides JSON (empty string if none).
    pub shortcuts_json: Arc<String>,
    /// CSS variable overrides string.
    pub styles_css: Arc<String>,
    /// Default chat surface ("in_page" or "popout").
    pub default_chat_mode: Arc<String>,
    /// Source-editor colour preset ("follow" or "vscode-dark"). Mirrored to
    /// the browser as the `data-editor-theme` attribute on <html>.
    pub editor_theme: Arc<String>,
    /// Access gate: server-level access-code hash (empty = no server gate).
    pub access_code_hash: Arc<String>,
    /// Secret for signing access cookies — the persistent per-install salt, so
    /// unlock cookies survive restarts (30-day persistence).
    pub access_secret: Arc<String>,
    /// Per-source-IP failed-unlock tracking for the brute-force cooldown.
    pub access_attempts:
        Arc<std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, AccessAttempts>>>,
    /// Whether collapsed sections should be printed (true) or replaced by a
    /// placeholder (false). Mirrored to the browser as a `<html>` data attr.
    pub print_collapsed_content: bool,
    /// Shutdown channel.
    pub shutdown_tx: mpsc::Sender<()>,
    /// Dev-only: esbuild watcher posts to /_/dev/reload-trigger and the
    /// webview's SSE stream listens on this channel to fire location.reload().
    /// Cheap to keep in release builds (one Arc<broadcast::Sender>); the
    /// routes that read it are only registered behind cfg(debug_assertions).
    #[cfg(debug_assertions)]
    pub dev_reload_tx: Arc<broadcast::Sender<()>>,
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

/// Escape a JSON string for safe inlining inside an HTML `<script>` element:
/// the `<`/`>`/`&` → `\uXXXX` form keeps the value valid JSON/JS while making
/// it impossible to form a `</script>` (or comment) sequence that breaks out.
fn js_json_safe(json: String) -> String {
    json.replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
}

pub fn workspace_url_path(workspace_id: &str, initial_path: Option<&str>) -> String {
    match initial_path {
        Some(path) => format!("/{workspace_id}/{}", path.trim_start_matches('/')),
        None => format!("/{workspace_id}/"),
    }
}

/// One reachable base URL with a human-facing label (network interface name,
/// or "localhost" for the loopback entry).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReachableUrl {
    pub label: String,
    pub url: String,
}

/// Every base URL a client could use to reach this server, plus the single one
/// we feature by default (headline link, QR code, browser auto-open).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReachableUrls {
    /// The featured base URL, e.g. `http://192.168.1.20:6419`.
    pub featured: String,
    /// All reachable base URLs (localhost first, then each LAN interface).
    pub all: Vec<ReachableUrl>,
}

/// Bracket a bare IPv6 literal for use in a URL; everything else passes through.
fn url_host_literal(host: &str) -> String {
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(addr)) => format!("[{addr}]"),
        _ => host.to_string(),
    }
}

/// Pure core of reachable-URL computation, taking the currently-available bind
/// hosts explicitly so it can be unit-tested without touching real interfaces.
///
/// Rules:
///   - `localhost` (127.0.0.1) is always reachable from the same machine.
///   - wildcard binds (0.0.0.0 / ::) additionally expose every non-loopback
///     interface IP; the featured one is `advertised_host` when it is still a
///     live interface, otherwise the first interface, otherwise localhost.
///   - a specific (non-loopback) bind exposes exactly that address.
///   - a loopback bind exposes only localhost.
fn assemble_reachable_urls(
    bind_host: &str,
    advertised_host: &str,
    port: u16,
    hosts: &[crate::net::BindHostOption],
) -> ReachableUrls {
    use crate::net::BindHostKind;

    let trimmed = bind_host.trim();
    let is_wildcard = matches!(trimmed, "" | "0.0.0.0" | "::" | "[::]");
    let is_loopback = matches!(trimmed, "127.0.0.1" | "::1" | "[::1]");

    // (label, address) entries. Only a wildcard bind also serves loopback, so
    // for a specific bind we list exactly that one address (127.0.0.1 is NOT
    // reachable when the socket is bound to a single LAN IP).
    let mut entries: Vec<(String, String)> = Vec::new();
    if is_wildcard {
        entries.push(("localhost".to_string(), "127.0.0.1".to_string()));
        for h in hosts.iter().filter(|h| h.kind == BindHostKind::Interface) {
            entries.push((h.interface.clone().unwrap_or_default(), h.address.clone()));
        }
    } else {
        let label = if is_loopback {
            "localhost".to_string()
        } else {
            hosts
                .iter()
                .find(|h| h.address == trimmed)
                .and_then(|h| h.interface.clone())
                .unwrap_or_default()
        };
        entries.push((label, trimmed.to_string()));
    }

    let all: Vec<ReachableUrl> = entries
        .iter()
        .map(|(label, addr)| ReachableUrl {
            label: label.clone(),
            url: format!("http://{}:{}", url_host_literal(addr), port),
        })
        .collect();

    let featured_addr: String = if is_wildcard {
        let adv = advertised_host.trim();
        let lan: Vec<&String> = entries
            .iter()
            .filter(|(label, _)| label != "localhost")
            .map(|(_, addr)| addr)
            .collect();
        if !adv.is_empty() && lan.iter().any(|a| a.as_str() == adv) {
            adv.to_string()
        } else if let Some(first) = lan.first() {
            (*first).clone()
        } else {
            "127.0.0.1".to_string()
        }
    } else {
        trimmed.to_string()
    };
    let featured = format!("http://{}:{}", url_host_literal(&featured_addr), port);

    ReachableUrls { featured, all }
}

/// All reachable base URLs for the current machine + bind configuration.
pub fn reachable_urls(bind_host: &str, advertised_host: &str, port: u16) -> ReachableUrls {
    assemble_reachable_urls(
        bind_host,
        advertised_host,
        port,
        &crate::net::available_bind_hosts(),
    )
}

/// The single featured base URL (LAN IP for wildcard binds, honouring an
/// `advertised_host` preference; localhost only as a fallback).
pub fn featured_base_url(bind_host: &str, advertised_host: &str, port: u16) -> String {
    reachable_urls(bind_host, advertised_host, port).featured
}

pub fn build_workspace_url(base: &str, workspace_path: &str) -> String {
    let suffix = if workspace_path.starts_with('/') {
        workspace_path.to_string()
    } else {
        format!("/{workspace_path}")
    };
    format!("{}{}", base.trim_end_matches('/'), suffix)
}

fn canonicalize_route_path(path: &FsPath) -> std::io::Result<PathBuf> {
    // `std::fs::canonicalize` returns verbatim (`\\?\`) paths on Windows.
    // Workspace roots are stored through `dunce`, so route containment checks
    // must use the same representation or valid files are rejected as outside
    // the workspace.
    dunce::canonicalize(path)
}

fn canonical_workspace_root(ws: &WorkspaceEntry) -> PathBuf {
    canonicalize_route_path(&ws.root).unwrap_or_else(|_| ws.root.clone())
}

fn workspace_relative_path(path: &FsPath, root: &FsPath) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(PathBuf::from)
}

fn is_inside_workspace(path: &FsPath, root: &FsPath) -> bool {
    path.starts_with(root)
}

fn path_to_route(path: &FsPath) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The file-type rule deciding what the server renders as markdown (vs raw-
/// serves, lists, or allows editing).
fn is_markdown_path(path: &FsPath) -> bool {
    path.extension()
        .is_some_and(|e| e.to_string_lossy().to_lowercase() == "md")
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
    // Mutating variants carry an optional `op_id` set by the originating
    // client. The server treats it as opaque and round-trips it verbatim so
    // the originator can recognise (and skip) its own echo. Old clients that
    // don't send the field deserialize as `None` and serialize without it
    // (`skip_serializing_if = Option::is_none`), preserving wire compat.
    #[serde(rename = "new_annotation")]
    NewAnnotation {
        annotation: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op_id: Option<String>,
    },
    #[serde(rename = "delete_annotation")]
    DeleteAnnotation {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op_id: Option<String>,
    },
    #[serde(rename = "clear_annotations")]
    ClearAnnotations {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op_id: Option<String>,
    },
    #[serde(rename = "viewed_state")]
    ViewedState {
        state: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op_id: Option<String>,
    },
    #[serde(rename = "update_viewed_state")]
    UpdateViewedState {
        state: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op_id: Option<String>,
    },
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
        advertised_host,
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
        default_chat_mode,
        editor_theme,
        access_code_hash,
        print_collapsed_content,
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
    let has_chat = initial_workspaces.iter().any(|w| w.flags.enable_chat);
    let needs_ws = is_gui_mode || shared_annotation || has_live;
    let needs_db = is_gui_mode || shared_annotation || has_chat;
    let db = if needs_db {
        let db_path = std::env::var("MARKON_SQLITE_PATH").unwrap_or_else(|_| {
            let home = dirs::home_dir().expect("Cannot find home directory");
            home.join(".markon/annotation.sqlite")
                .to_string_lossy()
                .to_string()
        });
        let parent_dir = std::path::Path::new(&db_path).parent().unwrap();
        fs::create_dir_all(parent_dir).expect("Failed to create database directory");
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
        crate::chat::storage::ChatStorage::init(&conn).expect("Failed to create chat tables");
        Some(Arc::new(Mutex::new(conn)))
    } else {
        None
    };
    let tx = needs_ws.then(|| broadcast::channel(100).0);

    // Build workspace registry and register initial workspaces.
    let effective_salt = salt.unwrap_or_else(|| format!("markon:{port}"));
    // Sign access cookies with the persistent salt so they survive restarts.
    let access_cookie_secret = effective_salt.clone();
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
            access_code_hash: ws_init.access_code_hash,
        });
        if first_workspace_url_path.is_none() {
            let url_path = workspace_url_path(&id, ws_init.initial_path.as_deref());
            first_workspace_url_path = Some(url_path);
        }
    }

    let token = Arc::new(management_token.unwrap_or_else(generate_token));
    // Distinct from the management token: this one is embedded in served edit
    // pages, so it must not unlock the privileged management routes.
    let save_token = Arc::new(generate_token());

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    let state = AppState {
        theme: Arc::new(theme),
        tera: Arc::new(tera),
        db,
        tx,
        workspace_registry: registry,
        management_token: token.clone(),
        save_token: save_token.clone(),
        // These JSON blobs are emitted into a <script> via `| safe`. Escape '<'
        // to < (same standard as markdown_content_json) so a stray '<' in a
        // translation/keybinding can't form `</script>` and break out.
        i18n_json: Arc::new(js_json_safe(i18n::load_i18n())),
        i18n_lang: Arc::new(detect_lang(&language)),
        // Default to "null" (valid JS literal) so `= {{ shortcuts_json | safe }};`
        // renders as `= null;` when no overrides; an empty string would produce
        // `= ;`, a syntax error that silently breaks i18n and shortcut runtime.
        shortcuts_json: Arc::new(js_json_safe(
            shortcuts_json.unwrap_or_else(|| "null".to_string()),
        )),
        styles_css: Arc::new(styles_css.unwrap_or_default()),
        default_chat_mode: Arc::new(default_chat_mode),
        editor_theme: Arc::new(editor_theme),
        access_code_hash: Arc::new(access_code_hash),
        access_secret: Arc::new(access_cookie_secret),
        access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        print_collapsed_content,
        shutdown_tx,
        #[cfg(debug_assertions)]
        dev_reload_tx: Arc::new(broadcast::channel::<()>(16).0),
    };

    // Management API: requires loopback source IP + the master token header.
    let mgmt = Router::new()
        .route("/api/workspace", post(add_workspace_handler))
        .route(
            "/api/workspace/{id}",
            delete(remove_workspace_handler).put(update_workspace_handler),
        )
        .route("/api/workspaces", get(list_workspaces_handler))
        .route("/api/shutdown", post(shutdown_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_and_token,
        ));

    // Save API: loopback + the save-scoped token (or the master token). Kept
    // separate from `mgmt` so the token embedded in edit pages can't reach the
    // privileged routes above.
    let save = Router::new()
        .route("/api/save", post(save_file_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_and_save_token,
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
        // Access-code gate: unlock endpoint (not itself gated).
        .route("/_/unlock", post(unlock_handler))
        // Workspace content routes
        // Chat popout — minimal chat-only page that ChatManager opens via
        // window.open. Registered before the catch-all `{*path}` so the
        // literal `_/chat` segment wins.
        .route("/{workspace_id}/_/chat", get(handle_chat_popout))
        .route("/{workspace_id}/", get(handle_workspace_root))
        .route("/{workspace_id}/{*path}", get(handle_workspace_path))
        // Everything else → 404
        .fallback(|| async { StatusCode::NOT_FOUND })
        .merge(mgmt)
        .merge(save);

    if needs_ws {
        app = app.route("/_/ws", get(ws_handler));
    }

    // Dev-only live-reload: esbuild's watch onEnd hook POSTs the trigger,
    // server fans it out as an SSE event, the webview reloads. cfg gate keeps
    // these routes (and the heavy tokio_stream / sse plumbing) out of release
    // builds entirely.
    #[cfg(debug_assertions)]
    {
        app = app
            .route("/_/dev/reload-stream", get(dev_reload_stream))
            .route("/_/dev/reload-trigger", post(dev_reload_trigger));
    }

    // Chat endpoints: SSE chat stream + thread/file REST. Each handler
    // checks `enable_chat` per-workspace and 403s otherwise, so it's safe
    // to register unconditionally.
    // Chat endpoints are public (no mgmt token, served to the viewer page) but
    // mutating, so guard them with a same-origin check to block cross-site /
    // CSRF / DNS-rebinding fetches.
    let app = app.merge(
        crate::chat::routes::router().route_layer(axum::middleware::from_fn(require_same_origin)),
    );

    // Access-code gate over every workspace-scoped route (no-op when unset).
    let app = app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        require_access_code,
    ));

    // Hardening headers (CSP / nosniff / frame options) on every response.
    let app = app.layer(axum::middleware::from_fn(security_headers));

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
    // `addr` is the bound socket (may be 0.0.0.0 for a wildcard bind, which is
    // not a usable URL host). `local_base` is the reachable, featured URL —
    // a LAN IP for wildcard binds, honouring the advertised-host preference.
    let local_base = featured_base_url(&host, &advertised_host, addr.port());
    // Keep "listening on" as the raw bind addr (it reports which interfaces are
    // served), but surface a clickable, reachable URL for the workspace.
    println!("listening on http://{addr}");
    if let Some(ref p) = first_workspace_url_path {
        println!("workspace: {}", build_workspace_url(&local_base, p));
    }

    // Write lock file so CLI can discover this server.
    let _lock_guard = {
        if let Err(e) = (ServerLock {
            port: addr.port(),
            token: token.as_ref().clone(),
            host: host.clone(),
        })
        .write()
        {
            tracing::warn!("failed to write lock file: {e}");
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
            local_base.clone()
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
            make_url("local", &first_workspace_url_path)
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
            tracing::warn!("best-effort browser open failed: {e}");
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
/// whenever workspace flags change. Requires same-origin (see
/// `check_ws_origin`) so a foreign page cannot subscribe to a victim's
/// workspace config stream when the server is shared on a LAN.
async fn config_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if !check_ws_origin(&headers, &addr) {
        return StatusCode::FORBIDDEN.into_response();
    }
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

/// Reject cross-origin WebSocket upgrades. When the server is bound to a
/// non-loopback interface (LAN share / QR-code mobile access), any browser on
/// the same network could otherwise open `/_/ws` from an attacker page and
/// read or poison annotations under a victim's identity. Browsers always
/// send `Origin` on WS handshakes; the rule is "Origin authority must equal
/// Host authority". Native (non-browser) clients can omit Origin entirely —
/// we let those through only when the TCP peer is loopback, since that's
/// where local CLI tooling legitimately connects without an Origin header.
fn check_ws_origin(headers: &axum::http::HeaderMap, peer: &std::net::SocketAddr) -> bool {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    match origin {
        None => peer.ip().is_loopback(),
        // Sandboxed iframes and some `file://` contexts send `Origin: null`.
        // We refuse rather than try to interpret what they mean.
        Some(o) if o.trim().eq_ignore_ascii_case("null") => false,
        Some(o) => {
            let host = headers
                .get(axum::http::header::HOST)
                .and_then(|v| v.to_str().ok());
            origin_matches_host(o, host)
        }
    }
}

/// Validate the first frame the WebSocket client sends as its `file_path`
/// identity. The value is used as a SQL key (parameterized, so no injection)
/// and as a broadcast match key — it does NOT have to point at a real file
/// on disk. We still reject obviously dangerous shapes so a foreign client
/// cannot claim a path like `../etc/passwd` and have it silently persist /
/// fan out to other connected viewers.
///
/// Constraints:
/// - Non-empty and at most 1024 bytes (db keys should be modest).
/// - No NUL bytes (defends downstream code that might pass the value to C
///   string APIs in syntect, sqlite, etc.).
/// - No `..` path components (a client must not normalise its way onto another
///   key).
///
/// Absolute paths ARE allowed: the server hands the browser the file's absolute
/// path in `<meta name="file-path">`, and the client echoes it back as the very
/// first WS frame, so the legitimate identity is always absolute. Rejecting it
/// here silently broke shared-annotation persistence — the socket closed right
/// after the handshake and no annotation was ever stored. The real access
/// boundary is the same-origin rule in `check_ws_origin`; this value is only
/// ever used as a parameterised SQL key and a broadcast match, never to open a
/// file, so an absolute shape carries no extra risk.
fn is_valid_ws_file_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 || path.contains('\0') {
        return false;
    }
    let p = std::path::Path::new(path);
    !p.components()
        .any(|comp| matches!(comp, std::path::Component::ParentDir))
}

/// True when `origin` (e.g. `http://192.168.1.10:1618`) and `host` (e.g.
/// `192.168.1.10:1618`) refer to the same authority. The origin's authority
/// is the part after `scheme://` up to the path/query. Comparison is
/// case-insensitive on the host part — port is matched verbatim.
fn origin_matches_host(origin: &str, host: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let Some(rest) = origin.split_once("://").map(|(_, r)| r) else {
        return false;
    };
    // Strip path/query if any (shouldn't normally be present on Origin).
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    authority.eq_ignore_ascii_case(host)
}

// ════════════════════════ Access gate ════════════════════════
// Optional per-server (and, later, per-workspace) access code. A device that
// hasn't unlocked the relevant scope is shown a gate page; on success a signed
// 30-day cookie auto-unlocks subsequent requests. Brute force is slowed by a
// per-source-IP cooldown. Fully disabled (nothing gated) when no code is set.

const ACCESS_COOKIE: &str = "markon_access";
const ACCESS_TTL_SECS: u64 = 30 * 24 * 60 * 60; // 30 days
const ACCESS_MAX_FAILS: u32 = 5;
const ACCESS_BASE_COOLDOWN_SECS: u64 = 30;
const ACCESS_MAX_COOLDOWN_SECS: u64 = 60 * 60; // 1h cap

fn access_now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn access_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Keyed integrity tag for the cookie. Secret is the per-install salt (in the
/// 0600 settings file), so a client can't forge or tamper with a cookie.
fn access_sig(secret: &str, payload_hex: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    h.update(b"\0mk-cookie\0");
    h.update(payload_hex.as_bytes());
    access_hex(&h.finalize())
}

/// Build the `Set-Cookie` value carrying the unlocked scopes until `exp`.
fn make_access_cookie(secret: &str, scopes: &[(String, String)], exp: u64) -> String {
    // payload grammar (before hex): "<exp>|<scope>=<hash>|<scope>=<hash>…"
    //   '|' separates fields (the exp, then each unlocked scope)
    //   '=' separates a scope from its hash
    //   ':' appears ONLY inside a scope ("w:<id>"), never as a separator
    // Each delimiter has exactly one role, so decoding is an unambiguous split
    // (no rsplit, no "the hash happens to be colon-free" reasoning). Hex-encoding
    // the whole payload keeps these bytes out of the cookie's own ';'/'='/',' syntax.
    let mut payload = exp.to_string();
    for (scope, hash) in scopes {
        payload.push('|');
        payload.push_str(scope);
        payload.push('=');
        payload.push_str(hash);
    }
    let payload_hex = access_hex(payload.as_bytes());
    let sig = access_sig(secret, &payload_hex);
    format!(
        "{ACCESS_COOKIE}={payload_hex}.{sig}; Path=/; Max-Age={ACCESS_TTL_SECS}; HttpOnly; SameSite=Lax"
    )
}

/// Verify the request's cookie and return the still-valid unlocked scopes.
fn access_cookie_scopes(secret: &str, cookie_header: Option<&str>) -> Vec<(String, String)> {
    let Some(header) = cookie_header else {
        return Vec::new();
    };
    let Some(token) = header
        .split(';')
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == ACCESS_COOKIE)
        .map(|(_, v)| v)
    else {
        return Vec::new();
    };
    let Some((payload_hex, sig)) = token.split_once('.') else {
        return Vec::new();
    };
    if payload_hex.len() % 2 != 0
        || !ct_eq(access_sig(secret, payload_hex).as_bytes(), sig.as_bytes())
    {
        return Vec::new();
    }
    let Ok(payload_bytes) = (0..payload_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&payload_hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
    else {
        return Vec::new();
    };
    let Ok(payload) = String::from_utf8(payload_bytes) else {
        return Vec::new();
    };
    // See make_access_cookie for the grammar. First field is the exp; each
    // remaining "<scope>=<hash>" field splits on its single '='. A scope's
    // internal ':' never interferes because '=' is the only kv delimiter.
    let mut fields = payload.split('|');
    let Some(exp) = fields.next().and_then(|s| s.parse::<u64>().ok()) else {
        return Vec::new();
    };
    if access_now_unix() >= exp {
        return Vec::new();
    }
    fields
        .filter_map(|kv| kv.split_once('='))
        .map(|(s, h)| (s.to_string(), h.to_string()))
        .collect()
}

/// The workspace id a request targets, for access-gating. `None` means the
/// route isn't workspace-scoped (static assets, mgmt, unlock, preview) and is
/// allowed through the gate.
fn access_gated_workspace(path: &str) -> Option<String> {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segs.len() >= 3 && segs[0] == "api" && segs[1] == "chat" {
        return Some(segs[2].to_string());
    }
    if segs.len() >= 3 && segs[0] == "_" && segs[1] == "ws" {
        return Some(segs[2].to_string());
    }
    if let Some(first) = segs.first() {
        if first.len() == 8 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(first.to_string());
        }
    }
    None
}

/// Only allow same-site relative redirect targets (no open redirect / no `//`).
fn access_safe_redirect(redirect: &str, ws_id: &str) -> String {
    if redirect.starts_with('/') && !redirect.starts_with("//") {
        redirect.to_string()
    } else {
        format!("/{ws_id}/")
    }
}

fn access_cooldown_remaining(state: &AppState, ip: std::net::IpAddr) -> Option<u64> {
    let map = state.access_attempts.lock().unwrap();
    let until = map.get(&ip)?.locked_until?;
    let now = std::time::Instant::now();
    (until > now).then(|| (until - now).as_secs() + 1)
}

/// Record a failed unlock; returns the cooldown seconds if it just locked.
fn access_record_failure(state: &AppState, ip: std::net::IpAddr) -> Option<u64> {
    let mut map = state.access_attempts.lock().unwrap();
    let st = map.entry(ip).or_default();
    st.fails += 1;
    if st.fails >= ACCESS_MAX_FAILS {
        let over = (st.fails - ACCESS_MAX_FAILS).min(7);
        let secs = (ACCESS_BASE_COOLDOWN_SECS << over).min(ACCESS_MAX_COOLDOWN_SECS);
        st.locked_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(secs));
        Some(secs)
    } else {
        None
    }
}

fn access_record_success(state: &AppState, ip: std::net::IpAddr) {
    state.access_attempts.lock().unwrap().remove(&ip);
}

/// The effective access requirement for a workspace: `(code_hash, scope)`, or
/// `None` when nothing gates it. A workspace's own code **overrides** the
/// server code; the scope ("w:{id}" vs "s") identifies which lock the cookie
/// must carry, so unlocking the server doesn't unlock a separately-coded
/// workspace and vice versa.
fn access_scope_for(state: &AppState, ws_id: &str) -> Option<(String, String)> {
    if let Some(entry) = state.workspace_registry.get(ws_id) {
        let wc = entry.access_code_hash();
        if !wc.is_empty() {
            return Some((wc, format!("w:{ws_id}")));
        }
    }
    let server = state.access_code_hash.as_str();
    (!server.is_empty()).then(|| (server.to_string(), "s".to_string()))
}

/// Render the access-code gate page (HTTP 200 + form). `err` is None on first
/// prompt, or a (kind, cooldown) pair for feedback.
fn render_access_gate(
    state: &AppState,
    ws_id: &str,
    redirect: &str,
    err: Option<(&str, u64)>,
) -> Response {
    let mut ctx = tera::Context::new();
    ctx.insert("workspace_id", ws_id);
    ctx.insert("redirect", &access_safe_redirect(redirect, ws_id));
    ctx.insert("theme", state.theme.as_str());
    ctx.insert("i18n_json", state.i18n_json.as_str());
    ctx.insert("i18n_lang", state.i18n_lang.as_str());
    // Always define these so the template's `{% if error == ... %}` is valid
    // even on the first (errorless) prompt.
    ctx.insert("error", "");
    ctx.insert("cooldown", &0u64);
    if let Some((kind, cooldown)) = err {
        ctx.insert("error", kind);
        ctx.insert("cooldown", &cooldown);
    }
    match state.tera.render("access-gate.html", &ctx) {
        Ok(html) => (StatusCode::OK, Html(html)).into_response(),
        Err(e) => {
            tracing::error!("access gate render failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "gate error").into_response()
        }
    }
}

/// Middleware: gate workspace-scoped routes behind the access code. No-op when
/// the workspace's effective code is empty.
async fn require_access_code(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_string();
    // `/search` carries its workspace id in the `?ws=` query param rather than
    // the path, so it has to be resolved here for the gate to cover it like the
    // path-based routes (ids are 8 hex chars — never percent-encoded).
    let ws_id = access_gated_workspace(&path).or_else(|| {
        if path != "/search" {
            return None;
        }
        req.uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("ws=")))
            .map(str::to_string)
    });
    let Some(ws_id) = ws_id else {
        return next.run(req).await;
    };
    let Some((current_hash, needed)) = access_scope_for(&state, &ws_id) else {
        return next.run(req).await;
    };
    let cookie = req
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok());
    if access_cookie_scopes(&state.access_secret, cookie)
        .iter()
        .any(|(s, h)| s == &needed && h == &current_hash)
    {
        return next.run(req).await;
    }
    if req.method() == axum::http::Method::GET && !path.starts_with("/api/") {
        render_access_gate(&state, &ws_id, &path, None)
    } else {
        (StatusCode::UNAUTHORIZED, "Access code required").into_response()
    }
}

#[derive(serde::Deserialize)]
struct UnlockForm {
    code: String,
    workspace_id: String,
    redirect: String,
}

/// `POST /_/unlock` — verify the submitted code, set the cookie, redirect back.
async fn unlock_handler(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    axum::extract::Form(form): axum::extract::Form<UnlockForm>,
) -> Response {
    let ip = addr.ip();
    let redirect = access_safe_redirect(&form.redirect, &form.workspace_id);
    if let Some(remaining) = access_cooldown_remaining(&state, ip) {
        tracing::warn!(%ip, ws = %form.workspace_id, "access unlock blocked: cooldown {remaining}s");
        return render_access_gate(
            &state,
            &form.workspace_id,
            &redirect,
            Some(("cooldown", remaining)),
        );
    }
    let Some((effective, scope)) = access_scope_for(&state, &form.workspace_id) else {
        return Redirect::to(&redirect).into_response();
    };
    if crate::workspace::access_code_matches(&state.access_secret, &form.code, &effective) {
        access_record_success(&state, ip);
        tracing::info!(%ip, ws = %form.workspace_id, "access unlocked");
        // Merge with any scopes the device already unlocked, so unlocking one
        // workspace doesn't drop access to another.
        let cookie_hdr = headers
            .get(axum::http::header::COOKIE)
            .and_then(|v| v.to_str().ok());
        let mut scopes = access_cookie_scopes(&state.access_secret, cookie_hdr);
        if let Some(entry) = scopes.iter_mut().find(|(s, _)| s == &scope) {
            entry.1 = effective;
        } else {
            scopes.push((scope, effective));
        }
        let cookie = make_access_cookie(
            &state.access_secret,
            &scopes,
            access_now_unix() + ACCESS_TTL_SECS,
        );
        return (
            [(axum::http::header::SET_COOKIE, cookie)],
            Redirect::to(&redirect),
        )
            .into_response();
    }
    let cooldown = access_record_failure(&state, ip);
    tracing::warn!(%ip, ws = %form.workspace_id, "access unlock failed");
    let err = cooldown.map_or(("wrong", 0), |s| ("cooldown", s));
    render_access_gate(&state, &form.workspace_id, &redirect, Some(err))
}

/// Max inbound WebSocket message (annotation payload). Caps SQLite growth and
/// broadcast amplification from a hostile peer; real annotations are tiny.
const MAX_WS_MSG_BYTES: usize = 256 * 1024;

/// Conservative Content-Security-Policy. `'unsafe-inline'` is required because
/// the templates ship inline `<script>`/`<style>` and inject `styles_css`; even
/// so this blocks **external** script/style loads, plugins, framing and base
/// hijacking, so an injection can't pull in a remote payload or be clickjacked.
/// `img/media-src *` keeps cross-origin images in user docs working. The full
/// fix for inline injection is HTML sanitisation (see security review H-1).
const SECURITY_CSP: &str = "default-src 'self'; \
script-src 'self' 'unsafe-inline'; \
style-src 'self' 'unsafe-inline'; \
img-src * data: blob:; media-src * data: blob:; font-src 'self' data:; \
connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; \
frame-ancestors 'self'";

/// Attach hardening headers to every response (CSP + nosniff + frame options).
async fn security_headers(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    h.insert(
        axum::http::header::X_FRAME_OPTIONS,
        axum::http::HeaderValue::from_static("SAMEORIGIN"),
    );
    h.insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_static(SECURITY_CSP),
    );
    resp
}

/// Same-origin guard for the chat API. Chat endpoints are reachable from the
/// (unauthenticated) viewer page, so they can't require the management token;
/// instead reject any request whose `Origin` doesn't match `Host`. A mutating
/// cross-site `fetch` always sends `Origin`, so a missing `Origin` (a same-origin
/// simple GET, or a local non-browser tool) is allowed through.
async fn require_same_origin(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let headers = req.headers();
    if let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let host = headers
            .get(axum::http::header::HOST)
            .and_then(|v| v.to_str().ok());
        if !origin_matches_host(origin, host) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    next.run(req).await
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
        .map(|t| ct_eq(t.as_bytes(), state.management_token.as_bytes()))
        .unwrap_or(false);
    if !ok {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

/// Like [`require_local_and_token`] but accepts the save-scoped token in
/// addition to the master token — used only for `/api/save`. The master token
/// is still honored so CLI/tooling callers keep working.
async fn require_local_and_save_token(
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
        .map(|t| {
            ct_eq(t.as_bytes(), state.save_token.as_bytes())
                || ct_eq(t.as_bytes(), state.management_token.as_bytes())
        })
        .unwrap_or(false);
    if !ok {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if !check_ws_origin(&headers, &addr) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_WS_MSG_BYTES)
        .max_frame_size(MAX_WS_MSG_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

#[cfg(debug_assertions)]
async fn dev_reload_stream(State(state): State<AppState>) -> impl IntoResponse {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use std::convert::Infallible;
    let rx = state.dev_reload_tx.subscribe();
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|item| async move {
        // Drop lagged frames silently; we only need *some* recent reload.
        item.ok()
            .map(|()| Ok::<Event, Infallible>(Event::default().event("reload")))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(debug_assertions)]
async fn dev_reload_trigger(State(state): State<AppState>) -> impl IntoResponse {
    // send() errors only when there are no subscribers; that's fine — esbuild
    // can fire before any webview connects, we just no-op.
    let _ = state.dev_reload_tx.send(());
    StatusCode::NO_CONTENT
}

async fn load_annotations(db: Arc<Mutex<Connection>>, file_path: String) -> Vec<serde_json::Value> {
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap();
        let mut stmt = match db.prepare("SELECT data FROM annotations WHERE file_path = ?1") {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(file_path = %file_path, "load_annotations: prepare failed: {e}");
                return Vec::new();
            }
        };
        let rows = match stmt.query_map([file_path.as_str()], |row| row.get::<_, String>(0)) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(file_path = %file_path, "load_annotations: query_map failed: {e}");
                return Vec::new();
            }
        };
        rows.filter_map(Result::ok)
            .filter_map(|s| serde_json::from_str(&s).ok())
            .collect()
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!("load_annotations join error: {e}");
        Vec::new()
    })
}

async fn load_viewed_state(db: Arc<Mutex<Connection>>, file_path: String) -> serde_json::Value {
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap();
        let state_json = db
            .query_row(
                "SELECT state FROM viewed_state WHERE file_path = ?1",
                [file_path.as_str()],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&state_json).unwrap_or_else(|_| serde_json::json!({}))
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!("load_viewed_state join error: {e}");
        serde_json::json!({})
    })
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

/// Side-effect plan computed inside the blocking SQLite worker. Returned to
/// the async caller so the broadcast (which touches the tokio channel) stays
/// on the runtime, not on the blocking pool.
enum DbResult {
    Broadcast(WebSocketMessage),
    /// Clear-annotations side-effect: broadcast a `clear_annotations` plus a
    /// reset `viewed_state` (both empty). Carries the originator's `op_id`
    /// so it propagates to every fan-out frame for echo dedup.
    BroadcastClear {
        op_id: Option<String>,
    },
    None,
}

async fn handle_client_msg(
    db: Option<Arc<Mutex<Connection>>>,
    tx: broadcast::Sender<String>,
    file_path: String,
    msg: WebSocketMessage,
) {
    // LiveAction is pure broadcast — no DB needed. Handle it before the DB
    // short-circuit so Live works in workspaces where shared_annotation is off.
    if let WebSocketMessage::LiveAction { data } = msg {
        broadcast_msg(&tx, &WebSocketMessage::LiveAction { data });
        return;
    }
    let Some(db) = db else { return };

    // One spawn_blocking per inbound message: take the lock exactly once,
    // run whichever SQL the message requires, then return the broadcast plan
    // for the async side to fan out.
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap();
        match msg {
            WebSocketMessage::NewAnnotation { annotation, op_id } => {
                let Some(id) = annotation["id"].as_str().map(str::to_owned) else {
                    return DbResult::None;
                };
                let Ok(data) = serde_json::to_string(&annotation) else {
                    return DbResult::None;
                };
                if let Err(e) = conn.execute(
                    "INSERT OR REPLACE INTO annotations (id, file_path, data) VALUES (?1, ?2, ?3)",
                    [id.as_str(), file_path.as_str(), data.as_str()],
                ) {
                    tracing::error!(file_path = %file_path, "insert annotation failed: {e}");
                    return DbResult::None;
                }
                DbResult::Broadcast(WebSocketMessage::NewAnnotation { annotation, op_id })
            }
            WebSocketMessage::DeleteAnnotation { id, op_id } => {
                if let Err(e) = conn.execute(
                    "DELETE FROM annotations WHERE id = ?1 AND file_path = ?2",
                    [id.as_str(), file_path.as_str()],
                ) {
                    tracing::error!(file_path = %file_path, "delete annotation failed: {e}");
                    return DbResult::None;
                }
                DbResult::Broadcast(WebSocketMessage::DeleteAnnotation { id, op_id })
            }
            WebSocketMessage::ClearAnnotations { op_id } => {
                tracing::info!(file_path = %file_path, "clearing annotations");
                if let Err(e) = conn.execute(
                    "DELETE FROM annotations WHERE file_path = ?1",
                    [file_path.as_str()],
                ) {
                    tracing::error!(file_path = %file_path, "clear annotations failed: {e}");
                }
                if let Err(e) = conn.execute(
                    "DELETE FROM viewed_state WHERE file_path = ?1",
                    [file_path.as_str()],
                ) {
                    tracing::error!(file_path = %file_path, "clear viewed_state failed: {e}");
                }
                DbResult::BroadcastClear { op_id }
            }
            WebSocketMessage::UpdateViewedState {
                state: viewed,
                op_id,
            } => {
                let Ok(state_json) = serde_json::to_string(&viewed) else {
                    return DbResult::None;
                };
                if let Err(e) = conn.execute(
                    "INSERT OR REPLACE INTO viewed_state (file_path, state, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                    [file_path.as_str(), state_json.as_str()],
                ) {
                    tracing::error!(file_path = %file_path, "update viewed_state failed: {e}");
                    return DbResult::None;
                }
                DbResult::Broadcast(WebSocketMessage::ViewedState {
                    state: viewed,
                    op_id,
                })
            }
            _ => DbResult::None,
        }
    })
    .await;

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("handle_client_msg join error: {e}");
            return;
        }
    };

    match result {
        DbResult::Broadcast(out) => broadcast_msg(&tx, &out),
        DbResult::BroadcastClear { op_id } => {
            broadcast_msg(
                &tx,
                &WebSocketMessage::ClearAnnotations {
                    op_id: op_id.clone(),
                },
            );
            broadcast_msg(
                &tx,
                &WebSocketMessage::ViewedState {
                    state: serde_json::Value::Object(serde_json::Map::new()),
                    op_id,
                },
            );
        }
        DbResult::None => {}
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
            tracing::warn!("failed to receive file path from client");
            return;
        }
    };
    if !is_valid_ws_file_path(&file_path) {
        tracing::warn!(file_path = %file_path, "rejecting suspicious file_path from client");
        return;
    }

    // Only send initial annotation/viewed state when a persistence layer exists.
    if let Some(db) = db.as_ref() {
        let annotations = load_annotations(db.clone(), file_path.clone()).await;
        tracing::debug!(
            file_path = %file_path,
            count = annotations.len(),
            "sending initial annotations to client",
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
        let viewed = load_viewed_state(db.clone(), file_path.clone()).await;
        if send_json(
            &mut sender,
            &WebSocketMessage::ViewedState {
                state: viewed,
                op_id: None,
            },
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
            if text.len() > MAX_WS_MSG_BYTES {
                tracing::warn!("dropping oversized ws message ({} bytes)", text.len());
                continue;
            }
            let Ok(msg) = serde_json::from_str::<WebSocketMessage>(&text) else {
                continue;
            };
            handle_client_msg(db.clone(), tx.clone(), file_path.clone(), msg).await;
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}

// ── Workspace content handlers ────────────────────────────────────────────────

/// Standalone chat-only page. Opened by ChatManager.#openPopout() in its own
/// browser-level window. Returns the minimal `chat.html` template — no
/// markdown body, no TOC, no Live, no annotations bundle. The shared
/// `main.js` bundle still loads, but at boot it sees `<meta name="chat-only">`
/// and routes to `ChatManager.initPopout()` instead of `MarkonApp`.
async fn handle_chat_popout(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Hide the chat page entirely if chat is disabled for this workspace —
    // mirrors the same gate the in-page chat panel respects via the
    // `enable-chat` meta flag.
    if !ws.flags().enable_chat {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut context = base_context(&state);
    context.insert("workspace_id", &workspace_id);
    context.insert("title", &"Markon Chat".to_string());
    render_template(&state, "chat.html", &context)
}

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
    let root = canonical_workspace_root(&ws);
    render_directory_listing(&workspace_id, &ws, &root, None, &state)
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

    let canonical = match canonicalize_route_path(&full_path) {
        Ok(p) => p,
        Err(_) => {
            return (StatusCode::NOT_FOUND, format!("Path not found: {decoded}")).into_response()
        }
    };

    let root = canonical_workspace_root(&ws);
    if !is_inside_workspace(&canonical, &root) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    if canonical.is_file() {
        if is_markdown_path(&canonical) {
            render_markdown_file(
                &canonical.to_string_lossy(),
                &workspace_id,
                &ws,
                &root,
                &state,
            )
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
        render_directory_listing(&workspace_id, &ws, &root, Some(&decoded), &state)
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
        access_code_hash: String::new(),
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
        tracing::warn!("search error: {e}");
        Vec::new()
    });
    Json(results)
}

/// Context pre-seeded with the page-independent keys shared by every template
/// (extra keys are ignored by templates that don't reference them).
fn base_context(state: &AppState) -> tera::Context {
    let mut context = tera::Context::new();
    context.insert("theme", state.theme.as_str());
    context.insert("i18n_json", state.i18n_json.as_str());
    context.insert("i18n_lang", state.i18n_lang.as_str());
    context.insert("shortcuts_json", state.shortcuts_json.as_str());
    context.insert("styles_css", state.styles_css.as_str());
    context.insert("default_chat_mode", state.default_chat_mode.as_str());
    context.insert("editor_theme", state.editor_theme.as_str());
    context.insert("print_collapsed_content", &state.print_collapsed_content);
    context
}

/// Render a template, mapping failure to a 500 with the error text.
fn render_template(state: &AppState, name: &str, context: &tera::Context) -> Response {
    match state.tera.render(name, context) {
        Ok(html) => Html(html).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Template error: {e}"),
        )
            .into_response(),
    }
}

fn render_markdown_file(
    file_path: &str,
    workspace_id: &str,
    ws: &WorkspaceEntry,
    root: &FsPath,
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

            let mut context = base_context(state);
            context.insert("title", &format!("markon - {title}"));
            context.insert("file_path", file_path);
            context.insert("workspace_id", workspace_id);
            context.insert("version", env!("CARGO_PKG_VERSION"));
            context.insert("content", &html_content);
            // Back link: parent dir of this file within the workspace.
            // Suppressed for single-file workspaces — `/{id}/` 303-redirects
            // back to this same file (see `handle_workspace_root`), so a
            // "Back to file list" link would be a no-op trap.
            let back_link = std::path::Path::new(file_path)
                .parent()
                .and_then(|p| workspace_relative_path(p, root))
                .map(|rel| {
                    let rel_str = path_to_route(&rel);
                    if rel_str.is_empty() {
                        format!("/{workspace_id}/")
                    } else {
                        format!("/{workspace_id}/{}/", rel_str)
                    }
                })
                .unwrap_or_else(|| format!("/{workspace_id}/"));
            context.insert("back_link", &back_link);
            context.insert("show_back_link", &!ws.is_ephemeral());
            context.insert("has_mermaid", &has_mermaid);
            context.insert("toc", &toc);
            let flags = ws.flags();
            context.insert("shared_annotation", &flags.shared_annotation);
            context.insert("enable_viewed", &flags.enable_viewed);
            context.insert("enable_search", &flags.enable_search);
            context.insert("enable_edit", &flags.enable_edit);
            context.insert("enable_live", &flags.enable_live);
            context.insert("enable_chat", &flags.enable_chat);

            if flags.enable_edit {
                // JSON-encode and HTML-escape so </script> in content can't break the page.
                let json = js_json_safe(serde_json::to_string(&markdown_input).unwrap_or_default());
                context.insert("markdown_content_json", &json);
                // Embed the save-scoped token, NOT the master management token —
                // this HTML is served to every viewer of the page.
                context.insert("save_token", state.save_token.as_str());
            }

            render_template(state, "layout.html", &context)
        }
        Err(e) => {
            let mut context = base_context(state);
            context.insert("title", "Error");
            context.insert("version", env!("CARGO_PKG_VERSION"));
            context.insert(
                "content",
                &format!(
                    r#"<p style="color: red;">Error reading file '{file_path}': {e}</p>
                       <a href="/">← Back to file list</a>"#
                ),
            );
            context.insert("show_back_link", &false);
            context.insert("has_mermaid", &false);

            render_template(state, "layout.html", &context)
        }
    }
}

fn render_directory_listing(
    workspace_id: &str,
    ws: &WorkspaceEntry,
    root: &FsPath,
    dir_param: Option<&str>,
    state: &AppState,
) -> Response {
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

    let current_dir = match canonicalize_route_path(&current_dir) {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("Invalid directory: {e}")).into_response()
        }
    };
    // Defense in depth: the caller's gate trims the leading slash before its
    // boundary check, but this function re-derives `current_dir` from the raw
    // (possibly absolute) `dir_param`. Re-verify the canonical dir is inside the
    // workspace so an absolute path like `/etc` can't list outside the root.
    if !current_dir.starts_with(root) {
        return StatusCode::NOT_FOUND.into_response();
    }

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
                let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
                let rel_url = path_to_route(&rel);
                if is_dir {
                    Some(Entry {
                        name,
                        is_dir: true,
                        link: format!("/{workspace_id}/{rel_url}/"),
                    })
                } else if is_markdown_path(&path) {
                    Some(Entry {
                        name,
                        is_dir: false,
                        link: format!("/{workspace_id}/{rel_url}"),
                    })
                } else {
                    None
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

    let show_parent = current_dir != root;
    let parent_link: Option<String> = if show_parent {
        current_dir.parent().map(|parent| {
            let rel = parent
                .strip_prefix(root)
                .map(path_to_route)
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

    let mut context = base_context(state);
    context.insert("workspace_id", workspace_id);
    context.insert("current_dir", &current_dir.display().to_string());
    context.insert("entries", &entries);
    context.insert("show_parent", &show_parent);
    context.insert("parent_link", &parent_link);
    context.insert(
        "enable_search",
        &ws.enable_search.load(std::sync::atomic::Ordering::Relaxed),
    );

    render_template(state, "directory.html", &context)
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
        // `file.data` is Cow::Borrowed in release builds; serving the Cow
        // directly avoids copying the embedded asset on every request.
        Some(file) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            file.data,
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
    let canonical = match canonicalize_route_path(&full_path) {
        Ok(p) => p,
        Err(_) => {
            return Json(SaveFileResponse {
                success: false,
                message: format!("File not found: {decoded}"),
            })
            .into_response()
        }
    };

    let root = canonical_workspace_root(&ws);
    if !is_inside_workspace(&canonical, &root) {
        return Json(SaveFileResponse {
            success: false,
            message: "Access denied".into(),
        })
        .into_response();
    }
    // Single-file gate, mirroring `handle_workspace_path`: writes outside
    // the pinned file (and its allowed assets) are rejected even when the
    // path resolves inside `ws.root`. No-op for normal directory workspaces.
    if ws.is_ephemeral() {
        let rel = workspace_relative_path(&canonical, &root)
            .map(|r| path_to_route(&r))
            .unwrap_or_default();
        if !ws.allows(&rel) {
            return Json(SaveFileResponse {
                success: false,
                message: "Access denied".into(),
            })
            .into_response();
        }
    }
    if !canonical.is_file() {
        return Json(SaveFileResponse {
            success: false,
            message: "Path is not a file".into(),
        })
        .into_response();
    }
    if !is_markdown_path(&canonical) {
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
    use axum::body::to_bytes;
    use serde_json::json;

    use axum::http::HeaderMap;
    use std::net::{IpAddr, Ipv4Addr};

    fn test_tera() -> Tera {
        let mut tera = Tera::default();
        for file_name in Templates::iter() {
            let file = Templates::get(&file_name).expect("embedded template");
            let content = std::str::from_utf8(&file.data).expect("utf-8 template");
            tera.add_raw_template(&file_name, content)
                .expect("template registration");
        }
        tera
    }

    fn test_state(registry: Arc<WorkspaceRegistry>) -> AppState {
        let (shutdown_tx, _) = tokio::sync::mpsc::channel(1);
        AppState {
            theme: Arc::new("light".into()),
            tera: Arc::new(test_tera()),
            db: None,
            tx: None,
            workspace_registry: registry,
            management_token: Arc::new("test-token".into()),
            save_token: Arc::new("save-token".into()),
            i18n_json: Arc::new(i18n::load_i18n()),
            i18n_lang: Arc::new("en".into()),
            shortcuts_json: Arc::new("null".into()),
            styles_css: Arc::new("".into()),
            default_chat_mode: Arc::new("in_page".into()),
            editor_theme: Arc::new("follow".into()),
            access_code_hash: Arc::new(String::new()),
            access_secret: Arc::new("test-salt".into()),
            access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            print_collapsed_content: false,
            shutdown_tx,
            #[cfg(debug_assertions)]
            dev_reload_tx: Arc::new(broadcast::channel::<()>(1).0),
        }
    }

    fn add_test_workspace(
        registry: &WorkspaceRegistry,
        root: PathBuf,
        flags: WorkspaceFlags,
    ) -> String {
        registry.add(WorkspaceConfig {
            path: dunce::canonicalize(root).expect("canonical workspace root"),
            flags,
            single_file: None,
            access_code_hash: String::new(),
        })
    }

    /// Repro for the reported "only the global code lets me into a workspace
    /// that has its own code": the workspace code must override the global both
    /// live AND after a restart reseed (same id, code preserved).
    #[test]
    fn workspace_code_overrides_global_and_survives_reseed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let salt = "test-salt";
        let ws_hash = crate::workspace::hash_access_code(salt, "wsCode");
        let global_hash = crate::workspace::hash_access_code(salt, "global");

        let reg = Arc::new(WorkspaceRegistry::new(salt.into()));
        let id = reg.add(WorkspaceConfig {
            path: root.clone(),
            flags: WorkspaceFlags::default(),
            single_file: None,
            access_code_hash: String::new(),
        });
        assert!(reg.set_access_code(&id, &ws_hash));

        let mut state = test_state(reg.clone());
        state.access_code_hash = Arc::new(global_hash.clone());
        let (h, scope) = access_scope_for(&state, &id).expect("workspace is gated");
        assert_eq!(scope, format!("w:{id}"), "must use the workspace scope");
        assert_eq!(h, ws_hash, "live: workspace code must win over global");

        // Simulate a server restart: fresh registry reseeded from the persisted
        // (path, access_code_hash) must yield the SAME id and keep the code.
        let reg2 = Arc::new(WorkspaceRegistry::new(salt.into()));
        let id2 = reg2.add(WorkspaceConfig {
            path: root,
            flags: WorkspaceFlags::default(),
            single_file: None,
            access_code_hash: ws_hash.clone(),
        });
        assert_eq!(id, id2, "workspace id must be stable across reseed");
        assert_eq!(
            reg2.get(&id2).unwrap().access_code_hash(),
            ws_hash,
            "code must survive the reseed"
        );
        let mut state2 = test_state(reg2);
        state2.access_code_hash = Arc::new(global_hash);
        let (h2, scope2) = access_scope_for(&state2, &id2).expect("gated after reseed");
        assert_eq!(scope2, format!("w:{id2}"));
        assert_eq!(h2, ws_hash, "after restart: workspace code must STILL win");
    }

    /// Repro for "the correct workspace code shows no content": the unlock
    /// cookie must round-trip a `w:{id}` scope. The scope itself contains a
    /// colon, so a pair encodes as `w:{id}:{hash}`; decoding must split on the
    /// LAST colon. With the old `split_once`, a workspace cookie decoded to
    /// scope "w" and never matched its `w:{id}` gate — only the colon-free `s`
    /// (global) scope worked, so entering the right workspace code looped back
    /// to the gate while the global code got in.
    #[test]
    fn access_cookie_round_trips_workspace_scope() {
        let secret = "test-salt";
        let scopes = vec![
            ("w:1a2b3c4d".to_string(), "4f965".to_string()),
            ("s".to_string(), "abcde".to_string()),
        ];
        let cookie = make_access_cookie(secret, &scopes, access_now_unix() + 1000);
        let back = access_cookie_scopes(secret, Some(&cookie));
        assert!(
            back.contains(&("w:1a2b3c4d".to_string(), "4f965".to_string())),
            "workspace scope must survive the cookie round-trip: {back:?}"
        );
        assert!(back.contains(&("s".to_string(), "abcde".to_string())));
    }

    async fn response_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 response")
    }

    fn all_flags() -> WorkspaceFlags {
        WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: true,
            enable_live: true,
            enable_chat: true,
            shared_annotation: true,
        }
    }

    fn headers_with(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(o) = origin {
            h.insert("origin", o.parse().unwrap());
        }
        if let Some(host) = host {
            h.insert("host", host.parse().unwrap());
        }
        h
    }

    fn loopback() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1618)
    }

    fn lan_peer() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)), 51234)
    }

    #[test]
    fn ws_origin_accepts_matching_authority() {
        let h = headers_with(Some("http://192.168.1.10:1618"), Some("192.168.1.10:1618"));
        assert!(check_ws_origin(&h, &lan_peer()));
    }

    #[test]
    fn ws_origin_rejects_cross_origin() {
        let h = headers_with(Some("http://evil.example.com"), Some("192.168.1.10:1618"));
        assert!(!check_ws_origin(&h, &lan_peer()));
    }

    #[test]
    fn ws_origin_rejects_port_mismatch() {
        let h = headers_with(Some("http://127.0.0.1:9000"), Some("127.0.0.1:1618"));
        assert!(!check_ws_origin(&h, &loopback()));
    }

    #[test]
    fn ws_origin_rejects_null_origin() {
        let h = headers_with(Some("null"), Some("127.0.0.1:1618"));
        assert!(!check_ws_origin(&h, &loopback()));
    }

    #[test]
    fn ws_missing_origin_allowed_only_from_loopback() {
        let h = headers_with(None, Some("127.0.0.1:1618"));
        assert!(check_ws_origin(&h, &loopback()));
        assert!(!check_ws_origin(&h, &lan_peer()));
    }

    #[test]
    fn ws_origin_case_insensitive_host_match() {
        let h = headers_with(
            Some("http://Example.Local:1618"),
            Some("example.local:1618"),
        );
        assert!(check_ws_origin(&h, &loopback()));
    }

    #[test]
    fn ws_origin_with_trailing_path_still_matches_authority() {
        // Defensive: spec says Origin has no path, but some clients append one.
        let h = headers_with(Some("http://127.0.0.1:1618/"), Some("127.0.0.1:1618"));
        assert!(check_ws_origin(&h, &loopback()));
    }

    #[test]
    fn ws_file_path_accepts_normal_paths() {
        assert!(is_valid_ws_file_path("notes/intro.md"));
        assert!(is_valid_ws_file_path("README.md"));
        assert!(is_valid_ws_file_path("docs/api/index.html"));
    }

    #[test]
    fn ws_file_path_accepts_absolute_path() {
        // The server issues the file's absolute path; the client echoes it back
        // as its WS identity. Absolute paths must be accepted or shared-mode
        // persistence never connects.
        assert!(is_valid_ws_file_path("/tmp/workspace/doc.md"));
        assert!(is_valid_ws_file_path("/Users/me/notes/intro.md"));
    }

    #[test]
    fn ws_file_path_rejects_parent_traversal() {
        assert!(!is_valid_ws_file_path("../etc/passwd"));
        assert!(!is_valid_ws_file_path("notes/../../etc/passwd"));
        assert!(!is_valid_ws_file_path("/tmp/ws/../../etc/passwd"));
    }

    #[test]
    fn ws_file_path_rejects_nul_byte_and_empty() {
        assert!(!is_valid_ws_file_path(""));
        assert!(!is_valid_ws_file_path("a\0b"));
    }

    #[test]
    fn ws_file_path_rejects_overlong() {
        let big = "a".repeat(1025);
        assert!(!is_valid_ws_file_path(&big));
    }

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

    /// `NewAnnotation` round-trips `op_id` verbatim in both directions and
    /// the field is omitted from the wire when `None` — keeping the protocol
    /// backward-compatible with clients that don't know about it yet.
    #[test]
    fn test_new_annotation_op_id_round_trip() {
        // Some(op_id): present on the wire, parsed back identically.
        let with = WebSocketMessage::NewAnnotation {
            annotation: json!({ "id": "anno-1", "text": "hi" }),
            op_id: Some("op-abc".into()),
        };
        let json_with = serde_json::to_string(&with).unwrap();
        assert!(
            json_with.contains("\"op_id\":\"op-abc\""),
            "wire form should include op_id: {json_with}"
        );
        let parsed: WebSocketMessage = serde_json::from_str(&json_with).unwrap();
        match parsed {
            WebSocketMessage::NewAnnotation { op_id, .. } => {
                assert_eq!(op_id.as_deref(), Some("op-abc"));
            }
            _ => panic!("expected NewAnnotation"),
        }

        // None: omitted from the wire (back-compat with old clients).
        let without = WebSocketMessage::NewAnnotation {
            annotation: json!({ "id": "anno-2" }),
            op_id: None,
        };
        let json_without = serde_json::to_string(&without).unwrap();
        assert!(
            !json_without.contains("op_id"),
            "wire form should omit op_id when None: {json_without}"
        );

        // An old-client payload with no op_id field deserialises to None.
        let legacy = r#"{"type":"new_annotation","annotation":{"id":"x"}}"#;
        let parsed_legacy: WebSocketMessage = serde_json::from_str(legacy).unwrap();
        match parsed_legacy {
            WebSocketMessage::NewAnnotation { op_id, .. } => assert!(op_id.is_none()),
            _ => panic!("expected NewAnnotation"),
        }
    }

    #[test]
    fn test_app_state_identity() {
        let (tx, _) = tokio::sync::mpsc::channel(1);
        let registry = Arc::new(crate::workspace::WorkspaceRegistry::new("salt".into()));
        let state = AppState {
            theme: Arc::new("dark".into()),
            tera: Arc::new(Tera::default()),
            db: None,
            tx: None,
            workspace_registry: registry,
            management_token: Arc::new("token".into()),
            save_token: Arc::new("save-token".into()),
            i18n_json: Arc::new("{}".into()),
            i18n_lang: Arc::new("zh".into()),
            shortcuts_json: Arc::new("{}".into()),
            styles_css: Arc::new("".into()),
            default_chat_mode: Arc::new("in_page".into()),
            editor_theme: Arc::new("follow".into()),
            access_code_hash: Arc::new(String::new()),
            access_secret: Arc::new("test-salt".into()),
            access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            print_collapsed_content: false,
            shutdown_tx: tx,
            #[cfg(debug_assertions)]
            dev_reload_tx: Arc::new(broadcast::channel::<()>(1).0),
        };
        assert_eq!(state.management_token.as_str(), "token");
    }

    fn sample_hosts() -> Vec<crate::net::BindHostOption> {
        use crate::net::{BindHostKind, BindHostOption};
        vec![
            BindHostOption {
                address: "127.0.0.1".into(),
                kind: BindHostKind::Localhost,
                interface: None,
            },
            BindHostOption {
                address: "0.0.0.0".into(),
                kind: BindHostKind::AllInterfaces,
                interface: None,
            },
            BindHostOption {
                address: "192.168.1.20".into(),
                kind: BindHostKind::Interface,
                interface: Some("en0".into()),
            },
            BindHostOption {
                address: "10.0.0.5".into(),
                kind: BindHostKind::Interface,
                interface: Some("eth1".into()),
            },
        ]
    }

    #[test]
    fn reachable_wildcard_lists_localhost_then_interfaces() {
        let r = assemble_reachable_urls("0.0.0.0", "", 6419, &sample_hosts());
        assert_eq!(r.all.len(), 3);
        assert_eq!(r.all[0].label, "localhost");
        assert_eq!(r.all[0].url, "http://127.0.0.1:6419");
        assert_eq!(r.all[1].url, "http://192.168.1.20:6419");
        assert_eq!(r.all[2].url, "http://10.0.0.5:6419");
        // No advertised preference → first interface is featured (not localhost).
        assert_eq!(r.featured, "http://192.168.1.20:6419");
    }

    #[test]
    fn reachable_wildcard_honours_advertised_host_and_falls_back() {
        let hosts = sample_hosts();
        // Advertised host is a live interface → used verbatim.
        assert_eq!(
            assemble_reachable_urls("0.0.0.0", "10.0.0.5", 6419, &hosts).featured,
            "http://10.0.0.5:6419"
        );
        // Stale advertised host (not currently bound) → first interface.
        assert_eq!(
            assemble_reachable_urls("0.0.0.0", "172.16.9.9", 6419, &hosts).featured,
            "http://192.168.1.20:6419"
        );
    }

    #[test]
    fn reachable_wildcard_without_interfaces_falls_back_to_localhost() {
        use crate::net::{BindHostKind, BindHostOption};
        let hosts = vec![
            BindHostOption {
                address: "127.0.0.1".into(),
                kind: BindHostKind::Localhost,
                interface: None,
            },
            BindHostOption {
                address: "0.0.0.0".into(),
                kind: BindHostKind::AllInterfaces,
                interface: None,
            },
        ];
        let r = assemble_reachable_urls("0.0.0.0", "", 6419, &hosts);
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.featured, "http://127.0.0.1:6419");
    }

    #[test]
    fn reachable_specific_bind_lists_only_that_address() {
        let r = assemble_reachable_urls("192.168.1.20", "", 6419, &sample_hosts());
        // A specific bind does NOT serve loopback, so localhost is absent.
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.all[0].label, "en0");
        assert_eq!(r.featured, "http://192.168.1.20:6419");
    }

    #[test]
    fn reachable_loopback_binds() {
        let hosts = sample_hosts();
        let v4 = assemble_reachable_urls("127.0.0.1", "", 6419, &hosts);
        assert_eq!(v4.all.len(), 1);
        assert_eq!(v4.featured, "http://127.0.0.1:6419");
        // IPv6 loopback is preserved (bracketed), not collapsed to 127.0.0.1.
        let v6 = assemble_reachable_urls("::1", "", 6419, &hosts);
        assert_eq!(v6.featured, "http://[::1]:6419");
    }

    #[test]
    fn access_cookie_round_trips_and_rejects_tamper() {
        let secret = "test-secret";
        let scopes = vec![("s".to_string(), "h1".to_string())];
        let raw = make_access_cookie(secret, &scopes, access_now_unix() + 100);
        let kv = raw.split(';').next().unwrap(); // markon_access=PAYLOAD.SIG
        assert_eq!(access_cookie_scopes(secret, Some(kv)), scopes);
        // Wrong secret, tampered value, and an expired cookie are all rejected.
        assert!(access_cookie_scopes("other-secret", Some(kv)).is_empty());
        assert!(access_cookie_scopes(secret, Some(&format!("{kv}00"))).is_empty());
        let expired = make_access_cookie(secret, &scopes, 1);
        assert!(access_cookie_scopes(secret, Some(expired.split(';').next().unwrap())).is_empty());
    }

    #[test]
    fn access_cooldown_locks_after_threshold() {
        let state = test_state(Arc::new(WorkspaceRegistry::new("s".into())));
        let ip: std::net::IpAddr = "1.2.3.4".parse().unwrap();
        for _ in 0..ACCESS_MAX_FAILS - 1 {
            assert!(access_record_failure(&state, ip).is_none());
        }
        assert!(access_cooldown_remaining(&state, ip).is_none());
        assert!(access_record_failure(&state, ip).is_some()); // crosses threshold → locks
        assert!(access_cooldown_remaining(&state, ip).is_some());
        access_record_success(&state, ip);
        assert!(access_cooldown_remaining(&state, ip).is_none());
    }

    #[test]
    fn access_gated_workspace_recognizes_routes() {
        assert_eq!(
            access_gated_workspace("/abcd1234/doc.md").as_deref(),
            Some("abcd1234")
        );
        assert_eq!(
            access_gated_workspace("/api/chat/abcd1234/threads").as_deref(),
            Some("abcd1234")
        );
        assert_eq!(
            access_gated_workspace("/_/ws/abcd1234").as_deref(),
            Some("abcd1234")
        );
        assert!(access_gated_workspace("/_/css/tokens.css").is_none());
        assert!(access_gated_workspace("/_/unlock").is_none());
        assert!(access_gated_workspace("/api/preview").is_none());
        assert!(access_gated_workspace("/favicon.ico").is_none());
    }

    #[test]
    fn featured_base_url_loopback_and_specific_are_network_independent() {
        // These paths don't enumerate interfaces, so the public wrappers are
        // deterministic regardless of the machine running the test.
        assert_eq!(
            featured_base_url("127.0.0.1", "", 6419),
            "http://127.0.0.1:6419"
        );
        assert_eq!(
            featured_base_url("198.51.100.7", "", 6419),
            "http://198.51.100.7:6419"
        );
        let r = reachable_urls("127.0.0.1", "", 6419);
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.featured, "http://127.0.0.1:6419");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn canonicalize_route_path_strips_windows_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let std_path = std::fs::canonicalize(dir.path()).unwrap();
        let route_path = canonicalize_route_path(dir.path()).unwrap();

        assert!(
            std_path.to_string_lossy().starts_with(r"\\?\"),
            "test expects Windows std::fs::canonicalize to return verbatim paths, got {std_path:?}"
        );
        assert!(
            !route_path.to_string_lossy().starts_with(r"\\?\"),
            "route canonicalization must match workspace roots stored through dunce: {route_path:?}"
        );
    }

    #[tokio::test]
    async fn workspace_path_handler_renders_markdown_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        fs::write(&file, "# Windows route check\n\nalpha beta gamma").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("route-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_path(State(state), AxumPath((id, "README.md".to_string())))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("Windows route check"));
        assert!(body.contains("alpha beta gamma"));
        assert!(body.contains("enable-edit"));
        assert!(body.contains("enable-search"));
    }

    #[tokio::test]
    async fn workspace_path_handler_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "# outside").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("traversal-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags::default(),
        );
        let state = test_state(registry);
        let outside_name = outside.path().file_name().unwrap().to_string_lossy();
        let route = format!("../{outside_name}");

        let response = handle_workspace_path(State(state), AxumPath((id, route)))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn directory_listing_uses_workspace_relative_links() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("README.md"), "# nested").unwrap();
        fs::write(sub.join("notes.txt"), "not listed").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("listing-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags::default(),
        );
        let state = test_state(registry);

        let response = handle_workspace_path(State(state), AxumPath((id.clone(), "sub/".into())))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains(&format!("/{id}/sub/README.md")));
        assert!(body.contains(&format!("/{id}/")));
        assert!(!body.contains("notes.txt"));
    }

    #[tokio::test]
    async fn save_file_handler_writes_relative_and_absolute_workspace_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        fs::write(&file, "# before").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("save-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_edit: true,
                ..WorkspaceFlags::default()
            },
        );
        let state = test_state(registry);

        let relative = SaveFileRequest {
            workspace_id: id.clone(),
            file_path: "README.md".into(),
            content: "# relative save".into(),
        };
        let response = save_file_handler(State(state.clone()), Json(relative))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(fs::read_to_string(&file).unwrap(), "# relative save");

        let absolute = SaveFileRequest {
            workspace_id: id,
            file_path: file.to_string_lossy().to_string(),
            content: "# absolute save".into(),
        };
        let response = save_file_handler(State(state), Json(absolute))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(fs::read_to_string(&file).unwrap(), "# absolute save");
    }

    #[tokio::test]
    async fn save_file_handler_rejects_outside_workspace_paths() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "# outside").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("save-outside-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_edit: true,
                ..WorkspaceFlags::default()
            },
        );
        let state = test_state(registry);

        let request = SaveFileRequest {
            workspace_id: id,
            file_path: outside.path().to_string_lossy().to_string(),
            content: "# should not write".into(),
        };
        let response = save_file_handler(State(state), Json(request))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "Access denied");
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "# outside");
    }

    #[tokio::test]
    async fn single_file_workspace_redirects_and_hides_siblings() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("opened.md"), "# opened\n\n![pic](pic.png)").unwrap();
        fs::write(dir.path().join("sibling.md"), "# sibling").unwrap();
        fs::write(dir.path().join("pic.png"), b"png").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("single-file-test".into()));
        let id = registry.add(WorkspaceConfig {
            path: dunce::canonicalize(dir.path()).unwrap(),
            flags: WorkspaceFlags::default(),
            single_file: Some("opened.md".into()),
            access_code_hash: String::new(),
        });
        let state = test_state(registry);

        let root = handle_workspace_root(State(state.clone()), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(root.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            root.headers().get(header::LOCATION).unwrap(),
            &format!("/{id}/opened.md")
        );

        let opened = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "opened.md".into())),
        )
        .await
        .into_response();
        assert_eq!(opened.status(), StatusCode::OK);

        let asset = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "pic.png".into())),
        )
        .await
        .into_response();
        assert_eq!(asset.status(), StatusCode::OK);

        let sibling = handle_workspace_path(State(state), AxumPath((id, "sibling.md".into())))
            .await
            .into_response();
        assert_eq!(sibling.status(), StatusCode::NOT_FOUND);
    }
}
