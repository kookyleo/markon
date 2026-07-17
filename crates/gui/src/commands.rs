use crate::service;
use crate::AppState;
use markon_core::chat::{config::ProviderKind, models};
use markon_core::control::{ControlError, RunningServer};
use markon_core::i18n;
use markon_core::net::{available_bind_hosts, host_in_list, BindHostOption};
use markon_core::server;
use markon_core::settings::{AppSettings, PortMode};
use markon_core::workspace::{expand_and_canonicalize, WorkspaceFlags, WorkspaceInfo};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{Emitter, State};
use tauri_plugin_updater::UpdaterExt;

const MARKON_REPO: &str = "kookyleo/markon";

/// Snapshot of server lifecycle + bind-host validity, broadcast on
/// `server-status-changed` whenever it might have shifted (after save, after
/// a network change). Mirrored by `get_server_status` for cold reads.
fn server_status_payload(state: &State<AppState>) -> serde_json::Value {
    let server = state.server.lock().unwrap();
    let bind_host = state.settings.lock().unwrap().host.clone();
    // The configured bind host still matters: it's what a respawn would hand the
    // service, so warn if it vanished from the NIC list. The check is meaningful
    // regardless of connection state.
    let host_available = host_in_list(&bind_host, &available_bind_hosts());
    serde_json::json!({
        "running": server.is_connected(),
        "error": server.last_error(),
        "host": bind_host,
        "port": server.port(),
        "host_available": host_available,
        // "connected" | "disconnected"
        "mode": server.mode(),
    })
}

/// Distinguishable error prefix for a failed control call (or a detached
/// service), so the frontend can surface the reconnect recovery affordance.
fn remote_err(e: ControlError) -> String {
    format!("remote-server-error: {e}")
}

/// Clone out the live service handle, or fail with a reconnect-triggering error
/// when the GUI is currently detached from `markond`.
fn require_service(state: &State<AppState>) -> Result<RunningServer, String> {
    state
        .server
        .lock()
        .unwrap()
        .handle()
        .ok_or_else(|| "remote-server-error: not connected to the markon service".to_string())
}

/// ONE mapping from a `WorkspaceInfo` to the workspace-panel JSON, shared by the
/// embedded (in-process registry) and remote (control API) list paths so every
/// field the panel reads stays identical across both modes.
fn workspace_panel_json(info: WorkspaceInfo, browser_base: &str) -> serde_json::Value {
    let url =
        server::build_workspace_url(browser_base, &server::workspace_url_path(&info.id, None));
    serde_json::json!({
        "id": info.id,
        "path": info.path,
        "url": url,
        "enable_search": info.flags.enable_search,
        "enable_viewed": info.flags.enable_viewed,
        "enable_edit": info.flags.enable_edit,
        "enable_live": info.flags.enable_live,
        "enable_chat": info.flags.enable_chat,
        "shared_annotation": info.flags.shared_annotation,
        // Non-zero iff a per-workspace collaborator access code is set. The
        // stored value is the full 64-hex digest, so this is only a set/not-set
        // signal (the panel draws a fixed dot count); not the digest itself.
        "collaborator_access_code_len": info.collaborator_access_code_hash.chars().count(),
        "search_ready": info.search_ready,
        // Lets the Settings UI filter out Open-With single-file workspaces.
        "ephemeral": info.ephemeral,
        "single_file": info.single_file,
        // Optional short display name (empty = none).
        "alias": info.alias,
    })
}

