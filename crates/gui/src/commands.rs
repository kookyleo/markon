use crate::server_manager::{ServerBackend, ServerManager};
use crate::AppState;
use markon_core::chat::{config::ProviderKind, models};
use markon_core::control::{ControlError, RunningServer};
use markon_core::i18n;
use markon_core::net::{available_bind_hosts, host_in_list, BindHostOption};
use markon_core::server;
use markon_core::settings::{AppSettings, PortMode};
use markon_core::workspace::{
    expand_and_canonicalize, WorkspaceConfig, WorkspaceFlags, WorkspaceInfo,
};
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
    let configured_host = state.settings.lock().unwrap().host.clone();
    let is_remote = server.is_remote();
    let bind_host = match &*server {
        ServerBackend::Remote(remote) if !remote.bind_host().trim().is_empty() => {
            remote.bind_host().to_string()
        }
        _ => configured_host,
    };
    // In remote mode this GUI doesn't bind anything, so the local bind-host
    // availability check is meaningless — report available so no stale banner
    // shows. The frontend keys off `mode` to render the connection state.
    let host_available = if is_remote {
        true
    } else {
        host_in_list(&bind_host, &available_bind_hosts())
    };
    serde_json::json!({
        "running": server.is_running(),
        "error": server.last_error(),
        "host": bind_host,
        "port": server.port(),
        "host_available": host_available,
        "mode": server.mode(),
    })
}

