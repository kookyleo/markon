use crate::AppState;
use markon_core::chat::{config::ProviderKind, models};
use markon_core::i18n;
use markon_core::net::{available_bind_hosts, host_in_list, BindHostOption};
use markon_core::server;
use markon_core::settings::{AppSettings, PortMode};
use markon_core::workspace::{expand_and_canonicalize, WorkspaceConfig, WorkspaceFlags};
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
    let hosts = available_bind_hosts();
    let host_available = host_in_list(&bind_host, &hosts);
    serde_json::json!({
        "running": server.is_running(),
        "error": server.last_error(),
        "host": bind_host,
        "port": server.port(),
        "host_available": host_available,
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
    let start_result = state.server.lock().unwrap().start(config, Some(persist));
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

    settings.save()?;
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

fn browser_base_url_for_state(state: &State<AppState>, port: u16) -> String {
    let (bind_host, advertised_host) = {
        let s = state.settings.lock().unwrap();
        (s.host.clone(), s.advertised_host.clone())
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
pub fn add_workspace(path: String, state: State<AppState>) -> Result<serde_json::Value, String> {
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
    let server = state.server.lock().unwrap();
    let id = server.registry.add(WorkspaceConfig {
        path: canonical,
        flags,
        single_file: None,
        collaborator_access_code_hash: String::new(),
        alias: String::new(),
    });
    let port = server.port();
    drop(server);
    let url = server::build_workspace_url(
        &browser_base_url_for_state(&state, port),
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

/// Update a workspace's feature flags in place. `registry.update_flags` fires
/// the persist hook, so the change is written to settings and survives restart.
#[tauri::command]
pub fn update_workspace(
    request: UpdateWorkspaceRequest,
    state: State<AppState>,
) -> Result<(), String> {
    let flags = flags_from_params(
        request.enable_search,
        request.enable_viewed,
        request.enable_edit,
        request.enable_live,
        request.enable_chat,
        request.shared_annotation,
    );
    let server = state.server.lock().unwrap();
    if !server.registry.update_flags(&request.id, flags) {
        return Err(format!("Workspace {} not found", request.id));
    }
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(id: String, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    let is_example = server
        .registry
        .info_list()
        .into_iter()
        .find(|info| info.id == id)
        .is_some_and(|info| is_example_workspace_path(&info.path));
    if !server.registry.remove(&id) {
        return Err(format!("Workspace {id} not found"));
    }
    drop(server);
    if is_example {
        let mut settings = state.settings.lock().unwrap();
        settings.example_workspace_hidden = true;
        settings.save()?;
    }
    Ok(())
}

/// List all active workspaces with their IDs and URLs.
#[tauri::command]
pub fn get_workspaces(state: State<AppState>) -> Vec<serde_json::Value> {
    let (port, workspaces) = {
        let server = state.server.lock().unwrap();
        (server.port(), server.registry.info_list())
    };
    let browser_base = browser_base_url_for_state(&state, port);
    workspaces
        .into_iter()
        .map(|info| {
            let url = server::build_workspace_url(
                &browser_base,
                &server::workspace_url_path(&info.id, None),
            );
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
                // Length of the per-workspace collaborator access code, 0 =
                // none. The stored hash length equals the code length (see
                // workspace::hash_access_code), so the panel both detects "code
                // set" and renders that many • in the indicator token. Not the
                // digest itself.
                "collaborator_access_code_len": info.collaborator_access_code_hash.chars().count(),
                "search_ready": info.search_ready,
                // Surfaced so the Settings UI can filter out Open-With
                // single-file workspaces (see `ui/index.html: refreshWorkspaces`).
                "ephemeral": info.ephemeral,
                "single_file": info.single_file,
                // Optional short display name (empty = none).
                "alias": info.alias,
            })
        })
        .collect()
}

/// Set (or clear, with an empty string) a workspace's alias. Per-workspace and
/// live — updates the shared registry (persists via its hook), no restart.
#[tauri::command]
pub fn set_alias(
    workspace_id: String,
    alias: String,
    state: State<AppState>,
) -> Result<(), String> {
    if state
        .server
        .lock()
        .unwrap()
        .registry
        .set_alias(&workspace_id, alias.trim())
    {
        Ok(())
    } else {
        Err("workspace not found".into())
    }
}

#[tauri::command]
pub fn open_url(url: String, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    let base = browser_base_url_for_state(&state, server.port());
    let markon_prefix = format!("{}/", base.trim_end_matches('/'));
    let target = if url.starts_with(&markon_prefix) {
        let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
        let mut redirect = parsed.path().to_string();
        if let Some(query) = parsed.query() {
            redirect.push('?');
            redirect.push_str(query);
        }
        server.admin_url(&base, &redirect)
    } else {
        url
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
pub fn set_collaborator_access_code(
    workspace_id: Option<String>,
    code: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let salt = state.settings.lock().unwrap().salt.clone();
    let code = code.trim();
    let hash = if code.is_empty() {
        String::new()
    } else {
        markon_core::workspace::hash_access_code(&salt, code)
    };
    match workspace_id {
        Some(id) if !id.is_empty() => {
            // Per-workspace: live update on the shared registry (persists via
            // the registry's persist hook). No restart needed.
            if state
                .server
                .lock()
                .unwrap()
                .registry
                .set_collaborator_access_code(&id, &hash)
            {
                Ok(())
            } else {
                Err("workspace not found".into())
            }
        }
        _ => {
            // Server-level: persist + restart so the new AppState carries it.
            {
                let mut s = state.settings.lock().unwrap();
                s.collaborator_access_code_hash = hash;
                s.save()?;
            }
            restart_server_and_broadcast(&app, &state)
        }
    }
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
    settings.save()?;
    drop(settings);
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(value).map_err(|e| e.to_string())?;
    }
    Ok(())
}