// Spawning a console program from a GUI app on Windows pops up a cmd window
// unless CREATE_NO_WINDOW is set. These helpers centralise the cfg dance so
// call sites look identical across platforms.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn silent_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(target_os = "windows")]
fn silent_tokio_command(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}
#[cfg(not(target_os = "windows"))]
fn silent_tokio_command(program: &str) -> tokio::process::Command {
    tokio::process::Command::new(program)
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

/// Rewrite the HKCU context-menu registry entries with labels in the user's
/// chosen language. The NSIS installer writes a default (zh-CN) on install;
/// this runs on every app start and on language change so the menu text
/// follows the in-app setting rather than the installer-time locale.
#[cfg(target_os = "windows")]
pub fn sync_shell_context_menu(language: &str) {
    let data = i18n::get_lang_data(language);
    let label = data["shell.open"]
        .as_str()
        .unwrap_or("Open with Markon")
        .to_string();
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.to_string_lossy().to_string();

    // (registry_base, command_arg)
    let entries: &[(&str, &str)] = &[
        (r"Software\Classes\.md\shell\open_with_markon", "%1"),
        (r"Software\Classes\.markdown\shell\open_with_markon", "%1"),
        (r"Software\Classes\Directory\shell\open_with_markon", "%1"),
        (
            r"Software\Classes\Directory\Background\shell\open_with_markon",
            "%W",
        ),
    ];
    for (base, arg) in entries {
        let base_key = format!(r"HKCU\{base}");
        let cmd_key = format!(r"{base_key}\command");
        let _ = silent_command("reg")
            .args(["add", &base_key, "/f", "/ve", "/t", "REG_SZ", "/d", &label])
            .output();
        let _ = silent_command("reg")
            .args([
                "add",
                &base_key,
                "/f",
                "/v",
                "Icon",
                "/t",
                "REG_SZ",
                "/d",
                &format!("{exe},0"),
            ])
            .output();
        let _ = silent_command("reg")
            .args([
                "add",
                &cmd_key,
                "/f",
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &format!(r#""{exe}" "{arg}""#),
            ])
            .output();
    }
}

/// Port to ask the OS to bind: 0 (ephemeral) in Auto mode, the configured
/// port otherwise.
pub(crate) fn effective_port(settings: &AppSettings) -> u16 {
    if settings.port_mode == PortMode::Auto {
        0
    } else {
        settings.port
    }
}

/// RESPAWN the shared markon service from the current settings snapshot, then
/// broadcast the resulting status. Shared by save_settings and the server-level
/// access-code path. Because the service is shared, this restarts `markond` for
/// everyone connected — the UI warns before triggering these edits.
async fn respawn_service_and_broadcast(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let current = state.server.lock().unwrap().handle();
    let conn = service::respawn(&state.settings, current).await;
    let result = match conn.last_error() {
        Some(err) => Err(err),
        None => Ok(()),
    };
    *state.server.lock().unwrap() = conn;
    // Always broadcast — even on failure UI needs the new (host, error) so
    // the banner state and toast don't lag the persisted settings.
    let _ = app.emit("server-status-changed", server_status_payload(state));
    result
}

#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Preserve fields the settings form does not own. Workspaces (and their
    // per-workspace access codes) are persisted by the DAEMON's registry persist
    // hook on every control-socket mutation, so our in-memory snapshot's copy is a
    // stale boot-time list; the server-level access-code hash, trusted hosts, the
    // example-hidden flag, and the salt are written by dedicated commands / at
    // load time. Reload the persisted truth from disk and merge it in — otherwise
    // the form round-trip would clobber workspaces the daemon changed since boot,
    // silently dropping or resurrecting them on the next save + respawn.
    let persisted = AppSettings::load();
    let mut settings = settings;
    settings.workspaces = persisted.workspaces;
    settings.collaborator_access_code_hash = persisted.collaborator_access_code_hash;
    // The current GUI has no trusted-host editor; preserve manually configured
    // reverse-proxy/mDNS entries instead of treating an omitted field as clear.
    settings.trusted_hosts = persisted.trusted_hosts;
    settings.example_workspace_hidden = persisted.example_workspace_hidden;
    // The salt determines every workspace id and is never part of the settings
    // form, so the round-trip must preserve it — a dropped salt would reset all
    // workspace ids on the next launch.
    settings.salt = persisted.salt;

    // Decide whether the shared service actually needs a restart: only when a
    // field baked into its DaemonConfig (bind host/port, advertised host, access
    // code, db path, salt, web-facing render config, …) changed. Purely GUI-local
    // edits (update channel, chat keys, editor/theme defaults, web theme) must NOT
    // tear down the service for every connected user. The two configs are built
    // from the SAME (fresh) preserved fields, so they differ only by the user's
    // form edits — and a workspace change made over the control socket, already
    // applied live in the daemon, never triggers a spurious respawn.
    let need_respawn = {
        let baseline = {
            let current = state.settings.lock().unwrap();
            let mut baseline = current.clone();
            baseline.workspaces = settings.workspaces.clone();
            baseline.collaborator_access_code_hash = settings.collaborator_access_code_hash.clone();
            baseline.trusted_hosts = settings.trusted_hosts.clone();
            baseline.example_workspace_hidden = settings.example_workspace_hidden;
            baseline.salt = settings.salt.clone();
            baseline
        };
        service::daemon_config_from_settings(&settings, effective_port(&settings))
            != service::daemon_config_from_settings(&baseline, effective_port(&baseline))
    };

    update_tray_language(&app, &settings.language);

    #[cfg(target_os = "windows")]
    sync_shell_context_menu(&settings.language);

    // Merge daemon-owned fields again under the cross-process write lock. The
    // earlier read prepared the comparison, but a control-socket mutation may
    // have landed between that read and this write.
    settings.save_preserving_server_owned_state()?;
    *state.settings.lock().unwrap() = settings;

    if need_respawn {
        respawn_service_and_broadcast(&app, &state).await
    } else {
        // Nothing the running daemon bakes in changed: keep the shared service up
        // and just refresh the UI's status snapshot (host/port/error) so the
        // banner doesn't lag the persisted settings.
        let _ = app.emit("server-status-changed", server_status_payload(&state));
        Ok(())
    }
}

/// Build the tray menu (Settings… / separator / Quit) with labels in the
/// given language. Shared by the initial tray construction in `setup` and
/// `update_tray_language`.
pub(crate) fn build_tray_menu<M: tauri::Manager<tauri::Wry>>(
    app: &M,
    language: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let data = i18n::get_lang_data(language);
    let label_settings = data["tray.show"].as_str().unwrap_or("Settings…");
    let label_quit = data["tray.quit"].as_str().unwrap_or("Quit Markon");

    let item_settings = MenuItem::with_id(app, "settings", label_settings, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let item_quit = MenuItem::with_id(app, "quit", label_quit, true, None::<&str>)?;
    Menu::with_items(app, &[&item_settings, &sep, &item_quit])
}

fn update_tray_language(app: &tauri::AppHandle, language: &str) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    if let Ok(menu) = build_tray_menu(app, language) {
        let _ = tray.set_menu(Some(menu));
    }
}

// Workspace commands below just drive the registry; persistence
// to settings.json happens via the persist hook wired at server startup,
// so CLI (HTTP API) and GUI (Tauri API) paths share a single flow.

/// Build the featured browser/QR base URL for the *attached daemon*. Both the
/// bind host and the advertised host come from the running service's discovery
/// lock ([`RunningServer::host`] / [`RunningServer::advertised_host`]) — NOT the
/// GUI's own settings, which can differ when the GUI attached to a daemon
/// another process (a CLI, or a prior GUI) started with a different `--host` /
/// `--entry`. The GUI's `settings.host` / `settings.advertised_host` are only a
/// fallback for a socket-only handle or a pre-split lock, where the daemon
/// didn't record its own values (`daemon_host` empty / `daemon_advertised`
/// `None`).
fn browser_base_url_for_state(
    state: &State<AppState>,
    daemon_host: &str,
    daemon_advertised: Option<&str>,
    port: u16,
) -> String {
    let (fallback_host, fallback_advertised) = {
        let s = state.settings.lock().unwrap();
        (s.host.clone(), s.advertised_host.clone())
    };
    let bind_host = if daemon_host.is_empty() {
        fallback_host
    } else {
        daemon_host.to_string()
    };
    let advertised_host = match daemon_advertised {
        Some(h) => h.to_string(),
        None => fallback_advertised,
    };
    server::featured_base_url(&bind_host, &advertised_host, port)
}

fn is_example_workspace_path(path: &str) -> bool {
    let Some(example_path) = AppSettings::example_workspace_path() else {
        return false;
    };
    let example_path = expand_and_canonicalize(&example_path.to_string_lossy())
        .unwrap_or_else(|_| example_path.clone());
    let candidate = expand_and_canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    candidate == example_path
}

#[tauri::command]
pub async fn add_workspace(
    path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let canonical = expand_and_canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let flags = {
        let settings = state.settings.lock().unwrap();
        WorkspaceFlags {
            enable_search: settings.default_search,
            enable_viewed: settings.default_viewed,
            enable_edit: settings.default_edit,
            enable_live: settings.default_live,
            enable_chat: settings.default_chat,
            shared_annotation: settings.default_shared_annotation,
        }
    };
    // Pure frontend: register the directory over the service's control socket.
    let remote = require_service(&state)?;
    let path_str = canonical.to_string_lossy().to_string();
    let id = remote
        .add_or_update_workspace(&path_str, flags, None)
        .await
        .map_err(remote_err)?;
    let port = remote.port();
    let url = server::build_workspace_url(
        &browser_base_url_for_state(&state, remote.host(), remote.advertised_host(), port),
        &server::workspace_url_path(&id, None),
    );
    Ok(serde_json::json!({ "id": id, "url": url }))
}

fn flags_from_params(
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    enable_live: bool,
    enable_chat: bool,
    shared_annotation: bool,
) -> WorkspaceFlags {
    WorkspaceFlags {
        enable_search,
        enable_viewed,
        enable_edit,
        enable_live,
        enable_chat,
        shared_annotation,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceRequest {
    id: String,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    enable_live: bool,
    enable_chat: bool,
    shared_annotation: bool,
}

/// Update a workspace's feature flags in place over the service's control
/// socket. The daemon fires its persist hook, so the change is written to
/// settings and survives restart.
#[tauri::command]
pub async fn update_workspace(
    request: UpdateWorkspaceRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let flags = flags_from_params(
        request.enable_search,
        request.enable_viewed,
        request.enable_edit,
        request.enable_live,
        request.enable_chat,
        request.shared_annotation,
    );
    let remote = require_service(&state)?;
    remote
        .update_flags(&request.id, flags)
        .await
        .map_err(remote_err)
}

#[tauri::command]
pub async fn remove_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
    // `is_example` gates persisting the "example hidden" onboarding flag, so the
    // bundled sample doesn't re-appear after the user removes it.
    let remote = require_service(&state)?;
    let is_example = remote
        .list_workspaces()
        .await
        .map_err(remote_err)?
        .into_iter()
        .find(|info| info.id == id)
        .is_some_and(|info| is_example_workspace_path(&info.path));
    remote.remove_workspace(&id).await.map_err(remote_err)?;
    if is_example {
        let mut settings = state.settings.lock().unwrap();
        settings.example_workspace_hidden = true;
        settings.save_preserving_server_owned_state()?;
    }
    Ok(())
}

/// List all active workspaces with their IDs and URLs over the service's
/// control socket, mapped through the shared `workspace_panel_json`.
#[tauri::command]
pub async fn get_workspaces(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let remote = require_service(&state)?;
    let port = remote.port();
    let infos = remote.list_workspaces().await.map_err(remote_err)?;
    state
        .settings
        .lock()
        .unwrap()
        .sync_from_workspace_infos(infos.clone());
    let browser_base =
        browser_base_url_for_state(&state, remote.host(), remote.advertised_host(), port);
    Ok(infos
        .into_iter()
        .map(|info| workspace_panel_json(info, &browser_base))
        .collect())
}

/// Set (or clear, with an empty string) a workspace's alias over the service's
/// control socket (SetAlias). Per-workspace and live; the daemon persists via
/// its hook, no restart.
#[tauri::command]
pub async fn set_alias(
    workspace_id: String,
    alias: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let remote = require_service(&state)?;
    remote
        .set_alias(&workspace_id, alias.trim())
        .await
        .map_err(remote_err)
}

#[tauri::command]
pub async fn open_url(url: String, state: State<'_, AppState>) -> Result<(), String> {
    let (remote, base) = {
        let server = state.server.lock().unwrap();
        let handle = server.handle();
        let daemon_host = handle
            .as_ref()
            .map(|r| r.host().to_string())
            .unwrap_or_default();
        let daemon_advertised = handle
            .as_ref()
            .and_then(|r| r.advertised_host().map(str::to_string));
        let base = browser_base_url_for_state(
            &state,
            &daemon_host,
            daemon_advertised.as_deref(),
            server.port(),
        );
        (handle, base)
    };
    let markon_prefix = format!("{}/", base.trim_end_matches('/'));
    // A markon URL is opened with a one-time administrator fragment minted by
    // the service over the control socket, so the local browser upgrades the
    // final page in place. Non-markon URLs (and the detached case) open as-is.
    let target = match remote {
        Some(remote) if url.starts_with(&markon_prefix) => {
            let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
            let mut redirect = parsed.path().to_string();
            if let Some(query) = parsed.query() {
                redirect.push('?');
                redirect.push_str(query);
            }
            remote
                .admin_bootstrap(&redirect)
                .await
                .map_err(remote_err)?
        }
        _ => url,
    };
    open::that(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_bind_hosts() -> Vec<BindHostOption> {
    available_bind_hosts()
}

#[tauri::command]
pub fn get_server_status(state: State<AppState>) -> serde_json::Value {
    server_status_payload(&state)
}

#[tauri::command]
pub async fn pick_workspace_dir() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select workspace folder")
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

#[tauri::command]
pub fn get_system_info() -> serde_json::Value {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os_version = os_version_string();
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string());
    serde_json::json!({
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": os,
        "os_version": os_version,
        "arch": arch,
        "locale": locale,
    })
}

#[cfg(target_os = "macos")]
fn os_version_string() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(target_os = "windows")]
fn os_version_string() -> String {
    silent_command("cmd")
        .args(["/C", "ver"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_version_string() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|content| {
            content.lines().find_map(|l| {
                l.strip_prefix("PRETTY_NAME=")
                    .map(|v| v.trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[tauri::command]
pub async fn pick_db_path(current_path: Option<String>) -> Option<String> {
    let current_path = current_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let fallback_dir = dirs::home_dir()
        .map(|home| home.join(".markon"))
        .unwrap_or_else(|| PathBuf::from("."));
    let directory = current_path
        .as_ref()
        .and_then(|path| path.parent().map(PathBuf::from))
        .filter(|path| path.is_dir())
        .unwrap_or(fallback_dir);
    let file_name = current_path
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("annotation.sqlite");
    let _ = std::fs::create_dir_all(&directory);

    rfd::AsyncFileDialog::new()
        .set_title("Select annotation database")
        .add_filter("SQLite", &["sqlite", "db", "sqlite3"])
        .set_directory(directory)
        .set_file_name(file_name)
        .save_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

fn updater_endpoint(channel: &str) -> String {
    let file = if channel.eq_ignore_ascii_case("rc") {
        "latest-rc.json"
    } else {
        "latest.json"
    };
    format!("https://github.com/{MARKON_REPO}/releases/download/updater/{file}")
}

#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let channel = state.settings.lock().unwrap().update_channel.clone();
    let endpoint: url::Url = updater_endpoint(&channel)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            return Ok(serde_json::json!({
                "available": false,
                "current": env!("CARGO_PKG_VERSION"),
                "channel": channel,
            }))
        }
        Err(e) => return Ok(serde_json::json!({ "available": false, "error": e.to_string() })),
    };
    let latest = update.version.clone();
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => Ok(serde_json::json!({
            "available": true,
            "current": env!("CARGO_PKG_VERSION"),
            "latest": latest,
            "channel": channel,
            "installed": true,
        })),
        Err(e) => Ok(serde_json::json!({
            "available": true,
            "current": env!("CARGO_PKG_VERSION"),
            "latest": latest,
            "channel": channel,
            "installed": false,
            "error": e.to_string(),
        })),
    }
}

#[tauri::command]
pub fn get_i18n() -> serde_json::Value {
    i18n::all_i18n_with_languages()
}

#[tauri::command]
pub fn list_fonts() -> Vec<String> {
    use font_kit::source::SystemSource;
    let families = match SystemSource::new().all_families() {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("list_fonts: SystemSource::all_families failed: {e}");
            return Vec::new();
        }
    };
    let mut fonts: Vec<String> = families
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    fonts.sort();
    fonts.dedup();
    fonts
}

async fn gh_available() -> bool {
    silent_tokio_command("gh")
        .args(["auth", "status"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn star_repo() -> bool {
    if !gh_available().await {
        return false;
    }
    let result = silent_tokio_command("gh")
        .args(["api", "-X", "PUT", &format!("user/starred/{MARKON_REPO}")])
        .output()
        .await;
    matches!(result, Ok(output) if output.status.success())
}

/// Fetch the list of chat-capable models from the configured provider.
/// Used by the settings panel's "refresh" button next to the model field.
#[tauri::command]
pub async fn list_chat_models(
    provider: String,
    api_key: String,
    base_url: String,
) -> Result<Vec<String>, String> {
    let kind = ProviderKind::parse(&provider);
    models::list_models(kind, &api_key, &base_url).await
}

/// Set or clear a workspace's collaborator access code. `workspace_id`
/// None/empty → the server-level code, which is baked into the daemon's config,
/// so changing it RESPAWNS the shared service (the UI warns first). Otherwise the
/// named workspace's code is updated live over the control socket. An empty
/// `code` clears. The plaintext is hashed here (salted) and never stored.
#[tauri::command]
pub async fn set_collaborator_access_code(
    workspace_id: Option<String>,
    code: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let salt = state.settings.lock().unwrap().salt.clone();
    let code = code.trim().to_string();
    markon_core::workspace::validate_access_code(&code)?;
    let hash = if code.is_empty() {
        String::new()
    } else {
        // The shared per-install salt makes this digest valid on the service, so
        // a control-socket set works without re-hashing.
        markon_core::workspace::hash_access_code(&salt, &code)
    };
    match workspace_id {
        Some(id) if !id.is_empty() => {
            // Per-workspace: live update over the control socket.
            let remote = require_service(&state)?;
            // Always send the hash (even the empty string) so clearing works:
            // `Some("")` reaches the server and resets the code, whereas `None`
            // would serialize to `{}` and leave the existing code untouched.
            remote
                .set_access_code(&id, Some(hash.as_str()))
                .await
                .map_err(remote_err)
        }
        _ => {
            // Server-level code: persisted, then applied by respawning the shared
            // service (it's a daemon-config field, not a live control endpoint).
            {
                let mut s = state.settings.lock().unwrap();
                s.save_collaborator_access_code(hash)?;
            }
            respawn_service_and_broadcast(&app, &state).await
        }
    }
}

/// Re-establish the connection to the markon service: attach to an already-
/// running `markond` (forwarding this install's persisted directory workspaces)
/// or spawn a fresh one. Used to recover after the service was restarted or
/// briefly unreachable, and as the disconnected-state recovery action.
#[tauri::command]
pub async fn reconnect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let conn = service::attach_or_spawn(&state.settings).await;
    let result = match conn.last_error() {
        Some(err) => Err(err),
        None => Ok(serde_json::json!({ "mode": conn.mode(), "port": conn.port() })),
    };
    *state.server.lock().unwrap() = conn;
    let _ = app.emit("server-status-changed", server_status_payload(&state));
    result
}

#[tauri::command]
pub fn set_tray_resident(
    value: bool,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    state.tray_resident.store(value, Ordering::Relaxed);
    let mut settings = state.settings.lock().unwrap();
    settings.tray_resident = value;
    settings.save_preserving_server_owned_state()?;
    drop(settings);
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(value).map_err(|e| e.to_string())?;
    }
    Ok(())
}