/// Distinguishable error prefix for a failed remote-control call, so the
/// frontend can surface the reconnect / start-local recovery affordances.
fn remote_err(e: ControlError) -> String {
    format!("remote-server-error: {e}")
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

/// (Re)start the server from the current settings snapshot and broadcast the
/// resulting status. Shared by save_settings and set_access_code.
fn restart_server_and_broadcast(
    app: &tauri::AppHandle,
    state: &State<AppState>,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    let config = settings.to_server_config(effective_port(&settings));
    let persist = AppSettings::persist_hook(state.settings.clone());
    // Only an embedded server has a lifecycle we own. In remote mode there is
    // nothing to (re)start — the settings that would rebind a server don't
    // apply to a server another process is running; just re-broadcast status.
    let start_result = match &mut *state.server.lock().unwrap() {
        ServerBackend::Embedded(m) => m.start(config, Some(persist)),
        ServerBackend::Remote(_) => Ok(()),
    };
    // Always broadcast — even on failure UI needs the new (host, error) so
    // the banner state and toast don't lag the persisted settings.
    let _ = app.emit("server-status-changed", server_status_payload(state));
    start_result
}

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // Preserve existing workspaces (managed separately via the
    // add/remove/update commands) and the collaborator access-code hash (set
    // via the dedicated command, which hashes the plaintext, never through the
    // settings form) — the form round-trip must not clobber them.
    let (
        existing_workspaces,
        existing_collaborator_access_code,
        existing_trusted_hosts,
        example_workspace_hidden,
        existing_salt,
    ) = {
        let s = state.settings.lock().unwrap();
        (
            s.workspaces.clone(),
            s.collaborator_access_code_hash.clone(),
            s.trusted_hosts.clone(),
            s.example_workspace_hidden,
            s.salt.clone(),
        )
    };
    let mut settings = settings;
    settings.workspaces = existing_workspaces;
    settings.collaborator_access_code_hash = existing_collaborator_access_code;
    // The current GUI has no trusted-host editor; preserve manually configured
    // reverse-proxy/mDNS entries instead of treating an omitted field as clear.
    settings.trusted_hosts = existing_trusted_hosts;
    settings.example_workspace_hidden = example_workspace_hidden;
    // The salt determines every workspace id and is never part of the settings
    // form, so the round-trip must preserve it — a dropped salt would reset all
    // workspace ids on the next launch.
    settings.salt = existing_salt;

    update_tray_language(&app, &settings.language);

    #[cfg(target_os = "windows")]
    sync_shell_context_menu(&settings.language);

    settings.save_preserving_server_owned_state()?;
    *state.settings.lock().unwrap() = settings;
    restart_server_and_broadcast(&app, &state)
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

fn browser_base_url_for_state(
    state: &State<AppState>,
    port: u16,
    server_bind_host: Option<&str>,
    server_advertised_host: Option<&str>,
) -> String {
    let (bind_host, advertised_host) = {
        let s = state.settings.lock().unwrap();
        (s.host.clone(), s.advertised_host.clone())
    };
    let bind_host = server_bind_host
        .filter(|host| !host.trim().is_empty())
        .unwrap_or(&bind_host);
    let advertised_host = server_advertised_host.unwrap_or(&advertised_host);
    server::featured_base_url(bind_host, advertised_host, port)
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
    // Embedded: add to the in-process registry under the lock. Remote: clone the
    // handle out, drop the (non-Send) guard, then await the control call.
    enum Dispatch {
        Embedded(String, u16),
        Remote(RunningServer),
    }
    let dispatch = {
        let backend = state.server.lock().unwrap();
        match &*backend {
            ServerBackend::Embedded(m) => {
                let id = m.registry.add(WorkspaceConfig {
                    path: canonical.clone(),
                    flags,
                    single_file: None,
                    collaborator_access_code_hash: String::new(),
                    alias: String::new(),
                });
                Dispatch::Embedded(id, m.port())
            }
            ServerBackend::Remote(r) => Dispatch::Remote(r.clone()),
        }
    };
    let (id, browser_base) = match dispatch {
        Dispatch::Embedded(id, port) => (id, browser_base_url_for_state(&state, port, None, None)),
        Dispatch::Remote(remote) => {
            let path_str = canonical.to_string_lossy().to_string();
            let id = remote
                .add_or_update_workspace(&path_str, flags, true, None, None, None)
                .await
                .map_err(remote_err)?;
            let browser_base = browser_base_url_for_state(
                &state,
                remote.port(),
                Some(remote.bind_host()),
                remote.advertised_host(),
            );
            (id, browser_base)
        }
    };
    let url = server::build_workspace_url(&browser_base, &server::workspace_url_path(&id, None));
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

/// Update a workspace's feature flags in place. `registry.update_flags` fires
/// the persist hook, so the change is written to settings and survives restart.
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
    let remote = {
        let backend = state.server.lock().unwrap();
        match &*backend {
            ServerBackend::Embedded(m) => {
                if !m.registry.update_flags(&request.id, flags) {
                    return Err(format!("Workspace {} not found", request.id));
                }
                return Ok(());
            }
            ServerBackend::Remote(r) => r.clone(),
        }
    };
    remote
        .update_flags(&request.id, flags)
        .await
        .map_err(remote_err)
}

#[tauri::command]
pub async fn remove_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
    // `is_example` gates persisting the "example hidden" onboarding flag, so the
    // bundled sample doesn't re-appear after the user removes it.
    let remote = {
        let backend = state.server.lock().unwrap();
        match &*backend {
            ServerBackend::Embedded(m) => {
                let is_example = m
                    .registry
                    .info_list()
                    .into_iter()
                    .find(|info| info.id == id)
                    .is_some_and(|info| is_example_workspace_path(&info.path));
                if !m.registry.remove(&id) {
                    return Err(format!("Workspace {id} not found"));
                }
                drop(backend);
                if is_example {
                    let mut settings = state.settings.lock().unwrap();
                    settings.example_workspace_hidden = true;
                    settings.save_preserving_server_owned_state()?;
                }
                return Ok(());
            }
            ServerBackend::Remote(r) => r.clone(),
        }
    };
    let is_example = remote
        .list_workspaces()
        .await
        .map_err(remote_err)?
        .into_iter()
        .find(|info| info.id == id)
        .is_some_and(|info| is_example_workspace_path(&info.path));
    remote.remove_workspace(&id).await.map_err(remote_err)?;
    let infos = remote.list_workspaces().await.map_err(remote_err)?;
    {
        let mut settings = state.settings.lock().unwrap();
        settings.sync_from_workspace_infos(infos);
        if is_example {
            settings.example_workspace_hidden = true;
            settings.save_preserving_server_owned_state()?;
        }
    }
    Ok(())
}

