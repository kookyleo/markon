#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
#[cfg(target_os = "macos")]
mod reopen_origin;
mod server_manager;
// settings moved to markon_core::settings

use markon_core::settings::{AppSettings, WorkspaceSettings};
use markon_core::workspace::{expand_and_canonicalize, WorkspaceFlags};
use server_manager::ServerManager;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{tray::TrayIconBuilder, Emitter, Manager};

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

    // SAFETY: All Win32 calls below are sound because:
    //   - `GetModuleHandleW(null)` is documented to return the current module
    //     handle (or NULL on failure); we don't dereference it.
    //   - `LoadImageW` returns NULL on failure and is null-checked at L74
    //     before being cast to `hicon`.
    //   - `SendMessageW` is only invoked once `hicon != 0`, with an `hwnd`
    //     obtained from Tauri's living window handle (still valid for the
    //     duration of this function), and `WM_SETICON` accepts a 0-or-handle
    //     LPARAM with well-defined semantics for both.
    //   - No raw pointer outlives the call. We never free/realloc anything.
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
    pub settings: Arc<Mutex<AppSettings>>,
    pub server: Mutex<ServerManager>,
    /// UNIX-millis of the most recent file/folder open intent (RunEvent::Opened).
    /// A paired Reopen Apple Event arrives right after Opened; we suppress that
    /// one so an "Open With" doesn't *also* adopt the front Finder folder. Stored
    /// as a timestamp rather than a sticky bool so a mark left behind by an Opened
    /// with no trailing Reopen can't later swallow an unrelated toolbar click.
    pub last_file_open_ms: AtomicU64,
    /// Live tray_resident flag — written by menu handler, read by window close handler.
    pub tray_resident: Arc<AtomicBool>,
    /// A File -> New Workspace action can arrive while the settings webview has
    /// been recycled. The next settings page boot consumes this flag.
    pub pending_new_workspace: AtomicBool,
}

impl AppState {
    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Record that a file/folder open was just handled (RunEvent::Opened).
    pub fn mark_file_opened(&self) {
        self.last_file_open_ms
            .store(Self::now_ms(), Ordering::Relaxed);
    }

    /// Consume a recent open mark. Returns true (and clears it) only when an
    /// Opened fired within the last `WINDOW_MS` — i.e. this Reopen is the paired
    /// activation and should be skipped. A stale mark is cleared but ignored.
    pub fn consume_recent_file_open(&self) -> bool {
        const WINDOW_MS: u64 = 2_000;
        let last = self.last_file_open_ms.swap(0, Ordering::Relaxed);
        last != 0 && Self::now_ms().saturating_sub(last) < WINDOW_MS
    }
}

const EXAMPLE_WORKSPACE_RESOURCE: &str = "example";
const EXAMPLE_WORKSPACE_MANIFEST: &str = "e2e-manifest.json";
#[cfg(any(target_os = "macos", test))]
const SETTINGS_WEBVIEW_RECYCLE_AFTER: std::time::Duration =
    std::time::Duration::from_secs(12 * 60 * 60);
#[cfg(target_os = "macos")]
const SETTINGS_WEBVIEW_RECYCLE_CHECK_EVERY: std::time::Duration =
    std::time::Duration::from_secs(10 * 60);
#[cfg(target_os = "macos")]
const KEEPALIVE_WINDOW_LABEL: &str = "__markon_keepalive";

