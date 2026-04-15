#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod server_manager;
// settings moved to markon_core::settings

use markon_core::settings::AppSettings;
use server_manager::ServerManager;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};

// Point the Win32 HWND at the multi-size icon embedded in the .exe resource
// so the titlebar slot picks the exact native raster from our .ico (16 /
// 20 / 24 / 32 / 48 / …) instead of getting a bilinear downscale of the
// single PNG Tauri's default path passes to tao (see tauri-apps/tauri
// #14596 — tao only takes one RGBA frame out of an .ico and stretches
// it for both ICON_SMALL and ICON_BIG).
//
// Resource id 32512 (IDI_APPLICATION) is what tauri-winres bakes the app
// icon under — **not** 1, despite it looking like the obvious default.
// `LoadImageW` silently returns NULL for a wrong id, so the bug is
// invisible at runtime; the code falls through and tao's blurry original
// stays. Probe a few common ids defensively.
#[cfg(target_os = "windows")]
fn install_exe_window_icon(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd: HWND = hwnd.0 as HWND;

    // Known ids used by Tauri toolchains for the app icon resource.
    const CANDIDATE_IDS: &[u16] = &[32512, 1, 2];

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let slots = [
            (
                ICON_SMALL,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
            ),
            (
                ICON_BIG,
                GetSystemMetrics(SM_CXICON),
                GetSystemMetrics(SM_CYICON),
            ),
        ];
        for (msg_param, w, h) in slots {
            let mut hicon: isize = 0;
            for &id in CANDIDATE_IDS {
                let handle = LoadImageW(
                    hinstance,
                    id as *const u16,
                    IMAGE_ICON,
                    w,
                    h,
                    LR_DEFAULTCOLOR,
                );
                if !handle.is_null() {
                    hicon = handle as isize;
                    break;
                }
            }
            if hicon != 0 {
                SendMessageW(hwnd, WM_SETICON, msg_param as WPARAM, hicon as LPARAM);
            }
        }
    }
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub server: Mutex<ServerManager>,
    /// Set to true when RunEvent::Opened fires so Reopen doesn't override it with Settings.
    pub file_just_opened: Arc<AtomicBool>,
    /// Live tray_resident flag — written by menu handler, read by window close handler.
    pub tray_resident: Arc<AtomicBool>,
}

// ── Path-open logic ───────────────────────────────────────────────────────────

fn handle_open_path(app: &tauri::AppHandle, path: &Path) {
    // dunce::canonicalize strips the Windows \\?\ verbatim prefix so the
    // path shown in the workspace list matches what the user typed.
    let canonical = match dunce::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Warning: cannot resolve path {}: {}", path.display(), e);
            return;
        }
    };

    // Determine workspace root and relative path for this file/dir.
    let (ws_root, rel_path) = if canonical.is_dir() {
        (canonical.clone(), None)
    } else {
        let parent = canonical.parent().unwrap().to_path_buf();
        let file_name = canonical.file_name().unwrap().to_string_lossy().to_string();
        (parent, Some(file_name))
    };

    let state = app.state::<AppState>();
    let server = state.server.lock().unwrap();

    if !server.is_running() {
        eprintln!("Warning: server not running, cannot open path");
        return;
    }

    let ws_root_str = ws_root.to_string_lossy().to_string();

    // Read default feature flags from settings.
    let (def_search, def_viewed, def_edit, def_shared) = {
        let settings = state.settings.lock().unwrap();
        (
            settings.default_search,
            settings.default_viewed,
            settings.default_edit,
            settings.default_shared_annotation,
        )
    };

    let id = server
        .registry
        .add(markon_core::workspace::WorkspaceConfig {
            path: ws_root,
            enable_search: def_search,
            enable_viewed: def_viewed,
            enable_edit: def_edit,
            shared_annotation: def_shared,
        });
    let port = server.port();
    drop(server);

    // Persist to settings so the workspace survives restart and appears in the UI list.
    {
        use markon_core::settings::WorkspaceSettings;
        let mut settings = state.settings.lock().unwrap();
        if !settings.workspaces.iter().any(|w| w.path == ws_root_str) {
            settings.workspaces.push(WorkspaceSettings {
                path: ws_root_str,
                enable_search: def_search,
                enable_viewed: def_viewed,
                enable_edit: def_edit,
                shared_annotation: def_shared,
            });
            settings.save().ok();
        }
    }

    let url = match rel_path {
        Some(p) => format!("http://127.0.0.1:{port}/{id}/{p}"),
        None => format!("http://127.0.0.1:{port}/{id}/"),
    };

    let _ = open::that(url);

    // Hide settings window — app lives in tray while serving.
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.hide();
    }
}

