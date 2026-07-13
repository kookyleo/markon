use axum::{
    extract::{
        ws::{Message, WebSocket},
        Extension, Path as AxumPath, Query, State, WebSocketUpgrade,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{stream::StreamExt, SinkExt};
use qrcode::render::unicode::Dense1x2;
use qrcode::{EcLevel, QrCode};
use rayon::prelude::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use tera::Tera;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};

use crate::admin_auth::{self, AdminBootstrapStore};
use crate::assets::{CssAssets, IconAssets, JsAssets, Templates};
use crate::git;
use crate::i18n;
use crate::markdown::{
    default_markdown_engine, MarkdownEngine, MarkdownHtmlRenderer, MarkdownRenderer,
};
use crate::markdown_ast;
use crate::search::{SearchQuery, SearchResult};
use crate::workspace::{
    ct_eq, expand_and_canonicalize, generate_token, ServerLock, WorkspaceConfig, WorkspaceEntry,
    WorkspaceEvent, WorkspaceFlags, WorkspaceRegistry,
};
use crate::workspace_fs::WorkspaceFs;

const WORKSPACE_WS_ROUTE: &str = "/_/{workspace_id}/ws";

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
    /// File name for a temporary single-file workspace. When set, `path` is
    /// its parent directory and the registry keeps serving/search scoped to
    /// this file and its explicitly referenced local assets.
    pub single_file: Option<String>,
    /// Per-workspace collaborator access-code hash (empty = inherit the server
    /// collaborator code).
    pub collaborator_access_code_hash: String,
    /// Optional short display name (empty = none).
    pub alias: String,
}

/// Server configuration
pub struct ServerConfig {
    pub host: String,
    /// Preferred address to feature when bound to a wildcard (0.0.0.0/::):
    /// the LAN IP used for the headline URL, QR code, and browser auto-open.
    /// Empty = no preference (fall back to the first interface).
    pub advertised_host: String,
    /// Exact host names accepted in HTTP Host/Origin authorities in addition
    /// to localhost, bind addresses, and the advertised address. Entries may
    /// be bare hosts or full http(s) origins; no wildcards are accepted.
    pub trusted_hosts: Vec<String>,
    pub port: u16,
    pub theme: String,
    pub qr: Option<String>,
    pub open_browser: Option<String>,
    pub shared_annotation: bool,
    /// SQLite path for annotations, viewed state, and chat.
    /// `MARKON_SQLITE_PATH` still takes precedence when present.
    pub db_path: Option<String>,
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
    /// Optional externally-owned bootstrap store (GUI mode). Keeping the store
    /// beside the native process lets it mint browser capabilities without
    /// exposing the long-lived management token to any page.
    pub admin_bootstraps: Option<Arc<AdminBootstrapStore>>,
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
    /// Server-level collaborator access-code hash (empty = no collaborator
    /// token unless a workspace defines one).
    pub collaborator_access_code_hash: String,
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
    /// Timestamp of the most recent recorded failure. Used to expire stale
    /// entries so the per-IP map does not grow unbounded (especially with
    /// per-address IPv6 clients).
    pub last_attempt: Option<std::time::Instant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessRole {
    Collaborator,
    Admin,
}

#[derive(Clone, Debug)]
struct AccessRequirement {
    role: AccessRole,
    hash: String,
    scope: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AllowedHosts {
    names: HashSet<String>,
    secure_names: HashSet<String>,
}

impl AllowedHosts {
    fn insert(&mut self, value: &str) {
        if let Some((name, secure)) = normalized_configured_host(value) {
            self.names.insert(name.clone());
            if secure {
                self.secure_names.insert(name);
            }
        }
    }

    fn allows_header(&self, host: Option<&str>) -> bool {
        host.and_then(normalized_authority_host)
            .is_some_and(|host| self.names.contains(&host))
    }

    fn is_secure_header(&self, host: Option<&str>) -> bool {
        host.and_then(normalized_authority_host)
            .is_some_and(|host| self.secure_names.contains(&host))
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub theme: Arc<String>,
    pub tera: Arc<Tera>,
    pub db: Option<Arc<Mutex<Connection>>>,
    pub workspace_registry: Arc<WorkspaceRegistry>,
    pub management_token: Arc<String>,
    pub admin_bootstraps: Arc<AdminBootstrapStore>,
    pub(crate) allowed_hosts: Arc<AllowedHosts>,
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
    /// Access gate: server-level collaborator access-code hash.
    pub collaborator_access_code_hash: Arc<String>,
    /// Secret for signing access cookies — the persistent per-install salt, so
    /// unlock cookies survive restarts (30-day persistence).
    pub access_secret: Arc<String>,
    /// Per-source-IP failed-unlock tracking for the brute-force cooldown.
    pub access_attempts:
        Arc<std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, AccessAttempts>>>,
    /// In-memory rendered Markdown diff cache. Scoped to this server state so
    /// theme/config changes get their own cache lifecycle.
    pub(crate) markdown_diff_cache: Arc<Mutex<MarkdownDiffCache>>,
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
        Some(path) => workspace_file_url(workspace_id, path),
        None => workspace_root_url(workspace_id),
    }
}

fn workspace_root_url(workspace_id: &str) -> String {
    format!("/{workspace_id}/")
}

fn workspace_file_url(workspace_id: &str, path: &str) -> String {
    let rel = path.trim_start_matches('/');
    if rel.is_empty() {
        workspace_root_url(workspace_id)
    } else {
        format!("/{workspace_id}/{}", encode_route_path(rel))
    }
}

fn workspace_internal_url(workspace_id: &str, path: &str) -> String {
    let rel = path.trim_start_matches('/');
    format!("/_/{workspace_id}/{rel}")
}

fn workspace_git_history_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "git/history")
}

fn normalize_host_name(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches(['[', ']']).trim_end_matches('.');
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

fn normalized_authority_host(authority: &str) -> Option<String> {
    authority
        .parse::<axum::http::uri::Authority>()
        .ok()
        .and_then(|authority| normalize_host_name(authority.host()))
}

fn normalized_configured_host(value: &str) -> Option<(String, bool)> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "local" || trimmed == "missing" {
        return None;
    }
    if trimmed.contains("://") {
        let uri = trimmed.parse::<axum::http::Uri>().ok()?;
        let authority = uri.authority()?;
        let name = normalize_host_name(authority.host())?;
        let secure = uri
            .scheme_str()
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https"));
        return Some((name, secure));
    }
    if let Some(name) = normalized_authority_host(trimmed) {
        return Some((name, false));
    }
    trimmed
        .parse::<std::net::IpAddr>()
        .ok()
        .and_then(|ip| normalize_host_name(&ip.to_string()))
        .map(|name| (name, false))
}

fn build_allowed_hosts(
    bind_host: &str,
    advertised_host: &str,
    port: u16,
    trusted_hosts: &[String],
    external_bases: &[Option<String>],
) -> AllowedHosts {
    let mut allowed = AllowedHosts::default();
    for host in ["localhost", "127.0.0.1", "::1", bind_host, advertised_host] {
        allowed.insert(host);
    }
    // A wildcard bind is reachable through each current interface address;
    // reuse the URL enumerator so legitimate LAN Host headers remain valid.
    for reachable in reachable_urls(bind_host, advertised_host, port).all {
        allowed.insert(&reachable.url);
    }
    for host in trusted_hosts {
        allowed.insert(host);
    }
    for base in external_bases.iter().flatten() {
        allowed.insert(base);
    }
    allowed
}

fn workspace_git_branches_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "git/branches")
}

fn workspace_git_tags_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "git/tags")
}

fn workspace_git_checkout_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "git/checkout")
}

fn workspace_files_data_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "files/data")
}

fn workspace_files_dir_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "files/dir")
}

fn workspace_file_create_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "files/create")
}

fn workspace_folder_create_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "files/folder")
}

fn workspace_settings_features_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "settings/features")
}

fn workspace_compare_base_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "compare")
}

fn workspace_compare_options_url(workspace_id: &str) -> String {
    workspace_internal_url(workspace_id, "compare/options")
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

/// Pure core of reachable-URL computation, taking the currently-available bind
/// hosts explicitly so it can be unit-tested without touching real interfaces.
///
/// Rules:
///   - loopback binds are reachable only through that loopback family.
///   - wildcard binds expose the matching address family:
///     `0.0.0.0` lists IPv4 loopback + IPv4 interfaces, while `::` lists
///     IPv6 loopback + IPv6 interfaces.
///   - the featured wildcard URL is `advertised_host` when it is still a live
///     interface for that family, otherwise the first interface, otherwise
///     the family loopback.
///   - a specific (non-loopback) bind exposes exactly that address.
fn assemble_reachable_urls(
    bind_host: &str,
    advertised_host: &str,
    port: u16,
    hosts: &[crate::net::BindHostOption],
) -> ReachableUrls {
    use crate::net::BindHostKind;

    let trimmed = bind_host.trim();
    let is_wildcard_v6 = crate::net::host_is_wildcard_v6(trimmed);
    let is_wildcard_v4 = crate::net::host_is_wildcard_v4(trimmed);
    let is_wildcard = is_wildcard_v4 || is_wildcard_v6;
    let is_loopback = crate::net::host_is_loopback(trimmed);
    let loopback_addr = if is_wildcard_v6 { "::1" } else { "127.0.0.1" };

    // (label, address) entries. Only a wildcard bind also serves loopback, so
    // for a specific bind we list exactly that one address (127.0.0.1 is NOT
    // reachable when the socket is bound to a single LAN IP).
    let mut entries: Vec<(String, String)> = Vec::new();
    if is_wildcard {
        entries.push(("localhost".to_string(), loopback_addr.to_string()));
        for h in hosts.iter().filter(|h| {
            h.kind == BindHostKind::Interface
                && if is_wildcard_v6 {
                    crate::net::host_is_ipv6(&h.address)
                } else {
                    crate::net::host_is_ipv4(&h.address)
                }
        }) {
            entries.push((h.interface.clone().unwrap_or_default(), h.address.clone()));
        }
    } else {
        let label = if is_loopback {
            "localhost".to_string()
        } else {
            hosts
                .iter()
                .find(|h| crate::net::host_matches(&h.address, trimmed))
                .and_then(|h| h.interface.clone())
                .unwrap_or_default()
        };
        entries.push((label, trimmed.to_string()));
    }

    let all: Vec<ReachableUrl> = entries
        .iter()
        .map(|(label, addr)| ReachableUrl {
            label: label.clone(),
            url: format!("http://{}:{}", crate::net::url_host_literal(addr), port),
        })
        .collect();

    let featured_addr: String = if is_wildcard {
        let adv = advertised_host.trim();
        let lan: Vec<&String> = entries
            .iter()
            .filter(|(label, _)| label != "localhost")
            .map(|(_, addr)| addr)
            .collect();
        if !adv.is_empty() && lan.iter().any(|a| crate::net::host_matches(a, adv)) {
            adv.to_string()
        } else if let Some(first) = lan.first() {
            (*first).clone()
        } else {
            loopback_addr.to_string()
        }
    } else {
        trimmed.to_string()
    };
    let featured = format!(
        "http://{}:{}",
        crate::net::url_host_literal(&featured_addr),
        port
    );

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
    canonicalize_route_path(ws.fs.ambient_root())
        .unwrap_or_else(|_| ws.fs.ambient_root().to_path_buf())
}

macro_rules! directory_root_or_not_found {
    ($ws:expr) => {
        match $ws.fs.directory_root() {
            Some(root) => root,
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
}

fn workspace_relative_path(path: &FsPath, root: &FsPath) -> Option<PathBuf> {
    path.strip_prefix(root).ok().map(PathBuf::from)
}

fn is_inside_workspace(path: &FsPath, root: &FsPath) -> bool {
    path.starts_with(root)
}

/// Verify that the deepest already-existing ancestor of `target` canonicalizes
/// to a location inside `root`, BEFORE any directory is materialized. This
/// closes the window where a pre-existing symlinked intermediate could make
/// `create_dir_all` create directories outside the workspace root: any newly
/// created component cannot be a symlink, so only existing ancestors can
/// escape, and the deepest one dominates the resolved location.
fn deepest_existing_ancestor_inside_workspace(target: &FsPath, root: &FsPath) -> bool {
    let mut ancestor = target.parent();
    while let Some(dir) = ancestor {
        if fs::symlink_metadata(dir).is_ok() {
            return matches!(
                canonicalize_route_path(dir),
                Ok(p) if is_inside_workspace(&p, root)
            );
        }
        ancestor = dir.parent();
    }
    // No existing ancestor found (the workspace root should always exist).
    false
}

fn path_to_route(path: &FsPath) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn workspace_display_name(ws: &WorkspaceEntry, root: &FsPath) -> String {
    let alias = ws.alias();
    if alias.is_empty() {
        root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        alias
    }
}

fn workspace_display_path(root: &FsPath) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rel) = root.strip_prefix(&home) {
            return if rel.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", path_to_route(rel))
            };
        }
    }
    root.display().to_string()
}

fn insert_workspace_header_context(
    context: &mut tera::Context,
    ws: &WorkspaceEntry,
    root: &FsPath,
) {
    context.insert("workspace_display_name", &workspace_display_name(ws, root));
    context.insert("workspace_display_path", &workspace_display_path(root));
}

fn encode_route_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn path_to_hash(path: &FsPath) -> String {
    encode_route_path(&path_to_route(path))
}

fn workspace_file_back_link(workspace_id: &str, path: &FsPath, root: &FsPath) -> String {
    workspace_relative_path(path, root)
        .map(|rel| {
            let hash_path = path_to_hash(&rel);
            if hash_path.is_empty() {
                workspace_root_url(workspace_id)
            } else {
                format!("/{workspace_id}/#{hash_path}")
            }
        })
        .unwrap_or_else(|| workspace_root_url(workspace_id))
}