fn ensure_example_workspace(app: &tauri::App, settings: &mut AppSettings) {
    if settings.example_workspace_hidden {
        return;
    }
    let Some(dest) = AppSettings::example_workspace_path() else {
        return;
    };
    let dest_for_match =
        expand_and_canonicalize(&dest.to_string_lossy()).unwrap_or_else(|_| dest.clone());
    let already_configured = settings
        .workspaces
        .iter()
        .any(|workspace| workspace_path_matches(&workspace.path, &dest_for_match));
    let src = example_workspace_source(app);
    let should_sync = src
        .as_deref()
        .is_some_and(|src| example_workspace_manifest_changed(src, &dest));
    if should_sync {
        let src = src.as_ref().expect("checked by should_sync");
        if let Err(e) = copy_example_workspace(src, &dest, true) {
            tracing::warn!(
                source = %src.display(),
                dest = %dest.display(),
                "failed to sync example workspace: {e}"
            );
            return;
        }
    } else if !dest.join(EXAMPLE_WORKSPACE_MANIFEST).is_file() {
        tracing::warn!("bundled example workspace source not found");
        return;
    }
    if !dest.join(EXAMPLE_WORKSPACE_MANIFEST).is_file() {
        tracing::warn!(dest = %dest.display(), "example workspace manifest missing after install");
        return;
    }
    if already_configured {
        return;
    }
    let canonical = expand_and_canonicalize(&dest.to_string_lossy()).unwrap_or(dest);
    settings.workspaces.push(WorkspaceSettings {
        path: canonical.to_string_lossy().to_string(),
        flags: WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: true,
            enable_live: true,
            enable_chat: false,
            shared_annotation: true,
        },
        collaborator_access_code_hash: String::new(),
        alias: String::new(),
    });
    if let Err(e) = settings.save() {
        tracing::warn!("failed to persist example workspace onboarding state: {e}");
    }
}

fn workspace_path_matches(path: &str, target: &Path) -> bool {
    let candidate = expand_and_canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    candidate == target
}

fn example_workspace_source(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(EXAMPLE_WORKSPACE_RESOURCE);
        if bundled.join(EXAMPLE_WORKSPACE_MANIFEST).is_file() {
            return Some(bundled);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../example");
    source
        .join(EXAMPLE_WORKSPACE_MANIFEST)
        .is_file()
        .then_some(source)
}

fn example_workspace_manifest_changed(src: &Path, dest: &Path) -> bool {
    let src_manifest = src.join(EXAMPLE_WORKSPACE_MANIFEST);
    let dest_manifest = dest.join(EXAMPLE_WORKSPACE_MANIFEST);
    if !dest_manifest.is_file() {
        return true;
    }
    match (
        std::fs::read_to_string(&src_manifest),
        std::fs::read_to_string(&dest_manifest),
    ) {
        (Ok(src), Ok(dest)) => src != dest,
        _ => true,
    }
}

fn copy_example_workspace(
    src: &Path,
    dest: &Path,
    overwrite_existing: bool,
) -> std::io::Result<()> {
    if !dest.exists() {
        std::fs::create_dir_all(dest)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let source_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if source_path.is_dir() {
            copy_example_workspace(&source_path, &dest_path, overwrite_existing)?;
        } else if overwrite_existing || !dest_path.exists() {
            std::fs::copy(&source_path, &dest_path)?;
        }
    }
    Ok(())
}

/// On macOS, `RunEvent::Opened` for "Open With Markon" can fire **before** `setup()`
/// runs and `AppState` is `manage()`'d (Apple Events are dispatched during early
/// AppKit launch, ahead of Tauri's setup callback). Calling `app.state::<AppState>()`
/// at that point panics with "state() called before manage()". Stash the URLs here
/// and drain them at the end of `setup()` once state is live.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn pending_opens() -> &'static Mutex<Vec<PathBuf>> {
    static PENDING: std::sync::OnceLock<Mutex<Vec<PathBuf>>> = std::sync::OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(any(target_os = "macos", test))]
fn launch_arg_path(arg: &str) -> Option<PathBuf> {
    if arg.contains("://") {
        let Ok(url) = url::Url::parse(arg) else {
            return None;
        };
        if url.scheme() == "file" {
            return url.to_file_path().ok();
        }
        return None;
    }
    Some(PathBuf::from(arg))
}

#[cfg(any(target_os = "macos", test))]
fn is_markdown_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase()),
        Some(ext) if ext == "md" || ext == "markdown"
    )
}

#[cfg(any(target_os = "macos", test))]
fn markdown_file_launch_args<I, S>(args: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter_map(|arg| launch_arg_path(arg.as_ref()))
        .filter(|path| is_markdown_file(path))
        .collect()
}