/// List all active workspaces with their IDs and URLs. Works in both modes via
/// the shared `workspace_panel_json` mapping over `WorkspaceInfo`.
#[tauri::command]
pub async fn get_workspaces(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    enum Dispatch {
        Embedded(u16, Vec<WorkspaceInfo>),
        Remote(RunningServer, u16),
    }
    let dispatch = {
        let backend = state.server.lock().unwrap();
        match &*backend {
            ServerBackend::Embedded(m) => Dispatch::Embedded(m.port(), m.registry.info_list()),
            ServerBackend::Remote(r) => Dispatch::Remote(r.clone(), r.port()),
        }
    };
    let (port, infos, server_bind_host, server_advertised_host) = match dispatch {
        Dispatch::Embedded(port, infos) => (port, infos, None, None),
        Dispatch::Remote(remote, port) => {
            let infos = remote.list_workspaces().await.map_err(remote_err)?;
            state
                .settings
                .lock()
                .unwrap()
                .sync_from_workspace_infos(infos.clone());
            (
                port,
                infos,
                Some(remote.bind_host().to_string()),
                remote.advertised_host().map(str::to_string),
            )
        }
    };
    let browser_base = browser_base_url_for_state(
        &state,
        port,
        server_bind_host.as_deref(),
        server_advertised_host.as_deref(),
    );
    Ok(infos
        .into_iter()
        .map(|info| workspace_panel_json(info, &browser_base))
        .collect())
}

/// Set (or clear, with an empty string) a workspace's alias. Per-workspace and
/// live — updates the shared registry (persists via its hook), no restart.
#[tauri::command]
pub async fn set_alias(
    workspace_id: String,
    alias: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let remote = {
        let backend = state.server.lock().unwrap();
        match &*backend {
            ServerBackend::Embedded(m) => {
                return if m.registry.set_alias(&workspace_id, alias.trim()) {
                    Ok(())
                } else {
                    Err("workspace not found".into())
                };
            }
            ServerBackend::Remote(remote) => remote.clone(),
        }
    };
    remote
        .set_alias(&workspace_id, alias.trim())
        .await
        .map_err(remote_err)
}

#[tauri::command]
pub fn open_url(url: String, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    let (remote_host, remote_advertised_host) = match &*server {
        ServerBackend::Remote(remote) => (Some(remote.bind_host()), remote.advertised_host()),
        ServerBackend::Embedded(_) => (None, None),
    };
    let base =
        browser_base_url_for_state(&state, server.port(), remote_host, remote_advertised_host);
    let markon_prefix = format!("{}/", base.trim_end_matches('/'));
    // Only an embedded server can mint a one-time admin bootstrap (its
    // AdminBootstrapStore). For a remote server, bootstrap belongs to the owning
    // process, so open the plain URL (no admin session) instead of rewriting.
    let target = match &*server {
        ServerBackend::Embedded(m) if url.starts_with(&markon_prefix) => {
            let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
            let mut redirect = parsed.path().to_string();
            if let Some(query) = parsed.query() {
                redirect.push('?');
                redirect.push_str(query);
            }
            m.admin_url(&base, &redirect)
        }
        _ => url,
    };
    drop(server);
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
/// None/empty → the server-level code (needs a server restart so the running
/// AppState picks it up); otherwise the named workspace's code is updated live
/// on the registry. An empty `code` clears. The plaintext is hashed here
/// (salted) and never stored.
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
        // The shared per-install salt makes this digest valid on a server
        // another process started, so a remote set works without re-hashing.
        markon_core::workspace::hash_access_code(&salt, &code)
    };
    match workspace_id {
        Some(id) if !id.is_empty() => {
            // Per-workspace: live update. Embedded mutates the shared registry
            // (persists via its hook); remote pushes over the control API.
            let remote = {
                let backend = state.server.lock().unwrap();
                match &*backend {
                    ServerBackend::Embedded(m) => {
                        return if m.registry.set_collaborator_access_code(&id, &hash) {
                            Ok(())
                        } else {
                            Err("workspace not found".into())
                        };
                    }
                    ServerBackend::Remote(r) => r.clone(),
                }
            };
            // Always send the hash (even the empty string) so clearing works:
            // `Some("")` reaches the server and resets the code, whereas `None`
            // would serialize to `{}` and leave the existing code untouched.
            remote
                .set_access_code(&id, Some(hash.as_str()))
                .await
                .map_err(remote_err)
        }
        _ => {
            // Server-level code. Embedded persists + restarts so the new
            // AppState carries it. A remote server has no control API for its
            // server-level code — that needs the owning process's own restart —
            // so it's unsupported here (the UI disables the editor in remote
            // mode; this guards the command path too).
            if state.server.lock().unwrap().is_remote() {
                return Err(
                    "the server-level access code can't be changed while connected to an \
                     external server; set it on that server, or start a local server"
                        .into(),
                );
            }
            {
                let mut s = state.settings.lock().unwrap();
                s.collaborator_access_code_hash = hash;
                s.save()?;
            }
            restart_server_and_broadcast(&app, &state)
        }
    }
}