fn show_settings_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Returns the POSIX path of the front Finder window's target directory, if any.
/// Used to detect Finder-toolbar clicks in RunEvent::Reopen.
#[cfg(target_os = "macos")]
fn finder_front_directory() -> Option<String> {
    let out = std::process::Command::new("osascript")
        .args([
            "-e",
            "tell application \"Finder\"\n\
             if (count of windows) > 0 then\n\
             POSIX path of (target of front window as alias)\n\
             end if\n\
             end tell",
        ])
        .output()
        .ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let settings = AppSettings::load();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path_str) = args.get(1) {
                handle_open_path(app, Path::new(path_str));
            } else {
                show_settings_window(app);
            }
        }))
        .setup(move |app| {
            use markon_core::settings::PortMode;

            let port = if settings.port_mode == PortMode::Auto {
                0
            } else {
                settings.port
            };
            let config = settings.to_server_config(port);

            let tray_resident_init = settings.tray_resident;
            let language_init = settings.language.clone();

            // Windows Explorer right-click menu labels follow the app language.
            // NSIS writes a fixed (zh-CN) label on install; this rewrites it
            // to match the user's current choice on every launch.
            #[cfg(target_os = "windows")]
            commands::sync_shell_context_menu(&language_init);

            let state = AppState {
                settings: Mutex::new(settings),
                server: Mutex::new(ServerManager::new()),
                file_just_opened: Arc::new(AtomicBool::new(false)),
                tray_resident: Arc::new(AtomicBool::new(tray_resident_init)),
            };
            let mut server = state.server.lock().unwrap();
            server.start(config);
            drop(server);
            app.manage(state);

            // ── System tray ───────────────────────────────────────────────
            // macOS uses a template icon (monochrome + alpha) that the system
            // auto-tints against the menu bar. Windows and Linux trays do not
            // have this concept, so we ship a separately-styled colored icon
            // for them — otherwise the white template PNG is invisible on a
            // light Windows taskbar.
            #[cfg(target_os = "macos")]
            let icon = tauri::include_image!("icons/tray.png");
            #[cfg(not(target_os = "macos"))]
            let icon = tauri::include_image!("icons/tray-colored.png");

            let i18n_data = markon_core::i18n::get_lang_data(&language_init);
            let label_settings = i18n_data["tray.show"]
                .as_str()
                .unwrap_or("Settings…")
                .to_string();
            let label_quit = i18n_data["tray.quit"]
                .as_str()
                .unwrap_or("Quit Markon")
                .to_string();

            let item_settings =
                MenuItem::with_id(app, "settings", label_settings, true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let item_quit = MenuItem::with_id(app, "quit", label_quit, true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&item_settings, &sep, &item_quit])?;

            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => show_settings_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // ── Apply saved tray_resident state ───────────────────────────
            if !tray_resident_init {
                if let Some(tray) = app.tray_by_id("main") {
                    let _ = tray.set_visible(false);
                }
            }

            // ── Settings window: restore size, close behavior, persist size ──
            if let Some(win) = app.get_webview_window("settings") {
                // Windows: replace Tauri's single-PNG icon (bilinearly scaled by
                // Windows into a blurry titlebar blob) with the multi-size icon
                // baked into the .exe resource. Windows picks the exact 16/20/24
                // raster from our .ico instead of downsampling 32x32.png.
                #[cfg(target_os = "windows")]
                install_exe_window_icon(&win);

                // Restore saved size from settings if present.
                {
                    let state = app.state::<AppState>();
                    let settings = state.settings.lock().unwrap();
                    if let (Some(w), Some(h)) = (settings.window_width, settings.window_height) {
                        let _ = win.set_size(tauri::LogicalSize::new(w, h));
                    }
                }

                let win_clone = win.clone();
                let app_handle = app.app_handle().clone();
                let tray_flag = app.state::<AppState>().tray_resident.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Persist current window size before hiding/closing.
                        if let Ok(size) = win_clone.inner_size() {
                            if let Ok(factor) = win_clone.scale_factor() {
                                let logical = size.to_logical::<u32>(factor);
                                let state = app_handle.state::<AppState>();
                                let mut settings = state.settings.lock().unwrap();
                                settings.window_width = Some(logical.width);
                                settings.window_height = Some(logical.height);
                                settings.save().ok();
                            }
                        }
                        if tray_flag.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = win_clone.hide();
                        }
                        // else: allow close → app exits normally
                    }
                });
            }

            // ── Handle CLI / file-association launch arg ───────────────────
            let args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(path_str) = args.first() {
                handle_open_path(&app.app_handle().clone(), Path::new(path_str));
            } else {
                // Show Settings on launch when there's no file to open, UNLESS:
                // macOS + tray_resident=true (tray is accessible; Reopen/Opened handle navigation).
                // If tray_resident=false the tray is hidden, so Settings must show.
                #[cfg(target_os = "macos")]
                if !tray_resident_init {
                    if let Some(w) = app.get_webview_window("settings") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                #[cfg(not(target_os = "macos"))]
                if let Some(w) = app.get_webview_window("settings") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::set_tray_resident,
            commands::add_workspace,
            commands::update_workspace,
            commands::remove_workspace,
            commands::get_workspaces,
            commands::open_browser,
            commands::open_url,
            commands::get_system_info,
            commands::pick_workspace_dir,
            commands::pick_db_path,
            commands::check_for_update,
            commands::get_i18n,
            commands::list_fonts,
            commands::star_repo,
        ])
        .build(tauri::generate_context!())
        .expect("error building markon-gui");

    app.run(|app_handle, event| {
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let _ = &app_handle;
        match event {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                let flag = app_handle.state::<AppState>().file_just_opened.clone();
                flag.store(true, Ordering::Relaxed);
                for url in &urls {
                    if let Ok(path) = url.to_file_path() {
                        handle_open_path(app_handle, &path);
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                let flag = app_handle.state::<AppState>().file_just_opened.clone();
                // If Opened just fired (file/folder drag or right-click Open With), skip.
                if flag.swap(false, Ordering::Relaxed) {
                    return;
                }
                // Finder toolbar click: Finder has a front window → open its directory.
                if let Some(dir) = finder_front_directory() {
                    handle_open_path(app_handle, std::path::Path::new(&dir));
                    return;
                }
                // No target (Dock icon click, no Finder window open) → show Settings.
                if !has_visible_windows {
                    show_settings_window(app_handle);
                }
            }
            _ => {}
        }
    });
}