// ── Path-open logic ───────────────────────────────────────────────────────────

fn handle_open_path(app: &tauri::AppHandle, path: &Path) {
    // dunce::canonicalize strips the Windows \\?\ verbatim prefix so the
    // path shown in the workspace list matches what the user typed.
    let canonical = match dunce::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("cannot resolve path {}: {}", path.display(), e);
            return;
        }
    };

    // Determine workspace root and per-file context.
    //
    // Files take the single-file ephemeral path: parent dir is the serving
    // root (so co-located images resolve via relative URLs), but only the
    // file itself + assets it references are reachable, and the workspace
    // is not persisted to settings.json. Directories keep the existing
    // "the whole thing is the workspace" behavior.
    let (ws_root, rel_path, single_file) = if canonical.is_dir() {
        (canonical.clone(), None, None)
    } else {
        let parent = canonical.parent().unwrap().to_path_buf();
        let file_name = canonical.file_name().unwrap().to_string_lossy().to_string();
        (parent, Some(file_name.clone()), Some(file_name))
    };

    let state = app.state::<AppState>();
    let server = state.server.lock().unwrap();

    if !server.is_running() {
        tracing::warn!("server not running, cannot open path");
        return;
    }

    let (flags, browser_base) = {
        let settings = state.settings.lock().unwrap();
        // Single-file workspaces follow the user's defaults for every flag.
        // Search is safe here: the registry builds a file-scoped index (only
        // the pinned file, no parent WalkDir), so there's no sibling leakage.
        (
            markon_core::workspace::WorkspaceFlags {
                enable_search: settings.default_search,
                enable_viewed: settings.default_viewed,
                enable_edit: settings.default_edit,
                enable_live: settings.default_live,
                enable_chat: settings.default_chat,
                shared_annotation: settings.default_shared_annotation,
            },
            markon_core::server::featured_base_url(
                &settings.host,
                &settings.advertised_host,
                server.port(),
            ),
        )
    };

    // `registry.add` is idempotent on (path, single_file) and triggers the
    // persist hook, which mirrors directory workspaces into AppSettings.
    // Single-file entries are skipped by `sync_from_registry` and never hit
    // settings.json.
    let id = server
        .registry
        .add(markon_core::workspace::WorkspaceConfig {
            path: ws_root,
            flags,
            single_file,
            collaborator_access_code_hash: String::new(),
            alias: String::new(),
        });
    drop(server);

    let workspace_path = markon_core::server::workspace_url_path(&id, rel_path.as_deref());
    let url = markon_core::server::build_workspace_url(&browser_base, &workspace_path);

    let _ = open::that(url);

    // Hide settings window — app lives in tray while serving.
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.hide();
    }
}

fn show_settings_window(app: &tauri::AppHandle) {
    let window = match app.get_webview_window("settings") {
        Some(window) => window,
        None => match create_settings_window(app) {
            Some(window) => window,
            None => return,
        },
    };
    let _ = window.show();
    let _ = window.set_focus();
}

fn create_settings_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    #[cfg(target_os = "macos")]
    ensure_keepalive_window(app);

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "settings")
    else {
        tracing::warn!("settings window config not found");
        return None;
    };

    let window = match tauri::WebviewWindowBuilder::from_config(app, config)
        .and_then(|builder| builder.build())
    {
        Ok(window) => window,
        Err(e) => {
            tracing::warn!("failed to recreate settings window: {e}");
            return None;
        }
    };
    configure_settings_window(app, &window);
    tracing::info!("recreated settings webview window after idle recycle");
    Some(window)
}

#[cfg(target_os = "macos")]
fn ensure_keepalive_window(app: &tauri::AppHandle) {
    if app.get_webview_window(KEEPALIVE_WINDOW_LABEL).is_some() {
        return;
    }
    let url = "about:blank"
        .parse()
        .expect("about:blank is a valid external URL");
    if let Err(e) = tauri::WebviewWindowBuilder::new(
        app,
        KEEPALIVE_WINDOW_LABEL,
        tauri::WebviewUrl::External(url),
    )
    .title("")
    .inner_size(1.0, 1.0)
    .visible(false)
    .decorations(false)
    .skip_taskbar(true)
    .build()
    {
        tracing::warn!("failed to create keepalive window: {e}");
    }
}