/// Re-probe for a running server and, if one is up, (re)attach as a controller
/// (Remote mode), forwarding this install's persisted workspaces with their
/// directory/single-file scopes intact. Used to recover after a remote server
/// was restarted or briefly unreachable. Errors when no server is found (the
/// frontend then offers "start a local server").
#[tauri::command]
pub async fn reconnect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let Some(remote) = RunningServer::discover() else {
        return Err("no running markon server found".into());
    };
    // TCP reachability alone is not identity: a stale lock's port may have been
    // reused by an unrelated process. Authenticate one management request
    // before switching the GUI into Remote mode.
    remote.list_workspaces().await.map_err(remote_err)?;
    let to_forward = {
        let s = state.settings.lock().unwrap();
        s.workspaces.clone()
    };
    for workspace in to_forward {
        remote
            .add_or_update_workspace(
                &workspace.path,
                workspace.flags,
                true,
                workspace.single_file.as_deref(),
                (!workspace.collaborator_access_code_hash.is_empty())
                    .then_some(workspace.collaborator_access_code_hash.as_str()),
                Some(&workspace.alias),
            )
            .await
            .map_err(remote_err)?;
    }
    let infos = remote.list_workspaces().await.map_err(remote_err)?;
    state
        .settings
        .lock()
        .unwrap()
        .sync_from_workspace_infos(infos);
    let port = remote.port();
    *state.server.lock().unwrap() = ServerBackend::Remote(remote);
    let _ = app.emit("server-status-changed", server_status_payload(&state));
    Ok(serde_json::json!({ "mode": "remote", "port": port }))
}

/// Transition to owning an in-process (Embedded) server, starting one from the
/// current settings. Used when the user wants their own server after a remote
/// died (no auto-takeover). Dropping any prior Remote handle does NOT stop the
/// remote — only Embedded owns a lifecycle.
#[tauri::command]
pub fn start_local_server(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    // Enforce the single-server invariant at the command, not just the UI: if a
    // server is live (e.g. a different daemon came up while we were
    // disconnected), starting our own would clobber the machine lock and orphan
    // it. Refuse and steer the user to reconnect.
    if RunningServer::discover().is_some() {
        return Err(
            "a markon server is already running — use Reconnect instead of starting a second one"
                .into(),
        );
    }
    let settings = state.settings.lock().unwrap().clone();
    let config = settings.to_server_config(effective_port(&settings));
    let persist = AppSettings::persist_hook(state.settings.clone());
    let mut manager = ServerManager::new();
    let result = manager.start(config, Some(persist));
    *state.server.lock().unwrap() = ServerBackend::Embedded(manager);
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
