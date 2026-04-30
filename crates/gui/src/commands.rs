use crate::AppState;
use markon_core::chat::{config::ProviderKind, models};
use markon_core::i18n;
use markon_core::settings::{AppSettings, PortMode};
use markon_core::workspace::{expand_and_canonicalize, WorkspaceConfig, WorkspaceFlags};
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::State;
use tauri_plugin_updater::UpdaterExt;

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
#[cfg(not(target_os = "windows"))]
fn silent_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
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

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // Preserve existing workspaces — they are managed separately via add/remove/update commands.
    let existing_workspaces = state.settings.lock().unwrap().workspaces.clone();
    let mut settings = settings;
    settings.workspaces = existing_workspaces;

    update_tray_language(&app, &settings.language);

    #[cfg(target_os = "windows")]
    sync_shell_context_menu(&settings.language);

    settings.save()?;
    let port = if settings.port_mode == PortMode::Auto {
        0
    } else {
        settings.port
    };
    let config = settings.to_server_config(port);
    *state.settings.lock().unwrap() = settings;
    let persist = AppSettings::persist_hook(state.settings.clone());
    state.server.lock().unwrap().start(config, Some(persist));
    Ok(())
}

fn update_tray_language(app: &tauri::AppHandle, language: &str) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let data = i18n::get_lang_data(language);
    let label_settings = data["tray.show"].as_str().unwrap_or("Settings…");
    let label_quit = data["tray.quit"].as_str().unwrap_or("Quit Markon");

    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let item_settings = MenuItem::with_id(app, "settings", label_settings, true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let item_quit = MenuItem::with_id(app, "quit", label_quit, true, None::<&str>)?;
        Menu::with_items(app, &[&item_settings, &sep, &item_quit])
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

// All three workspace commands below just drive the registry; persistence
// to settings.json happens via the persist hook wired at server startup,
// so CLI (HTTP API) and GUI (Tauri API) paths share a single flow.

// Tauri commands take flat scalar args (no struct), so add/update repeat
// the six bool params; this helper packs them once.
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

#[tauri::command]
pub fn add_workspace(
    path: String,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    enable_live: bool,
    enable_chat: bool,
    shared_annotation: bool,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let canonical = expand_and_canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let flags = flags_from_params(
        enable_search,
        enable_viewed,
        enable_edit,
        enable_live,
        enable_chat,
        shared_annotation,
    );
    let server = state.server.lock().unwrap();
    let id = server.registry.add(WorkspaceConfig {
        path: canonical,
        flags,
        single_file: None,
    });
    let url = format!("http://127.0.0.1:{}/{id}/", server.port());
    Ok(serde_json::json!({ "id": id, "url": url }))
}

#[tauri::command]
pub fn update_workspace(
    id: String,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    enable_live: bool,
    enable_chat: bool,
    shared_annotation: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let flags = flags_from_params(
        enable_search,
        enable_viewed,
        enable_edit,
        enable_live,
        enable_chat,
        shared_annotation,
    );
    let server = state.server.lock().unwrap();
    if !server.registry.update_flags(&id, flags) {
        return Err(format!("Workspace {id} not found"));
    }
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(id: String, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    if !server.registry.remove(&id) {
        return Err(format!("Workspace {id} not found"));
    }
    Ok(())
}

/// List all active workspaces with their IDs and URLs.
#[tauri::command]
pub fn get_workspaces(state: State<AppState>) -> Vec<serde_json::Value> {
    let server = state.server.lock().unwrap();
    let port = server.port();
    server
        .registry
        .info_list()
        .into_iter()
        .map(|info| {
            let url = format!("http://127.0.0.1:{port}/{}/", info.id);
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
                "search_ready": info.search_ready,
            })
        })
        .collect()
}

#[tauri::command]
pub fn open_browser(path: Option<String>, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    if server.is_running() {
        let url = match path {
            Some(p) => format!("http://127.0.0.1:{}{}", server.port(), p),
            None => format!("http://127.0.0.1:{}/", server.port()),
        };
        open::that(url).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
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
pub async fn pick_db_path() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select annotation database")
        .add_filter("SQLite", &["sqlite", "db", "sqlite3"])
        .set_file_name("annotation.sqlite")
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
    format!("https://github.com/kookyleo/markon/releases/download/updater/{file}")
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
            eprintln!("list_fonts: SystemSource::all_families failed: {e}");
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

const MARKON_REPO: &str = "kookyleo/markon";

fn gh_available() -> bool {
    silent_command("gh")
        .args(["auth", "status"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn star_repo() -> bool {
    if !gh_available() {
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