fn persist_settings_window_size(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(factor) = window.scale_factor() else {
        return;
    };
    let logical = size.to_logical::<u32>(factor);
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().unwrap();
    settings.window_width = Some(logical.width);
    settings.window_height = Some(logical.height);
    settings.save().ok();
}

fn configure_settings_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    install_exe_window_icon(window);

    {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        if let (Some(w), Some(h)) = (settings.window_width, settings.window_height) {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
        }
    }

    let window_for_event = window.clone();
    let app_handle = app.clone();
    let tray_flag = app.state::<AppState>().tray_resident.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            persist_settings_window_size(&app_handle, &window_for_event);
            if tray_flag.load(Ordering::Relaxed) {
                api.prevent_close();
                let _ = window_for_event.hide();
            }
            // else: allow close -> app exits normally
        }
    });
}

#[cfg(any(target_os = "macos", test))]
fn settings_webview_recycle_due(hidden_since_ms: Option<u64>, now_ms: u64) -> bool {
    let threshold_ms = SETTINGS_WEBVIEW_RECYCLE_AFTER.as_millis() as u64;
    hidden_since_ms
        .map(|hidden_since| now_ms.saturating_sub(hidden_since) >= threshold_ms)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn spawn_settings_webview_recycler(app: &tauri::AppHandle) {
    let app_for_recycler = app.clone();
    let mut hidden_since_ms =
        app.get_webview_window("settings")
            .and_then(|window| match window.is_visible() {
                Ok(false) => Some(AppState::now_ms()),
                _ => None,
            });

    tauri::async_runtime::spawn(async move {
        use tokio::time::sleep;

        loop {
            sleep(SETTINGS_WEBVIEW_RECYCLE_CHECK_EVERY).await;

            let Some(window) = app_for_recycler.get_webview_window("settings") else {
                hidden_since_ms = None;
                continue;
            };
            if window.is_visible().unwrap_or(true) {
                hidden_since_ms = None;
                continue;
            }

            let now_ms = AppState::now_ms();
            let started_ms = *hidden_since_ms.get_or_insert(now_ms);
            if !settings_webview_recycle_due(Some(started_ms), now_ms) {
                continue;
            }
            hidden_since_ms = None;

            let inner = app_for_recycler.clone();
            if let Err(e) = app_for_recycler.run_on_main_thread(move || {
                let Some(window) = inner.get_webview_window("settings") else {
                    return;
                };
                if window.is_visible().unwrap_or(true) {
                    return;
                }
                persist_settings_window_size(&inner, &window);
                match window.destroy() {
                    Ok(()) => tracing::info!(
                        "destroyed idle hidden settings webview to release WKWebView resources"
                    ),
                    Err(e) => tracing::warn!("failed to destroy hidden settings webview: {e}"),
                }
            }) {
                tracing::warn!("failed to schedule hidden settings webview recycle: {e}");
            }
        }
    });
}

#[tauri::command]
fn take_pending_new_workspace(state: tauri::State<AppState>) -> bool {
    state.pending_new_workspace.swap(false, Ordering::Relaxed)
}

/// App menu bar. Starts from Tauri's standard menu (so Edit copy/paste, Quit,
/// Window management stay intact) and adds a "New Workspace" item with the ⌘N
/// accelerator to the File submenu. Registering it as a real menu accelerator is
/// what makes the shortcut actually fire — see the on_menu_event comment.
fn build_app_menu<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem};
    let menu = Menu::default(handle)?;
    let new_ws = MenuItem::with_id(
        handle,
        "new_workspace",
        "New Workspace",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    for kind in menu.items()? {
        if let Some(sub) = kind.as_submenu() {
            if sub.text().map(|t| t == "File").unwrap_or(false) {
                sub.prepend(&new_ws)?;
                break;
            }
        }
    }
    Ok(menu)
}