fn sanitize_new_file_path(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.contains('\0') {
        return None;
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
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

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct WsHello {
    #[serde(rename = "type")]
    _kind: WsHelloKind,
    target: WsTarget,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
enum WsHelloKind {
    Hello,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WsTarget {
    Document { path: String },
    Surface { key: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WsSessionTarget {
    Document { file_path: String },
    Surface,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WsSession {
    channel: String,
    target: WsSessionTarget,
}

pub async fn start(config: ServerConfig) -> Result<(), String> {
    let ServerConfig {
        host,
        advertised_host,
        trusted_hosts,
        port,
        theme,
        qr,
        open_browser,
        shared_annotation: _,
        db_path,
        salt,
        initial_workspaces,
        bound_listener,
        registry,
        management_token,
        admin_bootstraps,
        language,
        shortcuts_json,
        styles_css,
        default_chat_mode,
        editor_theme,
        collaborator_access_code_hash,
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

    // Workspace features are runtime-configurable from the workspace page, so
    // the SQLite-backed stores must exist even when the corresponding features
    // were disabled at process start. Collaboration fan-out lives on each
    // WorkspaceEntry so cross-workspace delivery is impossible by construction.
    let db_path = std::env::var("MARKON_SQLITE_PATH")
        .ok()
        .or(db_path)
        .unwrap_or_else(|| {
            let home = dirs::home_dir().expect("Cannot find home directory");
            home.join(".markon/annotation.sqlite")
                .to_string_lossy()
                .to_string()
        });
    let parent_dir = std::path::Path::new(&db_path).parent().unwrap();
    fs::create_dir_all(parent_dir).expect("Failed to create database directory");
    let conn = Connection::open(&db_path).expect("Failed to open database");
    // WAL: the single-server invariant is not enforced (the GUI can start a
    // second server on a different/auto port while a CLI daemon holds the same
    // db — it never consults the server lock), so two processes can open this
    // file concurrently. WAL gives multi-reader / single-writer concurrency
    // across processes instead of the rollback journal's whole-file lock. It is
    // persisted in the db header (set-once; re-asserting on each open is cheap)
    // and adds `-wal`/`-shm` sidecar files — a plain-copy backup must include
    // them or checkpoint first.
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .unwrap_or_default();
    if !journal_mode.eq_ignore_ascii_case("wal") {
        tracing::warn!(
            got = %journal_mode,
            "could not enable WAL journal mode; concurrent multi-process access may hit 'database is locked'"
        );
    }
    // Wait up to 5s for a competing writer to release the lock instead of
    // failing immediately with SQLITE_BUSY — complements WAL under write bursts.
    conn.pragma_update(None, "busy_timeout", 5000)
        .expect("Failed to set busy_timeout");
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
    let db = Some(Arc::new(Mutex::new(conn)));

    // Build workspace registry and register initial workspaces.
    let effective_salt = salt.unwrap_or_else(|| format!("markon:{port}"));
    // Sign access cookies with the persistent salt so they survive restarts.
    let access_cookie_secret = effective_salt.clone();
    let registry = registry.unwrap_or_else(|| Arc::new(WorkspaceRegistry::new(effective_salt)));

    // Track first workspace's URL path for browser/QR.
    let mut first_workspace_url_path: Option<String> = None;

    for ws_init in initial_workspaces {
        let path = expand_and_canonicalize(&ws_init.path.to_string_lossy())
            .unwrap_or_else(|_| ws_init.path.clone());
        let id = registry.add(WorkspaceConfig {
            path,
            flags: ws_init.flags,
            single_file: ws_init.single_file,
            collaborator_access_code_hash: ws_init.collaborator_access_code_hash,
            alias: ws_init.alias,
        });
        if first_workspace_url_path.is_none() {
            let url_path = workspace_url_path(&id, ws_init.initial_path.as_deref());
            first_workspace_url_path = Some(url_path);
        }
    }

    let token = Arc::new(management_token.unwrap_or_else(generate_token));
    let admin_bootstraps = admin_bootstraps.unwrap_or_else(|| Arc::new(AdminBootstrapStore::new()));
    let allowed_hosts = Arc::new(build_allowed_hosts(
        &host,
        &advertised_host,
        port,
        &trusted_hosts,
        &[qr.clone(), open_browser.clone()],
    ));
    // Distinct from the management token: this one is embedded in served edit
    // pages, so it must not unlock the privileged management routes.
    let save_token = Arc::new(generate_token());

    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    let state = AppState {
        theme: Arc::new(theme),
        tera: Arc::new(tera),
        db,
        workspace_registry: registry,
        management_token: token.clone(),
        admin_bootstraps: admin_bootstraps.clone(),
        allowed_hosts,
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
        collaborator_access_code_hash: Arc::new(collaborator_access_code_hash),
        access_secret: Arc::new(access_cookie_secret),
        access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        markdown_diff_cache: Arc::new(Mutex::new(MarkdownDiffCache::default())),
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
        .route(
            "/api/workspace/{id}/access",
            axum::routing::put(update_workspace_access_handler),
        )
        .route("/api/workspaces", get(list_workspaces_handler))
        .route("/api/admin/bootstrap", post(create_admin_bootstrap_handler))
        .route("/api/shutdown", post(shutdown_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_and_token,
        ));

    // Save API: same-origin browser page + a workspace-scoped save capability
    // (or the master token). Kept separate from `mgmt` so a token embedded in
    // one edit page cannot reach privileged routes or another workspace.
    let save = Router::new()
        .route("/api/save", post(save_file_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_save_origin,
        ));

    // Preview API: stateless "text in, HTML out" for the editor's live preview.
    // Guarded same-origin (or loopback without Origin), so a cross-site page or
    // an anonymous LAN device can no longer hammer syntect rendering into a CPU
    // DoS. A tight body limit bounds per-request work, and the handler offloads
    // the render to a blocking pool so one large document can't stall a worker.
    let preview = Router::new()
        .route("/api/preview", post(preview_handler))
        .layer(axum::extract::DefaultBodyLimit::max(PREVIEW_BODY_LIMIT))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_local_save_origin,
        ));

    let app = Router::new()
        // Static assets (literal prefix beats /{workspace_id}/ param)
        .route("/favicon.ico", get(serve_favicon))
        .route("/_/favicon.ico", get(serve_favicon))
        .route("/_/favicon.svg", get(serve_favicon_svg))
        .route("/_/css/{filename}", get(serve_css))
        .route("/_/js/{*path}", get(serve_js))
        .route("/_/admin", get(admin_bootstrap_page))
        .route("/_/admin/bootstrap", get(admin_bootstrap_page))
        .route("/_/admin/session", post(admin_session_handler))
        .route("/_/ws/{workspace_id}", get(config_ws_handler))
        // Read-only public APIs
        .route("/_/{workspace_id}/search", get(workspace_search_handler))
        // Access-code gate: unlock endpoint (not itself gated).
        .route("/_/unlock", post(unlock_handler))
        // Workspace content routes
        // Chat popout — minimal chat-only page that ChatManager opens via
        // window.open. Registered before the catch-all `{*path}` so the
        // literal `_/chat` segment wins.
        .route(
            "/_/{workspace_id}/git/data/history",
            get(handle_git_history_data),
        )
        .route(
            "/_/{workspace_id}/git/data/diff/work",
            get(handle_git_working_diff_data),
        )
        .route(
            "/_/{workspace_id}/git/data/show/{commit}",
            get(handle_git_commit_diff_data),
        )
        .route("/_/{workspace_id}/git/history", get(handle_git_history))
        .route("/_/{workspace_id}/git/branches", get(handle_git_branches))
        .route("/_/{workspace_id}/git/tags", get(handle_git_tags))
        .route(
            "/_/{workspace_id}/compare/options",
            get(handle_git_compare_options_status),
        )
        .route(
            "/_/{workspace_id}/git/diff/work",
            get(handle_git_working_diff),
        )
        .route(
            "/_/{workspace_id}/git/show/{commit}",
            get(handle_git_commit_diff),
        )
        .route(
            "/_/{workspace_id}/compare/{*range}",
            get(handle_pretty_compare_diff),
        )
        .route(
            "/_/{workspace_id}/git/commit",
            post(handle_git_commit)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/git/checkout",
            post(handle_git_checkout)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/files/data",
            get(handle_workspace_files_data),
        )
        .route(
            "/_/{workspace_id}/files/dir",
            get(handle_workspace_dir_data),
        )
        .route(
            "/_/{workspace_id}/files/create",
            post(handle_workspace_create_file)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/files/folder",
            post(handle_workspace_create_folder)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/files/delete",
            post(handle_workspace_delete_file)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/settings/features",
            post(handle_workspace_update_features)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route(
            "/_/{workspace_id}/settings/alias",
            post(handle_workspace_update_alias)
                .route_layer(axum::middleware::from_fn(require_admin_role))
                .route_layer(axum::middleware::from_fn(require_same_origin)),
        )
        .route("/_/{workspace_id}/chat", get(handle_chat_popout))
        .route(WORKSPACE_WS_ROUTE, get(ws_handler))
        .route("/{workspace_id}/", get(handle_workspace_root))
        .route("/{workspace_id}/{*path}", get(handle_workspace_path))
        // Everything else → 404
        .fallback(|| async { StatusCode::NOT_FOUND })
        .merge(mgmt)
        .merge(save)
        .merge(preview);

    // Dev-only live-reload: esbuild's watch onEnd hook POSTs the trigger,
    // server fans it out as an SSE event, the webview reloads. cfg gate keeps
    // these routes (and the heavy tokio_stream / sse plumbing) out of release
    // builds entirely.
    #[cfg(debug_assertions)]
    let app = app
        .route("/_/dev/reload-stream", get(dev_reload_stream))
        .route("/_/dev/reload-trigger", post(dev_reload_trigger));

    // Chat endpoints: SSE chat stream + thread/file REST. Each handler
    // checks `enable_chat` per-workspace and 403s otherwise, so it's safe
    // to register unconditionally.
    // Chat is a collaboration ability, not management: each handler checks the
    // per-workspace `enable_chat` flag and 403s otherwise, so collaborators may
    // use it when enabled. Access-code, Host, and same-origin layers remain
    // independent boundaries.
    let app = app.merge(
        crate::chat::routes::router().route_layer(axum::middleware::from_fn(require_same_origin)),
    );
    // Access-code gate over every workspace-scoped route (no-op when unset).
    let app = app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        require_access_code,
    ));

    // Reject unknown Host authorities before any route can read or mutate
    // state. Origin==Host alone is insufficient under DNS rebinding.
    let app = app.layer(axum::middleware::from_fn_with_state(
        state.clone(),
        require_allowed_host,
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
        let addr = crate::net::bind_socket_addr(&host, port)?;
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
        let base = if base_opt == "local" {
            local_base.clone()
        } else {
            base_opt.to_string()
        };
        let redirect = first_workspace_url_path.as_deref().unwrap_or("/");
        let nonce = admin_bootstraps.issue_url(redirect);
        let bootstrap = build_workspace_url(&base, "/_/admin/bootstrap");
        let url = format!("{bootstrap}#nonce={nonce}");
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
        loop {
            match rx.recv().await {
                Ok(()) => {
                    if socket
                        .send(axum::extract::ws::Message::Text("reload".into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "config ws broadcast lagged; continuing");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Reject cross-origin WebSocket upgrades. When the server is bound to a
/// non-loopback interface (LAN share / QR-code mobile access), any browser on
/// the same network could otherwise open a workspace collaboration socket from
/// an attacker page and read or poison annotations under a victim's identity.
/// Browsers always send `Origin` on WS handshakes; the rule is "Origin authority
/// must equal Host authority". Native (non-browser) clients can omit Origin —
/// we let those through only when the TCP peer is loopback, since that's
/// where local CLI tooling legitimately connects without an Origin header.
fn check_ws_origin(headers: &axum::http::HeaderMap, peer: &std::net::SocketAddr) -> bool {
    same_origin_or_loopback_no_origin(headers, peer)
}

/// Browser mutating channels served to LAN clients must be same-origin: when
/// `Origin` is present it has to match `Host`. Native local tooling can omit
/// `Origin`, but only from loopback.
fn same_origin_or_loopback_no_origin(
    headers: &axum::http::HeaderMap,
    peer: &std::net::SocketAddr,
) -> bool {
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

fn authorize_ws_target(entry: &WorkspaceEntry, target: WsTarget) -> Option<WsSession> {
    match target {
        WsTarget::Document { path } => {
            let requested = FsPath::new(&path);
            if path.is_empty()
                || path.len() > 4096
                || path.contains('\0')
                || !requested.is_absolute()
            {
                return None;
            }
            let authorized = entry.fs.resolve_content_input(requested).ok()?;
            if !authorized.is_file() {
                return None;
            }
            // Preserve the existing database invariant: annotations and viewed
            // state are keyed by the canonical absolute file path, never by a
            // workspace id or client-supplied alias.
            let file_path = authorized.to_string_lossy().into_owned();
            Some(WsSession {
                channel: format!("document:{file_path}"),
                target: WsSessionTarget::Document { file_path },
            })
        }
        WsTarget::Surface { key } => {
            if !entry.enable_live.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            let key = canonical_ws_surface_key(&entry.id, &key)?;
            Some(WsSession {
                channel: format!("surface:{key}"),
                target: WsSessionTarget::Surface,
            })
        }
    }
}

/// Surface channels represent non-file pages such as directory listings and
/// diffs. They may carry Live actions only. Bind the key to the workspace URL
/// namespace so a client cannot use this socket as an arbitrary global topic.
fn canonical_ws_surface_key(workspace_id: &str, key: &str) -> Option<String> {
    if key.is_empty() || key.len() > 2048 || key.contains('\0') {
        return None;
    }
    // A fragment is client-side view state (expanded directory, focused diff
    // block), not the identity of the shared page. Excluding it keeps viewers
    // on the same path/query in one Live channel.
    let without_fragment = key.split('#').next().unwrap_or(key);
    let path = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    let public_root = format!("/{workspace_id}");
    let internal_root = format!("/_/{workspace_id}");
    let in_workspace = path == public_root
        || path.starts_with(&format!("{public_root}/"))
        || path == internal_root
        || path.starts_with(&format!("{internal_root}/"));
    in_workspace.then(|| without_fragment.to_string())
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
    admin_auth::auth_tag(secret, b"markon-access-cookie\0", payload_hex)
}

/// Derive a browser save capability for exactly one workspace. The process
/// secret never enters a page, and a token learned from workspace A cannot be
/// replayed against workspace B.
fn workspace_save_token(secret: &str, workspace_id: &str) -> String {
    admin_auth::auth_tag(secret, b"markon-save-workspace\0", workspace_id)
}

/// Build the `Set-Cookie` value carrying the unlocked scopes until `exp`.
fn make_access_cookie(secret: &str, scopes: &[(String, String)], exp: u64, secure: bool) -> String {
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
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{ACCESS_COOKIE}={payload_hex}.{sig}; Path=/; Max-Age={ACCESS_TTL_SECS}; HttpOnly; SameSite=Lax{secure_attr}"
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
/// allowed through the access-code gate. (`/api/preview` is not access-gated but
/// carries its own same-origin guard — see the `preview` router.)
fn decoded_workspace_id(segment: &str) -> Option<String> {
    let decoded = urlencoding::decode(segment).ok()?;
    (decoded.len() == 8 && decoded.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| decoded.into_owned())
}

fn access_gated_workspace(path: &str) -> Option<String> {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segs.len() >= 3 && segs[0] == "api" && segs[1] == "chat" {
        return decoded_workspace_id(segs[2]);
    }
    if segs.len() >= 3 && segs[0] == "_" && segs[1] == "ws" {
        return decoded_workspace_id(segs[2]);
    }
    if segs.len() >= 2 && segs[0] == "_" {
        if let Some(workspace_id) = decoded_workspace_id(segs[1]) {
            return Some(workspace_id);
        }
    }
    segs.first()
        .and_then(|segment| decoded_workspace_id(segment))
}

/// Only allow same-site relative redirect targets (no open redirect / no `//`).
fn access_safe_redirect(redirect: &str, ws_id: &str) -> String {
    if redirect.starts_with('/') && !redirect.starts_with("//") {
        redirect.to_string()
    } else {
        format!("/{ws_id}/")
    }
}

/// Drop entries whose last recorded failure is older than the maximum
/// cooldown. Any lock on such an entry is guaranteed to have expired (a lock
/// lasts at most `ACCESS_MAX_COOLDOWN_SECS`), so this only removes dead state.
fn prune_access_attempts(
    map: &mut std::collections::HashMap<std::net::IpAddr, AccessAttempts>,
    now: std::time::Instant,
) {
    let max = std::time::Duration::from_secs(ACCESS_MAX_COOLDOWN_SECS);
    map.retain(|_, st| match st.last_attempt {
        Some(ts) => now.saturating_duration_since(ts) < max,
        None => true,
    });
}

fn access_cooldown_remaining(state: &AppState, ip: std::net::IpAddr) -> Option<u64> {
    let mut map = state.access_attempts.lock().unwrap();
    let now = std::time::Instant::now();
    prune_access_attempts(&mut map, now);
    let until = map.get(&ip)?.locked_until?;
    (until > now).then(|| (until - now).as_secs() + 1)
}

/// Record a failed unlock; returns the cooldown seconds if it just locked.
fn access_record_failure(state: &AppState, ip: std::net::IpAddr) -> Option<u64> {
    let mut map = state.access_attempts.lock().unwrap();
    let now = std::time::Instant::now();
    prune_access_attempts(&mut map, now);
    let st = map.entry(ip).or_default();
    st.fails += 1;
    st.last_attempt = Some(now);
    if st.fails >= ACCESS_MAX_FAILS {
        let over = (st.fails - ACCESS_MAX_FAILS).min(7);
        let secs = (ACCESS_BASE_COOLDOWN_SECS << over).min(ACCESS_MAX_COOLDOWN_SECS);
        st.locked_until = Some(now + std::time::Duration::from_secs(secs));
        Some(secs)
    } else {
        None
    }
}

fn access_record_success(state: &AppState, ip: std::net::IpAddr) {
    state.access_attempts.lock().unwrap().remove(&ip);
}

/// The effective collaborator access requirement for a workspace. A
/// workspace-specific code overrides the server-level code and gets a distinct
/// cookie scope; browser administrator sessions are handled independently.
fn access_requirements_for(state: &AppState, ws_id: &str) -> Vec<AccessRequirement> {
    let entry = state.workspace_registry.get(ws_id);
    let workspace_collaborator = entry.as_ref().map(|e| e.collaborator_access_code_hash());

    let (collaborator_hash, collaborator_scope) =
        if let Some(hash) = workspace_collaborator.filter(|hash| !hash.is_empty()) {
            (hash, format!("w:{ws_id}:collaborator"))
        } else if !state.collaborator_access_code_hash.is_empty() {
            (
                state.collaborator_access_code_hash.as_str().to_string(),
                "s:collaborator".to_string(),
            )
        } else {
            (String::new(), String::new())
        };

    let mut out = Vec::new();
    if !collaborator_hash.is_empty() {
        out.push(AccessRequirement {
            role: AccessRole::Collaborator,
            hash: collaborator_hash,
            scope: collaborator_scope,
        });
    }
    out
}

fn access_role_from_cookie(
    state: &AppState,
    ws_id: &str,
    cookie_header: Option<&str>,
) -> Option<AccessRole> {
    let requirements = access_requirements_for(state, ws_id);
    if requirements.is_empty() {
        return Some(AccessRole::Collaborator);
    }
    let scopes = access_cookie_scopes(&state.access_secret, cookie_header);
    for req in requirements.iter() {
        if scopes
            .iter()
            .any(|(s, h)| s == &req.scope && h == &req.hash)
        {
            return Some(req.role);
        }
    }
    None
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
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_string();
    let ws_id = access_gated_workspace(&path);
    let Some(ws_id) = ws_id else {
        return next.run(req).await;
    };
    let cookie = req
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok());
    // Administration is an explicit browser capability. Network position is
    // never promoted to identity, so loopback proxies and DNS rebinding cannot
    // inherit management privileges.
    if admin_auth::admin_cookie_valid(&state.management_token, cookie, access_now_unix()) {
        req.extensions_mut().insert(AccessRole::Admin);
        return next.run(req).await;
    }
    let requirements = access_requirements_for(&state, &ws_id);
    if requirements.is_empty() {
        req.extensions_mut().insert(AccessRole::Collaborator);
        return next.run(req).await;
    };
    if let Some(role) = access_role_from_cookie(&state, &ws_id, cookie) {
        req.extensions_mut().insert(role);
        return next.run(req).await;
    }
    let websocket_upgrade = req
        .headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if websocket_upgrade {
        return (StatusCode::UNAUTHORIZED, "Access code required").into_response();
    }
    if req.method() == axum::http::Method::GET && !path.starts_with("/api/") {
        render_access_gate(&state, &ws_id, &path, None)
    } else {
        (StatusCode::UNAUTHORIZED, "Access code required").into_response()
    }
}

/// Structural browser operations require the explicit administrator role
/// inserted by `require_access_code` after validating the admin session cookie.
async fn require_admin_role(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if req.extensions().get::<AccessRole>() == Some(&AccessRole::Admin) {
        next.run(req).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

/// Global DNS-rebinding boundary: only authorities derived from the bind/
/// advertised addresses or explicitly trusted origins are accepted.
async fn require_allowed_host(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let host = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok());
    if !state.allowed_hosts.allows_header(host) {
        tracing::warn!(
            host = host.unwrap_or("<missing>"),
            "request rejected: untrusted Host"
        );
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    next.run(req).await
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AdminBootstrapMode {
    Url,
    Code,
}

#[derive(Deserialize)]
struct CreateAdminBootstrapRequest {
    mode: AdminBootstrapMode,
    #[serde(default = "admin_default_redirect")]
    redirect: String,
}

fn admin_default_redirect() -> String {
    "/".to_string()
}

#[derive(Serialize)]
struct CreateAdminBootstrapResponse {
    path: &'static str,
    nonce: Option<String>,
    code: Option<String>,
    expires_in: u64,
}

/// Native management clients use the master token to mint a narrow, one-time
/// browser bootstrap capability. The master token itself never enters HTML,
/// JavaScript, browser storage, URLs, or cookies.
async fn create_admin_bootstrap_handler(
    State(state): State<AppState>,
    Json(request): Json<CreateAdminBootstrapRequest>,
) -> Json<CreateAdminBootstrapResponse> {
    let response = match request.mode {
        AdminBootstrapMode::Url => CreateAdminBootstrapResponse {
            path: "/_/admin/bootstrap",
            nonce: Some(state.admin_bootstraps.issue_url(&request.redirect)),
            code: None,
            expires_in: 60,
        },
        AdminBootstrapMode::Code => CreateAdminBootstrapResponse {
            path: "/_/admin",
            nonce: None,
            code: Some(state.admin_bootstraps.issue_code(&request.redirect)),
            expires_in: 5 * 60,
        },
    };
    Json(response)
}

async fn admin_bootstrap_page(State(state): State<AppState>) -> Response {
    let context = base_context(&state);
    let mut response = render_template(&state, "admin-bootstrap.html", &context);
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

#[derive(Deserialize)]
struct AdminSessionRequest {
    nonce: Option<String>,
    code: Option<String>,
}

#[derive(Serialize)]
struct AdminSessionResponse {
    redirect: String,
}

/// Exchange a one-time bootstrap capability for a short-lived, HttpOnly admin
/// session. The capability is the identity proof; peer IP is not.
async fn admin_session_handler(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(request): Json<AdminSessionRequest>,
) -> Response {
    if !same_origin_or_loopback_no_origin(&headers, &addr) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let redirect = request
        .nonce
        .as_deref()
        .and_then(|nonce| state.admin_bootstraps.consume_url(nonce))
        .or_else(|| {
            request
                .code
                .as_deref()
                .and_then(|code| state.admin_bootstraps.consume_code(code))
        });
    let Some(redirect) = redirect else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok());
    let cookie = admin_auth::make_admin_cookie(
        &state.management_token,
        access_now_unix(),
        state.allowed_hosts.is_secure_header(host),
    );
    (
        [
            (axum::http::header::SET_COOKIE, cookie),
            (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(AdminSessionResponse { redirect }),
    )
        .into_response()
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
    let requirements = access_requirements_for(&state, &form.workspace_id);
    if requirements.is_empty() {
        return Redirect::to(&redirect).into_response();
    };
    if let Some(req) = requirements.iter().find(|req| {
        crate::workspace::access_code_matches(&state.access_secret, &form.code, &req.hash)
    }) {
        access_record_success(&state, ip);
        tracing::info!(%ip, ws = %form.workspace_id, role = ?req.role, "access unlocked");
        // Merge with any scopes the device already unlocked, so unlocking one
        // workspace doesn't drop access to another.
        let cookie_hdr = headers
            .get(axum::http::header::COOKIE)
            .and_then(|v| v.to_str().ok());
        let mut scopes = access_cookie_scopes(&state.access_secret, cookie_hdr);
        if let Some(entry) = scopes.iter_mut().find(|(s, _)| s == &req.scope) {
            entry.1 = req.hash.clone();
        } else {
            scopes.push((req.scope.clone(), req.hash.clone()));
        }
        let cookie = make_access_cookie(
            &state.access_secret,
            &scopes,
            access_now_unix() + ACCESS_TTL_SECS,
            state.allowed_hosts.is_secure_header(
                headers
                    .get(axum::http::header::HOST)
                    .and_then(|value| value.to_str().ok()),
            ),
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

/// Save API origin guard. The handler validates the workspace-scoped token
/// after decoding the request body, because the target workspace is part of
/// that body. Local CLI/tooling callers may omit Origin only from loopback.
async fn require_local_save_origin(
    State(_state): State<AppState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if !same_origin_or_loopback_no_origin(req.headers(), &addr) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(req).await
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if !check_ws_origin(&headers, &addr) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(entry) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let flags = entry.flags();
    if !flags.shared_annotation && !flags.enable_live {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_WS_MSG_BYTES)
        .max_frame_size(MAX_WS_MSG_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, entry))
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
        let db = db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let db = db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

async fn send_initial_document_state(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    db: Arc<Mutex<Connection>>,
    file_path: String,
) -> Result<(), ()> {
    let annotations = load_annotations(db.clone(), file_path.clone()).await;
    tracing::debug!(
        file_path = %file_path,
        count = annotations.len(),
        "sending initial annotations to client",
    );
    send_json(sender, &WebSocketMessage::AllAnnotations { annotations }).await?;
    let viewed = load_viewed_state(db, file_path).await;
    send_json(
        sender,
        &WebSocketMessage::ViewedState {
            state: viewed,
            op_id: None,
        },
    )
    .await
}

fn broadcast_msg(tx: &broadcast::Sender<WorkspaceEvent>, channel: &str, msg: &WebSocketMessage) {
    if let Ok(encoded) = serde_json::to_string(msg) {
        let _ = tx.send(WorkspaceEvent::Channel {
            channel: channel.to_string(),
            payload: encoded,
        });
    }
}

fn workspace_event_payload(event: WorkspaceEvent, channel: &str) -> Option<String> {
    match event {
        WorkspaceEvent::Workspace { payload } => Some(payload),
        WorkspaceEvent::Channel {
            channel: event_channel,
            payload,
        } if event_channel == channel => Some(payload),
        WorkspaceEvent::Channel { .. } => None,
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

/// Insert or update an annotation only when an existing global id already
/// belongs to this same document. The persisted schema intentionally keeps its
/// historical global primary key, so the query itself must prevent a client on
/// one document from moving/replacing a row owned by another document.
fn upsert_annotation_for_file(
    conn: &Connection,
    id: &str,
    file_path: &str,
    data: &str,
) -> rusqlite::Result<bool> {
    conn.execute(
        "INSERT INTO annotations (id, file_path, data)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data
         WHERE annotations.file_path = excluded.file_path",
        rusqlite::params![id, file_path, data],
    )
    .map(|changed| changed > 0)
}

async fn handle_client_msg(
    db: Option<Arc<Mutex<Connection>>>,
    entry: Arc<WorkspaceEntry>,
    session: Arc<WsSession>,
    msg: WebSocketMessage,
) {
    // Live is independently feature-gated and available to both document and
    // surface sessions. Checking on every frame closes the small race between
    // a runtime config update and the socket's config-change shutdown.
    if let WebSocketMessage::LiveAction { data } = msg {
        if entry.enable_live.load(std::sync::atomic::Ordering::Relaxed) {
            broadcast_msg(
                &entry.events_tx,
                &session.channel,
                &WebSocketMessage::LiveAction { data },
            );
        }
        return;
    }

    // Surface channels never have database capability. Annotation/viewed
    // operations require both a document target and the server-side feature.
    if !entry
        .shared_annotation
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return;
    }
    let WsSessionTarget::Document { file_path } = &session.target else {
        return;
    };
    let file_path = file_path.clone();
    let Some(db) = db else { return };

    // One spawn_blocking per inbound message: take the lock exactly once,
    // run whichever SQL the message requires, then return the broadcast plan
    // for the async side to fan out.
    let result = tokio::task::spawn_blocking(move || {
        let conn = db.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match msg {
            WebSocketMessage::NewAnnotation { annotation, op_id } => {
                let Some(id) = annotation["id"].as_str().map(str::to_owned) else {
                    return DbResult::None;
                };
                let Ok(data) = serde_json::to_string(&annotation) else {
                    return DbResult::None;
                };
                match upsert_annotation_for_file(
                    &conn,
                    id.as_str(),
                    file_path.as_str(),
                    data.as_str(),
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        tracing::warn!(
                            annotation_id = %id,
                            file_path = %file_path,
                            "rejected annotation id already owned by another document"
                        );
                        return DbResult::None;
                    }
                    Err(e) => {
                        tracing::error!(file_path = %file_path, "insert annotation failed: {e}");
                        return DbResult::None;
                    }
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
        DbResult::Broadcast(out) => broadcast_msg(&entry.events_tx, &session.channel, &out),
        DbResult::BroadcastClear { op_id } => {
            broadcast_msg(
                &entry.events_tx,
                &session.channel,
                &WebSocketMessage::ClearAnnotations {
                    op_id: op_id.clone(),
                },
            );
            broadcast_msg(
                &entry.events_tx,
                &session.channel,
                &WebSocketMessage::ViewedState {
                    state: serde_json::Value::Object(serde_json::Map::new()),
                    op_id,
                },
            );
        }
        DbResult::None => {}
    }
}

async fn handle_socket(socket: WebSocket, state: AppState, entry: Arc<WorkspaceEntry>) {
    let (mut sender, mut receiver) = socket.split();
    let db = state.db.clone();
    let mut rx = entry.events_tx.subscribe();
    let mut config_rx = entry.config_tx.subscribe();

    let hello = match tokio::time::timeout(std::time::Duration::from_secs(5), receiver.next()).await
    {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<WsHello>(&text).ok(),
        Err(_) => {
            tracing::warn!(workspace_id = %entry.id, "timed out waiting for websocket hello");
            return;
        }
        _ => {
            tracing::warn!(workspace_id = %entry.id, "missing or invalid websocket hello");
            return;
        }
    };
    let Some(session) = hello.and_then(|hello| authorize_ws_target(&entry, hello.target)) else {
        tracing::warn!(workspace_id = %entry.id, "rejecting unauthorized websocket target");
        return;
    };
    let session = Arc::new(session);

    // A Live-only connection receives no stored annotation/viewed data. Surface
    // sessions never receive it, even when shared annotations are enabled.
    if entry
        .shared_annotation
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        if let WsSessionTarget::Document { file_path } = &session.target {
            let Some(db) = db.as_ref() else { return };
            tokio::select! {
                biased;
                _ = config_rx.recv() => return,
                result = send_initial_document_state(&mut sender, db.clone(), file_path.clone()) => {
                    if result.is_err() {
                        return;
                    }
                }
            }
        }
    }

    let send_channel = session.channel.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let Some(payload) = workspace_event_payload(event, &send_channel) else {
                        continue;
                    };
                    if sender.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "ws broadcast lagged; continuing");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let recv_entry = entry.clone();
    let recv_session = session.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            if text.len() > MAX_WS_MSG_BYTES {
                tracing::warn!("dropping oversized ws message ({} bytes)", text.len());
                continue;
            }
            let Ok(msg) = serde_json::from_str::<WebSocketMessage>(&text) else {
                continue;
            };
            handle_client_msg(db.clone(), recv_entry.clone(), recv_session.clone(), msg).await;
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
        _ = config_rx.recv() => {
            send_task.abort();
            recv_task.abort();
        }
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
    // `enable-chat` meta flag. Chat is a collaboration ability, so it stays open
    // to remote collaborators too whenever the flag is on.
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
    role: Option<Extension<AccessRole>>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Single-file workspace: there's no listing, just the one document.
    // 302 to the file URL so the user lands directly on the rendered .md.
    if let Some(only) = &ws.single_file {
        return Redirect::to(&workspace_file_url(&workspace_id, only)).into_response();
    }
    let root = canonical_workspace_root(&ws);
    let can_manage = role.is_some_and(|Extension(role)| role == AccessRole::Admin);
    render_directory_listing(&workspace_id, &ws, &root, None, &state, can_manage)
}

async fn handle_workspace_path(
    State(state): State<AppState>,
    AxumPath((workspace_id, path)): AxumPath<(String, String)>,
    role: Option<Extension<AccessRole>>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let decoded = urlencoding::decode(&path).unwrap_or_else(|_| path.clone().into());
    let rel = decoded.trim_start_matches('/');
    let canonical = match ws.fs.resolve_served(rel) {
        Ok(path) => path,
        Err(
            crate::workspace_fs::WorkspaceFsError::InvalidPath
            | crate::workspace_fs::WorkspaceFsError::Denied,
        ) if !ws.is_ephemeral() => {
            return (StatusCode::FORBIDDEN, "Access denied").into_response();
        }
        Err(_) => {
            return (StatusCode::NOT_FOUND, format!("Path not found: {decoded}")).into_response();
        }
    };

    let root = canonical_workspace_root(&ws);
    let can_manage = role.is_some_and(|Extension(role)| role == AccessRole::Admin);
    if !is_inside_workspace(&canonical, &root) {
        return (StatusCode::FORBIDDEN, "Access denied").into_response();
    }

    if canonical.is_file() {
        if is_markdown_path(&canonical) {
            render_markdown_file_async(
                canonical.to_string_lossy().into_owned(),
                workspace_id.clone(),
                ws.clone(),
                root.clone(),
                state.clone(),
                can_manage,
            )
            .await
        } else {
            // Small UTF-8 text/code files get an elegant read-only, syntax-
            // highlighted preview page. Everything else — images, media, PDFs,
            // binaries, oversized text — is served as raw bytes (the browser
            // displays what it can inline and downloads the rest); this also
            // keeps embedded resources like markdown images working verbatim.
            match render_preview_or_none(
                canonical.clone(),
                workspace_id.clone(),
                ws.clone(),
                root.clone(),
                state.clone(),
            )
            .await
            {
                Some(resp) => resp,
                None => serve_file(&canonical, &headers).await,
            }
        }
    } else if canonical.is_dir() {
        if ws.is_ephemeral() {
            // Single-file capabilities never authorize directories. Keep this
            // explicit as defense in depth if serving policy changes later.
            return (StatusCode::NOT_FOUND, "Path not found").into_response();
        }
        // Subdirectories are browsed in place on the workspace root via a URL
        // hash (e.g. "/{id}/#docs/") which the frontend expands as an inline
        // tree — there is no standalone subdirectory listing page anymore.
        // Redirect any direct/legacy subdirectory URL to that anchor form.
        match workspace_relative_path(&canonical, &root).map(|rel| path_to_route(&rel)) {
            Some(rel_str) if !rel_str.is_empty() => Redirect::to(&format!(
                "{}#{}/",
                workspace_root_url(&workspace_id),
                rel_str
            ))
            .into_response(),
            // The workspace root itself is served by `handle_workspace_root`;
            // this arm is just a safe fallback.
            _ => render_directory_listing(&workspace_id, &ws, &root, None, &state, can_manage),
        }
    } else {
        (StatusCode::NOT_FOUND, "Path not found").into_response()
    }
}

#[derive(Deserialize)]
struct GitHistoryQuery {
    branch: Option<String>,
    author: Option<String>,
    range: Option<String>,
}

/// Map a toolbar range key to a git `--since` approxidate. `""`/`"all"` (and any
/// unknown key) mean "no lower bound".
fn git_history_since(range: Option<&str>) -> Option<String> {
    match range.map(str::trim).unwrap_or("") {
        "day" => Some("1 day ago".to_string()),
        "week" => Some("1 week ago".to_string()),
        "month" => Some("1 month ago".to_string()),
        "year" => Some("1 year ago".to_string()),
        _ => None,
    }
}

async fn handle_git_history(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(q): Query<GitHistoryQuery>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let branch = q
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    let author = q
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_string);
    let range_key = q
        .range
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "all")
        .unwrap_or("")
        .to_string();
    let filter = git::HistoryFilter {
        branch: branch.clone(),
        author: author.clone(),
        since: git_history_since(Some(&range_key)),
    };
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let git_root = root.clone();
    let history =
        tokio::task::spawn_blocking(move || git::history_filtered(&git_root, 80, &filter))
            .await
            .unwrap_or_else(|e| {
                tracing::error!("git history blocking task join error: {e}");
                Err(git::GitError::Command("internal task error".into()))
            });
    match history {
        Ok(commits) => render_git_history_page(
            &state,
            &workspace_id,
            &root,
            &commits,
            branch.as_deref(),
            author.as_deref(),
            &range_key,
        ),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to list git history: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_history_data(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let history = tokio::task::spawn_blocking(move || git::history(&root, 80))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git history blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match history {
        Ok(commits) => Json(commits).into_response(),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to list git history: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_branches(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let branches = tokio::task::spawn_blocking(move || git::branches_detailed(&root))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git branches blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match branches {
        Ok(branches) => render_git_branches_page(&state, &workspace_id, &branches),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to list git branches: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_tags(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let tags = tokio::task::spawn_blocking(move || git::tags(&root, 200))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git tags blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match tags {
        Ok(tags) => render_git_tags_page(&state, &workspace_id, &tags),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to list git tags: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_working_diff(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitViewQuery>,
    role: Option<Extension<AccessRole>>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let can_manage = role.is_some_and(|Extension(role)| role == AccessRole::Admin);
    let initial_view = diff_view_from_query(query.view.as_deref());
    directory_root_or_not_found!(ws);
    let workspace_fs = ws.fs.clone();
    let diff = tokio::task::spawn_blocking(move || git::working_diff(&workspace_fs))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git working diff blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match diff {
        Ok(diff) => {
            render_git_diff_page(&state, &workspace_id, &ws, can_manage, &diff, initial_view)
        }
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read git diff: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_working_diff_data(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitViewQuery>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if diff_view_from_query(query.view.as_deref()) == "rendered" {
        directory_root_or_not_found!(ws);
        return match markdown_compare_diff_data_async(
            &state,
            &workspace_id,
            ws.fs.clone(),
            "HEAD",
            "worktree",
            query.f.as_deref(),
        )
        .await
        {
            Ok(data) => Json(data).into_response(),
            Err(git::GitError::NotRepository) => git_not_repository_response(),
            Err(git::GitError::InvalidRevision) => {
                (StatusCode::BAD_REQUEST, "Invalid git revision").into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read markdown diff: {e}"),
            )
                .into_response(),
        };
    }
    directory_root_or_not_found!(ws);
    let workspace_fs = ws.fs.clone();
    let diff = tokio::task::spawn_blocking(move || git::working_diff(&workspace_fs))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git working diff blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match diff {
        Ok(diff) => git_diff_json_response(&diff, query.f.as_deref()),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read git diff: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_commit_diff(
    State(state): State<AppState>,
    AxumPath((workspace_id, commit)): AxumPath<(String, String)>,
    Query(query): Query<GitViewQuery>,
    role: Option<Extension<AccessRole>>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let can_manage = role.is_some_and(|Extension(role)| role == AccessRole::Admin);
    let initial_view = diff_view_from_query(query.view.as_deref());
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let diff = tokio::task::spawn_blocking(move || git::commit_diff(&root, &commit))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git commit diff blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match diff {
        Ok(diff) => {
            render_git_diff_page(&state, &workspace_id, &ws, can_manage, &diff, initial_view)
        }
        Err(git::GitError::InvalidRevision) => {
            (StatusCode::BAD_REQUEST, "Invalid git revision").into_response()
        }
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("Git diff not found: {e}")).into_response(),
    }
}

async fn handle_git_commit_diff_data(
    State(state): State<AppState>,
    AxumPath((workspace_id, commit)): AxumPath<(String, String)>,
    Query(query): Query<GitViewQuery>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = directory_root_or_not_found!(ws).to_path_buf();
    let diff = tokio::task::spawn_blocking(move || git::commit_diff(&root, &commit))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("git commit diff blocking task join error: {e}");
            Err(git::GitError::Command("internal task error".into()))
        });
    match diff {
        Ok(diff) => git_diff_json_response(&diff, query.f.as_deref()),
        Err(git::GitError::InvalidRevision) => {
            (StatusCode::BAD_REQUEST, "Invalid git revision").into_response()
        }
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("Git diff not found: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct GitViewQuery {
    view: Option<String>,
    f: Option<String>,
}

#[derive(Deserialize)]
struct PrettyCompareQuery {
    view: Option<String>,
    format: Option<String>,
    f: Option<String>,
}

#[derive(Deserialize)]
struct GitCompareOptionsStatusQuery {
    base: String,
    compare: String,
}

fn diff_view_from_query(view: Option<&str>) -> &'static str {
    // Rendered is the default; only an explicit ?view=raw selects the source view.
    match view {
        Some("raw") => "raw",
        _ => "rendered",
    }
}

fn git_not_repository_response() -> Response {
    (StatusCode::CONFLICT, "Workspace is not a git repository").into_response()
}

async fn handle_pretty_compare_diff(
    State(state): State<AppState>,
    AxumPath((workspace_id, range)): AxumPath<(String, String)>,
    Query(query): Query<PrettyCompareQuery>,
    role: Option<Extension<AccessRole>>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((base, compare)) = parse_pretty_compare_range(&range) else {
        return (StatusCode::BAD_REQUEST, "Invalid compare range").into_response();
    };
    let can_manage = role.is_some_and(|Extension(role)| role == AccessRole::Admin);
    let initial_view = diff_view_from_query(query.view.as_deref());
    if query.format.as_deref() == Some("data") && initial_view == "rendered" {
        directory_root_or_not_found!(ws);
        return match markdown_compare_diff_data_async(
            &state,
            &workspace_id,
            ws.fs.clone(),
            &base,
            &compare,
            query.f.as_deref(),
        )
        .await
        {
            Ok(data) => Json(data).into_response(),
            Err(git::GitError::NotRepository) => git_not_repository_response(),
            Err(git::GitError::InvalidRevision) => {
                (StatusCode::BAD_REQUEST, "Invalid git revision").into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read markdown diff: {e}"),
            )
                .into_response(),
        };
    }
    directory_root_or_not_found!(ws);
    match git::compare_diff(&ws.fs, &base, &compare) {
        Ok(diff) if query.format.as_deref() == Some("data") => {
            git_diff_json_response(&diff, query.f.as_deref())
        }
        Ok(diff) => {
            render_git_diff_page(&state, &workspace_id, &ws, can_manage, &diff, initial_view)
        }
        Err(git::GitError::InvalidRevision) => {
            (StatusCode::BAD_REQUEST, "Invalid git revision").into_response()
        }
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("Git diff not found: {e}")).into_response(),
    }
}

async fn handle_git_compare_options_status(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<GitCompareOptionsStatusQuery>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = directory_root_or_not_found!(ws);
    if !git::status(root).available {
        return git_not_repository_response();
    }
    // Each side independently probes ~dozens of candidate refs for markdown
    // changes (one git diff each), so run the two sides concurrently; each side
    // also parallelizes its own probes internally.
    let (base, compare) = rayon::join(
        || {
            git_compare_option_statuses(git_compare_options(
                root,
                &query.base,
                false,
                &query.compare,
                GitCompareOptionRole::Base,
                GitCompareOptionStatusMode::Checked,
            ))
        },
        || {
            git_compare_option_statuses(git_compare_options(
                root,
                &query.compare,
                true,
                &query.base,
                GitCompareOptionRole::Compare,
                GitCompareOptionStatusMode::Checked,
            ))
        },
    );
    Json(GitCompareOptionsStatus { base, compare }).into_response()
}

fn parse_pretty_compare_range(range: &str) -> Option<(String, String)> {
    let (base, compare) = range.split_once("...")?;
    if base.trim().is_empty() || compare.trim().is_empty() {
        return None;
    }
    Some((base.to_string(), compare.to_string()))
}

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

#[derive(Deserialize)]
struct GitCheckoutRequest {
    branch: String,
}

#[derive(Serialize)]
struct GitCommitResponse {
    success: bool,
    message: String,
    commit: Option<git::GitCommitResult>,
}

#[derive(Serialize)]
struct GitCheckoutResponse {
    success: bool,
    message: String,
    status: Option<git::GitStatus>,
}

async fn handle_git_commit(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<GitCommitRequest>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match git::commit_workspace(directory_root_or_not_found!(ws), &payload.message) {
        Ok(commit) => Json(GitCommitResponse {
            success: true,
            message: "Committed workspace changes".to_string(),
            commit: Some(commit),
        })
        .into_response(),
        Err(git::GitError::NothingToCommit) => Json(GitCommitResponse {
            success: false,
            message: "Nothing to commit".to_string(),
            commit: None,
        })
        .into_response(),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to commit workspace changes: {e}"),
        )
            .into_response(),
    }
}

async fn handle_git_checkout(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<GitCheckoutRequest>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match git::checkout_branch(directory_root_or_not_found!(ws), &payload.branch) {
        Ok(status) => Json(GitCheckoutResponse {
            success: true,
            message: "Switched branch".to_string(),
            status: Some(status),
        })
        .into_response(),
        Err(git::GitError::InvalidRevision) => Json(GitCheckoutResponse {
            success: false,
            message: "Invalid branch".to_string(),
            status: None,
        })
        .into_response(),
        Err(git::GitError::NotRepository) => git_not_repository_response(),
        Err(e) => Json(GitCheckoutResponse {
            success: false,
            message: format!("Failed to switch branch: {e}"),
            status: None,
        })
        .into_response(),
    }
}

#[derive(Serialize)]
struct WorkspaceFileListEntry {
    path: String,
    name: String,
    is_markdown: bool,
    url: String,
}

async fn handle_workspace_files_data(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut files = Vec::new();
    for (rel, path) in ws.fs.served_files(2000) {
        let route = rel.as_route();
        files.push(WorkspaceFileListEntry {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| route.clone()),
            is_markdown: is_markdown_path(&path),
            url: workspace_file_url(&workspace_id, &route),
            path: route,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Json(files).into_response()
}

#[derive(Deserialize)]
struct CreateFileRequest {
    path: String,
    content: Option<String>,
}

#[derive(Serialize)]
struct CreateFileResponse {
    success: bool,
    message: String,
    url: Option<String>,
}

async fn handle_workspace_create_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<CreateFileRequest>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(root) = ws.fs.directory_root() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !ws.enable_edit.load(std::sync::atomic::Ordering::Relaxed) {
        return Json(CreateFileResponse {
            success: false,
            message: "Edit feature is not enabled".to_string(),
            url: None,
        })
        .into_response();
    }
    let Some(rel) = sanitize_new_file_path(&payload.path) else {
        return Json(CreateFileResponse {
            success: false,
            message: "Invalid file path".to_string(),
            url: None,
        })
        .into_response();
    };
    let full_path = root.join(&rel);
    if fs::symlink_metadata(&full_path).is_ok() {
        return Json(CreateFileResponse {
            success: false,
            message: "File already exists".to_string(),
            url: None,
        })
        .into_response();
    }
    // Verify containment BEFORE creating any directory, so a symlinked
    // intermediate cannot cause `create_dir_all` to materialize dirs outside
    // the workspace root.
    if !deepest_existing_ancestor_inside_workspace(&full_path, root) {
        return Json(CreateFileResponse {
            success: false,
            message: "Access denied".to_string(),
            url: None,
        })
        .into_response();
    }
    if let Some(parent) = full_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Json(CreateFileResponse {
                success: false,
                message: format!("Failed to create directory: {e}"),
                url: None,
            })
            .into_response();
        }
    }
    // Defense in depth: confirm the resolved parent still lands inside the
    // workspace after creation.
    if let Some(parent) = full_path.parent() {
        match canonicalize_route_path(parent) {
            Ok(parent) if is_inside_workspace(&parent, root) => {}
            _ => {
                return Json(CreateFileResponse {
                    success: false,
                    message: "Access denied".to_string(),
                    url: None,
                })
                .into_response()
            }
        }
    }
    let content = payload.content.unwrap_or_default();
    let write_result = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, content.as_bytes()));
    if let Err(e) = write_result {
        return Json(CreateFileResponse {
            success: false,
            message: format!("Failed to create file: {e}"),
            url: None,
        })
        .into_response();
    }
    let route = path_to_route(&rel);
    Json(CreateFileResponse {
        success: true,
        message: "File created".to_string(),
        url: Some(workspace_file_url(&workspace_id, &route)),
    })
    .into_response()
}

/// Create an empty folder inside the workspace. Reuses {@link CreateFileRequest}
/// (the `content` field is ignored). Same edit gate + traversal-safety as
/// file creation; `create_dir_all` so intermediate folders are made too.
async fn handle_workspace_create_folder(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<CreateFileRequest>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(root) = ws.fs.directory_root() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !ws.enable_edit.load(std::sync::atomic::Ordering::Relaxed) {
        return Json(CreateFileResponse {
            success: false,
            message: "Edit feature is not enabled".to_string(),
            url: None,
        })
        .into_response();
    }
    let Some(rel) = sanitize_new_file_path(&payload.path) else {
        return Json(CreateFileResponse {
            success: false,
            message: "Invalid folder path".to_string(),
            url: None,
        })
        .into_response();
    };
    let full_path = root.join(&rel);
    if fs::symlink_metadata(&full_path).is_ok() {
        return Json(CreateFileResponse {
            success: false,
            message: "Folder already exists".to_string(),
            url: None,
        })
        .into_response();
    }
    // Verify containment BEFORE creating any directory, so a symlinked
    // intermediate cannot cause `create_dir_all` to materialize dirs outside
    // the workspace root.
    if !deepest_existing_ancestor_inside_workspace(&full_path, root) {
        return Json(CreateFileResponse {
            success: false,
            message: "Access denied".to_string(),
            url: None,
        })
        .into_response();
    }
    if let Err(e) = fs::create_dir_all(&full_path) {
        return Json(CreateFileResponse {
            success: false,
            message: format!("Failed to create folder: {e}"),
            url: None,
        })
        .into_response();
    }
    // Defense in depth: confirm the created folder resolved inside the workspace.
    match canonicalize_route_path(&full_path) {
        Ok(p) if is_inside_workspace(&p, root) => {}
        _ => {
            return Json(CreateFileResponse {
                success: false,
                message: "Access denied".to_string(),
                url: None,
            })
            .into_response()
        }
    }
    Json(CreateFileResponse {
        success: true,
        message: "Folder created".to_string(),
        url: None,
    })
    .into_response()
}

#[derive(Deserialize)]
struct DeleteFileRequest {
    path: String,
}

#[derive(Serialize)]
struct DeleteFileResponse {
    success: bool,
    message: String,
}

async fn handle_workspace_delete_file(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<DeleteFileRequest>,
) -> impl IntoResponse {
    let fail = |message: &str| {
        Json(DeleteFileResponse {
            success: false,
            message: message.to_string(),
        })
        .into_response()
    };
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(root) = ws.fs.directory_root() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !ws.enable_edit.load(std::sync::atomic::Ordering::Relaxed) {
        return fail("Edit feature is not enabled");
    }
    let rel = payload.path.trim().trim_start_matches('/');
    if rel.is_empty() || rel.contains('\0') {
        return fail("Invalid file path");
    }
    let canon = match canonicalize_route_path(&root.join(rel)) {
        Ok(p) if is_inside_workspace(&p, root) => p,
        _ => return fail("Access denied"),
    };
    if !canon.is_file() {
        return fail("Not a file");
    }
    // The workspace file watcher picks up the removal and updates the search
    // index / notifies viewers, mirroring how create relies on the watcher.
    match std::fs::remove_file(&canon) {
        Ok(_) => Json(DeleteFileResponse {
            success: true,
            message: "File deleted".to_string(),
        })
        .into_response(),
        Err(e) => fail(&format!("Failed to delete file: {e}")),
    }
}

#[derive(Deserialize)]
struct UpdateWorkspaceFeaturesRequest {
    #[serde(flatten)]
    flags: WorkspaceFlags,
}

#[derive(Serialize)]
struct UpdateWorkspaceFeaturesResponse {
    success: bool,
    message: String,
}

async fn handle_workspace_update_features(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<UpdateWorkspaceFeaturesRequest>,
) -> Response {
    if state
        .workspace_registry
        .update_flags(&workspace_id, payload.flags)
    {
        Json(UpdateWorkspaceFeaturesResponse {
            success: true,
            message: "Workspace features updated".to_string(),
        })
        .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(UpdateWorkspaceFeaturesResponse {
                success: false,
                message: "Workspace not found".to_string(),
            }),
        )
            .into_response()
    }
}

#[derive(Deserialize)]
struct UpdateWorkspaceAliasRequest {
    #[serde(default)]
    alias: String,
}

/// Set/clear a workspace's alias from the web (directory page). Gated by
/// `require_admin_role` + `require_same_origin` (NOT the master token), so the
/// browser can use its narrow, HttpOnly admin session without exposing the
/// native management bearer.
async fn handle_workspace_update_alias(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(payload): Json<UpdateWorkspaceAliasRequest>,
) -> Response {
    if state
        .workspace_registry
        .set_alias(&workspace_id, payload.alias.trim())
    {
        Json(serde_json::json!({ "success": true })).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "success": false, "message": "Workspace not found" })),
        )
            .into_response()
    }
}

// ── Workspace management API ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct AddWorkspaceRequest {
    path: String,
    #[serde(flatten)]
    flags: WorkspaceFlags,
    #[serde(default)]
    collaborator_access_code_hash: String,
}

#[derive(Deserialize)]
struct UpdateWorkspaceRequest {
    #[serde(flatten)]
    flags: WorkspaceFlags,
}

#[derive(Deserialize)]
struct UpdateWorkspaceAccessRequest {
    collaborator_access_code_hash: Option<String>,
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
        collaborator_access_code_hash: req.collaborator_access_code_hash,
        alias: String::new(),
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
    Json(req): Json<UpdateWorkspaceRequest>,
) -> impl IntoResponse {
    if state.workspace_registry.update_flags(&id, req.flags) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn update_workspace_access_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(req): Json<UpdateWorkspaceAccessRequest>,
) -> impl IntoResponse {
    if let Some(hash) = req.collaborator_access_code_hash {
        if !state
            .workspace_registry
            .set_collaborator_access_code(&id, &hash)
        {
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    StatusCode::OK.into_response()
}

async fn list_workspaces_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.workspace_registry.info_list())
}

// ── Search handler ────────────────────────────────────────────────────────────

async fn workspace_search_handler(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    axum::extract::Query(query): axum::extract::Query<SearchQuery>,
) -> impl IntoResponse {
    workspace_search_results(&state, &workspace_id, &query.q).await
}

async fn workspace_search_results(
    state: &AppState,
    workspace_id: &str,
    query: &str,
) -> Json<Vec<SearchResult>> {
    if query.is_empty() {
        return Json(Vec::<SearchResult>::new());
    }
    let Some(ws) = state.workspace_registry.get(workspace_id) else {
        return Json(Vec::new());
    };
    if !ws.enable_search.load(std::sync::atomic::Ordering::Relaxed) {
        return Json(Vec::new());
    }
    let Some(idx) = ws.search_index.load_full() else {
        return Json(Vec::new()); // still indexing
    };
    // Tantivy search is CPU/IO-bound; run it on the blocking pool so it does not
    // stall a tokio worker thread.
    let query_owned = query.to_string();
    let results = tokio::task::spawn_blocking(move || idx.search(&query_owned, 20))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("search blocking task join error: {e}");
            Ok(Vec::new())
        })
        .unwrap_or_else(|e| {
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

#[derive(Serialize)]
struct GitDiffTemplate<'a> {
    range: &'a str,
    title: &'a str,
    subtitle: Option<&'a str>,
    mode_label: String,
    base_label: String,
    compare_label: String,
    base_value: String,
    compare_value: String,
    files: Vec<GitDiffFileTemplate<'a>>,
    nav_entries: Vec<GitDiffNavEntry<'a>>,
    total_additions: usize,
    total_deletions: usize,
}

#[derive(Serialize)]
struct GitDiffFileTemplate<'a> {
    path: &'a str,
    old_path: Option<&'a str>,
    status: &'a str,
    additions: usize,
    deletions: usize,
}

#[derive(Serialize)]
struct GitDiffNavEntry<'a> {
    kind: &'static str,
    name: String,
    path: String,
    depth: usize,
    status: Option<&'a str>,
    additions: usize,
    deletions: usize,
}

#[derive(Serialize)]
struct GitCompareOption {
    value: String,
    label: String,
    /// Lightweight display alias for special refs/commits, e.g. the newest
    /// concrete commit that is also reachable as HEAD.
    alias: String,
    /// Option family for the rich picker UI: worktree | head | branch | tag | commit.
    kind: String,
    /// Commit subject (commits only; "" otherwise).
    subject: String,
    /// Secondary detail — short hash for commits/tags, "current" for the current
    /// branch, "" otherwise.
    detail: String,
    /// Relative time (commits/tags; "" otherwise).
    date: String,
    selected: bool,
    disabled: bool,
}

#[derive(Serialize)]
struct GitCompareOptionStatus {
    value: String,
    disabled: bool,
}

#[derive(Serialize)]
struct GitCompareOptionsStatus {
    base: Vec<GitCompareOptionStatus>,
    compare: Vec<GitCompareOptionStatus>,
}

#[derive(Serialize)]
struct GitDiffData<'a> {
    range: &'a str,
    title: &'a str,
    subtitle: Option<&'a str>,
    files: Vec<GitDiffDataFile<'a>>,
    rows: Vec<GitDiffDataRow<'a>>,
    total_additions: usize,
    total_deletions: usize,
}

#[derive(Serialize)]
struct GitDiffDataFile<'a> {
    path: &'a str,
    old_path: Option<&'a str>,
    status: &'a str,
    additions: usize,
    deletions: usize,
    start_row: usize,
    row_count: usize,
}

#[derive(Serialize)]
#[serde(tag = "kind")]
enum GitDiffDataRow<'a> {
    #[serde(rename = "file")]
    File {
        file_index: usize,
        path: &'a str,
        old_path: Option<&'a str>,
        status: &'a str,
        additions: usize,
        deletions: usize,
    },
    #[serde(rename = "line")]
    Line {
        file_index: usize,
        old_line_no: Option<usize>,
        new_line_no: Option<usize>,
        old_class_name: &'static str,
        new_class_name: &'static str,
        old_segments: Vec<GitDiffDataSegment>,
        new_segments: Vec<GitDiffDataSegment>,
    },
}

#[derive(Serialize)]
struct GitDiffDataSegment {
    text: String,
    class_name: Option<&'static str>,
}

struct GitDiffDataSide {
    line_no: Option<usize>,
    class_name: &'static str,
    segments: Vec<GitDiffDataSegment>,
}

#[derive(Serialize)]
struct MarkdownDiffData {
    title: String,
    subtitle: Option<String>,
    engine: markdown_ast::MarkdownAstEngineInfo,
    files: Vec<MarkdownDiffFile>,
}

#[derive(Clone, Serialize)]
struct MarkdownDiffFile {
    path: String,
    // Canonical absolute path of the new-side file on disk, byte-identical to the
    // annotation `file_path` key that `render_markdown_file` builds when the same
    // file is opened normally. The listing uses `git diff --relative`, so
    // `entry.path` is workspace-relative; joining it onto the workspace root
    // resolves the same key even when the workspace is a subdirectory of the repo.
    abs_path: String,
    old_path: Option<String>,
    status: String,
    // Slim per-side outline: the frontend only reads `block_count` and a
    // per-block {index, kind, label} to compute heading-section indentation.
    // The heavy rendered HTML lives on `blocks[].old/new` (rendered once), so
    // shipping full per-side summaries here would triple the HTML payload.
    old: Option<MarkdownDocOutline>,
    new: Option<MarkdownDocOutline>,
    // Full, untruncated source text of each side. The raw (source) diff view
    // renders exact file lines from these, sliced by each block's line span, so
    // both views share one block-based segmentation (and stay aligned). Absent
    // when a side does not exist (added file has no old; deleted has no new).
    old_source: Option<String>,
    new_source: Option<String>,
    additions: usize,
    deletions: usize,
    blocks: Vec<MarkdownDiffBlock>,
    diagnostics: Vec<MarkdownDiffDiagnostic>,
}

#[derive(Clone, Serialize)]
struct MarkdownDocOutline {
    block_count: usize,
    blocks: Vec<MarkdownBlockOutline>,
}

#[derive(Clone, Serialize)]
struct MarkdownBlockOutline {
    index: usize,
    kind: String,
    label: String,
}

impl MarkdownDocOutline {
    fn from_summary(summary: &markdown_ast::MarkdownDocumentSummary) -> Self {
        MarkdownDocOutline {
            block_count: summary.block_count,
            blocks: summary
                .blocks
                .iter()
                .map(|b| MarkdownBlockOutline {
                    index: b.index,
                    kind: b.kind.clone(),
                    label: b.label.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Clone, Serialize)]
struct MarkdownDiffBlock {
    kind: &'static str,
    old: Option<markdown_ast::MarkdownBlockSummary>,
    new: Option<markdown_ast::MarkdownBlockSummary>,
}

#[derive(Clone, Serialize)]
struct MarkdownDiffDiagnostic {
    side: &'static str,
    code: String,
    severity: String,
    message: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
}

const MARKDOWN_DIFF_CACHE_VERSION: &str = "markdown-diff-cache-v2";
const MARKDOWN_DIFF_DOCUMENT_CACHE_LIMIT: usize = 256;
const MARKDOWN_DIFF_FILE_CACHE_LIMIT: usize = 512;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MarkdownDocumentCacheKey {
    version: &'static str,
    theme: String,
    workspace_id: String,
    file_path: String,
    content_hash: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MarkdownDiffFileCacheKey {
    version: &'static str,
    theme: String,
    workspace_id: String,
    path: String,
    old_path: Option<String>,
    status: String,
    // Stable content identity per side: a git blob oid where available (no read
    // needed — comes straight from `git diff --raw`), or a `h:<sha256>` of the
    // worktree content. Keying on the blob oid lets a warm reload hit the cache
    // without reading or re-rendering the old side.
    old_id: Option<String>,
    new_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct MarkdownDiffCache {
    documents: HashMap<MarkdownDocumentCacheKey, Arc<markdown_ast::MarkdownDocumentSummary>>,
    document_lru: VecDeque<MarkdownDocumentCacheKey>,
    files: HashMap<MarkdownDiffFileCacheKey, Arc<MarkdownDiffFile>>,
    file_lru: VecDeque<MarkdownDiffFileCacheKey>,
    document_hits: u64,
    document_misses: u64,
    file_hits: u64,
    file_misses: u64,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct MarkdownDiffCacheStats {
    document_entries: usize,
    file_entries: usize,
    document_hits: u64,
    document_misses: u64,
    file_hits: u64,
    file_misses: u64,
}

impl MarkdownDiffCache {
    fn get_document(
        &mut self,
        key: &MarkdownDocumentCacheKey,
    ) -> Option<Arc<markdown_ast::MarkdownDocumentSummary>> {
        if let Some(summary) = self.documents.get(key).cloned() {
            self.document_hits += 1;
            touch_lru_key(&mut self.document_lru, key);
            Some(summary)
        } else {
            self.document_misses += 1;
            None
        }
    }

    fn insert_document(
        &mut self,
        key: MarkdownDocumentCacheKey,
        summary: markdown_ast::MarkdownDocumentSummary,
    ) -> Arc<markdown_ast::MarkdownDocumentSummary> {
        let summary = Arc::new(summary);
        self.documents.insert(key.clone(), summary.clone());
        touch_lru_key(&mut self.document_lru, &key);
        trim_lru_cache(
            &mut self.documents,
            &mut self.document_lru,
            MARKDOWN_DIFF_DOCUMENT_CACHE_LIMIT,
        );
        summary
    }

    fn get_file(&mut self, key: &MarkdownDiffFileCacheKey) -> Option<Arc<MarkdownDiffFile>> {
        if let Some(file) = self.files.get(key).cloned() {
            self.file_hits += 1;
            touch_lru_key(&mut self.file_lru, key);
            Some(file)
        } else {
            self.file_misses += 1;
            None
        }
    }

    fn insert_file(
        &mut self,
        key: MarkdownDiffFileCacheKey,
        file: MarkdownDiffFile,
    ) -> Arc<MarkdownDiffFile> {
        let file = Arc::new(file);
        self.files.insert(key.clone(), file.clone());
        touch_lru_key(&mut self.file_lru, &key);
        trim_lru_cache(
            &mut self.files,
            &mut self.file_lru,
            MARKDOWN_DIFF_FILE_CACHE_LIMIT,
        );
        file
    }

    #[cfg(test)]
    fn stats(&self) -> MarkdownDiffCacheStats {
        MarkdownDiffCacheStats {
            document_entries: self.documents.len(),
            file_entries: self.files.len(),
            document_hits: self.document_hits,
            document_misses: self.document_misses,
            file_hits: self.file_hits,
            file_misses: self.file_misses,
        }
    }
}

fn touch_lru_key<K>(lru: &mut VecDeque<K>, key: &K)
where
    K: Clone + Eq,
{
    if let Some(index) = lru.iter().position(|existing| existing == key) {
        lru.remove(index);
    }
    lru.push_back(key.clone());
}

fn trim_lru_cache<K, V>(cache: &mut HashMap<K, V>, lru: &mut VecDeque<K>, limit: usize)
where
    K: Clone + Eq + std::hash::Hash,
{
    while cache.len() > limit {
        let Some(key) = lru.pop_front() else {
            break;
        };
        cache.remove(&key);
    }
}

#[derive(Serialize)]
struct WorkspaceFeatureStatus {
    key: &'static str,
    label: &'static str,
    label_key: &'static str,
    enabled: bool,
}

fn git_diff_template<'a>(
    root: &FsPath,
    diff: &'a git::GitDiff,
    base_value: String,
    compare_value: String,
) -> GitDiffTemplate<'a> {
    let files: Vec<GitDiffFileTemplate<'_>> = diff
        .files
        .iter()
        .map(|file| GitDiffFileTemplate {
            path: &file.path,
            old_path: file.old_path.as_deref(),
            status: &file.status,
            additions: file.additions,
            deletions: file.deletions,
        })
        .collect();
    let total_additions = diff.files.iter().map(|file| file.additions).sum();
    let total_deletions = diff.files.iter().map(|file| file.deletions).sum();
    let (mode_label, base_label, compare_label) =
        git_diff_range_labels(root, diff, &base_value, &compare_value);
    GitDiffTemplate {
        range: &diff.range,
        title: &diff.title,
        subtitle: diff.subtitle.as_deref(),
        mode_label,
        base_label,
        compare_label,
        base_value,
        compare_value,
        nav_entries: git_diff_nav_entries(&diff.files),
        files,
        total_additions,
        total_deletions,
    }
}

fn git_diff_range_labels(
    root: &FsPath,
    diff: &git::GitDiff,
    base_value: &str,
    compare_value: &str,
) -> (String, String, String) {
    if diff.range == "HEAD..worktree" {
        return (
            "Working tree".to_string(),
            "HEAD".to_string(),
            "Worktree".to_string(),
        );
    }
    if let Some((base, compare)) = diff.range.split_once("..") {
        return (
            "Git range".to_string(),
            base.to_string(),
            compare.to_string(),
        );
    }
    if valid_hex_display_ref(&diff.range) {
        let base = git::parent_commit(root, &diff.range)
            .ok()
            .flatten()
            .map(|parent| short_git_ref(&parent))
            .unwrap_or_else(|| "Parent".to_string());
        return ("Commit".to_string(), base, short_git_ref(compare_value));
    }
    (
        "Git range".to_string(),
        short_git_ref(base_value),
        short_git_ref(compare_value),
    )
}

fn valid_hex_display_ref(value: &str) -> bool {
    (4..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn short_git_ref(value: &str) -> String {
    if value.len() > 12 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        value[..12].to_string()
    } else {
        value.to_string()
    }
}

fn git_diff_nav_entries(files: &[git::GitDiffFile]) -> Vec<GitDiffNavEntry<'_>> {
    let mut sorted: Vec<&git::GitDiffFile> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut emitted_dirs = std::collections::BTreeSet::new();
    let mut entries = Vec::new();

    for file in sorted {
        let segments: Vec<&str> = file
            .path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        for depth in 0..segments.len().saturating_sub(1) {
            let path = segments[..=depth].join("/");
            if emitted_dirs.insert(path.clone()) {
                entries.push(GitDiffNavEntry {
                    kind: "dir",
                    name: segments[depth].to_string(),
                    path,
                    depth,
                    status: None,
                    additions: 0,
                    deletions: 0,
                });
            }
        }

        entries.push(GitDiffNavEntry {
            kind: "file",
            name: segments
                .last()
                .copied()
                .unwrap_or(file.path.as_str())
                .to_string(),
            path: file.path.clone(),
            depth: segments.len().saturating_sub(1),
            status: Some(file.status.as_str()),
            additions: file.additions,
            deletions: file.deletions,
        });
    }

    entries
}

fn git_diff_json_response(diff: &git::GitDiff, file_filter: Option<&str>) -> Response {
    let diff = markdown_only_git_diff(diff, file_filter);
    match serde_json::to_value(git_diff_data(&diff)) {
        Ok(value) => Json(value).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize git diff: {e}"),
        )
            .into_response(),
    }
}

fn markdown_only_git_diff(diff: &git::GitDiff, file_filter: Option<&str>) -> git::GitDiff {
    let files: Vec<git::GitDiffFile> = diff
        .files
        .iter()
        .filter(|file| is_markdown_diff_file(file))
        .filter(|file| diff_file_matches_filter(file, file_filter))
        .cloned()
        .collect();
    let patch = files.iter().map(|file| file.patch.as_str()).collect();
    git::GitDiff {
        range: diff.range.clone(),
        title: diff.title.clone(),
        subtitle: diff.subtitle.clone(),
        patch,
        files,
    }
}

fn diff_file_matches_filter(file: &git::GitDiffFile, file_filter: Option<&str>) -> bool {
    let Some(filter) = file_filter
        .map(str::trim)
        .filter(|filter| !filter.is_empty())
    else {
        return true;
    };
    file.path == filter || file.old_path.as_deref() == Some(filter)
}

fn git_diff_data(diff: &git::GitDiff) -> GitDiffData<'_> {
    let mut rows = Vec::new();
    let mut files = Vec::new();

    for (file_index, file) in diff.files.iter().enumerate() {
        let start_row = rows.len();
        rows.push(GitDiffDataRow::File {
            file_index,
            path: &file.path,
            old_path: file.old_path.as_deref(),
            status: &file.status,
            additions: file.additions,
            deletions: file.deletions,
        });
        push_diff_data_rows(file_index, &file.patch, &mut rows);
        let row_count = rows.len() - start_row;
        files.push(GitDiffDataFile {
            path: &file.path,
            old_path: file.old_path.as_deref(),
            status: &file.status,
            additions: file.additions,
            deletions: file.deletions,
            start_row,
            row_count,
        });
    }

    GitDiffData {
        range: &diff.range,
        title: &diff.title,
        subtitle: diff.subtitle.as_deref(),
        files,
        rows,
        total_additions: diff.files.iter().map(|file| file.additions).sum(),
        total_deletions: diff.files.iter().map(|file| file.deletions).sum(),
    }
}

fn push_diff_data_rows<'a>(
    file_index: usize,
    unified_diff: &str,
    rows: &mut Vec<GitDiffDataRow<'a>>,
) {
    let mut old_line_no: Option<usize> = None;
    let mut new_line_no: Option<usize> = None;
    let mut pending_deletes: Vec<(usize, &str)> = Vec::new();
    let mut pending_inserts: Vec<(usize, &str)> = Vec::new();

    for raw_line in unified_diff.split_inclusive('\n') {
        let line = raw_line.trim_end_matches('\n').trim_end_matches('\r');
        if line.starts_with("@@ ") {
            flush_diff_data_change_block(
                rows,
                file_index,
                &mut pending_deletes,
                &mut pending_inserts,
            );
            if let Some((old_start, new_start)) = parse_hunk_line_numbers(line) {
                old_line_no = Some(old_start);
                new_line_no = Some(new_start);
            }
            push_diff_data_meta_line(rows, file_index, line);
            continue;
        }

        if is_diff_delete_line(line) {
            let current = old_line_no.unwrap_or(0);
            pending_deletes.push((current, line));
            if let Some(line_no) = old_line_no.as_mut() {
                *line_no += 1;
            }
            continue;
        }
        if is_diff_insert_line(line) {
            let current = new_line_no.unwrap_or(0);
            pending_inserts.push((current, line));
            if let Some(line_no) = new_line_no.as_mut() {
                *line_no += 1;
            }
            continue;
        }
        flush_diff_data_change_block(rows, file_index, &mut pending_deletes, &mut pending_inserts);

        if let Some(body) = line.strip_prefix(' ') {
            push_diff_data_split_line(
                rows,
                file_index,
                GitDiffDataSide {
                    line_no: old_line_no,
                    class_name: "git-diff-line",
                    segments: diff_data_plain_segments(body),
                },
                GitDiffDataSide {
                    line_no: new_line_no,
                    class_name: "git-diff-line",
                    segments: diff_data_plain_segments(body),
                },
            );
            if let Some(line_no) = old_line_no.as_mut() {
                *line_no += 1;
            }
            if let Some(line_no) = new_line_no.as_mut() {
                *line_no += 1;
            }
        } else {
            push_diff_data_meta_line(rows, file_index, line);
        }
    }
    flush_diff_data_change_block(rows, file_index, &mut pending_deletes, &mut pending_inserts);
}

fn flush_diff_data_change_block<'a>(
    rows: &mut Vec<GitDiffDataRow<'a>>,
    file_index: usize,
    deletes: &mut Vec<(usize, &str)>,
    inserts: &mut Vec<(usize, &str)>,
) {
    if deletes.is_empty() && inserts.is_empty() {
        return;
    }
    let pairs = deletes.len().max(inserts.len());
    for index in 0..pairs {
        let old_line = deletes.get(index).copied();
        let new_line = inserts.get(index).copied();
        match (old_line, new_line) {
            (Some((old_no, old_line)), Some((new_no, new_line))) => {
                push_diff_data_word_split_line(rows, file_index, old_no, old_line, new_no, new_line)
            }
            (Some((old_no, old_line)), None) => push_diff_data_split_line(
                rows,
                file_index,
                GitDiffDataSide {
                    line_no: Some(old_no),
                    class_name: "git-diff-line git-diff-del",
                    segments: diff_data_plain_segments(diff_line_body(old_line)),
                },
                GitDiffDataSide {
                    line_no: None,
                    class_name: "git-diff-line git-diff-empty-side",
                    segments: vec![GitDiffDataSegment::blank()],
                },
            ),
            (None, Some((new_no, new_line))) => push_diff_data_split_line(
                rows,
                file_index,
                GitDiffDataSide {
                    line_no: None,
                    class_name: "git-diff-line git-diff-empty-side",
                    segments: vec![GitDiffDataSegment::blank()],
                },
                GitDiffDataSide {
                    line_no: Some(new_no),
                    class_name: "git-diff-line git-diff-add",
                    segments: diff_data_plain_segments(diff_line_body(new_line)),
                },
            ),
            (None, None) => {}
        }
    }
    deletes.clear();
    inserts.clear();
}

fn push_diff_data_word_split_line<'a>(
    rows: &mut Vec<GitDiffDataRow<'a>>,
    file_index: usize,
    old_line_no: usize,
    old_line: &str,
    new_line_no: usize,
    new_line: &str,
) {
    let mut old_segments = Vec::new();
    let mut new_segments = Vec::new();
    let word_diff = TextDiff::from_words(diff_line_body(old_line), diff_line_body(new_line));
    for change in word_diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Delete => {
                old_segments.push(GitDiffDataSegment {
                    text: change.value().to_string(),
                    class_name: Some("git-diff-word-del"),
                });
            }
            ChangeTag::Insert => {
                new_segments.push(GitDiffDataSegment {
                    text: change.value().to_string(),
                    class_name: Some("git-diff-word-add"),
                });
            }
            ChangeTag::Equal => {
                old_segments.push(GitDiffDataSegment {
                    text: change.value().to_string(),
                    class_name: None,
                });
                new_segments.push(GitDiffDataSegment {
                    text: change.value().to_string(),
                    class_name: None,
                });
            }
        }
    }
    if old_segments.is_empty() {
        old_segments.push(GitDiffDataSegment::blank());
    }
    if new_segments.is_empty() {
        new_segments.push(GitDiffDataSegment::blank());
    }
    push_diff_data_split_line(
        rows,
        file_index,
        GitDiffDataSide {
            line_no: Some(old_line_no),
            class_name: "git-diff-line git-diff-del",
            segments: old_segments,
        },
        GitDiffDataSide {
            line_no: Some(new_line_no),
            class_name: "git-diff-line git-diff-add",
            segments: new_segments,
        },
    );
}

fn push_diff_data_meta_line<'a>(rows: &mut Vec<GitDiffDataRow<'a>>, file_index: usize, line: &str) {
    push_diff_data_split_line(
        rows,
        file_index,
        GitDiffDataSide {
            line_no: None,
            class_name: neutral_diff_line_class(line),
            segments: diff_data_plain_segments(line),
        },
        GitDiffDataSide {
            line_no: None,
            class_name: neutral_diff_line_class(line),
            segments: diff_data_plain_segments(line),
        },
    );
}

fn push_diff_data_split_line<'a>(
    rows: &mut Vec<GitDiffDataRow<'a>>,
    file_index: usize,
    old: GitDiffDataSide,
    new: GitDiffDataSide,
) {
    rows.push(GitDiffDataRow::Line {
        file_index,
        old_line_no: old.line_no,
        new_line_no: new.line_no,
        old_class_name: old.class_name,
        new_class_name: new.class_name,
        old_segments: old.segments,
        new_segments: new.segments,
    });
}

fn diff_line_body(line: &str) -> &str {
    line.get(1..).unwrap_or("")
}

fn diff_data_plain_segments(text: &str) -> Vec<GitDiffDataSegment> {
    vec![GitDiffDataSegment {
        text: if text.is_empty() {
            " ".to_string()
        } else {
            text.to_string()
        },
        class_name: None,
    }]
}

impl GitDiffDataSegment {
    fn blank() -> Self {
        Self {
            text: " ".to_string(),
            class_name: None,
        }
    }
}

fn parse_hunk_line_numbers(line: &str) -> Option<(usize, usize)> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "@@" {
        return None;
    }
    let old = parse_hunk_start(parts.next()?, '-')?;
    let new = parse_hunk_start(parts.next()?, '+')?;
    Some((old, new))
}

fn parse_hunk_start(token: &str, prefix: char) -> Option<usize> {
    token
        .strip_prefix(prefix)?
        .split(',')
        .next()?
        .parse::<usize>()
        .ok()
}

#[cfg(test)]
fn render_unified_diff_html(unified_diff: &str) -> String {
    let mut out = String::new();
    let mut pending_deletes: Vec<&str> = Vec::new();
    let mut pending_inserts: Vec<&str> = Vec::new();

    for raw_line in unified_diff.split_inclusive('\n') {
        let line = raw_line.trim_end_matches('\n').trim_end_matches('\r');
        if is_diff_delete_line(line) {
            pending_deletes.push(line);
            continue;
        }
        if is_diff_insert_line(line) {
            pending_inserts.push(line);
            continue;
        }
        flush_diff_change_block(&mut out, &mut pending_deletes, &mut pending_inserts);
        render_diff_line(&mut out, line, neutral_diff_line_class(line));
    }
    flush_diff_change_block(&mut out, &mut pending_deletes, &mut pending_inserts);
    out
}

fn is_diff_delete_line(line: &str) -> bool {
    line.starts_with('-') && !line.starts_with("--- ")
}

fn is_diff_insert_line(line: &str) -> bool {
    line.starts_with('+') && !line.starts_with("+++ ")
}

#[cfg(test)]
fn flush_diff_change_block<'a>(
    out: &mut String,
    deletes: &mut Vec<&'a str>,
    inserts: &mut Vec<&'a str>,
) {
    if deletes.is_empty() && inserts.is_empty() {
        return;
    }
    let pairs = deletes.len().max(inserts.len());
    for index in 0..pairs {
        let old_line = deletes.get(index).copied();
        let new_line = inserts.get(index).copied();
        match (old_line, new_line) {
            (Some(old_line), Some(new_line)) => {
                render_word_diff_line(out, old_line, new_line, ChangeTag::Delete);
                render_word_diff_line(out, old_line, new_line, ChangeTag::Insert);
            }
            (Some(old_line), None) => {
                render_diff_line(out, old_line, "git-diff-line git-diff-del");
            }
            (None, Some(new_line)) => {
                render_diff_line(out, new_line, "git-diff-line git-diff-add");
            }
            (None, None) => {}
        }
    }
    deletes.clear();
    inserts.clear();
}

#[cfg(test)]
fn render_word_diff_line(out: &mut String, old_line: &str, new_line: &str, side: ChangeTag) {
    let (line, line_class, word_class) = match side {
        ChangeTag::Delete => (old_line, "git-diff-line git-diff-del", "git-diff-word-del"),
        ChangeTag::Insert => (new_line, "git-diff-line git-diff-add", "git-diff-word-add"),
        ChangeTag::Equal => (old_line, "git-diff-line", ""),
    };
    let body = line.get(1..).unwrap_or("");
    out.push_str("<span class=\"");
    out.push_str(line_class);
    out.push_str("\">");
    push_escaped(out, &line[..line.len().min(1)]);

    let word_diff = TextDiff::from_words(
        old_line.get(1..).unwrap_or(""),
        new_line.get(1..).unwrap_or(""),
    );
    for change in word_diff.iter_all_changes() {
        match (side, change.tag()) {
            (ChangeTag::Delete, ChangeTag::Delete) | (ChangeTag::Insert, ChangeTag::Insert) => {
                out.push_str("<span class=\"");
                out.push_str(word_class);
                out.push_str("\">");
                push_escaped(out, change.value());
                out.push_str("</span>");
            }
            (ChangeTag::Delete, ChangeTag::Equal) | (ChangeTag::Insert, ChangeTag::Equal) => {
                push_escaped(out, change.value());
            }
            _ => {}
        }
    }
    if body.is_empty() {
        out.push(' ');
    }
    out.push_str("</span>\n");
}

fn neutral_diff_line_class(line: &str) -> &'static str {
    if line.starts_with("@@ ")
        || line.starts_with("--- ")
        || line.starts_with("+++ ")
        || line.starts_with("Binary files differ:")
        || line.starts_with("rename from ")
        || line.starts_with("rename to ")
        || line.starts_with("\\ No newline")
    {
        "git-diff-line git-diff-meta"
    } else {
        "git-diff-line"
    }
}

#[cfg(test)]
fn render_diff_line(out: &mut String, line: &str, class_name: &str) {
    out.push_str("<span class=\"");
    out.push_str(class_name);
    out.push_str("\">");
    push_escaped(out, line);
    if line.is_empty() {
        out.push(' ');
    }
    out.push_str("</span>\n");
}

#[cfg(test)]
fn push_escaped(out: &mut String, text: &str) {
    html_escape::encode_text_to_string(text, out);
}

fn git_diff_ref_values(root: &FsPath, diff: &git::GitDiff) -> (String, String) {
    if diff.range == "HEAD..worktree" {
        return ("HEAD".to_string(), "worktree".to_string());
    }
    if let Some((base, compare)) = diff.range.split_once("..") {
        return (base.to_string(), compare.to_string());
    }
    let base = git::parent_commit(root, &diff.range)
        .ok()
        .flatten()
        .unwrap_or_else(|| "HEAD".to_string());
    (base, diff.range.clone())
}

#[derive(Clone, Copy)]
enum GitCompareOptionRole {
    Base,
    Compare,
}

#[derive(Clone, Copy)]
enum GitCompareOptionStatusMode {
    Fast,
    Checked,
}

fn git_compare_option_has_markdown_changes(
    root: &FsPath,
    value: &str,
    other_ref: &str,
    role: GitCompareOptionRole,
) -> bool {
    let (base, compare) = match role {
        GitCompareOptionRole::Base => (value, other_ref),
        GitCompareOptionRole::Compare => (other_ref, value),
    };
    if base == compare {
        return false;
    }
    // Refs here come from a trusted enumeration (HEAD / history / worktree), so
    // skip re-validation and run just the single diff probe.
    git::diff_has_markdown_changes_unchecked(root, base, compare).unwrap_or(true)
}

fn git_compare_option_statuses(options: Vec<GitCompareOption>) -> Vec<GitCompareOptionStatus> {
    options
        .into_iter()
        .map(|option| GitCompareOptionStatus {
            value: option.value,
            disabled: option.disabled,
        })
        .collect()
}

fn git_compare_options(
    root: &FsPath,
    selected: &str,
    include_worktree: bool,
    other_ref: &str,
    role: GitCompareOptionRole,
    status_mode: GitCompareOptionStatusMode,
) -> Vec<GitCompareOption> {
    // 1) Gather unique candidates in display order (a handful of cheap git
    //    calls). `check` marks options whose "disabled" state needs a diff probe.
    // A candidate carries the rich metadata the picker panel renders (kind /
    // subject / detail / date), plus `check` = whether its disabled state needs a
    // markdown-diff probe.
    struct Cand {
        value: String,
        label: String,
        alias: String,
        kind: String,
        subject: String,
        detail: String,
        date: String,
        check: bool,
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut candidates: Vec<Cand> = Vec::new();
    let mut add = |c: Cand| {
        if seen.insert(c.value.clone()) {
            candidates.push(c);
        }
    };

    add(Cand {
        value: "HEAD".to_string(),
        label: "HEAD".to_string(),
        alias: String::new(),
        kind: "head".to_string(),
        subject: "Latest commit".to_string(),
        detail: String::new(),
        date: String::new(),
        check: true,
    });
    for branch in git::branches(root).unwrap_or_default() {
        let label = if branch.current {
            format!("{} (current)", branch.name)
        } else {
            branch.name.clone()
        };
        add(Cand {
            value: branch.name,
            label,
            alias: String::new(),
            kind: "branch".to_string(),
            subject: String::new(),
            detail: if branch.current {
                "current".to_string()
            } else {
                String::new()
            },
            date: String::new(),
            check: false,
        });
    }
    for (idx, commit) in git::history(root, 50)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        add(Cand {
            value: commit.hash,
            label: format!("{} {}", commit.short_hash, commit.subject),
            alias: if idx == 0 {
                "Latest".to_string()
            } else {
                String::new()
            },
            kind: "commit".to_string(),
            subject: commit.subject,
            detail: commit.short_hash,
            date: commit.relative_time,
            check: true,
        });
    }
    for tag in git::tags(root, 200).unwrap_or_default() {
        add(Cand {
            value: tag.name.clone(),
            label: format!("{} (tag)", tag.name),
            alias: String::new(),
            kind: "tag".to_string(),
            subject: String::new(),
            detail: tag.short_hash,
            date: tag.relative_time,
            check: false,
        });
    }
    if include_worktree {
        add(Cand {
            value: "worktree".to_string(),
            label: "Worktree".to_string(),
            alias: String::new(),
            kind: "worktree".to_string(),
            subject: "Uncommitted working-tree files".to_string(),
            detail: String::new(),
            date: String::new(),
            check: true,
        });
    }

    // 2) Resolve each option's `disabled` state in parallel. Every probe spawns
    //    its own git subprocess(es); the bottleneck is process spawn, so this
    //    fans the ~dozens of probes across cores instead of running serially.
    let checked = matches!(status_mode, GitCompareOptionStatusMode::Checked);
    let mut out: Vec<GitCompareOption> = candidates
        .par_iter()
        .map(|c| {
            let disabled = checked
                && c.check
                && c.value != selected
                && !git_compare_option_has_markdown_changes(root, &c.value, other_ref, role);
            GitCompareOption {
                selected: c.value == selected,
                value: c.value.clone(),
                label: c.label.clone(),
                alias: c.alias.clone(),
                kind: c.kind.clone(),
                subject: c.subject.clone(),
                detail: c.detail.clone(),
                date: c.date.clone(),
                disabled,
            }
        })
        .collect();

    if !selected.is_empty() && !seen.contains(selected) {
        out.insert(
            0,
            GitCompareOption {
                value: selected.to_string(),
                label: short_git_ref(selected),
                alias: String::new(),
                kind: "commit".to_string(),
                subject: String::new(),
                detail: short_git_ref(selected),
                date: String::new(),
                selected: true,
                disabled: false,
            },
        );
    }

    out
}

const GIT_EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn git_commit_compare_base(root: &FsPath, commit: &str) -> String {
    git::parent_commit(root, commit)
        .ok()
        .flatten()
        .unwrap_or_else(|| GIT_EMPTY_TREE_HASH.to_string())
}

fn git_commit_markdown_diff_url(
    root: &FsPath,
    workspace_id: &str,
    commit: &git::GitCommit,
    view: &str,
) -> Option<String> {
    let diff = git::commit_diff(root, &commit.hash).ok()?;
    if markdown_only_git_diff(&diff, None).files.is_empty() {
        return None;
    }
    Some(pretty_compare_page_url(
        workspace_id,
        &git_commit_compare_base(root, &commit.hash),
        &commit.hash,
        view,
    ))
}

fn git_source_diff_url(
    workspace_id: &str,
    root: &FsPath,
    diff: &git::GitDiff,
    base: &str,
    compare: &str,
) -> String {
    if diff.range == "HEAD..worktree" {
        pretty_compare_page_url(workspace_id, "HEAD", "worktree", "raw")
    } else if diff.range.contains("..") {
        pretty_compare_page_url(workspace_id, base, compare, "raw")
    } else {
        pretty_compare_page_url(
            workspace_id,
            &git_commit_compare_base(root, &diff.range),
            &diff.range,
            "raw",
        )
    }
}

fn markdown_work_diff_page_url(workspace_id: &str) -> String {
    pretty_compare_page_url(workspace_id, "HEAD", "worktree", "rendered")
}

fn markdown_diff_page_url(
    workspace_id: &str,
    root: &FsPath,
    diff: &git::GitDiff,
    base: &str,
    compare: &str,
) -> String {
    if diff.range == "HEAD..worktree" {
        markdown_work_diff_page_url(workspace_id)
    } else if diff.range.contains("..") {
        pretty_compare_page_url(workspace_id, base, compare, "rendered")
    } else {
        pretty_compare_page_url(
            workspace_id,
            &git_commit_compare_base(root, &diff.range),
            &diff.range,
            "rendered",
        )
    }
}

fn pretty_compare_page_url(workspace_id: &str, base: &str, compare: &str, view: &str) -> String {
    format!(
        "{}/{}...{}?view={}",
        workspace_compare_base_url(workspace_id),
        encode_compare_ref_for_path(base),
        encode_compare_ref_for_path(compare),
        view
    )
}

fn pretty_compare_data_url(workspace_id: &str, base: &str, compare: &str, view: &str) -> String {
    format!(
        "{}&format=data",
        pretty_compare_page_url(workspace_id, base, compare, view)
    )
}

fn encode_compare_ref_for_path(value: &str) -> String {
    urlencoding::encode(value).replace("%2F", "/")
}

fn markdown_diff_data_url(workspace_id: &str, base: &str, compare: &str) -> String {
    pretty_compare_data_url(workspace_id, base, compare, "rendered")
}

fn render_git_diff_page(
    state: &AppState,
    workspace_id: &str,
    ws: &WorkspaceEntry,
    can_manage: bool,
    diff: &git::GitDiff,
    initial_view: &str,
) -> Response {
    let flags = ws.flags();
    let root = directory_root_or_not_found!(ws);
    let (base_value, compare_value) = git_diff_ref_values(root, diff);
    let initial_view = if initial_view == "rendered" {
        "rendered"
    } else {
        "raw"
    };
    let display_diff = markdown_only_git_diff(diff, None);
    // Default to the all-files continuous view (no file pre-selected). The left
    // file list focuses a single file on demand; an empty default means "no `f`"
    // renders every changed file in one scroll instead of just the first.
    let default_diff_path = "";
    let mut context = base_context(state);
    context.insert("title", &format!("Markdiff · {}", diff.range));
    context.insert("workspace_id", workspace_id);
    context.insert(
        "diff",
        &git_diff_template(
            root,
            &display_diff,
            base_value.clone(),
            compare_value.clone(),
        ),
    );
    context.insert("can_manage", &can_manage);
    context.insert("shared_annotation", &flags.shared_annotation);
    context.insert("enable_live", &flags.enable_live);
    context.insert("enable_chat", &flags.enable_chat);
    context.insert("history_url", &workspace_git_history_url(workspace_id));
    context.insert("files_url", &workspace_root_url(workspace_id));
    // Home-collapsed workspace path shown beside the title (links to the home).
    let ws_display_path = workspace_display_path(root);
    context.insert("workspace_display_path", &ws_display_path);
    context.insert("workspace_alias", &ws.alias());
    context.insert("work_diff_url", &markdown_work_diff_page_url(workspace_id));
    context.insert(
        "markdown_diff_url",
        &markdown_diff_page_url(workspace_id, root, diff, &base_value, &compare_value),
    );
    context.insert(
        "source_diff_url",
        &git_source_diff_url(workspace_id, root, diff, &base_value, &compare_value),
    );
    context.insert(
        "compare_url",
        &pretty_compare_page_url(workspace_id, &base_value, &compare_value, initial_view),
    );
    context.insert(
        "compare_path_base",
        &workspace_compare_base_url(workspace_id),
    );
    context.insert(
        "compare_options_status_url",
        &workspace_compare_options_url(workspace_id),
    );
    context.insert("initial_diff_view", initial_view);
    context.insert("default_diff_path", &default_diff_path);
    context.insert("is_markdown_diff", &(initial_view == "rendered"));
    let base_options = git_compare_options(
        root,
        &base_value,
        false,
        &compare_value,
        GitCompareOptionRole::Base,
        GitCompareOptionStatusMode::Fast,
    );
    let compare_options = git_compare_options(
        root,
        &compare_value,
        true,
        &base_value,
        GitCompareOptionRole::Compare,
        GitCompareOptionStatusMode::Fast,
    );
    // One JSON bundle drives the custom Base↔Compare picker panel (rich rows with
    // subject/date, quick presets, client-side navigation + status probing).
    let picker_json = serde_json::json!({
        "base": base_options,
        "compare": compare_options,
        "baseValue": base_value,
        "compareValue": compare_value,
        "pathBase": workspace_compare_base_url(workspace_id),
        "statusUrl": workspace_compare_options_url(workspace_id),
    })
    .to_string();
    context.insert("compare_picker_json", &picker_json);
    // "Worktree-targeting" = the Compare (new) side is the live worktree, for ANY
    // base (HEAD…Worktree, a-tag…Worktree, …). That new side is the set of real,
    // writable files on disk — what annotations bind to and what the sidebar's
    // create-file/folder writes into. (`worktree` is only ever offered as a
    // Compare option, never a Base.) Comparing two commits never targets it.
    let is_worktree_diff = compare_value == "worktree";
    context.insert("is_worktree_diff", &is_worktree_diff);
    // The sidebar tree can create files/folders only when the comparison targets
    // the (writable) worktree AND the workspace permits editing.
    let diff_editable =
        is_worktree_diff && ws.enable_edit.load(std::sync::atomic::Ordering::Relaxed);
    context.insert("diff_editable", &diff_editable);
    context.insert("create_file_url", &workspace_file_create_url(workspace_id));
    context.insert(
        "create_folder_url",
        &workspace_folder_create_url(workspace_id),
    );
    // Both views (rendered + raw source) now consume one unified Markdown block
    // payload, so a single data URL drives the whole page.
    let markdown_diff_data_url = markdown_diff_data_url(workspace_id, &base_value, &compare_value);
    context.insert("markdown_diff_data_url", &markdown_diff_data_url);
    render_template(state, "git-diff.html", &context)
}

#[derive(Serialize)]
struct GitHistoryCommitTemplate<'a> {
    short_hash: &'a str,
    author: &'a str,
    date: &'a str,
    subject: &'a str,
    diff_url: Option<String>,
}

/// One calendar day worth of commits, matching GitHub's date-grouped Commits
/// page. `commits` keeps the incoming reverse-chronological order.
#[derive(Serialize)]
struct GitHistoryDay<'a> {
    day_label: String,
    commits: Vec<GitHistoryCommitTemplate<'a>>,
}

/// Turn an ISO date like `2026-03-07T08:30:43+08:00` into GitHub's
/// `Mar 7, 2026` heading. No new deps — the month is mapped by hand from the
/// `MM` field. Falls back to the raw string if the date is malformed.
fn git_history_day_label(date: &str) -> String {
    if date.len() < 10 {
        return date.to_string();
    }
    let year = &date[0..4];
    let month = match &date[5..7] {
        "01" => "Jan",
        "02" => "Feb",
        "03" => "Mar",
        "04" => "Apr",
        "05" => "May",
        "06" => "Jun",
        "07" => "Jul",
        "08" => "Aug",
        "09" => "Sep",
        "10" => "Oct",
        "11" => "Nov",
        "12" => "Dec",
        other => other,
    };
    let day = date[8..10].trim_start_matches('0');
    let day = if day.is_empty() { "0" } else { day };
    format!("{month} {day}, {year}")
}

/// One selectable branch in the toolbar's branch dropdown; `current` marks the
/// entry that matches the active `?branch=` (or the real checked-out branch).
#[derive(Serialize)]
struct GitBranchOption {
    name: String,
    current: bool,
}

/// A time-range preset for the "All time" dropdown.
#[derive(Serialize)]
struct GitRangeOption {
    key: &'static str,
    label: &'static str,
    current: bool,
}

/// An author entry for the "All users" dropdown.
#[derive(Serialize)]
struct GitAuthorOption {
    name: String,
    current: bool,
}

fn render_git_history_page(
    state: &AppState,
    workspace_id: &str,
    root: &FsPath,
    commits: &[git::GitCommit],
    selected_branch: Option<&str>,
    selected_author: Option<&str>,
    range_key: &str,
) -> Response {
    // Group commits by their `YYYY-MM-DD` prefix while preserving the incoming
    // reverse-chronological order (commits are already sorted newest-first).
    // Resolve every commit's parent + markdown-changed flag in one git pass, so
    // the per-commit diff link below is a pure hashmap lookup rather than a
    // `git show` + `rev-parse` subprocess pair per row.
    let commit_hashes: Vec<&str> = commits.iter().map(|c| c.hash.as_str()).collect();
    let diff_index = git::commit_diff_index(root, &commit_hashes).unwrap_or_default();
    let mut groups: Vec<GitHistoryDay<'_>> = Vec::new();
    let mut last_key: Option<&str> = None;
    for commit in commits {
        let key = commit.date.get(0..10).unwrap_or(commit.date.as_str());
        let diff_url = diff_index
            .get(&commit.hash)
            .filter(|info| info.has_markdown)
            .map(|info| {
                pretty_compare_page_url(
                    workspace_id,
                    info.parent.as_deref().unwrap_or(GIT_EMPTY_TREE_HASH),
                    &commit.hash,
                    "rendered",
                )
            });
        let item = GitHistoryCommitTemplate {
            short_hash: &commit.short_hash,
            author: &commit.author,
            date: &commit.date,
            subject: &commit.subject,
            diff_url,
        };
        if last_key == Some(key) {
            groups
                .last_mut()
                .expect("last_key set implies a prior group")
                .commits
                .push(item);
        } else {
            groups.push(GitHistoryDay {
                day_label: git_history_day_label(&commit.date),
                commits: vec![item],
            });
            last_key = Some(key);
        }
    }
    // Real branch list + the name actually checked out, used both to build the
    // dropdown and to label it when no explicit `?branch=` is selected.
    let all_branches = git::branches(root).unwrap_or_default();
    let checked_out = all_branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .unwrap_or_else(|| "main".to_string());
    // Only honour a `?branch=` that really exists (mirrors history_filtered's
    // whitelist, so the label never lies about which rev was walked).
    let active_branch = selected_branch
        .filter(|name| all_branches.iter().any(|b| b.name == *name))
        .map(str::to_string);
    let current_branch_label = active_branch.clone().unwrap_or_else(|| checked_out.clone());
    let branch_options: Vec<GitBranchOption> = all_branches
        .iter()
        .map(|b| GitBranchOption {
            name: b.name.clone(),
            current: b.name == current_branch_label,
        })
        .collect();

    let author_list = git::authors(root).unwrap_or_default();
    let author_options: Vec<GitAuthorOption> = author_list
        .iter()
        .map(|name| GitAuthorOption {
            name: name.clone(),
            current: selected_author == Some(name.as_str()),
        })
        .collect();
    let current_author_label = selected_author
        .map(str::to_string)
        .unwrap_or_else(|| "All users".to_string());

    const RANGE_PRESETS: [(&str, &str); 5] = [
        ("", "All time"),
        ("day", "Last 24 hours"),
        ("week", "Last 7 days"),
        ("month", "Last 30 days"),
        ("year", "Last 12 months"),
    ];
    let range_options: Vec<GitRangeOption> = RANGE_PRESETS
        .iter()
        .map(|(key, label)| GitRangeOption {
            key,
            label,
            current: *key == range_key,
        })
        .collect();
    let current_range_label = RANGE_PRESETS
        .iter()
        .find(|(key, _)| *key == range_key)
        .map(|(_, label)| *label)
        .unwrap_or("All time");

    let work_diff_url = git::diff_has_markdown_changes(root, "HEAD", "worktree")
        .unwrap_or(false)
        .then(|| markdown_work_diff_page_url(workspace_id));
    let mut context = base_context(state);
    context.insert("title", "markon git history");
    context.insert("workspace_id", workspace_id);
    context.insert("groups", &groups);
    context.insert("commit_count", &commits.len());
    context.insert("current_branch", &current_branch_label);
    context.insert("current_branch_label", &current_branch_label);
    context.insert("branches", &branch_options);
    context.insert("authors", &author_options);
    context.insert("current_author", &selected_author);
    context.insert("current_author_label", &current_author_label);
    context.insert("ranges", &range_options);
    context.insert("current_range", &range_key);
    context.insert("current_range_label", &current_range_label);
    context.insert("files_url", &workspace_root_url(workspace_id));
    context.insert("has_commits", &!groups.is_empty());
    let filters_active = selected_author.is_some() || (!range_key.is_empty() && range_key != "all");
    context.insert("filters_active", &filters_active);
    context.insert("work_diff_url", &work_diff_url);
    render_template(state, "git-history.html", &context)
}

fn render_git_branches_page(
    state: &AppState,
    workspace_id: &str,
    branches: &[git::GitBranchDetail],
) -> Response {
    let mut context = base_context(state);
    context.insert("title", "markon git branches");
    context.insert("workspace_id", workspace_id);
    context.insert("files_url", &workspace_root_url(workspace_id));
    context.insert("history_url", &workspace_git_history_url(workspace_id));
    context.insert("page_title", "Branches");
    context.insert("page_title_key", "web.ws.git.branches");
    context.insert("empty_key", "web.ws.git.no_branches");
    context.insert("mode", "branches");

    // Row shape the template renders directly: `has_counts` flags whether the
    // ahead/behind comparison resolved (so `Some(0)` still shows `0｜0` while an
    // unresolved `None` shows a placeholder), and the counts are flattened to
    // plain numbers to avoid null/`Option` ambiguity in the template.
    #[derive(Serialize)]
    struct BranchRow {
        name: String,
        updated: String,
        is_default: bool,
        has_counts: bool,
        behind: usize,
        ahead: usize,
    }
    let to_row = |b: &git::GitBranchDetail| BranchRow {
        name: b.name.clone(),
        updated: b.updated.clone(),
        is_default: b.is_default,
        has_counts: b.behind.is_some() && b.ahead.is_some(),
        behind: b.behind.unwrap_or(0),
        ahead: b.ahead.unwrap_or(0),
    };

    // Group GitHub-style: the default branch on its own, the rest name-sorted.
    let default_branch = branches.iter().find(|b| b.is_default).map(to_row);
    let mut other_branches: Vec<BranchRow> = branches
        .iter()
        .filter(|b| !b.is_default)
        .map(to_row)
        .collect();
    other_branches.sort_by(|a, b| a.name.cmp(&b.name));
    let default_branch_name = default_branch
        .as_ref()
        .map(|b| b.name.clone())
        .unwrap_or_default();

    context.insert("default_branch", &default_branch);
    context.insert("other_branches", &other_branches);
    context.insert("default_branch_name", &default_branch_name);
    context.insert("branch_total", &branches.len());
    context.insert("has_items", &!branches.is_empty());
    render_template(state, "git-refs.html", &context)
}

fn render_git_tags_page(state: &AppState, workspace_id: &str, tags: &[git::GitTag]) -> Response {
    let mut context = base_context(state);
    context.insert("title", "markon git tags");
    context.insert("workspace_id", workspace_id);
    context.insert("files_url", &workspace_root_url(workspace_id));
    context.insert("history_url", &workspace_git_history_url(workspace_id));
    context.insert("page_title", "Tags");
    context.insert("page_title_key", "web.ws.git.tags");
    context.insert("empty_key", "web.ws.git.no_tags");
    context.insert("mode", "tags");
    context.insert("branches", &Vec::<git::GitBranch>::new());
    context.insert("tags", tags);
    context.insert("has_items", &!tags.is_empty());
    render_template(state, "git-refs.html", &context)
}

/// One markdown file whose rendered diff must be (re)built — i.e. it missed the
/// file cache. Carries the resolved per-side content identity so a batched blob
/// read + parallel render can finish the job without further git subprocesses.
struct MarkdownBuildItem<'a> {
    entry: &'a git::MarkdownDiffEntry,
    old_id: Option<String>,
    new_id: Option<String>,
    /// Worktree new-side content, already read in pass 1 (worktree has no blob).
    new_worktree: Option<String>,
    read_diagnostics: Vec<MarkdownDiffDiagnostic>,
    file_key: Option<MarkdownDiffFileCacheKey>,
}

fn markdown_compare_diff_data(
    state: &AppState,
    workspace_id: &str,
    workspace_fs: &WorkspaceFs,
    base: &str,
    compare: &str,
    file_filter: Option<&str>,
) -> git::Result<MarkdownDiffData> {
    let root = workspace_fs
        .directory_root()
        .ok_or_else(|| git::GitError::Io("directory workspace required".to_string()))?;
    let engine = markdown_ast::engine_info();
    // Cheap enumeration: `git diff --raw` (no patch) + untracked md. Gives each
    // changed file's status and per-side blob oids without reading content.
    let listing = git::markdown_diff_listing(workspace_fs, base, compare)?;
    if !engine.enabled {
        return Ok(MarkdownDiffData {
            title: "Markdown visual diff".to_string(),
            subtitle: engine.message.map(str::to_string),
            engine,
            files: Vec::new(),
        });
    }

    let filter = file_filter.map(str::trim).filter(|f| !f.is_empty());
    let entries: Vec<&git::MarkdownDiffEntry> = listing
        .entries
        .iter()
        .filter(|e| filter.is_none_or(|f| e.path == f || e.old_path.as_deref() == Some(f)))
        .collect();

    enum Slot<'a> {
        Cached(Arc<MarkdownDiffFile>),
        Build(Box<MarkdownBuildItem<'a>>),
    }

    // ---- Pass 1: resolve content identity; serve file-cache hits without I/O ----
    // The old side is identified purely by its blob oid (from `--raw`), so a warm
    // reload hits the cache without reading or re-rendering it. The worktree new
    // side has no oid yet, so it is read here (cheap) to derive its identity.
    let mut slots: Vec<Slot> = Vec::with_capacity(entries.len());
    let mut needed_blobs: Vec<String> = Vec::new();

    for entry in &entries {
        let mut read_diagnostics = Vec::new();
        let old_id = if entry.status == "added" {
            None
        } else {
            entry.old_blob.clone()
        };

        let mut new_worktree = None;
        let new_id = if entry.status == "deleted" {
            None
        } else if let Some(blob) = &entry.new_blob {
            Some(blob.clone())
        } else {
            match workspace_fs.read_content_to_string(&entry.path) {
                Ok(content) => {
                    let id = format!("h:{}", markdown_content_hash(&content));
                    new_worktree = Some(content);
                    Some(id)
                }
                Err(e) => {
                    read_diagnostics.push(markdown_diff_diagnostic(
                        "new",
                        "read_worktree_failed",
                        "error",
                        format!("Failed to read {}: {e}", entry.path),
                    ));
                    None
                }
            }
        };

        let file_key = read_diagnostics
            .is_empty()
            .then(|| MarkdownDiffFileCacheKey {
                version: MARKDOWN_DIFF_CACHE_VERSION,
                theme: state.theme.as_str().to_string(),
                workspace_id: workspace_id.to_string(),
                path: entry.path.clone(),
                old_path: entry.old_path.clone(),
                status: entry.status.clone(),
                old_id: old_id.clone(),
                new_id: new_id.clone(),
            });

        if let Some(key) = &file_key {
            if let Some(cached) = state
                .markdown_diff_cache
                .lock()
                .expect("markdown diff cache poisoned")
                .get_file(key)
            {
                slots.push(Slot::Cached(cached));
                continue;
            }
        }

        // Cache miss: schedule the blobs this build will need.
        if let Some(oid) = &old_id {
            needed_blobs.push(oid.clone());
        }
        if entry.new_blob.is_some() {
            if let Some(oid) = &new_id {
                needed_blobs.push(oid.clone());
            }
        }
        slots.push(Slot::Build(Box::new(MarkdownBuildItem {
            entry,
            old_id,
            new_id,
            new_worktree,
            read_diagnostics,
            file_key,
        })));
    }

    // ---- Pass 2: one batched `git cat-file` for every missing blob ----
    needed_blobs.sort();
    needed_blobs.dedup();
    let blobs = git::read_blobs(root, &needed_blobs)?;

    // ---- Pass 3: render the misses in parallel (render_html, not full render) ----
    let builds: Vec<(usize, &MarkdownBuildItem)> = slots
        .iter()
        .enumerate()
        .filter_map(|(i, slot)| match slot {
            Slot::Build(item) => Some((i, item.as_ref())),
            Slot::Cached(_) => None,
        })
        .collect();
    let mut built: HashMap<usize, MarkdownDiffFile> = builds
        .into_par_iter()
        .map(|(i, item)| {
            (
                i,
                build_markdown_diff_file(state, workspace_id, item, &blobs, workspace_fs),
            )
        })
        .collect();

    // ---- Pass 4: assemble in original order; promote freshly built into cache ----
    let mut files = Vec::with_capacity(slots.len());
    for (i, slot) in slots.iter().enumerate() {
        match slot {
            Slot::Cached(arc) => files.push((**arc).clone()),
            Slot::Build(item) => {
                let file = built.remove(&i).expect("built file present");
                if let Some(key) = item.file_key.clone() {
                    let cached = state
                        .markdown_diff_cache
                        .lock()
                        .expect("markdown diff cache poisoned")
                        .insert_file(key, file);
                    files.push((*cached).clone());
                } else {
                    files.push(file);
                }
            }
        }
    }

    Ok(MarkdownDiffData {
        title: listing.title,
        subtitle: Some(format!(
            "{} Markdown files changed · {}",
            files.len(),
            listing.range
        )),
        engine,
        files,
    })
}

/// Async wrapper for [`markdown_compare_diff_data`]. The diff build shells out to
/// git, reads worktree files, and renders in parallel via rayon — all blocking
/// work that would otherwise stall a tokio worker. Move it to the blocking pool;
/// a join failure surfaces as a generic IO error the caller already maps to 500.
async fn markdown_compare_diff_data_async(
    state: &AppState,
    workspace_id: &str,
    workspace_fs: Arc<WorkspaceFs>,
    base: &str,
    compare: &str,
    file_filter: Option<&str>,
) -> git::Result<MarkdownDiffData> {
    let state = state.clone();
    let workspace_id = workspace_id.to_string();
    let base = base.to_string();
    let compare = compare.to_string();
    let file_filter = file_filter.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        markdown_compare_diff_data(
            &state,
            &workspace_id,
            &workspace_fs,
            &base,
            &compare,
            file_filter.as_deref(),
        )
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!("markdown_compare_diff_data join error: {e}");
        Err(git::GitError::Io("diff render task failed".to_string()))
    })
}

/// Build a single file's rendered diff from already-resolved content sources.
/// Pure CPU + cache lookups — safe to run in parallel across files.
fn build_markdown_diff_file(
    state: &AppState,
    workspace_id: &str,
    item: &MarkdownBuildItem,
    blobs: &HashMap<String, Vec<u8>>,
    workspace_fs: &WorkspaceFs,
) -> MarkdownDiffFile {
    let entry = item.entry;
    let root = workspace_fs
        .directory_root()
        .expect("markdown diff requires a directory workspace");
    // Canonicalize the new-side path the same way `render_markdown_file` builds
    // its `file_path` key, so a highlight made in the diff binds to the same
    // annotation row as one made in the normal file view. `entry.path` is
    // workspace-relative (the listing uses `git diff --relative`), so joining it
    // onto the workspace root reaches the exact same on-disk file — and the same
    // canonical key — as the normal view, including subdirectory-of-repo
    // workspaces. Deleted files have no on-disk new side, so canonicalize falls
    // back to the lexical join (such files are not annotatable anyway).
    let abs_path = {
        let joined = root.join(&entry.path);
        workspace_fs
            .resolve_content(&entry.path)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| joined.to_string_lossy().into_owned())
    };
    let mut diagnostics = item.read_diagnostics.clone();

    let blob_text =
        |id: &str, side: &'static str, diags: &mut Vec<MarkdownDiffDiagnostic>| match blobs.get(id)
        {
            Some(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            None => {
                diags.push(markdown_diff_diagnostic(
                    side,
                    "read_blob_failed",
                    "error",
                    format!("Missing blob {id}"),
                ));
                None
            }
        };

    let old_content = item
        .old_id
        .as_deref()
        .and_then(|id| blob_text(id, "old", &mut diagnostics));
    let new_content = if entry.status == "deleted" {
        None
    } else if let Some(content) = &item.new_worktree {
        Some(content.clone())
    } else {
        item.new_id
            .as_deref()
            .and_then(|id| blob_text(id, "new", &mut diagnostics))
    };

    let old_path = entry.old_path.as_deref().unwrap_or(&entry.path);
    let old_file_path = root.join(old_path);
    let new_file_path = root.join(&entry.path);
    let old_renderer = default_markdown_engine(state.theme.as_str()).with_asset_context(
        workspace_id,
        &old_file_path,
        root,
    );
    let new_renderer = default_markdown_engine(state.theme.as_str()).with_asset_context(
        workspace_id,
        &new_file_path,
        root,
    );

    let old = summarize_side_cached(
        state,
        "old",
        old_content.as_deref(),
        item.old_id.as_deref(),
        workspace_id,
        &old_file_path,
        &old_renderer,
    );
    diagnostics.extend(markdown_side_diagnostics("old", old.as_ref()));
    let new = summarize_side_cached(
        state,
        "new",
        new_content.as_deref(),
        item.new_id.as_deref(),
        workspace_id,
        &new_file_path,
        &new_renderer,
    );
    diagnostics.extend(markdown_side_diagnostics("new", new.as_ref()));

    let blocks = diff_markdown_blocks(
        old.as_ref().map(|s| s.blocks.as_slice()),
        new.as_ref().map(|s| s.blocks.as_slice()),
    );

    MarkdownDiffFile {
        path: entry.path.clone(),
        abs_path,
        old_path: entry.old_path.clone(),
        status: entry.status.clone(),
        old: old.as_ref().map(MarkdownDocOutline::from_summary),
        new: new.as_ref().map(MarkdownDocOutline::from_summary),
        old_source: old_content,
        new_source: new_content,
        additions: entry.additions,
        deletions: entry.deletions,
        blocks,
        diagnostics,
    }
}

/// Summarize one side, keyed in the document cache by a stable content id (blob
/// oid, or `h:<sha256>` for worktree content). The cache includes workspace and
/// file path because rendered local asset URLs depend on both. Blocks use
/// `render_html` only; the diff does not need the diagnostic pass of full
/// `render()`.
fn summarize_side_cached(
    state: &AppState,
    side: &'static str,
    content: Option<&str>,
    content_id: Option<&str>,
    workspace_id: &str,
    file_path: &FsPath,
    renderer: &MarkdownRenderer,
) -> Option<markdown_ast::MarkdownDocumentSummary> {
    let content = content?;
    let id_owned;
    let id = match content_id {
        Some(id) => id,
        None => {
            id_owned = format!("h:{}", markdown_content_hash(content));
            id_owned.as_str()
        }
    };
    let key = markdown_document_cache_key(state, id, workspace_id, file_path);
    if let Some(summary) = state
        .markdown_diff_cache
        .lock()
        .expect("markdown diff cache poisoned")
        .get_document(&key)
    {
        return Some((*summary).clone());
    }

    let mut render_block = |fragment: &str| renderer.render_html(fragment).html;
    let summary = match markdown_ast::summarize_document(content, &mut render_block) {
        Ok(summary) => summary,
        Err(e) => markdown_summary_error(side, e.message),
    };
    let cached = state
        .markdown_diff_cache
        .lock()
        .expect("markdown diff cache poisoned")
        .insert_document(key, summary);
    Some((*cached).clone())
}

fn is_markdown_diff_file(file: &git::GitDiffFile) -> bool {
    is_markdown_route_path(&file.path)
        || file.old_path.as_deref().is_some_and(is_markdown_route_path)
}

fn is_markdown_route_path(path: &str) -> bool {
    FsPath::new(path)
        .extension()
        .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("md"))
}

fn markdown_content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn markdown_document_cache_key(
    state: &AppState,
    content_hash: &str,
    workspace_id: &str,
    file_path: &FsPath,
) -> MarkdownDocumentCacheKey {
    MarkdownDocumentCacheKey {
        version: MARKDOWN_DIFF_CACHE_VERSION,
        theme: state.theme.as_str().to_string(),
        workspace_id: workspace_id.to_string(),
        file_path: file_path.to_string_lossy().into_owned(),
        content_hash: content_hash.to_string(),
    }
}

fn markdown_summary_error(
    side: &'static str,
    message: String,
) -> markdown_ast::MarkdownDocumentSummary {
    markdown_ast::MarkdownDocumentSummary {
        block_count: 0,
        diagnostics: vec![markdown_ast::MarkdownAstDiagnostic {
            code: format!("{side}_parse_failed"),
            severity: "error".to_string(),
            message,
            start_line: None,
            end_line: None,
        }],
        blocks: Vec::new(),
    }
}

fn markdown_side_diagnostics(
    side: &'static str,
    summary: Option<&markdown_ast::MarkdownDocumentSummary>,
) -> Vec<MarkdownDiffDiagnostic> {
    summary
        .into_iter()
        .flat_map(|summary| {
            summary
                .diagnostics
                .iter()
                .map(move |diagnostic| MarkdownDiffDiagnostic {
                    side,
                    code: diagnostic.code.clone(),
                    severity: diagnostic.severity.clone(),
                    message: diagnostic.message.clone(),
                    start_line: diagnostic.start_line,
                    end_line: diagnostic.end_line,
                })
        })
        .collect()
}

fn markdown_diff_diagnostic(
    side: &'static str,
    code: &'static str,
    severity: &'static str,
    message: String,
) -> MarkdownDiffDiagnostic {
    MarkdownDiffDiagnostic {
        side,
        code: code.to_string(),
        severity: severity.to_string(),
        message,
        start_line: None,
        end_line: None,
    }
}

#[derive(Debug, Clone)]
enum MarkdownBlockOp {
    Equal(
        markdown_ast::MarkdownBlockSummary,
        markdown_ast::MarkdownBlockSummary,
    ),
    Delete(markdown_ast::MarkdownBlockSummary),
    Add(markdown_ast::MarkdownBlockSummary),
}

fn diff_markdown_blocks(
    old: Option<&[markdown_ast::MarkdownBlockSummary]>,
    new: Option<&[markdown_ast::MarkdownBlockSummary]>,
) -> Vec<MarkdownDiffBlock> {
    let old = old.unwrap_or(&[]);
    let new = new.unwrap_or(&[]);
    let ops = if old.len().saturating_mul(new.len()) <= 40_000 {
        diff_markdown_blocks_lcs(old, new)
    } else {
        diff_markdown_blocks_by_index(old, new)
    };
    coalesce_markdown_block_ops(ops)
}

fn diff_markdown_blocks_lcs(
    old: &[markdown_ast::MarkdownBlockSummary],
    new: &[markdown_ast::MarkdownBlockSummary],
) -> Vec<MarkdownBlockOp> {
    let n = old.len();
    let m = new.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old[i].digest == new[j].digest {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    let mut ops = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if old[i].digest == new[j].digest {
            ops.push(MarkdownBlockOp::Equal(old[i].clone(), new[j].clone()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(MarkdownBlockOp::Delete(old[i].clone()));
            i += 1;
        } else {
            ops.push(MarkdownBlockOp::Add(new[j].clone()));
            j += 1;
        }
    }
    while i < n {
        ops.push(MarkdownBlockOp::Delete(old[i].clone()));
        i += 1;
    }
    while j < m {
        ops.push(MarkdownBlockOp::Add(new[j].clone()));
        j += 1;
    }
    ops
}

fn diff_markdown_blocks_by_index(
    old: &[markdown_ast::MarkdownBlockSummary],
    new: &[markdown_ast::MarkdownBlockSummary],
) -> Vec<MarkdownBlockOp> {
    let mut ops = Vec::new();
    let max_len = old.len().max(new.len());
    for index in 0..max_len {
        match (old.get(index), new.get(index)) {
            (Some(old), Some(new)) if old.digest == new.digest => {
                ops.push(MarkdownBlockOp::Equal(old.clone(), new.clone()));
            }
            (Some(old), Some(new)) => {
                ops.push(MarkdownBlockOp::Delete(old.clone()));
                ops.push(MarkdownBlockOp::Add(new.clone()));
            }
            (Some(old), None) => ops.push(MarkdownBlockOp::Delete(old.clone())),
            (None, Some(new)) => ops.push(MarkdownBlockOp::Add(new.clone())),
            (None, None) => {}
        }
    }
    ops
}

fn coalesce_markdown_block_ops(ops: Vec<MarkdownBlockOp>) -> Vec<MarkdownDiffBlock> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < ops.len() {
        match &ops[index] {
            MarkdownBlockOp::Equal(old, new) => {
                out.push(MarkdownDiffBlock {
                    kind: "equal",
                    old: Some(old.clone()),
                    new: Some(new.clone()),
                });
                index += 1;
            }
            MarkdownBlockOp::Delete(_) => {
                let start = index;
                while index < ops.len() && matches!(ops[index], MarkdownBlockOp::Delete(_)) {
                    index += 1;
                }
                let delete_end = index;
                while index < ops.len() && matches!(ops[index], MarkdownBlockOp::Add(_)) {
                    index += 1;
                }
                let adds = ops[delete_end..index]
                    .iter()
                    .filter_map(|op| match op {
                        MarkdownBlockOp::Add(block) => Some(block.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let deletes = ops[start..delete_end]
                    .iter()
                    .filter_map(|op| match op {
                        MarkdownBlockOp::Delete(block) => Some(block.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let pair_count = deletes.len().min(adds.len());
                for pair_index in 0..pair_count {
                    out.push(MarkdownDiffBlock {
                        kind: "modified",
                        old: Some(deletes[pair_index].clone()),
                        new: Some(adds[pair_index].clone()),
                    });
                }
                for block in deletes.into_iter().skip(pair_count) {
                    out.push(MarkdownDiffBlock {
                        kind: "deleted",
                        old: Some(block),
                        new: None,
                    });
                }
                for block in adds.into_iter().skip(pair_count) {
                    out.push(MarkdownDiffBlock {
                        kind: "added",
                        old: None,
                        new: Some(block),
                    });
                }
            }
            MarkdownBlockOp::Add(new) => {
                out.push(MarkdownDiffBlock {
                    kind: "added",
                    old: None,
                    new: Some(new.clone()),
                });
                index += 1;
            }
        }
    }
    out
}

/// Text/code files above this size skip the (relatively expensive) syntax-
/// highlight preview and fall back to raw bytes (the browser shows plain text).
const MAX_TEXT_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// Request-body cap for `POST /api/preview`. The live editor preview never
/// needs the global 2 MB default; a smaller ceiling bounds the per-request
/// render cost (defense in depth behind the same-origin guard).
const PREVIEW_BODY_LIMIT: usize = 512 * 1024;

/// If `path` is a small UTF-8 text/code file, return its contents plus a
/// language hint (extension, or file name for extension-less files) for the
/// highlighted preview. Returns `None` for images, media, binaries and
/// oversized files — the caller serves those as raw bytes.
fn read_text_for_preview(path: &FsPath) -> Option<(String, String)> {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    if matches!(mime.type_().as_str(), "image" | "video" | "audio")
        || mime.essence_str() == "application/pdf"
    {
        return None;
    }
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_TEXT_PREVIEW_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // A NUL byte or invalid UTF-8 means it isn't text we can render.
    if bytes.contains(&0) {
        return None;
    }
    let content = String::from_utf8(bytes).ok()?;
    let token = path
        .extension()
        .and_then(|e| e.to_str())
        .filter(|s| !s.is_empty())
        .or_else(|| path.file_name().and_then(|n| n.to_str()))
        .unwrap_or_default()
        .to_string();
    Some((content, token))
}

/// Read-only, syntax-highlighted preview page for a non-markdown text/code file.
/// No collaboration chrome — just the file contents and line numbers.
fn render_file_view(
    path: &FsPath,
    content: String,
    token: String,
    workspace_id: &str,
    ws: &WorkspaceEntry,
    root: &FsPath,
    state: &AppState,
) -> Response {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // Back link: workspace root with this exact file highlighted; the directory
    // tree expands the parent folders from the hash path.
    let back_link = workspace_file_back_link(workspace_id, path, root);
    let rel_display = workspace_relative_path(path, root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| file_name.clone());

    // Strip one trailing newline so the highlighted <pre> and the line-number
    // gutter agree on the visual line count.
    let normalized = content.strip_suffix('\n').unwrap_or(content.as_str());
    let code_html = crate::markdown::highlight_source_file(&token, normalized);
    let line_count = normalized.split('\n').count().max(1);
    let gutter = (1..=line_count)
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join("\n");

    let mut context = base_context(state);
    context.insert("title", &format!("markon - {file_name}"));
    context.insert("workspace_id", workspace_id);
    insert_workspace_header_context(&mut context, ws, root);
    context.insert("version", env!("CARGO_PKG_VERSION"));
    context.insert("file_name", &file_name);
    context.insert("rel_display", &rel_display);
    context.insert("back_link", &back_link);
    context.insert("show_back_link", &!ws.is_ephemeral());
    context.insert("code_html", &code_html);
    context.insert("gutter", &gutter);
    context.insert("line_count", &line_count);

    render_template(state, "file-view.html", &context)
}

/// Async wrapper for [`render_markdown_file`]: the file read plus the markdown
/// render (syntect highlighting + server-side diagrams) run on the blocking pool
/// so a large document can't stall a tokio worker.
async fn render_markdown_file_async(
    file_path: String,
    workspace_id: String,
    ws: Arc<WorkspaceEntry>,
    root: PathBuf,
    state: AppState,
    is_local: bool,
) -> Response {
    tokio::task::spawn_blocking(move || {
        render_markdown_file(&file_path, &workspace_id, &ws, &root, &state, is_local)
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!("render_markdown_file join error: {e}");
        (StatusCode::INTERNAL_SERVER_ERROR, "render task failed").into_response()
    })
}

/// Async wrapper for the non-markdown preview path: the text sniff/read
/// ([`read_text_for_preview`]) and, when the file is text, the syntect-
/// highlighted [`render_file_view`] both run on the blocking pool. Returns
/// `None` when the file is not previewable text, so the caller falls back to
/// `serve_file`.
async fn render_preview_or_none(
    canonical: PathBuf,
    workspace_id: String,
    ws: Arc<WorkspaceEntry>,
    root: PathBuf,
    state: AppState,
) -> Option<Response> {
    tokio::task::spawn_blocking(move || {
        let (content, token) = read_text_for_preview(&canonical)?;
        Some(render_file_view(
            &canonical,
            content,
            token,
            &workspace_id,
            &ws,
            &root,
            &state,
        ))
    })
    .await
    .unwrap_or_else(|e| {
        tracing::error!("render_file_view join error: {e}");
        Some((StatusCode::INTERNAL_SERVER_ERROR, "preview task failed").into_response())
    })
}

fn render_markdown_file(
    file_path: &str,
    workspace_id: &str,
    ws: &WorkspaceEntry,
    root: &FsPath,
    state: &AppState,
    can_manage: bool,
) -> Response {
    match fs::read_to_string(file_path) {
        Ok(markdown_input) => {
            let renderer = default_markdown_engine(&state.theme).with_asset_context(
                workspace_id,
                file_path,
                root,
            );
            let rendered = MarkdownEngine::render(&renderer, &markdown_input);

            let title = std::path::Path::new(file_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| file_path.to_string());

            let mut context = base_context(state);
            context.insert("title", &title);
            context.insert("file_path", file_path);
            context.insert("workspace_id", workspace_id);
            insert_workspace_header_context(&mut context, ws, root);
            context.insert("version", env!("CARGO_PKG_VERSION"));
            context.insert("content", &rendered.html);
            context.insert("history_url", &workspace_git_history_url(workspace_id));
            // Back link: the workspace root with this exact file highlighted;
            // the directory tree expands the parent folders from the hash path.
            // Suppressed for single-file workspaces — `/{id}/` 303-redirects
            // back to this same file (see `handle_workspace_root`), so a
            // "Back" link would be a no-op trap.
            let back_link =
                workspace_file_back_link(workspace_id, std::path::Path::new(file_path), root);
            context.insert("back_link", &back_link);
            context.insert("show_back_link", &!ws.is_ephemeral());
            context.insert("has_mermaid", &rendered.has_mermaid);
            context.insert("has_math", &rendered.has_math);
            context.insert("toc", &rendered.toc);
            context.insert("markdown_diagnostics", &rendered.diagnostics);
            context.insert("referenced_assets", &rendered.referenced_assets);
            let flags = ws.flags();
            context.insert("shared_annotation", &flags.shared_annotation);
            context.insert("enable_viewed", &flags.enable_viewed);
            context.insert("enable_search", &flags.enable_search);
            context.insert("can_manage", &can_manage);
            // Edit/chat are collaboration abilities gated by their flags.
            // Structural writes require an explicit administrator session.
            context.insert("enable_edit", &flags.enable_edit);
            context.insert("enable_live", &flags.enable_live);
            context.insert("enable_chat", &flags.enable_chat);

            if flags.enable_edit {
                // JSON-encode and HTML-escape so </script> in content can't break the page.
                let json = js_json_safe(serde_json::to_string(&markdown_input).unwrap_or_default());
                context.insert("markdown_content_json", &json);
                // Embed a token derived for this workspace, NOT the process
                // secret or master management token. A collaborator cannot
                // replay it against a differently gated workspace.
                context.insert(
                    "save_token",
                    &workspace_save_token(&state.save_token, workspace_id),
                );
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
            context.insert("has_math", &false);

            render_template(state, "layout.html", &context)
        }
    }
}

/// One row of a directory listing. Shared between the server-rendered file table
/// (`render_directory_listing`) and the JSON endpoint that feeds the inline tree
/// (`handle_workspace_dir_data`), so both stay byte-for-byte consistent in what
/// they list, how they sort, and the commit metadata they attach.
#[derive(serde::Serialize)]
struct DirListingEntry {
    name: String,
    is_dir: bool,
    is_markdown: bool,
    is_hidden: bool,
    show_in_markdown: bool,
    link: String,
    rel_git_path: String,
    last_commit_subject: Option<String>,
    last_commit_time: Option<String>,
}

/// List the direct children of `current_dir` (already canonicalized and verified
/// inside `root`), sorted directories-first then by name, with the last-commit
/// subject/time attached per entry when the workspace is a git repo. Only this
/// one directory level is walked and only these paths are queried for commits —
/// cheap enough to serve on demand as a folder is expanded.
fn collect_directory_entries(
    workspace_id: &str,
    root: &FsPath,
    current_dir: &FsPath,
) -> std::io::Result<Vec<DirListingEntry>> {
    let mut entries: Vec<DirListingEntry> = fs::read_dir(current_dir)?
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_hidden = name.starts_with('.');
            // Use file_type() — avoids stat() syscall that can block on AutoFS mount points.
            let file_type = entry.file_type().ok()?;
            let is_dir = file_type.is_dir();
            let is_markdown = !is_dir && is_markdown_path(&path);
            let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            let rel_git_path = rel.to_string_lossy().replace('\\', "/");
            let rel_url = path_to_route(&rel);
            let link = if is_dir {
                workspace_file_url(workspace_id, &format!("{rel_url}/"))
            } else {
                workspace_file_url(workspace_id, &rel_url)
            };
            Some(DirListingEntry {
                name,
                is_dir,
                is_markdown,
                is_hidden,
                show_in_markdown: !is_hidden && is_markdown,
                link,
                rel_git_path,
                last_commit_subject: None,
                last_commit_time: None,
            })
        })
        .collect();

    if entries.iter().any(|entry| entry.is_dir && !entry.is_hidden) {
        let dirs_with_markdown = direct_child_dirs_with_markdown_descendants(root, current_dir);
        for entry in entries.iter_mut().filter(|entry| entry.is_dir) {
            entry.show_in_markdown =
                !entry.is_hidden && dirs_with_markdown.contains(&entry.rel_git_path);
        }
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    let git_status = git::status(root);
    if git_status.available {
        let rel_paths: Vec<String> = entries
            .iter()
            .map(|entry| entry.rel_git_path.clone())
            .collect();
        if let Ok(path_commits) = git::last_commits_for_paths(root, &rel_paths) {
            for entry in entries.iter_mut() {
                let Some(commit) = path_commits.get(&entry.rel_git_path) else {
                    continue;
                };
                entry.last_commit_subject = Some(commit.subject.clone());
                entry.last_commit_time = Some(commit.time.clone());
            }
        }
    }

    Ok(entries)
}

fn direct_child_dirs_with_markdown_descendants(
    root: &FsPath,
    current_dir: &FsPath,
) -> HashSet<String> {
    let mut dirs = HashSet::new();
    let walker = crate::fswalk::default_walker(current_dir).build();
    for entry in walker.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path == current_dir || !path.is_file() || !is_markdown_path(path) {
            continue;
        }
        let Ok(rel_to_current) = path.strip_prefix(current_dir) else {
            continue;
        };
        let Some(std::path::Component::Normal(first_component)) =
            rel_to_current.components().next()
        else {
            continue;
        };
        let direct_child = current_dir.join(first_component);
        if direct_child == path {
            continue;
        }
        let rel_to_root = direct_child.strip_prefix(root).unwrap_or(&direct_child);
        dirs.insert(path_to_route(rel_to_root));
    }
    dirs
}

/// JSON: the direct children of a directory (relative to the workspace root),
/// used by the inline directory tree on the workspace landing page. Mirrors the
/// auth/boundary handling of `handle_workspace_files_data`: canonicalize the
/// requested path and reject anything that escapes the workspace root.
async fn handle_workspace_dir_data(
    State(state): State<AppState>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<DirListingQuery>,
) -> impl IntoResponse {
    let Some(ws) = state.workspace_registry.get(&workspace_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if ws.is_ephemeral() {
        let rel = query.path.as_deref().unwrap_or("").trim().trim_matches('/');
        if rel.split('/').any(|part| part == ".." || part == ".") {
            return StatusCode::NOT_FOUND.into_response();
        }
        return Json(scoped_directory_entries(&workspace_id, &ws, rel)).into_response();
    }
    let root = canonical_workspace_root(&ws);
    let rel = query.path.as_deref().unwrap_or("").trim().trim_matches('/');
    let target = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel)
    };
    let current_dir = match canonicalize_route_path(&target) {
        Ok(p) => p,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if !current_dir.starts_with(&root) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match collect_directory_entries(&workspace_id, &root, &current_dir) {
        Ok(entries) => Json(entries).into_response(),
        Err(_) => Json(Vec::<DirListingEntry>::new()).into_response(),
    }
}

/// Build a virtual directory view from the single-file capability set without
/// touching or enumerating sibling filesystem entries.
fn scoped_directory_entries(
    workspace_id: &str,
    ws: &WorkspaceEntry,
    directory: &str,
) -> Vec<DirListingEntry> {
    let prefix = directory.trim_matches('/');
    let mut entries: HashMap<String, DirListingEntry> = HashMap::new();
    for (rel, path) in ws.fs.served_files(2000) {
        let route = rel.as_route();
        let rest = if prefix.is_empty() {
            route.as_str()
        } else if let Some(rest) = route.strip_prefix(prefix).and_then(|r| r.strip_prefix('/')) {
            rest
        } else {
            continue;
        };
        let (name, is_dir) = match rest.split_once('/') {
            Some((name, _)) => (name, true),
            None => (rest, false),
        };
        if name.is_empty() {
            continue;
        }
        let child_route = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        let link_route = if is_dir {
            format!("{child_route}/")
        } else {
            child_route.clone()
        };
        let markdown_descendant = is_markdown_path(&path);
        let entry = entries
            .entry(name.to_string())
            .or_insert_with(|| DirListingEntry {
                name: name.to_string(),
                is_dir,
                is_markdown: !is_dir && markdown_descendant,
                is_hidden: name.starts_with('.'),
                show_in_markdown: !name.starts_with('.') && markdown_descendant,
                link: workspace_file_url(workspace_id, &link_route),
                rel_git_path: child_route,
                last_commit_subject: None,
                last_commit_time: None,
            });
        entry.show_in_markdown |= !entry.is_hidden && markdown_descendant;
    }
    let mut entries: Vec<_> = entries.into_values().collect();
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    entries
}

#[derive(Deserialize)]
struct DirListingQuery {
    path: Option<String>,
}

fn render_directory_listing(
    workspace_id: &str,
    ws: &WorkspaceEntry,
    root: &FsPath,
    dir_param: Option<&str>,
    state: &AppState,
    can_manage: bool,
) -> Response {
    let Some(workspace_root) = ws.fs.directory_root() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let current_dir = if let Some(dir_str) = dir_param {
        let p = PathBuf::from(dir_str);
        if p.is_absolute() {
            p
        } else {
            workspace_root.join(&p)
        }
    } else {
        workspace_root.to_path_buf()
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

    let entries = match collect_directory_entries(workspace_id, root, &current_dir) {
        Ok(entries) => entries,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Error reading directory: {e}"),
            )
                .into_response()
        }
    };
    let git_status = git::status(root);

    let show_parent = current_dir != root;
    let parent_link: Option<String> = if show_parent {
        current_dir.parent().map(|parent| {
            let rel = parent
                .strip_prefix(root)
                .map(path_to_route)
                .unwrap_or_default();
            if rel.is_empty() {
                workspace_root_url(workspace_id)
            } else {
                workspace_file_url(workspace_id, &format!("{rel}/"))
            }
        })
    } else {
        None
    };

    // Breadcrumb from workspace root down to `current_dir`. The first segment is
    // the workspace itself (alias, falling back to the root dir name) linking to
    // the workspace root; each deeper segment links to its own subdirectory. The
    // final segment is the current directory and carries no link. At the root the
    // breadcrumb is a single (current) segment. Path components are joined with
    // `/` so Windows separators normalise like `path_to_route`.
    #[derive(serde::Serialize)]
    struct BreadcrumbSegment {
        name: String,
        link: String,
        is_current: bool,
    }
    let workspace_display_name = workspace_display_name(ws, root);
    let rel_components: Vec<String> = current_dir
        .strip_prefix(root)
        .ok()
        .map(|rel| {
            rel.components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut breadcrumb: Vec<BreadcrumbSegment> = Vec::new();
    let depth = rel_components.len();
    breadcrumb.push(BreadcrumbSegment {
        name: workspace_display_name,
        link: workspace_root_url(workspace_id),
        is_current: depth == 0,
    });
    let mut acc = String::new();
    for (i, comp) in rel_components.iter().enumerate() {
        if acc.is_empty() {
            acc = comp.clone();
        } else {
            acc = format!("{acc}/{comp}");
        }
        breadcrumb.push(BreadcrumbSegment {
            name: comp.clone(),
            link: workspace_file_url(workspace_id, &format!("{acc}/")),
            is_current: i + 1 == depth,
        });
    }

    let flags = ws.flags();
    let feature_statuses = vec![
        WorkspaceFeatureStatus {
            key: "enable_search",
            label: "Search",
            label_key: "web.ws.feature.search",
            enabled: flags.enable_search,
        },
        WorkspaceFeatureStatus {
            key: "enable_viewed",
            label: "Viewed tracking",
            label_key: "web.ws.feature.viewed",
            enabled: flags.enable_viewed,
        },
        WorkspaceFeatureStatus {
            key: "enable_edit",
            label: "Edit",
            label_key: "web.ws.feature.edit",
            enabled: flags.enable_edit,
        },
        WorkspaceFeatureStatus {
            key: "enable_live",
            label: "Live",
            label_key: "web.ws.feature.live",
            enabled: flags.enable_live,
        },
        WorkspaceFeatureStatus {
            key: "enable_chat",
            label: "AI Chat",
            label_key: "web.ws.feature.chat",
            enabled: flags.enable_chat,
        },
        WorkspaceFeatureStatus {
            key: "shared_annotation",
            label: "Shared notes",
            label_key: "web.ws.feature.shared",
            enabled: flags.shared_annotation,
        },
    ];
    let git_commits = if git_status.available {
        git::history(root, 6).unwrap_or_default()
    } else {
        Vec::new()
    };
    let git_commit_count = if git_status.available {
        git::commit_count(root).unwrap_or(0)
    } else {
        0
    };
    // Detailed branches (adds `is_default`) so the switch-branch panel can flag
    // the default branch; still carries `name`/`current` for checkout.
    let git_branches = if git_status.available {
        git::branches_detailed(root).unwrap_or_default()
    } else {
        Vec::new()
    };
    let git_branch_count = if git_status.available {
        git_branches.len()
    } else {
        0
    };
    let git_tag_count = if git_status.available {
        git::tag_count(root).unwrap_or(0)
    } else {
        0
    };
    let git_changed_count = git_status.added
        + git_status.modified
        + git_status.deleted
        + git_status.renamed
        + git_status.untracked;
    let work_diff_has_markdown_changes = git_status.available
        && git::diff_has_markdown_changes(root, "HEAD", "worktree").unwrap_or(false);
    let work_diff_url =
        work_diff_has_markdown_changes.then(|| markdown_work_diff_page_url(workspace_id));
    let latest_commit = git_commits.first().cloned();
    let latest_commit_diff_url = latest_commit
        .as_ref()
        .and_then(|commit| git_commit_markdown_diff_url(root, workspace_id, commit, "rendered"));
    let is_workspace_root = current_dir == root;
    let can_add_file = can_manage && flags.enable_edit;

    let mut context = base_context(state);
    context.insert("workspace_id", workspace_id);
    context.insert("workspace_alias", &ws.alias());
    context.insert(
        "workspace_name",
        &root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    context.insert("can_manage", &can_manage);
    context.insert("current_dir", &current_dir.display().to_string());
    context.insert("history_url", &workspace_git_history_url(workspace_id));
    context.insert("work_diff_url", &work_diff_url);
    context.insert("latest_commit", &latest_commit);
    context.insert("latest_commit_diff_url", &latest_commit_diff_url);
    context.insert("git_changed_count", &git_changed_count);
    context.insert("git_commit_count", &git_commit_count);
    context.insert("git_branch_count", &git_branch_count);
    context.insert("git_tag_count", &git_tag_count);
    context.insert("git_branches", &git_branches);
    context.insert("git_commits", &git_commits);
    context.insert("feature_statuses", &feature_statuses);
    context.insert("git", &git_status);
    context.insert("is_workspace_root", &is_workspace_root);
    context.insert("can_add_file", &can_add_file);
    context.insert("version", env!("CARGO_PKG_VERSION"));
    context.insert("branches_url", &workspace_git_branches_url(workspace_id));
    context.insert("tags_url", &workspace_git_tags_url(workspace_id));
    context.insert("checkout_url", &workspace_git_checkout_url(workspace_id));
    context.insert("files_data_url", &workspace_files_data_url(workspace_id));
    context.insert("files_dir_url", &workspace_files_dir_url(workspace_id));
    context.insert(
        "settings_features_url",
        &workspace_settings_features_url(workspace_id),
    );
    context.insert("create_file_url", &workspace_file_create_url(workspace_id));
    context.insert(
        "create_folder_url",
        &workspace_folder_create_url(workspace_id),
    );
    context.insert("entries", &entries);
    context.insert("show_parent", &show_parent);
    context.insert("parent_link", &parent_link);
    context.insert("breadcrumb", &breadcrumb);
    context.insert("enable_search", &flags.enable_search);
    context.insert("enable_live", &flags.enable_live);
    context.insert("enable_chat", &flags.enable_chat);

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
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    serve_static_file(&path, JsAssets::get, &content_type)
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

/// Serve a raw (non-markdown) workspace file. Delegates to `tower_http`'s
/// `ServeFile`, which streams the body from async I/O instead of reading the
/// whole file into memory, and honors `Range` (206) / conditional requests. The
/// caller's relevant request headers are forwarded so those features work;
/// `ServeFile` serves the fixed `path` regardless of the request URI. `path`
/// is already canonicalized and confinement-checked by the caller.
async fn serve_file(path: &std::path::Path, req_headers: &axum::http::HeaderMap) -> Response {
    use tower::ServiceExt;
    let mut req = axum::http::Request::new(axum::body::Body::empty());
    for name in [
        header::RANGE,
        header::IF_RANGE,
        header::IF_MODIFIED_SINCE,
        header::IF_NONE_MATCH,
        header::ACCEPT_ENCODING,
    ] {
        if let Some(value) = req_headers.get(&name) {
            req.headers_mut().insert(name, value.clone());
        }
    }
    match tower_http::services::ServeFile::new(path)
        .oneshot(req)
        .await
    {
        Ok(resp) => resp.map(axum::body::Body::new).into_response(),
        // ServeFile's error type is `Infallible`; it reports IO problems as an
        // error status in the response body, so this arm is effectively dead.
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Error reading file").into_response(),
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

/// Write `content` to `target` atomically: create a uniquely-named temp file in
/// the SAME directory, write + flush it, then `rename` it over the target. A
/// crash mid-write can therefore never leave a truncated document — either the
/// old file or the fully-written new file is visible. The temp file is removed
/// on any error. The unique name is derived from the process id plus a static
/// counter to avoid collisions between concurrent saves.
fn atomic_write(target: &FsPath, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = target.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "target has no parent directory",
        )
    })?;
    let base = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!(".{base}.{}.{n}.tmp", std::process::id()));

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    // The temp file now exists and is exclusively ours, so any later failure is
    // safe to clean up.
    if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    drop(file);
    // Preserve the destination's existing permission bits: `rename` swaps in the
    // fresh temp inode, which would otherwise reset an already-existing file's
    // mode to the umask default. Best-effort and Unix-only; the crash-safety of
    // the write does not depend on it succeeding.
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(&tmp_path, meta.permissions());
    }
    match std::fs::rename(&tmp_path, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

async fn save_file_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<SaveFileRequest>,
) -> impl IntoResponse {
    let supplied_token = headers
        .get("X-Markon-Token")
        .and_then(|value| value.to_str().ok());
    let scoped_token = workspace_save_token(&state.save_token, &payload.workspace_id);
    let token_valid = supplied_token.is_some_and(|token| {
        ct_eq(token.as_bytes(), scoped_token.as_bytes())
            || ct_eq(token.as_bytes(), state.management_token.as_bytes())
    });
    if !token_valid {
        return StatusCode::UNAUTHORIZED.into_response();
    }

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

    // Authorization is enforced by the origin middleware, the workspace-bound
    // token above, and the per-workspace edit flag below.
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
    let canonical = match ws.fs.resolve_editable_input(decoded_path) {
        Ok(path) => path,
        Err(
            crate::workspace_fs::WorkspaceFsError::InvalidPath
            | crate::workspace_fs::WorkspaceFsError::Denied,
        ) => {
            return Json(SaveFileResponse {
                success: false,
                message: "Access denied".into(),
            })
            .into_response()
        }
        Err(
            crate::workspace_fs::WorkspaceFsError::NotFound
            | crate::workspace_fs::WorkspaceFsError::Io(_),
        ) => {
            return Json(SaveFileResponse {
                success: false,
                message: format!("File not found: {decoded}"),
            })
            .into_response()
        }
    };

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
    // Perform the atomic write on the blocking pool so file I/O (open, write,
    // fsync, rename) does not stall a tokio worker thread.
    let content = payload.content;
    let write_result =
        tokio::task::spawn_blocking(move || atomic_write(&canonical, content.as_bytes())).await;
    match write_result {
        Ok(Ok(())) => Json(SaveFileResponse {
            success: true,
            message: "File saved successfully".into(),
        })
        .into_response(),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::PermissionDenied => Json(SaveFileResponse {
            success: false,
            message: "File is read-only".into(),
        })
        .into_response(),
        Ok(Err(e)) => Json(SaveFileResponse {
            success: false,
            message: format!("Failed to save: {e}"),
        })
        .into_response(),
        Err(e) => {
            tracing::error!("save_file_handler blocking task join error: {e}");
            Json(SaveFileResponse {
                success: false,
                message: "Failed to save: internal error".into(),
            })
            .into_response()
        }
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
    has_math: bool,
}

async fn preview_handler(
    State(state): State<AppState>,
    Json(payload): Json<PreviewRequest>,
) -> impl IntoResponse {
    // Markdown rendering (syntect highlight + AST walk) is CPU-bound; run it on
    // the blocking pool so a large document can't stall a runtime worker.
    let theme = state.theme.clone();
    let content = payload.content;
    let rendered =
        match tokio::task::spawn_blocking(move || {
            let renderer = default_markdown_engine(&theme);
            MarkdownEngine::render(&renderer, &content)
        })
        .await
        {
            Ok(rendered) => rendered,
            Err(e) => {
                tracing::error!(error = %e, "preview render task failed");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
    Json(PreviewResponse {
        html: rendered.html,
        has_mermaid: rendered.has_mermaid,
        has_math: rendered.has_math,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use serde_json::json;

    use axum::http::HeaderMap;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use tower::ServiceExt;

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
            workspace_registry: registry,
            management_token: Arc::new("test-token".into()),
            admin_bootstraps: Arc::new(AdminBootstrapStore::new()),
            allowed_hosts: Arc::new(build_allowed_hosts("127.0.0.1", "", 6419, &[], &[])),
            save_token: Arc::new("save-token".into()),
            i18n_json: Arc::new(i18n::load_i18n()),
            i18n_lang: Arc::new("en".into()),
            shortcuts_json: Arc::new("null".into()),
            styles_css: Arc::new("".into()),
            default_chat_mode: Arc::new("in_page".into()),
            editor_theme: Arc::new("follow".into()),
            collaborator_access_code_hash: Arc::new(String::new()),
            access_secret: Arc::new("test-salt".into()),
            access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            markdown_diff_cache: Arc::new(Mutex::new(MarkdownDiffCache::default())),
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
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        })
    }

    async fn spawn_collaboration_test_server(
        state: AppState,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route(WORKSPACE_WS_ROUTE, get(ws_handler))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_access_code,
            ))
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        (addr, task)
    }

    fn collaborator_access_scope_for(state: &AppState, id: &str) -> Option<(String, String)> {
        access_requirements_for(state, id)
            .into_iter()
            .find(|req| req.role == AccessRole::Collaborator)
            .map(|req| (req.hash, req.scope))
    }

    /// Repro for the reported "only the global code lets me into a workspace
    /// that has its own code": the workspace collaborator code must override the
    /// global one both live AND after a restart reseed (same id, code preserved).
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
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });
        assert!(reg.set_collaborator_access_code(&id, &ws_hash));

        let mut state = test_state(reg.clone());
        state.collaborator_access_code_hash = Arc::new(global_hash.clone());
        let (h, scope) = collaborator_access_scope_for(&state, &id).expect("workspace is gated");
        assert_eq!(
            scope,
            format!("w:{id}:collaborator"),
            "must use the workspace scope"
        );
        assert_eq!(h, ws_hash, "live: workspace code must win over global");

        // Simulate a server restart: fresh registry reseeded from the persisted
        // (path, collaborator_access_code_hash) must yield the SAME id and keep
        // the code.
        let reg2 = Arc::new(WorkspaceRegistry::new(salt.into()));
        let id2 = reg2.add(WorkspaceConfig {
            path: root,
            flags: WorkspaceFlags::default(),
            single_file: None,
            collaborator_access_code_hash: ws_hash.clone(),
            ..Default::default()
        });
        assert_eq!(id, id2, "workspace id must be stable across reseed");
        assert_eq!(
            reg2.get(&id2).unwrap().collaborator_access_code_hash(),
            ws_hash,
            "code must survive the reseed"
        );
        let mut state2 = test_state(reg2);
        state2.collaborator_access_code_hash = Arc::new(global_hash);
        let (h2, scope2) =
            collaborator_access_scope_for(&state2, &id2).expect("gated after reseed");
        assert_eq!(scope2, format!("w:{id2}:collaborator"));
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
        let cookie = make_access_cookie(secret, &scopes, access_now_unix() + 1000, false);
        let back = access_cookie_scopes(secret, Some(&cookie));
        assert!(
            back.contains(&("w:1a2b3c4d".to_string(), "4f965".to_string())),
            "workspace scope must survive the cookie round-trip: {back:?}"
        );
        assert!(back.contains(&("s".to_string(), "abcde".to_string())));
    }

    #[test]
    fn access_cookie_resolves_collaborator_role() {
        let tmp = tempfile::tempdir().unwrap();
        let salt = "test-salt";
        let collaborator_hash = crate::workspace::hash_access_code(salt, "guest-code");
        let reg = Arc::new(WorkspaceRegistry::new(salt.into()));
        let id = reg.add(WorkspaceConfig {
            path: dunce::canonicalize(tmp.path()).unwrap(),
            flags: WorkspaceFlags::default(),
            single_file: None,
            collaborator_access_code_hash: collaborator_hash.clone(),
            ..Default::default()
        });
        let state = test_state(reg);

        let collaborator_cookie = make_access_cookie(
            salt,
            &[(format!("w:{id}:collaborator"), collaborator_hash)],
            access_now_unix() + 100,
            false,
        );
        assert_eq!(
            access_role_from_cookie(&state, &id, Some(&collaborator_cookie)),
            Some(AccessRole::Collaborator)
        );
    }

    async fn response_text(response: Response) -> String {
        let bytes = response_bytes(response).await;
        String::from_utf8(bytes.to_vec()).expect("utf-8 response")
    }

    async fn response_bytes(response: Response) -> axum::body::Bytes {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body")
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

    fn save_headers(state: &AppState, workspace_id: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "X-Markon-Token",
            workspace_save_token(&state.save_token, workspace_id)
                .parse()
                .unwrap(),
        );
        headers
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
    fn save_origin_allows_lan_same_origin_but_not_missing_or_cross_origin() {
        let same_origin = headers_with(
            Some("http://192.168.1.13:59285"),
            Some("192.168.1.13:59285"),
        );
        assert!(same_origin_or_loopback_no_origin(&same_origin, &lan_peer()));

        let cross_origin =
            headers_with(Some("http://evil.example.com"), Some("192.168.1.13:59285"));
        assert!(!same_origin_or_loopback_no_origin(
            &cross_origin,
            &lan_peer()
        ));

        let missing_origin = headers_with(None, Some("192.168.1.13:59285"));
        assert!(!same_origin_or_loopback_no_origin(
            &missing_origin,
            &lan_peer()
        ));
        assert!(same_origin_or_loopback_no_origin(
            &missing_origin,
            &loopback()
        ));
    }

    #[test]
    fn ws_origin_case_insensitive_host_match() {
        let h = headers_with(
            Some("http://Example.Local:1618"),
            Some("example.local:1618"),
        );
        assert!(check_ws_origin(&h, &loopback()));
    }

    #[tokio::test]
    async fn preview_route_is_guarded_same_origin() {
        use axum::body::Body;
        use axum::http::Request;

        let registry = Arc::new(WorkspaceRegistry::new("preview-guard-test".into()));
        let state = test_state(registry);
        let app = Router::new()
            .route("/api/preview", post(preview_handler))
            .layer(axum::extract::DefaultBodyLimit::max(PREVIEW_BODY_LIMIT))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_local_save_origin,
            ))
            .with_state(state);

        let body = json!({ "content": "# hi" }).to_string();
        let build = |origin: Option<&str>, host: &str, peer: SocketAddr| {
            let mut b = Request::builder()
                .method("POST")
                .uri("/api/preview")
                .header("host", host)
                .header("content-type", "application/json");
            if let Some(o) = origin {
                b = b.header("origin", o);
            }
            let mut req = b.body(Body::from(body.clone())).unwrap();
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(peer));
            req
        };

        // Cross-site page from the LAN → rejected.
        let resp = app
            .clone()
            .oneshot(build(
                Some("http://evil.example.com"),
                "192.168.1.13:6419",
                lan_peer(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Anonymous LAN device (no Origin, not loopback) → rejected. This is the
        // curl-style abuse the fix closes.
        let resp = app
            .clone()
            .oneshot(build(None, "192.168.1.13:6419", lan_peer()))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Same-origin editor page → allowed.
        let resp = app
            .clone()
            .oneshot(build(
                Some("http://127.0.0.1:6419"),
                "127.0.0.1:6419",
                loopback(),
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[test]
    fn ws_origin_with_trailing_path_still_matches_authority() {
        // Defensive: spec says Origin has no path, but some clients append one.
        let h = headers_with(Some("http://127.0.0.1:1618/"), Some("127.0.0.1:1618"));
        assert!(check_ws_origin(&h, &loopback()));
    }

    #[test]
    fn ws_hello_requires_structured_non_legacy_protocol() {
        let hello: WsHello = serde_json::from_str(
            r#"{"type":"hello","target":{"kind":"surface","key":"/abcd1234/"}}"#,
        )
        .unwrap();
        assert!(matches!(hello.target, WsTarget::Surface { .. }));
        assert!(serde_json::from_str::<WsHello>(r#""/tmp/workspace/doc.md""#).is_err());
        assert!(serde_json::from_str::<WsHello>(
            r#"{"type":"legacy","target":{"kind":"surface","key":"/abcd1234/"}}"#
        )
        .is_err());
    }

    #[test]
    fn ws_document_target_is_canonical_and_workspace_scoped() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let document = root.path().join("note.md");
        let outside_file = outside.path().join("secret.md");
        fs::write(&document, "# note").unwrap();
        fs::write(&outside_file, "secret").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("ws-document-scope".into()));
        let id = add_test_workspace(&registry, root.path().to_path_buf(), all_flags());
        let entry = registry.get(&id).unwrap();
        let session = authorize_ws_target(
            &entry,
            WsTarget::Document {
                path: document.to_string_lossy().into_owned(),
            },
        )
        .expect("workspace document should be authorized");
        let canonical = dunce::canonicalize(&document)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            session.target,
            WsSessionTarget::Document {
                file_path: canonical.clone()
            }
        );
        assert_eq!(session.channel, format!("document:{canonical}"));

        assert!(authorize_ws_target(
            &entry,
            WsTarget::Document {
                path: outside_file.to_string_lossy().into_owned(),
            }
        )
        .is_none());
        assert!(authorize_ws_target(
            &entry,
            WsTarget::Document {
                path: "note.md".into(),
            }
        )
        .is_none());
    }

    #[test]
    fn ws_document_target_obeys_single_file_capability() {
        let root = tempfile::tempdir().unwrap();
        let pinned = root.path().join("pinned.md");
        let sibling = root.path().join("sibling.md");
        fs::write(&pinned, "# pinned").unwrap();
        fs::write(&sibling, "# sibling").unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-single-file".into()));
        let id = registry.add(WorkspaceConfig {
            path: dunce::canonicalize(root.path()).unwrap(),
            flags: all_flags(),
            single_file: Some("pinned.md".into()),
            collaborator_access_code_hash: String::new(),
            alias: String::new(),
        });
        let entry = registry.get(&id).unwrap();

        assert!(authorize_ws_target(
            &entry,
            WsTarget::Document {
                path: pinned.to_string_lossy().into_owned(),
            }
        )
        .is_some());
        assert!(authorize_ws_target(
            &entry,
            WsTarget::Document {
                path: sibling.to_string_lossy().into_owned(),
            }
        )
        .is_none());
    }

    #[test]
    fn ws_surface_target_is_live_only_and_bound_to_workspace_url() {
        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-surface".into()));
        let id = add_test_workspace(&registry, root.path().to_path_buf(), all_flags());
        let entry = registry.get(&id).unwrap();
        let surface = authorize_ws_target(
            &entry,
            WsTarget::Surface {
                key: format!("/_/{id}/compare?base=main#change"),
            },
        )
        .unwrap();
        assert_eq!(
            surface.channel,
            format!("surface:/_/{id}/compare?base=main")
        );
        assert!(authorize_ws_target(
            &entry,
            WsTarget::Surface {
                key: "/_/deadbeef/compare".into(),
            }
        )
        .is_none());

        registry.update_flags(
            &id,
            WorkspaceFlags {
                shared_annotation: true,
                enable_live: false,
                ..Default::default()
            },
        );
        assert!(authorize_ws_target(
            &entry,
            WsTarget::Surface {
                key: format!("/{id}/"),
            }
        )
        .is_none());
    }

    #[test]
    fn workspace_event_filter_prevents_cross_channel_delivery() {
        let event = WorkspaceEvent::Channel {
            channel: "document:/workspace/a.md".into(),
            payload: "a".into(),
        };
        assert_eq!(
            workspace_event_payload(event.clone(), "document:/workspace/a.md").as_deref(),
            Some("a")
        );
        assert!(workspace_event_payload(event, "document:/workspace/b.md").is_none());
        assert_eq!(
            workspace_event_payload(
                WorkspaceEvent::Workspace {
                    payload: "reload".into()
                },
                "surface:/abcd1234/"
            )
            .as_deref(),
            Some("reload")
        );
    }

    #[tokio::test]
    async fn ws_server_enforces_live_and_annotation_capabilities() {
        let root = tempfile::tempdir().unwrap();
        let document = root.path().join("note.md");
        fs::write(&document, "# note").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("ws-feature-gates".into()));
        let id = add_test_workspace(
            &registry,
            root.path().to_path_buf(),
            WorkspaceFlags {
                shared_annotation: true,
                enable_live: false,
                ..Default::default()
            },
        );
        let entry = registry.get(&id).unwrap();
        let session = Arc::new(
            authorize_ws_target(
                &entry,
                WsTarget::Document {
                    path: document.to_string_lossy().into_owned(),
                },
            )
            .unwrap(),
        );
        let mut rx = entry.events_tx.subscribe();
        handle_client_msg(
            None,
            entry.clone(),
            session,
            WebSocketMessage::LiveAction { data: json!({}) },
        )
        .await;
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        registry.update_flags(
            &id,
            WorkspaceFlags {
                shared_annotation: false,
                enable_live: true,
                ..Default::default()
            },
        );
        let surface = Arc::new(
            authorize_ws_target(
                &entry,
                WsTarget::Surface {
                    key: format!("/{id}/"),
                },
            )
            .unwrap(),
        );
        handle_client_msg(
            None,
            entry,
            surface,
            WebSocketMessage::NewAnnotation {
                annotation: json!({ "id": "forbidden" }),
                op_id: None,
            },
        )
        .await;
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
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

        let file = WebSocketMessage::FileChanged {
            workspace_id: "ws1".into(),
            path: "docs/a.md".into(),
        };
        let serialized = serde_json::to_string(&file).unwrap();
        assert!(serialized.contains("\"type\":\"file_changed\""));
        assert!(serialized.contains("\"workspace_id\":\"ws1\""));
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
            workspace_registry: registry,
            management_token: Arc::new("token".into()),
            admin_bootstraps: Arc::new(AdminBootstrapStore::new()),
            allowed_hosts: Arc::new(build_allowed_hosts("127.0.0.1", "", 6419, &[], &[])),
            save_token: Arc::new("save-token".into()),
            i18n_json: Arc::new("{}".into()),
            i18n_lang: Arc::new("zh".into()),
            shortcuts_json: Arc::new("{}".into()),
            styles_css: Arc::new("".into()),
            default_chat_mode: Arc::new("in_page".into()),
            editor_theme: Arc::new("follow".into()),
            collaborator_access_code_hash: Arc::new(String::new()),
            access_secret: Arc::new("test-salt".into()),
            access_attempts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            markdown_diff_cache: Arc::new(Mutex::new(MarkdownDiffCache::default())),
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
                address: "::1".into(),
                kind: BindHostKind::Localhost,
                interface: None,
            },
            BindHostOption {
                address: "0.0.0.0".into(),
                kind: BindHostKind::AllInterfaces,
                interface: None,
            },
            BindHostOption {
                address: "::".into(),
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
            BindHostOption {
                address: "fd00::20".into(),
                kind: BindHostKind::Interface,
                interface: Some("en0".into()),
            },
            BindHostOption {
                address: "2001:db8::5".into(),
                kind: BindHostKind::Interface,
                interface: Some("utun0".into()),
            },
        ]
    }

    #[test]
    fn reachable_ipv4_wildcard_lists_ipv4_localhost_then_interfaces() {
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
    fn reachable_ipv6_wildcard_lists_ipv6_localhost_then_interfaces() {
        let r = assemble_reachable_urls("::", "", 6419, &sample_hosts());
        assert_eq!(r.all.len(), 3);
        assert_eq!(r.all[0].label, "localhost");
        assert_eq!(r.all[0].url, "http://[::1]:6419");
        assert_eq!(r.all[1].url, "http://[fd00::20]:6419");
        assert_eq!(r.all[2].url, "http://[2001:db8::5]:6419");
        assert_eq!(r.featured, "http://[fd00::20]:6419");
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
        assert_eq!(
            assemble_reachable_urls("::", "2001:db8::5", 6419, &hosts).featured,
            "http://[2001:db8::5]:6419"
        );
        assert_eq!(
            assemble_reachable_urls("::", "[fd00::99]", 6419, &hosts).featured,
            "http://[fd00::20]:6419"
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
                address: "::1".into(),
                kind: BindHostKind::Localhost,
                interface: None,
            },
            BindHostOption {
                address: "0.0.0.0".into(),
                kind: BindHostKind::AllInterfaces,
                interface: None,
            },
            BindHostOption {
                address: "::".into(),
                kind: BindHostKind::AllInterfaces,
                interface: None,
            },
        ];
        let r = assemble_reachable_urls("0.0.0.0", "", 6419, &hosts);
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.featured, "http://127.0.0.1:6419");
        let r = assemble_reachable_urls("::", "", 6419, &hosts);
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.featured, "http://[::1]:6419");
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
    fn reachable_specific_ipv6_bind_lists_bracketed_address() {
        let r = assemble_reachable_urls("fd00::20", "", 6419, &sample_hosts());
        assert_eq!(r.all.len(), 1);
        assert_eq!(r.all[0].label, "en0");
        assert_eq!(r.all[0].url, "http://[fd00::20]:6419");
        assert_eq!(r.featured, "http://[fd00::20]:6419");
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
        let raw = make_access_cookie(secret, &scopes, access_now_unix() + 100, false);
        let kv = raw.split(';').next().unwrap(); // markon_access=PAYLOAD.SIG
        assert_eq!(access_cookie_scopes(secret, Some(kv)), scopes);
        // Wrong secret, tampered value, and an expired cookie are all rejected.
        assert!(access_cookie_scopes("other-secret", Some(kv)).is_empty());
        assert!(access_cookie_scopes(secret, Some(&format!("{kv}00"))).is_empty());
        let expired = make_access_cookie(secret, &scopes, 1, false);
        assert!(access_cookie_scopes(secret, Some(expired.split(';').next().unwrap())).is_empty());
        let secure = make_access_cookie(secret, &scopes, access_now_unix() + 100, true);
        assert!(secure.contains("; Secure"));
    }

    #[test]
    fn allowed_hosts_are_exact_and_track_explicit_https_origins() {
        let allowed = build_allowed_hosts(
            "127.0.0.1",
            "",
            6419,
            &["https://md.example.com".into(), "notes.local".into()],
            &[],
        );
        assert!(allowed.allows_header(Some("127.0.0.1:6419")));
        assert!(allowed.allows_header(Some("[::1]:6419")));
        assert!(allowed.allows_header(Some("LOCALHOST:9999")));
        assert!(allowed.allows_header(Some("md.example.com")));
        assert!(allowed.allows_header(Some("notes.local:443")));
        assert!(!allowed.allows_header(Some("evil.example")));
        assert!(!allowed.allows_header(Some("md.example.com.evil")));
        assert!(allowed.is_secure_header(Some("md.example.com")));
        assert!(!allowed.is_secure_header(Some("notes.local")));
    }

    #[tokio::test]
    async fn unknown_host_is_rejected_before_route_execution() {
        let state = test_state(Arc::new(WorkspaceRegistry::new("host-gate".into())));
        let app = Router::new()
            .route("/state-change", post(|| async { StatusCode::NO_CONTENT }))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_allowed_host,
            ))
            .with_state(state);

        let evil = axum::http::Request::builder()
            .method("POST")
            .uri("/state-change")
            .header(header::HOST, "evil.example:6419")
            .header(header::ORIGIN, "http://evil.example:6419")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(evil).await.unwrap().status(),
            StatusCode::MISDIRECTED_REQUEST
        );

        let local = axum::http::Request::builder()
            .method("POST")
            .uri("/state-change")
            .header(header::HOST, "127.0.0.1:6419")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(local).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn loopback_is_not_an_admin_identity() {
        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("admin-role".into()));
        let id = add_test_workspace(&registry, root.path().to_path_buf(), all_flags());
        let required_hash = crate::workspace::hash_access_code("test-salt", "guest");
        assert!(registry.set_collaborator_access_code(&id, &required_hash));
        let state = test_state(registry);
        let route = format!("/_/{id}/danger");
        let app = Router::new()
            .route(
                "/_/{workspace_id}/danger",
                post(|| async { StatusCode::NO_CONTENT })
                    .route_layer(axum::middleware::from_fn(require_admin_role)),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_access_code,
            ));

        let request = |cookie: Option<String>| {
            let mut builder = axum::http::Request::builder()
                .method("POST")
                .uri(&route)
                .extension(axum::extract::ConnectInfo(loopback()));
            if let Some(cookie) = cookie {
                builder = builder.header(header::COOKIE, cookie);
            }
            builder.body(axum::body::Body::empty()).unwrap()
        };

        // A loopback TCP peer without a capability still hits the collaborator
        // gate; network topology grants no role.
        assert_eq!(
            app.clone().oneshot(request(None)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        let collaborator = make_access_cookie(
            &state.access_secret,
            &[(format!("w:{id}:collaborator"), required_hash)],
            access_now_unix() + 60,
            false,
        );
        assert_eq!(
            app.clone()
                .oneshot(request(Some(collaborator)))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );

        let admin =
            admin_auth::make_admin_cookie(&state.management_token, access_now_unix(), false);
        assert_eq!(
            app.oneshot(request(Some(admin))).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn admin_nonce_exchange_sets_single_use_http_only_session() {
        let state = test_state(Arc::new(WorkspaceRegistry::new("admin-exchange".into())));
        let nonce = state.admin_bootstraps.issue_url("/abcd1234/");
        let headers = headers_with(Some("http://127.0.0.1:6419"), Some("127.0.0.1:6419"));
        let response = admin_session_handler(
            State(state.clone()),
            axum::extract::ConnectInfo(loopback()),
            headers.clone(),
            Json(AdminSessionRequest {
                nonce: Some(nonce.clone()),
                code: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .expect("admin session cookie");
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(admin_auth::admin_cookie_valid(
            &state.management_token,
            Some(cookie),
            access_now_unix(),
        ));

        let replay = admin_session_handler(
            State(state),
            axum::extract::ConnectInfo(loopback()),
            headers,
            Json(AdminSessionRequest {
                nonce: Some(nonce),
                code: None,
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn save_capability_cannot_cross_workspace_boundary() {
        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        std::fs::write(root_a.path().join("a.md"), "workspace a").unwrap();
        std::fs::write(root_b.path().join("b.md"), "workspace b").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("save-scope".into()));
        let id_a = add_test_workspace(&registry, root_a.path().to_path_buf(), all_flags());
        let id_b = add_test_workspace(&registry, root_b.path().to_path_buf(), all_flags());
        let state = test_state(registry);
        let token_a = workspace_save_token(&state.save_token, &id_a);
        let token_b = workspace_save_token(&state.save_token, &id_b);
        assert_ne!(token_a, token_b);

        let app = Router::new()
            .route("/api/save", post(save_file_handler))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_local_save_origin,
            ))
            .with_state(state);
        let request = |token: &str, content: &str| {
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/save")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "127.0.0.1:6419")
                .header(header::ORIGIN, "http://127.0.0.1:6419")
                .header("X-Markon-Token", token)
                .extension(axum::extract::ConnectInfo(loopback()))
                .body(axum::body::Body::from(
                    json!({
                        "workspace_id": id_b,
                        "file_path": "b.md",
                        "content": content,
                    })
                    .to_string(),
                ))
                .unwrap()
        };

        let denied = app
            .clone()
            .oneshot(request(&token_a, "stolen"))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            std::fs::read_to_string(root_b.path().join("b.md")).unwrap(),
            "workspace b"
        );

        let allowed = app.oneshot(request(&token_b, "updated b")).await.unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(root_b.path().join("b.md")).unwrap(),
            "updated b"
        );
    }

    #[test]
    fn annotation_id_cannot_replace_another_documents_row() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE annotations (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                data TEXT NOT NULL
            )",
            [],
        )
        .unwrap();

        assert!(upsert_annotation_for_file(
            &conn,
            "shared-id",
            "/workspace/a.md",
            r#"{"id":"shared-id","text":"a"}"#,
        )
        .unwrap());
        assert!(!upsert_annotation_for_file(
            &conn,
            "shared-id",
            "/workspace/b.md",
            r#"{"id":"shared-id","text":"b"}"#,
        )
        .unwrap());

        let (file_path, data): (String, String) = conn
            .query_row(
                "SELECT file_path, data FROM annotations WHERE id = ?1",
                ["shared-id"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(file_path, "/workspace/a.md");
        assert!(data.contains(r#""text":"a""#));

        assert!(upsert_annotation_for_file(
            &conn,
            "shared-id",
            "/workspace/a.md",
            r#"{"id":"shared-id","text":"a2"}"#,
        )
        .unwrap());
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
        assert_eq!(
            access_gated_workspace("/_/abcd1234/ws").as_deref(),
            Some("abcd1234")
        );
        assert!(access_gated_workspace("/_/ws").is_none());
        assert_eq!(
            access_gated_workspace("/_/abcd1234/git/diff/work").as_deref(),
            Some("abcd1234")
        );
        assert_eq!(
            access_gated_workspace("/_/abcd1234/search").as_deref(),
            Some("abcd1234")
        );
        for encoded in [
            "/%61bcd1234/doc.md",
            "/api/chat/%61bcd1234/threads",
            "/_/ws/%61bcd1234",
            "/_/%61bcd1234/ws",
        ] {
            assert_eq!(
                access_gated_workspace(encoded).as_deref(),
                Some("abcd1234"),
                "encoded workspace id escaped the gate: {encoded}"
            );
        }
        assert!(access_gated_workspace("/_/%2Fbad123/ws").is_none());
        assert!(access_gated_workspace("/_/css/tokens.css").is_none());
        assert!(access_gated_workspace("/_/unlock").is_none());
        assert!(access_gated_workspace("/api/preview").is_none());
        assert!(access_gated_workspace("/favicon.ico").is_none());
    }

    #[tokio::test]
    async fn workspace_ws_upgrade_requires_remote_access_cookie() {
        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-access-gate".into()));
        let id = add_test_workspace(
            &registry,
            root.path().to_path_buf(),
            WorkspaceFlags {
                enable_live: true,
                ..Default::default()
            },
        );
        let required_hash = "required-hash".to_string();
        assert!(registry.set_collaborator_access_code(&id, &required_hash));
        let state = test_state(registry);
        let app = Router::new()
            .route(WORKSPACE_WS_ROUTE, get(|| async { StatusCode::NO_CONTENT }))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                require_access_code,
            ));

        let request = axum::http::Request::builder()
            .uri(format!("/_/{id}/ws"))
            .header(header::UPGRADE, "websocket")
            .header(header::ORIGIN, "http://markon.local")
            .header(header::HOST, "markon.local")
            .extension(axum::extract::ConnectInfo(lan_peer()))
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let encoded_id = format!("%{:02X}{}", id.as_bytes()[0], &id[1..]);
        let encoded_request = axum::http::Request::builder()
            .uri(format!("/_/{encoded_id}/ws"))
            .header(header::UPGRADE, "websocket")
            .header(header::ORIGIN, "http://markon.local")
            .header(header::HOST, "markon.local")
            .extension(axum::extract::ConnectInfo(lan_peer()))
            .body(axum::body::Body::empty())
            .unwrap();
        let encoded_response = app.clone().oneshot(encoded_request).await.unwrap();
        assert_eq!(encoded_response.status(), StatusCode::UNAUTHORIZED);

        let cookie = make_access_cookie(
            &state.access_secret,
            &[(format!("w:{id}:collaborator"), required_hash)],
            access_now_unix() + 60,
            false,
        );
        let request = axum::http::Request::builder()
            .uri(format!("/_/{id}/ws"))
            .header(header::UPGRADE, "websocket")
            .header(header::COOKIE, cookie)
            .extension(axum::extract::ConnectInfo(lan_peer()))
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn workspace_ws_route_and_broadcast_are_actually_isolated() {
        use tokio_tungstenite::tungstenite::{Error as WsError, Message as ClientMessage};

        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-integration".into()));
        let live_flags = WorkspaceFlags {
            enable_live: true,
            ..Default::default()
        };
        let id_a = add_test_workspace(&registry, root_a.path().to_path_buf(), live_flags);
        let id_b = add_test_workspace(&registry, root_b.path().to_path_buf(), live_flags);
        let (addr, server) = spawn_collaboration_test_server(test_state(registry.clone())).await;

        let (mut socket_a, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id_a}/ws"))
                .await
                .unwrap();
        let (mut socket_a_other_channel, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id_a}/ws"))
                .await
                .unwrap();
        let (mut socket_b, _) =
            tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id_b}/ws"))
                .await
                .unwrap();

        socket_a
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "hello",
                    "target": { "kind": "surface", "key": format!("/{id_a}/") }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        socket_a_other_channel
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "hello",
                    "target": {
                        "kind": "surface",
                        "key": format!("/_/{id_a}/compare")
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        socket_b
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "hello",
                    "target": { "kind": "surface", "key": format!("/{id_b}/") }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        socket_a
            .send(ClientMessage::Text(
                r#"{"type":"live_action","data":{"action":"focus"}}"#.into(),
            ))
            .await
            .unwrap();
        let echoed = tokio::time::timeout(std::time::Duration::from_secs(2), socket_a.next())
            .await
            .expect("same channel should receive live event")
            .unwrap()
            .unwrap();
        assert!(echoed.to_text().unwrap().contains("live_action"));
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(150),
            socket_a_other_channel.next()
        )
        .await
        .is_err());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), socket_b.next())
                .await
                .is_err()
        );

        let legacy = tokio_tungstenite::connect_async(format!("ws://{addr}/_/ws"))
            .await
            .unwrap_err();
        assert!(
            matches!(legacy, WsError::Http(response) if response.status() == StatusCode::NOT_FOUND)
        );

        assert!(registry.remove(&id_a));
        let detached = tokio::time::timeout(std::time::Duration::from_secs(2), socket_a.next())
            .await
            .expect("detaching a workspace must close existing sockets");
        assert!(matches!(
            detached,
            None | Some(Ok(ClientMessage::Close(_))) | Some(Err(_))
        ));
        server.abort();
    }

    #[tokio::test]
    async fn workspace_ws_handshake_rejects_workspace_without_features() {
        use tokio_tungstenite::tungstenite::Error as WsError;

        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-disabled".into()));
        let id = add_test_workspace(
            &registry,
            root.path().to_path_buf(),
            WorkspaceFlags::default(),
        );
        let (addr, server) = spawn_collaboration_test_server(test_state(registry)).await;
        let error = tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id}/ws"))
            .await
            .unwrap_err();
        assert!(
            matches!(error, WsError::Http(response) if response.status() == StatusCode::FORBIDDEN)
        );
        server.abort();
    }

    #[tokio::test]
    async fn live_only_document_receives_no_stored_data_and_rejects_foreign_path() {
        use tokio_tungstenite::tungstenite::Message as ClientMessage;

        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        let document_a = root_a.path().join("a.md");
        let document_b = root_b.path().join("b.md");
        fs::write(&document_a, "# a").unwrap();
        fs::write(&document_b, "# b").unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("ws-live-only".into()));
        let id_a = add_test_workspace(
            &registry,
            root_a.path().to_path_buf(),
            WorkspaceFlags {
                enable_live: true,
                shared_annotation: false,
                ..Default::default()
            },
        );
        let _id_b = add_test_workspace(&registry, root_b.path().to_path_buf(), all_flags());

        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE annotations (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, data TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE viewed_state (file_path TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotations (id, file_path, data) VALUES ('secret', ?1, '{\"id\":\"secret\"}')",
            [dunce::canonicalize(&document_a)
                .unwrap()
                .to_string_lossy()
                .as_ref()],
        )
        .unwrap();
        let db = Arc::new(Mutex::new(conn));
        let mut state = test_state(registry);
        state.db = Some(db.clone());
        let (addr, server) = spawn_collaboration_test_server(state).await;

        let (mut valid, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id_a}/ws"))
            .await
            .unwrap();
        valid
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "hello",
                    "target": {
                        "kind": "document",
                        "path": document_a.to_string_lossy()
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(150), valid.next())
                .await
                .is_err()
        );
        valid
            .send(ClientMessage::Text(
                r#"{"type":"live_action","data":{"action":"focus"}}"#.into(),
            ))
            .await
            .unwrap();
        let live = tokio::time::timeout(std::time::Duration::from_secs(2), valid.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(live.to_text().unwrap().contains("live_action"));
        valid
            .send(ClientMessage::Text(
                r#"{"type":"new_annotation","annotation":{"id":"forbidden"}}"#.into(),
            ))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let forbidden_count: i64 = db
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM annotations WHERE id = 'forbidden'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(forbidden_count, 0);

        let (mut foreign, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/_/{id_a}/ws"))
            .await
            .unwrap();
        foreign
            .send(ClientMessage::Text(
                serde_json::json!({
                    "type": "hello",
                    "target": {
                        "kind": "document",
                        "path": document_b.to_string_lossy()
                    }
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), foreign.next())
            .await
            .expect("foreign path must be rejected before any data is sent");
        assert!(matches!(
            closed,
            None | Some(Ok(ClientMessage::Close(_))) | Some(Err(_))
        ));
        server.abort();
    }

    #[test]
    fn canonical_route_helpers_keep_file_and_tool_spaces_separate() {
        assert_eq!(workspace_root_url("abcd1234"), "/abcd1234/");
        assert_eq!(
            workspace_file_url("abcd1234", "docs/readme.md"),
            "/abcd1234/docs/readme.md"
        );
        assert_eq!(
            workspace_file_url("abcd1234", "docs/a b#c?.md"),
            "/abcd1234/docs/a%20b%23c%3F.md"
        );
        assert_eq!(
            workspace_internal_url("abcd1234", "git/history"),
            "/_/abcd1234/git/history"
        );
        assert_eq!(workspace_internal_url("abcd1234", "ws"), "/_/abcd1234/ws");
        assert_eq!(
            workspace_compare_base_url("abcd1234"),
            "/_/abcd1234/compare"
        );
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
        let docs = dir.path().join("docs");
        fs::create_dir(&docs).unwrap();
        let file = docs.join("EVDI_IMPLEMENTATION_PLAN.md");
        fs::write(&file, "# Windows route check\n\nalpha beta gamma").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("route-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_path(
            State(state),
            AxumPath((id.clone(), "docs/EVDI_IMPLEMENTATION_PLAN.md".to_string())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains("Windows route check"));
        assert!(body.contains("alpha beta gamma"));
        assert!(body.contains("enable-edit"));
        assert!(body.contains("enable-search"));
        assert!(body.contains("window.MarkonTheme"));
        assert!(body.contains("<title>EVDI_IMPLEMENTATION_PLAN.md</title>"));
        assert!(!body.contains("<title>markon - EVDI_IMPLEMENTATION_PLAN.md</title>"));
        assert!(body.contains(&format!("href=\"/{id}/#docs/EVDI_IMPLEMENTATION_PLAN.md\"")));
        let root = canonicalize_route_path(dir.path()).unwrap();
        let workspace_name = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let workspace_path = workspace_display_path(&root);
        assert!(body.contains(&format!(
            "class=\"workspace-back-name\">{workspace_name}</span>"
        )));
        assert!(body.contains(&format!(
            "class=\"workspace-back-path\">{workspace_path}</span>"
        )));
        assert!(!body.contains("id=\"back-link-text\""));
        assert!(!body.contains(&format!("/_/{id}/git/history")));
    }

    #[tokio::test]
    async fn workspace_path_handler_renders_text_file_as_content_only_view() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("notes.txt"), "alpha\nbeta").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("text-preview-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_path(
            State(state),
            AxumPath((id, "notes.txt".to_string())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("class=\"code-view\""), "{body}");
        assert!(body.contains("alpha"), "{body}");
        assert!(body.contains("beta"), "{body}");
        assert!(!body.contains("class=\"fv-back\""), "{body}");
        assert!(!body.contains("class=\"fv-head\""), "{body}");
        assert!(!body.contains("Back to workspace"), "{body}");
        assert!(!body.contains("notes.txt</span>"), "{body}");
    }

    #[tokio::test]
    async fn workspace_path_handler_loads_math_assets_when_needed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        fs::write(&file, "Inline $E = mc^2$.\n\n$$\na^2 + b^2 = c^2\n$$").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("math-assets-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_path(
            State(state),
            AxumPath((id, "README.md".to_string())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("/_/js/katex/katex.min.css"), "{body}");
        assert!(body.contains("/_/js/katex/katex.min.js"), "{body}");
        assert!(body.contains("/_/js/math-render.js"), "{body}");
        assert!(body.contains("data-math-display=\"true\""), "{body}");
    }

    #[tokio::test]
    async fn workspace_feature_controls_render_and_update_flags() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "# Feature controls").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("feature-controls-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_search: true,
                enable_viewed: false,
                enable_edit: false,
                enable_live: false,
                enable_chat: false,
                shared_annotation: false,
            },
        );
        let state = test_state(registry.clone());

        let response = handle_workspace_root(
            State(state.clone()),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains("data-workspace-feature-form"));
        assert!(body.contains(&format!(r#"data-update-url="/_/{id}/settings/features""#)));
        assert!(body.contains(r#"data-feature-key="enable_search""#));
        assert!(body.contains(r#"type="checkbox""#));

        let next_flags = WorkspaceFlags {
            enable_search: false,
            enable_viewed: true,
            enable_edit: true,
            enable_live: true,
            enable_chat: true,
            shared_annotation: true,
        };
        let response = handle_workspace_update_features(
            State(state.clone()),
            AxumPath(id.clone()),
            Json(UpdateWorkspaceFeaturesRequest { flags: next_flags }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(registry.get(&id).unwrap().flags(), next_flags);

        let response = handle_workspace_root(
            State(state),
            AxumPath(id),
            Some(Extension(AccessRole::Collaborator)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains(r#"data-can-edit="false""#));
        assert!(body.contains("disabled"));
    }

    /// New model: edit/chat are collaboration abilities gated purely by the
    /// per-workspace flag, so a remote (LAN) collaborator gets the in-browser
    /// editor + save token and the chat panel when the flags are on — the
    /// inverse of the old "admin-only" gate. Structural management stays
    /// loopback-only (covered by the directory `data-can-edit=false` test).
    #[tokio::test]
    async fn remote_collaborator_editor_and_chat_follow_flags() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "# hi\n\nbody\n").unwrap();

        // edit + chat ON → remote (LAN) peer gets editor, save token, and chat.
        let reg_on = Arc::new(WorkspaceRegistry::new("remote-flags-on".into()));
        let id_on = add_test_workspace(
            &reg_on,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_edit: true,
                enable_chat: true,
                ..Default::default()
            },
        );
        let on = response_text(
            handle_workspace_path(
                State(test_state(reg_on)),
                AxumPath((id_on, "README.md".to_string())),
                Some(Extension(AccessRole::Collaborator)),
                axum::http::HeaderMap::new(),
            )
            .await
            .into_response(),
        )
        .await;
        assert!(
            on.contains(r#"<meta name="enable-edit" content="true">"#),
            "{on}"
        );
        assert!(
            on.contains(r#"name="save-token""#),
            "remote collaborator with the edit flag must receive the save token"
        );
        assert!(on.contains(r#"<meta name="enable-chat" content="true">"#));

        // both OFF → no save token and no chat for the same remote peer.
        let reg_off = Arc::new(WorkspaceRegistry::new("remote-flags-off".into()));
        let id_off = add_test_workspace(
            &reg_off,
            dir.path().to_path_buf(),
            WorkspaceFlags::default(),
        );
        let off = response_text(
            handle_workspace_path(
                State(test_state(reg_off)),
                AxumPath((id_off, "README.md".to_string())),
                Some(Extension(AccessRole::Collaborator)),
                axum::http::HeaderMap::new(),
            )
            .await
            .into_response(),
        )
        .await;
        assert!(off.contains(r#"<meta name="enable-edit" content="false">"#));
        assert!(
            !off.contains(r#"name="save-token""#),
            "no edit flag → no save token even on a readable page"
        );
        assert!(off.contains(r#"<meta name="enable-chat" content="false">"#));
    }

    #[tokio::test]
    async fn dist_asset_route_uses_extension_mime_type() {
        let response = serve_js(AxumPath("katex/katex.min.css".into()))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/css"
        );
    }

    #[test]
    fn unified_diff_html_renders_word_highlights_and_escapes_text() {
        let html = render_unified_diff_html(
            "--- a.md\n+++ a.md\n@@ -1 +1 @@\n-old price <b>\n+new price <b>\n",
        );

        assert!(html.contains("git-diff-meta"));
        assert!(html.contains("git-diff-word-del"));
        assert!(html.contains("git-diff-word-add"));
        assert!(html.contains("&lt;b&gt;"));
        assert!(!html.contains("<b>"));
    }

    #[test]
    fn pretty_compare_range_accepts_slash_refs() {
        let (base, compare) =
            parse_pretty_compare_range("main...feat/wasm-ref-test-backend").unwrap();
        assert_eq!(base, "main");
        assert_eq!(compare, "feat/wasm-ref-test-backend");
    }

    #[tokio::test]
    async fn directory_git_diff_actions_disable_without_markdown_changes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "# Notes\n").unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .arg("init")
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.email", "test@example.com"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.name", "Test User"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["add", "."])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["commit", "-m", "initial markdown"])
            .output()
            .unwrap();
        fs::write(dir.path().join("notes.txt"), "Not markdown\n").unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["add", "."])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["commit", "-m", "txt only"])
            .output()
            .unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("git-md-actions-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_root(
            State(state),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains("txt only"));
        assert!(body.contains("workspace-action-disabled"));
        assert!(!body.contains(&format!("/_/{id}/git/show/")));
        assert!(!body.contains(&format!("/_/{id}/git/diff/work?view=rendered")));
        assert!(!body.contains(&format!("/_/{id}/compare/")));
        assert!(!body.contains(">Markdown diff<"));
        assert!(body.contains(&format!("/_/{id}/git/history")));
    }

    #[tokio::test]
    async fn non_git_workspace_hides_git_ui_and_git_routes_return_text() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "# Notes\n").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("non-git-workspace-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let response = handle_workspace_root(
            State(state.clone()),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains("workspace-shell--no-git"));
        assert!(body.contains("workspace-repo-toolbar--plain"));
        assert!(body.contains("data-workspace-spotlight-trigger"));
        assert!(!body.contains("workspace-file-kicker"));
        assert!(!body.contains(r#"<div class="workspace-ref-menu""#));
        assert!(!body.contains(r#"<a class="workspace-ref-link workspace-secondary-link""#));
        assert!(!body.contains(r#"data-branch-panel"#));
        assert!(!body.contains(r#"<article class="workspace-change-primary""#));
        assert!(!body.contains(r#"<h2 class="workspace-section-title" data-i18n="web.ws.changes""#));
        assert!(!body.contains(r#"data-i18n="web.ws.git.non_repo""#));
        assert!(!body.contains(&format!(r#"href="/_/{id}/git/branches""#)));
        assert!(!body.contains(&format!(r#"href="/_/{id}/git/tags""#)));
        assert!(!body.contains(&format!(r#"href="/_/{id}/git/history""#)));

        let diff = handle_git_working_diff(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: Some("rendered".into()),
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(diff.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_text(diff).await,
            "Workspace is not a git repository"
        );

        let compare = handle_pretty_compare_diff(
            State(state.clone()),
            AxumPath((id.clone(), "HEAD...worktree".into())),
            Query(PrettyCompareQuery {
                view: Some("rendered".into()),
                format: None,
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(compare.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_text(compare).await,
            "Workspace is not a git repository"
        );

        let options = handle_git_compare_options_status(
            State(state),
            AxumPath(id),
            Query(GitCompareOptionsStatusQuery {
                base: "HEAD".into(),
                compare: "worktree".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(options.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_text(options).await,
            "Workspace is not a git repository"
        );
    }

    #[tokio::test]
    async fn git_history_and_working_diff_pages_render() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "# Old\n").unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .arg("init")
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.email", "test@example.com"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.name", "Test User"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["add", "."])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["commit", "-m", "initial"])
            .output()
            .unwrap();
        fs::write(dir.path().join("a.md"), "# New\n").unwrap();
        fs::write(dir.path().join("notes.txt"), "Not markdown\n").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("git-web-test".into()));
        let id = add_test_workspace(&registry, dir.path().to_path_buf(), all_flags());
        let state = test_state(registry);

        let root = handle_workspace_root(
            State(state.clone()),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(root.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(root).await).to_string();
        assert!(body.contains("workspace-shell"));
        assert!(body.contains("workspace-meta-panel"));
        assert!(body.contains("workspace-side-section"));
        assert!(body.contains("workspace-repo-toolbar"));
        assert!(body.contains("data-workspace-spotlight-trigger"));
        assert!(body.contains("data-open-add-file"));
        assert!(body.contains("data-checkout-url"));
        assert!(body.contains(&format!("/_/{id}/git/branches")));
        assert!(body.contains(&format!("/_/{id}/git/tags")));
        assert!(body.contains("workspace-commit-header"));
        assert!(body.contains("workspace-commits-link"));
        assert!(body.contains("workspace-entry-commit"));
        assert!(body.contains("data-copy-text"));
        assert!(body.contains("Workspace changes"));
        assert!(body.contains("initial"));
        assert!(body.contains("1 Commits"));
        assert!(!body.contains("workspace-topbar"));
        assert!(!body.contains("workspace-side-card"));
        assert!(!body.contains("workspace-tabs"));
        assert!(!body.contains("data-inline-diff"));
        assert!(body.contains(&format!("/_/{id}/compare/")));
        assert!(body.contains("?view=rendered"));
        assert!(body.contains(&format!("/_/{id}/compare/HEAD...worktree?view=rendered")));
        assert!(!body.contains(&format!("/_/{id}/git/show/")));
        assert!(!body.contains(&format!("/_/{id}/git/diff/work?view=rendered")));
        assert!(!body.contains(">Markdown diff<"));
        assert!(!body.contains("Snapshot"));

        let diff = handle_git_working_diff(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: None,
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(diff.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(diff).await).to_string();
        assert!(body.contains("Markdiff"));
        assert!(body.contains("git-diff-sidebar"));
        assert!(body.contains("git-source-diff-pane"));
        assert!(body.contains("data-diff-filter"));
        assert!(body.contains("data-diff-file-list"));
        assert!(body.contains("Markdiff"));
        assert!(body.contains(">Base<"));
        assert!(body.contains(">Compare<"));
        assert!(!body.contains("data-md-engine-status"));
        assert!(!body.contains("git-diff-compare-submit"));
        assert!(body.contains("data-compare-status-url"));
        assert!(body.contains("data-compare-picker"));
        assert!(body.contains("a.md"));
        assert!(!body.contains("notes.txt"));
        assert!(body.contains("data-virtual-diff"));
        assert!(body.contains("data-current-diff-view=\"rendered\""));
        assert!(body.contains("git-diff-view-seg"));
        assert!(body.contains("data-diff-view-seg"));
        assert!(body.contains("data-markdown-diff"));
        assert!(body.contains("data-md-diff-content"));
        assert!(!body.contains("data-md-old-content"));
        assert!(!body.contains("data-md-new-content"));
        assert!(!body.contains("data-markon-interactive-body"));
        assert!(!body.contains("/_/js/main.js"));
        assert!(body.contains("/_/js/workspace-diff.js"));
        assert!(body.contains("/_/js/markdown-diff.js"));
        // Both views consume one unified Markdown block payload (view=rendered).
        assert!(!body.contains(&format!(
            "/_/{id}/compare/HEAD...worktree?view=raw&format=data"
        )));
        assert!(body.contains(&format!("/_/{id}/compare/HEAD...worktree?view=rendered")));
        assert!(!body.contains("md-diff-shell"));
        assert!(!body.contains("html_diff"));

        let compare = handle_pretty_compare_diff(
            State(state.clone()),
            AxumPath((id.clone(), "HEAD...worktree".to_string())),
            Query(PrettyCompareQuery {
                view: None,
                format: None,
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(compare.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(compare).await).to_string();
        assert!(body.contains(&format!("/_/{id}/compare/HEAD...worktree?view=raw")));
        assert!(body.contains("data-compare-trigger"));
        assert!(body.contains("data-compare-picker"));
        assert!(body.contains("Worktree"));
        assert!(body.contains("\"alias\":\"Latest\""));

        let compare_data = handle_pretty_compare_diff(
            State(state.clone()),
            AxumPath((id.clone(), "HEAD...worktree".to_string())),
            Query(PrettyCompareQuery {
                view: Some("raw".to_string()),
                format: Some("data".to_string()),
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(compare_data.status(), StatusCode::OK);
        let body = response_text(compare_data).await;
        assert!(body.contains("\"range\":\"HEAD..worktree\""));
        assert!(body.contains("\"path\":\"a.md\""));
        assert!(!body.contains("notes.txt"));

        let diff_data = handle_git_working_diff_data(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: Some("raw".to_string()),
                f: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(diff_data.status(), StatusCode::OK);
        let body = response_text(diff_data).await;
        assert!(body.contains("\"title\":\"Working tree diff\""));
        assert!(body.contains("\"path\":\"a.md\""));
        assert!(!body.contains("notes.txt"));
        assert!(body.contains("\"rows\""));
        assert!(body.contains("git-diff-add"));
        let diff_json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let split_line = diff_json["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| {
                row["kind"] == "line"
                    && row
                        .get("old_class_name")
                        .is_some_and(|class| class.as_str().unwrap_or("").contains("git-diff-del"))
            })
            .unwrap();
        assert!(split_line.get("old_line_no").is_some());
        assert!(split_line.get("new_line_no").is_some());
        assert!(split_line.get("old_segments").is_some());
        assert!(split_line.get("new_segments").is_some());
        assert!(!body.contains("html_diff"));

        let filtered_diff_data = handle_git_working_diff_data(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: None,
                f: Some("missing.md".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(filtered_diff_data.status(), StatusCode::OK);
        let body = response_text(filtered_diff_data).await;
        assert!(body.contains(r#""files":[]"#));
        assert!(!body.contains("\"path\":\"a.md\""));

        let markdown_diff = handle_git_working_diff(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: Some("rendered".to_string()),
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(markdown_diff.status(), StatusCode::OK);
        let body =
            html_escape::decode_html_entities(&response_text(markdown_diff).await).to_string();
        // The page no longer carries a synthetic `__markon_diff__` annotation key;
        // each file binds to its own canonical `abs_path`, and the page advertises
        // whether this is an annotatable worktree diff.
        assert!(!body.contains("__markon_diff__"));
        assert!(!body.contains(r#"name="file-path""#));
        assert!(body.contains(r#"name="is-worktree-diff" content="true""#));
        assert!(body.contains(r#"name="shared-annotation" content="true""#));
        assert!(body.contains(r#"name="enable-edit" content="false""#));
        assert!(body.contains("git-diff-page"));
        assert!(body.contains("git-diff-sidebar"));
        assert!(body.contains("git-diff-view-seg"));
        assert!(body.contains("data-markdown-diff"));
        assert!(body.contains("data-md-diff-content"));
        // Rendered diff now defaults to the all-files continuous view (empty
        // default path); the file list focuses a single file on demand.
        assert!(body.contains(r#"data-default-diff-path="""#));
        assert!(!body.contains("data-md-old-content"));
        assert!(!body.contains("data-md-new-content"));
        assert!(!body.contains("data-markon-interactive-body"));
        assert!(body.contains("/_/js/diff-ref-picker.js"));
        assert!(body.contains("/_/css/editor.css"));
        assert!(!body.contains("/_/js/main.js"));
        assert!(body.contains("/_/js/markdown-diff.js"));
        assert!(body.contains(&format!(
            "/_/{id}/compare/HEAD...worktree?view=rendered&format=data"
        )));
        assert!(!body.contains("markdown-diff/data/work"));
        assert!(!body.contains("md-diff-shell"));
        assert!(!body.contains("md-diff-source"));
        assert!(!body.contains("Open source diff"));

        let markdown_work_data = handle_git_working_diff_data(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: Some("rendered".to_string()),
                f: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(markdown_work_data.status(), StatusCode::OK);
        let body = response_text(markdown_work_data).await;
        assert!(body.contains("\"title\":\"Compare HEAD and worktree\""));
        assert!(body.contains("\"path\":\"a.md\""));

        let filtered_markdown_work_data = handle_git_working_diff_data(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitViewQuery {
                view: Some("rendered".to_string()),
                f: Some("missing.md".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(filtered_markdown_work_data.status(), StatusCode::OK);
        let body = response_text(filtered_markdown_work_data).await;
        assert!(body.contains(r#""files":[]"#));
        assert!(!body.contains("\"path\":\"a.md\""));

        let markdown_compare = handle_pretty_compare_diff(
            State(state.clone()),
            AxumPath((id.clone(), "HEAD...worktree".to_string())),
            Query(PrettyCompareQuery {
                view: Some("rendered".to_string()),
                format: None,
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(markdown_compare.status(), StatusCode::OK);
        let body =
            html_escape::decode_html_entities(&response_text(markdown_compare).await).to_string();
        assert!(body.contains(&format!("/_/{id}/compare/HEAD...worktree?view=rendered")));
        assert!(body.contains("data-compare-trigger"));
        assert!(!body.contains(&format!("/_/{id}/git/diff/work")));

        let markdown_compare_data = handle_pretty_compare_diff(
            State(state.clone()),
            AxumPath((id.clone(), "HEAD...worktree".to_string())),
            Query(PrettyCompareQuery {
                view: Some("rendered".to_string()),
                format: Some("data".to_string()),
                f: None,
            }),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(markdown_compare_data.status(), StatusCode::OK);
        let body = response_text(markdown_compare_data).await;
        assert!(body.contains("\"title\":\"Compare HEAD and worktree\""));
        assert!(body.contains("\"path\":\"a.md\""));

        let history = handle_git_history(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(GitHistoryQuery {
                branch: None,
                author: None,
                range: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(history.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(history).await).to_string();
        assert!(body.contains("markon git history"));
        assert!(body.contains("web.ws.git.commits"));
        assert!(body.contains("initial"));
        assert!(body.contains(&format!("/_/{id}/compare/")));
        assert!(body.contains(&format!("/_/{id}/compare/HEAD...worktree?view=rendered")));
        assert!(!body.contains(&format!("/_/{id}/git/show/")));
        assert!(!body.contains(&format!("/_/{id}/git/diff/work")));

        let history_data = handle_git_history_data(State(state.clone()), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(history_data.status(), StatusCode::OK);
        let body = response_text(history_data).await;
        assert!(body.contains("\"subject\":\"initial\""));

        let branches = handle_git_branches(State(state.clone()), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(branches.status(), StatusCode::OK);
        let body = response_text(branches).await;
        assert!(body.contains("refs-title"));
        assert!(body.contains("web.ws.git.branches"));

        let tags = handle_git_tags(State(state), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(tags.status(), StatusCode::OK);
        let body = response_text(tags).await;
        assert!(body.contains("refs-title"));
        assert!(body.contains("web.ws.git.tags"));
    }

    #[test]
    fn rendered_markdown_diff_cache_hits_and_invalidates_worktree_content() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "# Title\n\nOld body\n").unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .arg("init")
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.email", "test@example.com"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["config", "user.name", "Test User"])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["add", "."])
            .output()
            .unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["commit", "-m", "initial"])
            .output()
            .unwrap();
        fs::write(dir.path().join("a.md"), "# Title\n\nNew body\n").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("git-cache-test".into()));
        let state = test_state(registry);
        let workspace_fs = WorkspaceFs::new(dir.path().to_path_buf(), None);

        let first = markdown_compare_diff_data(
            &state,
            "git-cache-test",
            &workspace_fs,
            "HEAD",
            "worktree",
            Some("a.md"),
        )
        .unwrap();
        assert_eq!(first.files.len(), 1);
        // `abs_path` is the per-file annotation key. It must be byte-identical to
        // the canonical path `render_markdown_file` derives for the same file
        // opened normally (worktree-root join + dunce canonicalize).
        let expected_abs = canonicalize_route_path(&dir.path().join("a.md"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(first.files[0].abs_path, expected_abs);
        assert!(serde_json::to_string(&first).unwrap().contains("New body"));
        let first_stats = state.markdown_diff_cache.lock().unwrap().stats();
        assert_eq!(first_stats.file_hits, 0);
        assert_eq!(first_stats.file_misses, 1);
        assert_eq!(first_stats.document_hits, 0);
        assert_eq!(first_stats.document_misses, 2);
        assert_eq!(first_stats.document_entries, 2);
        assert_eq!(first_stats.file_entries, 1);

        let second = markdown_compare_diff_data(
            &state,
            "git-cache-test",
            &workspace_fs,
            "HEAD",
            "worktree",
            Some("a.md"),
        )
        .unwrap();
        assert_eq!(second.files.len(), 1);
        let second_stats = state.markdown_diff_cache.lock().unwrap().stats();
        assert_eq!(second_stats.file_hits, 1);
        assert_eq!(second_stats.file_misses, 1);
        assert_eq!(second_stats.document_hits, 0);
        assert_eq!(second_stats.document_misses, 2);

        fs::write(dir.path().join("a.md"), "# Title\n\nNewest body\n").unwrap();
        let third = markdown_compare_diff_data(
            &state,
            "git-cache-test",
            &workspace_fs,
            "HEAD",
            "worktree",
            Some("a.md"),
        )
        .unwrap();
        let third_json = serde_json::to_string(&third).unwrap();
        assert!(third_json.contains("Newest body"));
        assert!(!third_json.contains("New body\\n"));
        let third_stats = state.markdown_diff_cache.lock().unwrap().stats();
        assert_eq!(third_stats.file_hits, 1);
        assert_eq!(third_stats.file_misses, 2);
        assert_eq!(third_stats.document_hits, 1);
        assert_eq!(third_stats.document_misses, 3);
        assert_eq!(third_stats.document_entries, 3);
        assert_eq!(third_stats.file_entries, 2);
    }

    #[test]
    fn rendered_markdown_diff_rewrites_relative_assets_per_file_path() {
        let dir = tempfile::tempdir().unwrap();
        for folder in ["docs", "guide"] {
            let asset_dir = dir.path().join(folder).join("images");
            fs::create_dir_all(&asset_dir).unwrap();
            fs::write(asset_dir.join("pic one.png"), b"png").unwrap();
            fs::write(
                dir.path().join(folder).join("page.md"),
                "# Title\n\n![diagram](images/pic one.png)\n\nOld body\n",
            )
            .unwrap();
        }

        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {:?} failed", args);
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test User"]);
        git(&["add", "."]);
        git(&["commit", "-m", "initial"]);

        for folder in ["docs", "guide"] {
            fs::write(
                dir.path().join(folder).join("page.md"),
                "# Title\n\n![diagram](images/pic one.png)\n\nNew body\n",
            )
            .unwrap();
        }

        let registry = Arc::new(WorkspaceRegistry::new("asset-diff-test".into()));
        let state = test_state(registry);
        let workspace_fs = WorkspaceFs::new(dir.path().to_path_buf(), None);
        let data =
            markdown_compare_diff_data(&state, "asset-ws", &workspace_fs, "HEAD", "worktree", None)
                .unwrap();

        for folder in ["docs", "guide"] {
            let path = format!("{folder}/page.md");
            let file = data
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("missing rendered diff for {path}"));
            let html = file
                .blocks
                .iter()
                .flat_map(|block| block.old.iter().chain(block.new.iter()))
                .map(|block| block.html.as_str())
                .collect::<String>();
            assert!(
                html.contains(&format!("src=\"/asset-ws/{folder}/images/pic%20one.png\"")),
                "unexpected rendered asset HTML: {html}",
            );
            assert!(!html.contains("src=\"images/pic%20one.png\""));
        }
    }

    // Regression for finding F / §10.4: when the workspace is a *subdirectory* of
    // the git repo, the per-file `abs_path` (the annotation key) must still be
    // byte-identical to the canonical path the normal file view derives — i.e.
    // `canonicalize(ws_root.join(rel))` — for BOTH a tracked modified file and an
    // untracked new file. Before `git diff --relative`, the two enumeration
    // sources carried different path bases (tracked: repo-root-relative; untracked:
    // workspace-relative), so the untracked file's key landed under the repo root
    // instead of the workspace, diverging from the normal view.
    #[test]
    fn rendered_markdown_diff_abs_path_matches_normal_view_in_repo_subdir() {
        let repo = tempfile::tempdir().unwrap();
        let git_init = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(repo.path())
                .args(args)
                .output()
                .unwrap();
        };
        // Workspace is a subdirectory of the repo: repo/docs.
        let ws_root = repo.path().join("docs");
        fs::create_dir_all(&ws_root).unwrap();
        // A tracked file that we will modify (exists on both sides).
        fs::write(ws_root.join("tracked.md"), "# Title\n\nOld body\n").unwrap();
        git_init(&["init"]);
        git_init(&["config", "user.email", "test@example.com"]);
        git_init(&["config", "user.name", "Test User"]);
        git_init(&["add", "."]);
        git_init(&["commit", "-m", "initial"]);
        // Tracked-modified new side + a brand new untracked file, both in the subdir.
        fs::write(ws_root.join("tracked.md"), "# Title\n\nNew body\n").unwrap();
        fs::write(ws_root.join("untracked.md"), "# Fresh\n\nBrand new\n").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("subdir-abs-test".into()));
        let state = test_state(registry);
        let workspace_fs = WorkspaceFs::new(ws_root.clone(), None);

        // Pass the SUBDIRECTORY as the workspace root, exactly as the route would.
        let data = markdown_compare_diff_data(
            &state,
            "subdir-abs-test",
            &workspace_fs,
            "HEAD",
            "worktree",
            None,
        )
        .unwrap();
        assert_eq!(data.files.len(), 2, "expected tracked + untracked file");

        for rel in ["tracked.md", "untracked.md"] {
            let file = data
                .files
                .iter()
                .find(|f| f.path == rel)
                .unwrap_or_else(|| {
                    panic!(
                        "missing diff entry for {rel}; got {:?}",
                        data.files
                            .iter()
                            .map(|f| f.path.clone())
                            .collect::<Vec<_>>()
                    )
                });
            // The normal file-view annotation key: canonicalize(ws_root.join(rel)).
            let expected = canonicalize_route_path(&ws_root.join(rel))
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert_eq!(
                file.abs_path, expected,
                "abs_path for {rel} must match the normal-view key byte-for-byte"
            );
        }

        // The tracked file's NEW side must have actually loaded (Defect 3): in a
        // subdir workspace the old code read `root.join(repo_relative_path)` and
        // failed, yielding an empty new side. Assert the new content is present.
        let json = serde_json::to_string(&data).unwrap();
        assert!(
            json.contains("New body"),
            "tracked new side must load in a subdir workspace"
        );
        assert!(json.contains("Brand new"), "untracked new side must load");
    }

    #[cfg(unix)]
    #[test]
    fn rendered_markdown_diff_does_not_read_untracked_outside_symlink() {
        use std::os::unix::fs::symlink;

        let repo = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "OUTSIDE SECRET MARKER").unwrap();
        fs::write(repo.path().join("README.md"), "# tracked").unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(repo.path())
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test User"]);
        git(&["add", "README.md"]);
        git(&["commit", "-m", "initial"]);
        symlink(outside.path(), repo.path().join("leak.md")).unwrap();

        let state = test_state(Arc::new(WorkspaceRegistry::new("symlink-diff-test".into())));
        let workspace_fs = WorkspaceFs::new(repo.path().to_path_buf(), None);
        let raw = git::working_diff(&workspace_fs).unwrap();
        assert!(!raw.patch.contains("OUTSIDE SECRET MARKER"));
        let compare = git::compare_diff(&workspace_fs, "HEAD", "worktree").unwrap();
        assert!(!compare.patch.contains("OUTSIDE SECRET MARKER"));
        let data = markdown_compare_diff_data(
            &state,
            "symlink-diff-test",
            &workspace_fs,
            "HEAD",
            "worktree",
            None,
        )
        .unwrap();
        let entry = data
            .files
            .iter()
            .find(|file| file.path == "leak.md")
            .expect("untracked markdown symlink must exercise the diff path");
        assert!(entry.new_source.is_none());
        assert_eq!(entry.additions, 0);
        assert!(!serde_json::to_string(&data)
            .unwrap()
            .contains("OUTSIDE SECRET MARKER"));
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

        let response = handle_workspace_path(
            State(state),
            AxumPath((id, route)),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
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
        fs::write(sub.join("notes.txt"), "listed in all-files mode").unwrap();
        fs::write(sub.join(".env"), "hidden but listed in all-files mode").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("listing-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags::default(),
        );
        let state = test_state(registry);

        let response = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "sub/".into())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let location = response
            .headers()
            .get(axum::http::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert_eq!(location, format!("/{id}/#sub/"));

        let response = handle_workspace_root(
            State(state),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = html_escape::decode_html_entities(&response_text(response).await).to_string();
        assert!(body.contains("data-file-filter=\"markdown\""));
        assert!(body.contains("data-entry-kind=\"dir\""));
        assert!(body.contains("data-entry-path=\"sub\""));
        assert!(body.contains("data-dir-link=\"/"));
        assert!(body.contains(&format!("/{id}/sub/")));
        assert!(body.contains("data-filter-visible-markdown=\"true\""));
        assert!(!body.contains(&format!("/_/{id}/git/history")));
    }

    #[test]
    fn directory_markdown_filter_keeps_only_markdown_files_and_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let docs_nested = dir.path().join("docs").join("guides");
        let src = dir.path().join("src");
        let empty = dir.path().join("empty");
        fs::create_dir_all(&docs_nested).unwrap();
        fs::create_dir(&src).unwrap();
        fs::create_dir(&empty).unwrap();
        fs::write(docs_nested.join("intro.md"), "# nested").unwrap();
        fs::write(src.join("main.rs"), "fn main() {}\n").unwrap();
        fs::write(empty.join("notes.txt"), "not markdown").unwrap();
        fs::write(dir.path().join("README.md"), "# root").unwrap();
        fs::write(dir.path().join("Cargo.toml"), "[package]\n").unwrap();

        let root = dunce::canonicalize(dir.path()).unwrap();
        let entries = collect_directory_entries("ws", &root, &root).unwrap();
        let shown = |name: &str| -> bool {
            entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap_or_else(|| panic!("missing directory entry {name}"))
                .show_in_markdown
        };

        assert!(shown("docs"));
        assert!(shown("README.md"));
        assert!(!shown("src"));
        assert!(!shown("empty"));
        assert!(!shown("Cargo.toml"));
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
        let response = save_file_handler(
            State(state.clone()),
            save_headers(&state, &id),
            Json(relative),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(fs::read_to_string(&file).unwrap(), "# relative save");

        let absolute = SaveFileRequest {
            workspace_id: id.clone(),
            file_path: file.to_string_lossy().to_string(),
            content: "# absolute save".into(),
        };
        let response = save_file_handler(
            State(state.clone()),
            save_headers(&state, &id),
            Json(absolute),
        )
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
            workspace_id: id.clone(),
            file_path: outside.path().to_string_lossy().to_string(),
            content: "# should not write".into(),
        };
        let response = save_file_handler(
            State(state.clone()),
            save_headers(&state, &id),
            Json(request),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "Access denied");
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "# outside");
    }

    #[tokio::test]
    async fn workspace_create_file_creates_inside_workspace_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("create-file-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_edit: true,
                ..WorkspaceFlags::default()
            },
        );
        let state = test_state(registry);

        let request = CreateFileRequest {
            path: "docs/new-note.md".into(),
            content: Some("# New note\n".into()),
        };
        let response =
            handle_workspace_create_file(State(state.clone()), AxumPath(id.clone()), Json(request))
                .await
                .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert_eq!(
            fs::read_to_string(dir.path().join("docs/new-note.md")).unwrap(),
            "# New note\n"
        );

        let request = CreateFileRequest {
            path: "../outside.md".into(),
            content: Some("# outside".into()),
        };
        let response = handle_workspace_create_file(State(state), AxumPath(id), Json(request))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "Invalid file path");
        assert!(!dir.path().join("../outside.md").exists());
    }

    #[tokio::test]
    async fn workspace_create_folder_creates_inside_workspace_and_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(WorkspaceRegistry::new("create-folder-test".into()));
        let id = add_test_workspace(
            &registry,
            dir.path().to_path_buf(),
            WorkspaceFlags {
                enable_edit: true,
                ..WorkspaceFlags::default()
            },
        );
        let state = test_state(registry);

        // Nested folder is created (with intermediate dirs).
        let request = CreateFileRequest {
            path: "docs/sub/new-folder".into(),
            content: None,
        };
        let response = handle_workspace_create_folder(
            State(state.clone()),
            AxumPath(id.clone()),
            Json(request),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], true);
        assert!(dir.path().join("docs/sub/new-folder").is_dir());

        // Creating it again reports the existing folder.
        let request = CreateFileRequest {
            path: "docs/sub/new-folder".into(),
            content: None,
        };
        let response = handle_workspace_create_folder(
            State(state.clone()),
            AxumPath(id.clone()),
            Json(request),
        )
        .await
        .into_response();
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], false);
        assert_eq!(body["message"], "Folder already exists");

        // Traversal is rejected.
        let request = CreateFileRequest {
            path: "../escape".into(),
            content: None,
        };
        let response = handle_workspace_create_folder(State(state), AxumPath(id), Json(request))
            .await
            .into_response();
        let body: serde_json::Value = serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(body["success"], false);
        assert!(!dir.path().join("../escape").exists());
    }

    #[tokio::test]
    async fn single_file_workspace_redirects_and_hides_siblings() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("nested")).unwrap();
        let spaced_asset = dir.path().join("pic with space.png");
        fs::write(
            dir.path().join("opened.md"),
            format!(
                "# opened\n\n![pic](pic.png)\n![space]({})\n![root](/nested/root.png)",
                spaced_asset.to_string_lossy()
            ),
        )
        .unwrap();
        fs::write(dir.path().join("sibling.md"), "# sibling").unwrap();
        fs::write(dir.path().join("pic.png"), b"png").unwrap();
        fs::write(&spaced_asset, b"png").unwrap();
        fs::write(dir.path().join("nested/root.png"), b"png").unwrap();

        let registry = Arc::new(WorkspaceRegistry::new("single-file-test".into()));
        let id = registry.add(WorkspaceConfig {
            path: dunce::canonicalize(dir.path()).unwrap(),
            flags: WorkspaceFlags {
                enable_edit: true,
                ..WorkspaceFlags::default()
            },
            single_file: Some("opened.md".into()),
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });
        let state = test_state(registry);

        let root = handle_workspace_root(
            State(state.clone()),
            AxumPath(id.clone()),
            Some(Extension(AccessRole::Admin)),
        )
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
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        let opened_status = opened.status();
        let opened_body = response_text(opened).await;
        assert_eq!(opened_status, StatusCode::OK);
        assert!(
            opened_body.contains(&format!(r#"src="/{id}/pic%20with%20space.png""#)),
            "body: {opened_body}"
        );
        assert!(
            opened_body.contains(&format!(r#"src="/{id}/nested/root.png""#)),
            "body: {opened_body}"
        );

        let asset = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "pic.png".into())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(asset.status(), StatusCode::OK);

        let spaced_asset = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "pic%20with%20space.png".into())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(spaced_asset.status(), StatusCode::OK);

        let root_asset = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "nested/root.png".into())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(root_asset.status(), StatusCode::OK);

        let sibling = handle_workspace_path(
            State(state.clone()),
            AxumPath((id.clone(), "sibling.md".into())),
            Some(Extension(AccessRole::Admin)),
            axum::http::HeaderMap::new(),
        )
        .await
        .into_response();
        assert_eq!(sibling.status(), StatusCode::NOT_FOUND);

        let files = handle_workspace_files_data(State(state.clone()), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(files.status(), StatusCode::OK);
        let files = response_text(files).await;
        assert!(files.contains("opened.md"), "body: {files}");
        assert!(files.contains("pic.png"), "body: {files}");
        assert!(!files.contains("sibling.md"), "body: {files}");

        let directory = handle_workspace_dir_data(
            State(state.clone()),
            AxumPath(id.clone()),
            Query(DirListingQuery { path: None }),
        )
        .await
        .into_response();
        assert_eq!(directory.status(), StatusCode::OK);
        let directory = response_text(directory).await;
        assert!(directory.contains("opened.md"), "body: {directory}");
        assert!(!directory.contains("sibling.md"), "body: {directory}");

        let git = handle_git_history_data(State(state.clone()), AxumPath(id.clone()))
            .await
            .into_response();
        assert_eq!(git.status(), StatusCode::NOT_FOUND);

        let save = save_file_handler(
            State(state.clone()),
            save_headers(&state, &id),
            Json(SaveFileRequest {
                workspace_id: id.clone(),
                file_path: "sibling.md".into(),
                content: "# overwritten".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(save.status(), StatusCode::OK);
        let save: serde_json::Value = serde_json::from_str(&response_text(save).await).unwrap();
        assert_eq!(save["success"], false);
        assert_eq!(
            fs::read_to_string(dir.path().join("sibling.md")).unwrap(),
            "# sibling"
        );

        let create = handle_workspace_create_file(
            State(state.clone()),
            AxumPath(id.clone()),
            Json(CreateFileRequest {
                path: "created.md".into(),
                content: Some("# created".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(create.status(), StatusCode::NOT_FOUND);
        assert!(!dir.path().join("created.md").exists());

        let delete = handle_workspace_delete_file(
            State(state),
            AxumPath(id),
            Json(DeleteFileRequest {
                path: "sibling.md".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(delete.status(), StatusCode::NOT_FOUND);
        assert!(dir.path().join("sibling.md").exists());
    }
}
