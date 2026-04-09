use crate::settings::{AppSettings, PortMode, WorkspaceSettings};
use crate::AppState;
use markon_core::workspace::WorkspaceConfig;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::State;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(settings: AppSettings, state: State<AppState>) -> Result<(), String> {
    // Preserve existing workspaces — they are managed separately via add/remove/update commands.
    let existing_workspaces = state.settings.lock().unwrap().workspaces.clone();
    let mut settings = settings;
    settings.workspaces = existing_workspaces;

    settings.save()?;
    let port = if settings.port_mode == PortMode::Auto { 0 } else { settings.port };
    let config = settings.to_server_config(port);
    *state.settings.lock().unwrap() = settings;
    state.server.lock().unwrap().start(config);
    Ok(())
}

/// Add a workspace directory to the running server. Returns the workspace ID and URL.
#[tauri::command]
pub fn add_workspace(
    path: String,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    shared_annotation: bool,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    // Expand leading ~ (ASCII) or ～ (full-width, macOS IME) to home directory.
    let normalized = if path.starts_with('～') {
        path.replacen('～', "~", 1)
    } else {
        path.clone()
    };
    let expanded = if normalized.starts_with("~/") || normalized == "~" {
        let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
        if normalized == "~" {
            home
        } else {
            home.join(&normalized[2..])
        }
    } else {
        PathBuf::from(&normalized)
    };
    let canonical = expanded
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;

    let canonical_str = canonical.to_string_lossy().to_string();

    let server = state.server.lock().unwrap();
    let id = server.registry.add(WorkspaceConfig {
        path: canonical,
        enable_search,
        enable_viewed,
        enable_edit,
        shared_annotation,
    });
    let port = server.port();
    let url = format!("http://127.0.0.1:{port}/{id}/");

    // Persist to settings (use canonical path so restarts don't break)
    drop(server);
    let mut settings = state.settings.lock().unwrap();
    settings.workspaces.push(WorkspaceSettings {
        path: canonical_str,
        enable_search,
        enable_viewed,
        enable_edit,
        shared_annotation,
    });
    settings.save().ok();

    Ok(serde_json::json!({ "id": id, "url": url }))
}

/// Update feature flags for an existing workspace (takes effect immediately, persists to settings).
#[tauri::command]
pub fn update_workspace(
    id: String,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    shared_annotation: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    let ws = server.registry.get(&id).ok_or_else(|| format!("Workspace {id} not found"))?;
    let ws_path = ws.root.to_string_lossy().to_string();
    server.registry.update_flags(&id, enable_search, enable_viewed, enable_edit, shared_annotation);
    drop(server);

    let mut settings = state.settings.lock().unwrap();
    if let Some(entry) = settings.workspaces.iter_mut().find(|w| w.path == ws_path) {
        entry.enable_search = enable_search;
        entry.enable_viewed = enable_viewed;
        entry.enable_edit = enable_edit;
        entry.shared_annotation = shared_annotation;
    }
    settings.save().ok();
    Ok(())
}

/// Remove a workspace from the running server.
#[tauri::command]
pub fn remove_workspace(id: String, state: State<AppState>) -> Result<(), String> {
    let server = state.server.lock().unwrap();
    let removed = server.registry.remove(&id);
    if !removed {
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
                "enable_search": info.enable_search,
                "enable_viewed": info.enable_viewed,
                "enable_edit": info.enable_edit,
                "shared_annotation": info.shared_annotation,
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

/// Show a native folder picker and return the selected path, or None if cancelled.
/// Uses rfd's async API so the UI dispatch is handled correctly on macOS.
#[tauri::command]
pub async fn pick_workspace_dir() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select workspace folder")
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().to_string())
}

/// Returns system/app info used to prefill a GitHub issue template
/// and to drive UI i18n.
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
    std::process::Command::new("cmd")
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

/// Show a native file dialog to pick (or create) a SQLite database file.
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

/// Check for updates and return status. If an update is available, download & install it.
/// Returns a JSON with { available, current, latest, error? }.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> serde_json::Value {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return serde_json::json!({ "available": false, "error": e.to_string() }),
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return serde_json::json!({ "available": false, "current": env!("CARGO_PKG_VERSION") }),
        Err(e) => return serde_json::json!({ "available": false, "error": e.to_string() }),
    };
    let latest = update.version.clone();
    // Download and install
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => serde_json::json!({
            "available": true,
            "current": env!("CARGO_PKG_VERSION"),
            "latest": latest,
            "installed": true,
        }),
        Err(e) => serde_json::json!({
            "available": true,
            "current": env!("CARGO_PKG_VERSION"),
            "latest": latest,
            "installed": false,
            "error": e.to_string(),
        }),
    }
}

/// Toggle tray-resident setting: persists, updates AtomicBool, and applies tray visibility.
#[tauri::command]
pub fn set_tray_resident(value: bool, app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
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