/// Show Settings as a *deferred* fallback after a macOS activation that carried
/// no file. A Finder double-click delivers BOTH a `Reopen` activation and an
/// `Opened` (the file) Apple Event, in either order — so reacting to `Reopen`
/// synchronously pops Settings before the paired `Opened` can open the file in
/// the browser. Waiting briefly and bailing out if a file-open marks the state
/// makes the decision order-independent: a real file-open wins, a genuine bare
/// reactivation still surfaces Settings a beat later.
#[cfg(target_os = "macos")]
fn schedule_settings_fallback(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(state) = inner.try_state::<AppState>() {
                // An Opened/argv file-open raced in → don't cover it with Settings.
                if state.consume_recent_file_open() {
                    return;
                }
            }
            if let Some(w) = inner.get_webview_window("settings") {
                if w.is_visible().unwrap_or(false) {
                    return;
                }
            }
            show_settings_window(&inner);
        });
    });
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

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();
}

// Force `main.rs` to recompile whenever the embedded frontend changes. Tauri's
// `generate_context!()` bakes `ui/` into the binary at THIS file's compile time,
// but a plain `cargo:rerun-if-changed=ui` only re-runs build.rs — it does NOT
// recompile main.rs, so editing ui/index.html alone left the old frontend
// embedded on incremental builds. Depending on the file via `include_str!` makes
// rustc track it as an input of main.rs, so a ui/ edit now forces the re-embed.
const _UI_REEMBED_MARKER: &str = include_str!("../ui/index.html");

