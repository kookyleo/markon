use crate::settings::{AppSettings, PortMode, WorkspaceSettings};
use crate::AppState;
use markon_core::workspace::WorkspaceConfig;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::State;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(settings: AppSettings, state: State<AppState>) -> Result<(), String> {
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