fn main() {
    init_tracing();
    let settings = AppSettings::load();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // macOS normally delivers Open With through Apple Events
            // (RunEvent::Opened), but older Finder/AppKit paths can surface a
            // Markdown file in argv when the resident instance is already
            // running. Only trust explicit Markdown files here; directories in
            // argv can be Finder's front folder (e.g. /Applications), not the
            // user's target.
            #[cfg(not(target_os = "macos"))]
            if let Some(path_str) = args.get(1) {
                handle_open_path(app, Path::new(path_str));
                return;
            }
            #[cfg(target_os = "macos")]
            {
                let paths = markdown_file_launch_args(args.iter().map(String::as_str));
                if !paths.is_empty() {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.mark_file_opened();
                        for p in &paths {
                            handle_open_path(app, p);
                        }
                    } else {
                        pending_opens().lock().unwrap().extend(paths);
                    }
                    return;
                }
                // No Markdown file in argv. macOS may still deliver the file via a
                // separate Opened Apple Event right after, so defer the Settings
                // fallback and let a file-open cancel it.
                schedule_settings_fallback(app);
            }
            #[cfg(not(target_os = "macos"))]
            show_settings_window(app);
        }))
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "new_workspace" {
                // A native accelerator is the only reliable way to fire ⌘N on
                // macOS — WKWebView's responder chain swallows Cmd-letter combos
                // that match no menu item, so a JS keydown listener never sees
                // them. Surface Settings, then let the frontend run its existing
                // add-workspace flow (native folder picker + registry insert).
                let settings_window_recycled = app.get_webview_window("settings").is_none();
                if settings_window_recycled {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.pending_new_workspace.store(true, Ordering::Relaxed);
                    }
                }
                show_settings_window(app);
                if settings_window_recycled {
                    if app.get_webview_window("settings").is_none() {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.pending_new_workspace.store(false, Ordering::Relaxed);
                        }
                    }
                } else {
                    let _ = app.emit("menu:new-workspace", ());
                }
            }
        })
        .setup(move |app| {
            let mut settings = settings;
            ensure_example_workspace(app, &mut settings);
            let config = settings.to_server_config(commands::effective_port(&settings));

            let tray_resident_init = settings.tray_resident;
            let language_init = settings.language.clone();

            // Windows Explorer right-click menu labels follow the app language.
            // NSIS writes a fixed (zh-CN) label on install; this rewrites it
            // to match the user's current choice on every launch.
            #[cfg(target_os = "windows")]
            commands::sync_shell_context_menu(&language_init);

            let settings_arc = Arc::new(Mutex::new(settings));
            let persist_hook = AppSettings::persist_hook(settings_arc.clone());
            let state = AppState {
                settings: settings_arc,
                server: Mutex::new(ServerManager::new()),
                last_file_open_ms: AtomicU64::new(0),
                tray_resident: Arc::new(AtomicBool::new(tray_resident_init)),
                pending_new_workspace: AtomicBool::new(false),
            };
            let mut server = state.server.lock().unwrap();
            if let Err(e) = server.start(config, Some(persist_hook)) {
                tracing::error!("server failed to start: {e}");
            }
            drop(server);
            app.manage(state);

            #[cfg(target_os = "macos")]
            ensure_keepalive_window(app.app_handle());

            // Poll for NIC changes — switching Wi-Fi or toggling a VPN
            // mutates the available-bind-hosts list, and a server bound to a
            // specific NIC IP that just disappeared will silently fail. Push
            // both the new list and the freshness of the active host so the
            // settings UI can re-render its dropdown and surface a banner.
            let app_for_watcher = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use std::time::Duration;
                use tokio::time::sleep;
                let mut prev = markon_core::net::available_bind_hosts();
                loop {
                    sleep(Duration::from_secs(3)).await;
                    let cur = markon_core::net::available_bind_hosts();
                    if cur == prev {
                        continue;
                    }
                    prev = cur.clone();
                    let bind_host = match app_for_watcher.try_state::<AppState>() {
                        Some(state) => state.settings.lock().unwrap().host.clone(),
                        None => continue,
                    };
                    let host_available = markon_core::net::host_in_list(&bind_host, &cur);
                    let payload = serde_json::json!({
                        "hosts": cur,
                        "current_host": bind_host,
                        "host_available": host_available,
                    });
                    let _ = app_for_watcher.emit("bind-hosts-changed", payload);
                }
            });

            #[cfg(target_os = "macos")]
            spawn_settings_webview_recycler(app.app_handle());

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

            let menu = commands::build_tray_menu(app, &language_init)?;

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
                configure_settings_window(app.app_handle(), &win);
            }

            // ── Handle CLI / file-association launch arg ───────────────────
            // On macOS this block is intentionally skipped: file-open
            // intents always arrive through RunEvent::Opened (Apple
            // Events), never argv. Older macOS versions would pass the
            // Finder front window's directory as argv[1] for apps that
            // claim public.folder in Info.plist, which caused the
            // Applications folder to be silently added as a workspace
            // on first launch. Linux/Windows still use argv for file
            // associations.
            #[cfg(not(target_os = "macos"))]
            {
                let args: Vec<String> = std::env::args().skip(1).collect();
                if let Some(path_str) = args.first() {
                    handle_open_path(&app.app_handle().clone(), Path::new(path_str));
                } else {
                    show_settings_window(app.app_handle());
                }
            }
            // Drain any RunEvent::Opened paths that arrived before AppState
            // was managed (see `pending_opens` for the cold-launch race),
            // then any Markdown files passed via argv.
            #[cfg(target_os = "macos")]
            let opened_any: bool = {
                let mut paths: Vec<PathBuf> = std::mem::take(&mut *pending_opens().lock().unwrap());
                paths.extend(markdown_file_launch_args(std::env::args().skip(1)));
                let had = !paths.is_empty();
                if had {
                    app.state::<AppState>().mark_file_opened();
                    let handle = app.app_handle().clone();
                    for p in &paths {
                        handle_open_path(&handle, p);
                    }
                }
                had
            };

            #[cfg(target_os = "macos")]
            if !tray_resident_init && !opened_any {
                // Tray is hidden, so Settings must show for the app to be
                // reachable on launch. With tray_resident=true the tray
                // icon stays visible and Reopen/Opened cover navigation.
                // If an Open With path was handled, the user explicitly asked
                // for a file — don't pop the Settings window over it.
                show_settings_window(app.app_handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::set_collaborator_access_code,
            commands::set_alias,
            commands::set_tray_resident,
            commands::add_workspace,
            commands::update_workspace,
            commands::remove_workspace,
            commands::get_workspaces,
            commands::open_url,
            commands::get_bind_hosts,
            commands::get_server_status,
            commands::get_system_info,
            commands::pick_workspace_dir,
            commands::pick_db_path,
            commands::check_for_update,
            commands::get_i18n,
            commands::list_fonts,
            commands::list_chat_models,
            commands::star_repo,
            take_pending_new_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("error building markon-gui");

    app.run(|app_handle, event| {
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let _ = &app_handle;
        match event {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                // Apple Events can fire before setup() runs `app.manage(state)`,
                // so try_state() — fall back to a process-level queue that
                // setup() drains once state is live. See `pending_opens`.
                let paths: Vec<PathBuf> =
                    urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.mark_file_opened();
                    for p in &paths {
                        handle_open_path(app_handle, p);
                    }
                } else {
                    pending_opens().lock().unwrap().extend(paths);
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                // try_state, not state(): Reopen is an Apple Event and can fire
                // before setup() runs `app.manage(state)` (same race Opened
                // guards). The panicking state() here would crash on an early
                // toolbar reopen; if state isn't live yet there's nothing to do.
                let Some(state) = app_handle.try_state::<AppState>() else {
                    return;
                };
                // If an Opened just fired (file/folder drag or right-click Open
                // With), this is its paired activation — skip so we don't also
                // adopt the front Finder folder. Time-bounded: a stale mark won't
                // swallow an unrelated, much-later toolbar click.
                if state.consume_recent_file_open() {
                    return;
                }
                // Adopt the front Finder window as a workspace ONLY for a real
                // Finder-toolbar click. `Reopen` fires for every reactivation
                // (Dock, Spotlight, `open`, ⌘-Tab + Dock), and a front Finder
                // window merely existing doesn't mean the click came from its
                // toolbar — so gate on the reopen event's sender being Finder.
                // Without this, launching the app via Dock/Spotlight while any
                // Finder window is open silently adds that folder. See
                // reopen_origin for how the sender is read race-free.
                if reopen_origin::reopen_came_from_finder() {
                    if let Some(dir) = finder_front_directory() {
                        handle_open_path(app_handle, std::path::Path::new(&dir));
                        return;
                    }
                }
                // No Finder-toolbar intent → behave like a plain reactivation:
                // surface Settings if there's nothing else visible — but DEFER it,
                // so a paired `Opened` (double-click delivers both, any order) can
                // open the file in the browser instead of us popping the panel.
                if !has_visible_windows {
                    schedule_settings_fallback(app_handle);
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_case_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "markon-launch-arg-test-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn markdown_launch_args_accept_files_but_not_directories() {
        let dir = temp_case_dir();
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("note.md");
        let markdown = dir.join("other.markdown");
        let txt = dir.join("note.txt");
        fs::write(&md, "# hi").unwrap();
        fs::write(&markdown, "# hi").unwrap();
        fs::write(&txt, "hi").unwrap();
        let file_url = url::Url::from_file_path(&md).unwrap().to_string();

        let paths = markdown_file_launch_args([
            "Markon.app/Contents/MacOS/Markon".to_string(),
            dir.to_string_lossy().into_owned(),
            txt.to_string_lossy().into_owned(),
            markdown.to_string_lossy().into_owned(),
            file_url,
        ]);

        assert_eq!(paths, vec![markdown, md]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_webview_recycle_due_waits_for_threshold() {
        let threshold_ms = SETTINGS_WEBVIEW_RECYCLE_AFTER.as_millis() as u64;
        assert!(!settings_webview_recycle_due(None, threshold_ms));
        assert!(!settings_webview_recycle_due(
            Some(1_000),
            1_000 + threshold_ms - 1
        ));
        assert!(settings_webview_recycle_due(
            Some(1_000),
            1_000 + threshold_ms
        ));
        assert!(!settings_webview_recycle_due(Some(2_000), 1_000));
    }
}
