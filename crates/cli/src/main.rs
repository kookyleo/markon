use clap::Parser;
use dialoguer::{Confirm, Select};
use markon_core::control::{ControlError, RunningServer};
use markon_core::daemon::{DaemonConfig, DaemonWorkspace};
use markon_core::net::{available_bind_hosts, BindHostKind};
use markon_core::server::{self, ServerConfig, WorkspaceInit};
use markon_core::settings::AppSettings;
use markon_core::workspace::{
    expand_and_canonicalize, hash_access_code, ServerLock, WorkspaceFlags, WorkspaceInfo,
    WorkspaceOpenTarget, WorkspaceRegistry,
};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod feedback;
mod tui;

fn get_available_hosts() -> Vec<(String, String)> {
    available_bind_hosts()
        .into_iter()
        .map(|host| {
            let label = match host.kind {
                BindHostKind::Localhost if host.address == "127.0.0.1" => {
                    "Localhost (local only)".to_string()
                }
                BindHostKind::Localhost => format!("Localhost ({}, local only)", host.address),
                BindHostKind::AllInterfaces if host.address == "0.0.0.0" => {
                    "All interfaces (LAN accessible)".to_string()
                }
                BindHostKind::AllInterfaces => {
                    format!("All interfaces ({}, LAN accessible)", host.address)
                }
                BindHostKind::Interface => host
                    .interface
                    .map(|name| format!("{} ({name})", host.address))
                    .unwrap_or_else(|| host.address.clone()),
            };
            (host.address, label)
        })
        .collect()
}

fn select_host() -> Result<String, Box<dyn std::error::Error>> {
    let hosts = get_available_hosts();
    let items: Vec<&str> = hosts.iter().map(|(_, d)| d.as_str()).collect();
    let sel = Select::new()
        .with_prompt("Select host address to bind")
        .items(&items)
        .default(0)
        .interact()?;
    Ok(hosts[sel].0.clone())
}

/// markon - Mark it on.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Cli {
    /// Subcommand for workspace management.
    #[command(subcommand)]
    command: Option<Commands>,

    /// The markdown file or directory to open.
    file: Option<String>,

    /// Port for the server (default: 6419).
    #[arg(short, long, default_value_t = 6419)]
    port: u16,

    /// Host address to bind (interactive if flag given without value).
    #[arg(long, value_name = "IP", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "select")]
    host: Option<String>,

    /// Public HTTP(S) base URL; workspace paths are appended. Saved as the default; empty clears it.
    #[arg(long, aliases = ["public-url", "entry", "qr"], value_name = "URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "missing")]
    public_base_url: Option<String>,

    /// Additional exact Host/origin accepted by the server (repeatable).
    #[arg(long = "trusted-host", value_name = "HOST_OR_ORIGIN", action = clap::ArgAction::Append)]
    trusted_hosts: Vec<String>,

    /// Open a browser for this invocation; an omitted URL uses the local address.
    #[arg(short = 'b', long, value_name = "URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "local")]
    open_browser: Option<String>,

    /// Salt for workspace ID generation.
    #[arg(long)]
    salt: Option<String>,

    /// Set or clear the workspace collaborator access code. Empty string clears.
    #[arg(long, value_name = "CODE")]
    collaborator_access_code: Option<String>,

    /// Include the body of collapsed sections when printing. Default: hide
    /// collapsed bodies and mark them with a placeholder.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    print_collapsed_content: bool,
}

#[derive(clap::Subcommand, Debug)]
enum Commands {
    /// Create an explicit administrator browser session.
    Admin {
        #[command(subcommand)]
        command: AdminCommands,
    },
    /// List all active workspaces in the running server.
    Ls {
        /// Output format. Omit on an interactive terminal to launch the
        /// interactive browser; omit when piped/redirected for static cards.
        #[arg(long, value_enum)]
        format: Option<WorkspaceListFormat>,
    },
    /// Remove a workspace from the running server by ID or index.
    Detach {
        /// Workspace ID or index (from 'markon ls').
        target: String,
    },
    /// Toggle a workspace feature on/off, e.g. `markon set 3 edit on`.
    Set {
        /// Workspace ID or index (from 'markon ls').
        target: String,
        /// Advanced capability: edit | chat | live | share
        feature: String,
        /// on | off
        value: String,
    },
    /// Show and optionally remove data belonging to closed workspaces.
    Cleanup {
        /// Skip the confirmation prompt.
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Shutdown the background Markon server.
    Shutdown,
    /// File a bug report on GitHub (requires `gh`, authenticated).
    Bug {
        /// Issue title. If omitted, you'll be prompted.
        #[arg(long, short = 't')]
        title: Option<String>,
        /// Issue body (markdown). If omitted, opens $EDITOR with a template.
        #[arg(long, short = 'b')]
        body: Option<String>,
    },
    /// File a feature idea as a GitHub Discussion (requires `gh`).
    Idea {
        /// Discussion title. If omitted, you'll be prompted.
        #[arg(long, short = 't')]
        title: Option<String>,
        /// Discussion body (markdown). If omitted, opens $EDITOR.
        #[arg(long, short = 'b')]
        body: Option<String>,
    },
    /// Ask a question on GitHub Discussions (requires `gh`).
    Ask {
        /// Discussion title. If omitted, you'll be prompted.
        #[arg(long, short = 't')]
        title: Option<String>,
        /// Discussion body (markdown). If omitted, opens $EDITOR.
        #[arg(long, short = 'b')]
        body: Option<String>,
    },
}

#[derive(clap::Subcommand, Debug)]
enum AdminCommands {
    /// Open a browser and redeem a one-time fragment nonce.
    Open,
    /// Print a one-time pairing code for manual browser entry.
    Code,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
enum WorkspaceListFormat {
    Cards,
    Table,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceAccessSummary {
    workspace_path: String,
    flags: WorkspaceFlags,
    /// Every reachable workspace URL (localhost first, then each LAN interface).
    local_urls: Vec<server::ReachableUrl>,
    /// The featured workspace URL (LAN IP for wildcard binds), used as the QR
    /// fallback. Administrator browser launches choose their origin separately.
    featured_url: String,
    public_url: Option<String>,
    qr_url: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct CliColors {
    enabled: bool,
}

impl CliColors {
    fn detect() -> Self {
        let term = std::env::var_os("TERM");
        let enabled = std::io::stdout().is_terminal()
            && std::env::var_os("NO_COLOR").is_none()
            && std::env::var_os("CLICOLOR").as_deref() != Some(std::ffi::OsStr::new("0"))
            && known_color_terminal(term.as_deref())
            && enable_ansi_output();
        Self { enabled }
    }

    #[cfg(test)]
    fn plain() -> Self {
        Self { enabled: false }
    }

    fn paint(&self, text: &str, code: &str) -> String {
        if self.enabled {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    fn title(&self, text: &str) -> String {
        self.paint(text, "1;36")
    }

    fn path(&self, text: &str) -> String {
        self.paint(text, "1")
    }

    fn id(&self, text: &str) -> String {
        self.paint(text, "1;34")
    }

    fn enabled_flag(&self, text: &str) -> String {
        self.paint(text, "1;32")
    }

    fn disabled_flag(&self, text: &str) -> String {
        self.paint(text, "2")
    }

    fn local_url(&self, text: &str) -> String {
        self.paint(text, "36")
    }

    fn public_url(&self, text: &str) -> String {
        self.paint(text, "35")
    }
}

/// Prefer plain text to guessing from COLORTERM, TERM_PROGRAM, or FORCE_COLOR.
/// Windows consoles often omit TERM; their capability is checked with Win32.
fn known_color_terminal(term: Option<&std::ffi::OsStr>) -> bool {
    let Some(term) = term else {
        return cfg!(windows);
    };
    matches!(
        term.to_str(),
        Some(
            "ansi"
                | "linux"
                | "xterm"
                | "xterm-color"
                | "xterm-256color"
                | "xterm-direct"
                | "xterm-kitty"
                | "screen"
                | "screen-256color"
                | "screen-256color-bce"
                | "screen.xterm-256color"
                | "tmux"
                | "tmux-256color"
                | "rxvt"
                | "rxvt-unicode"
                | "rxvt-unicode-256color"
                | "alacritty"
                | "foot"
                | "foot-extra"
                | "foot-direct"
                | "kitty"
                | "wezterm"
                | "st"
                | "st-256color"
                | "putty"
                | "putty-256color"
                | "cygwin"
        )
    )
}

#[cfg(not(windows))]
fn enable_ansi_output() -> bool {
    true
}

#[cfg(windows)]
fn enable_ansi_output() -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, SetConsoleMode, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING,
    };

    // Check the actual console rather than accepting an environment hint.
    // SAFETY: stdout owns the borrowed handle; mode is a valid writable DWORD.
    unsafe {
        let handle = std::io::stdout().as_raw_handle();
        let mut mode = 0;
        if GetConsoleMode(handle, &mut mode) == 0 {
            return false;
        }
        let ansi_mode = mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
        mode == ansi_mode || SetConsoleMode(handle, ansi_mode) != 0
    }
}

/// Whether an interactive full-screen TUI should launch for a bare `markon ls`.
///
/// Requires both stdin and stdout to be real terminals AND a usable `TERM`
/// (set and not `dumb`). A dumb/limited terminal (or `TERM` unset) falls back
/// to static cards instead
/// of emitting alternate-screen / cursor-hide escapes as literal garbage.
/// `MARKON_NO_TUI` is an explicit escape hatch for PTY environments that
/// report a terminal but should stay non-interactive.
fn tui_enabled() -> bool {
    if std::env::var_os("MARKON_NO_TUI").is_some() {
        return false;
    }
    let term_ok = std::env::var("TERM")
        .map(|term| term != "dumb")
        .unwrap_or(false);
    term_ok && std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn display_workspace_path(path: &Path) -> String {
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        if let Ok(rest) = path.strip_prefix(&home) {
            return if rest.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rest.to_string_lossy())
            };
        }
    }
    path.to_string_lossy().to_string()
}

/// User-visible path for one workspace row.
///
/// A file-scoped workspace serves out of the file's *parent*, so `WorkspaceInfo.path`
/// alone renders as the directory — indistinguishable from a directory workspace
/// over the same folder, which is exactly what two entries for one folder look
/// like after a file is opened. Joining `single_file` (the wire format documents
/// this as required of any consumer that displays the path) shows what the
/// workspace actually serves.
fn display_workspace_scope(info: &WorkspaceInfo) -> String {
    let root = Path::new(&info.path);
    match info.single_file.as_deref() {
        Some(file) => display_workspace_path(&root.join(file)),
        None => display_workspace_path(root),
    }
}

/// Ordered advanced capabilities shared by cards, tables, and the TUI form.
fn workspace_flag_entries(
    flags: WorkspaceFlags,
) -> [(bool, &'static str, &'static str, &'static str); 4] {
    [
        (flags.enable_edit, "Edit", "Edit", "Edit"),
        (flags.enable_chat, "Chat", "Chat", "Chat"),
        (flags.enable_live, "Live", "Live", "Live"),
        (flags.shared_annotation, "Share", "Share", "Share"),
    ]
}

/// Mutable accessor in the same order as [`workspace_flag_entries`]. Legacy
/// baseline fields are deliberately excluded from interactive editing.
fn workspace_flag_mut(flags: &mut WorkspaceFlags, idx: usize) -> &mut bool {
    match idx {
        0 => &mut flags.enable_edit,
        1 => &mut flags.enable_chat,
        2 => &mut flags.enable_live,
        3 => &mut flags.shared_annotation,
        other => panic!("workspace flag index {other} out of range (0..4)"),
    }
}

fn format_workspace_flags(flags: WorkspaceFlags, colors: CliColors) -> String {
    workspace_flag_entries(flags)
        .into_iter()
        .map(|(enabled, card_label, _, _)| {
            let plain = format!("[{}] {card_label}", if enabled { "x" } else { " " });
            if enabled {
                colors.enabled_flag(&plain)
            } else {
                colors.disabled_flag(&plain)
            }
        })
        .collect::<Vec<_>>()
        .join("  ")
}

fn format_workspace_feature_tags(flags: WorkspaceFlags) -> String {
    let features: Vec<&str> = workspace_flag_entries(flags)
        .into_iter()
        .filter(|(enabled, _, _, _)| *enabled)
        .map(|(_, _, tag_label, _)| tag_label)
        .collect();
    if features.is_empty() {
        "-".to_string()
    } else {
        features.join(" | ")
    }
}

fn workspace_search_status(search_ready: bool) -> &'static str {
    if search_ready {
        "Search ready"
    } else {
        "Search indexing"
    }
}

/// Apply a CLI capability choice without changing obsolete baseline flags.
/// The boolean indicates whether a native management update is needed.
fn apply_workspace_feature(
    flags: &mut WorkspaceFlags,
    feature: &str,
    on: bool,
) -> Result<bool, String> {
    match feature.to_ascii_lowercase().as_str() {
        "search" | "viewed" | "progress" if on => return Ok(false),
        "search" | "viewed" | "progress" => {
            return Err(format!(
                "{feature} is a baseline capability and cannot be disabled"
            ));
        }
        "edit" => flags.enable_edit = on,
        "chat" => flags.enable_chat = on,
        "live" => flags.enable_live = on,
        "share" | "shared" | "annotation" | "notes" => flags.shared_annotation = on,
        other => {
            return Err(format!(
                "Unknown feature '{other}' — use edit, chat, live, or share"
            ))
        }
    }
    Ok(true)
}

fn default_workspace_flags(settings: &AppSettings) -> WorkspaceFlags {
    WorkspaceFlags {
        enable_search: settings.default_search,
        enable_viewed: settings.default_viewed,
        enable_edit: settings.default_edit,
        enable_live: settings.default_live,
        enable_chat: settings.default_chat,
        shared_annotation: settings.default_shared_annotation,
    }
}

fn workspace_path_matches(saved_path: &str, root: &Path) -> bool {
    let saved = expand_and_canonicalize(saved_path).unwrap_or_else(|_| PathBuf::from(saved_path));
    saved == root
}

fn resolve_workspace_collaborator_hash(
    saved_collaborator_hash: &str,
    collaborator_access_code: Option<&str>,
    salt: &str,
) -> String {
    collaborator_access_code
        .map(|code| {
            let code = code.trim();
            if code.is_empty() {
                String::new()
            } else {
                hash_access_code(salt, code)
            }
        })
        .unwrap_or_else(|| saved_collaborator_hash.to_string())
}

fn pad_right(text: &str, width: usize) -> String {
    let pad = width.saturating_sub(text.chars().count());
    format!("{text}{}", " ".repeat(pad))
}

/// Resolve the bind host used for printed / opened URLs without prompting.
/// Precedence: explicit `--host` (ignoring the interactive `select` sentinel)
/// > global config `settings.host` (when non-empty) > loopback.
fn configured_bind_host(cli_host: Option<&str>, settings_host: &str) -> String {
    match cli_host {
        Some(h) if h != "select" => h.to_string(),
        _ if !settings_host.trim().is_empty() => settings_host.to_string(),
        _ => "127.0.0.1".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_workspace_access_summary(
    workspace_root: &Path,
    flags: WorkspaceFlags,
    bind_host: &str,
    advertised_host: &str,
    port: u16,
    workspace_id: &str,
    initial_path: Option<&str>,
    public_base: Option<&str>,
) -> WorkspaceAccessSummary {
    let workspace_path = server::workspace_url_path(workspace_id, initial_path);
    let reach = server::reachable_urls(bind_host, advertised_host, port);
    let local_urls: Vec<server::ReachableUrl> = reach
        .all
        .iter()
        .map(|r| server::ReachableUrl {
            label: r.label.clone(),
            url: server::build_workspace_url(&r.url, &workspace_path),
        })
        .collect();
    let featured_url = server::build_workspace_url(&reach.featured, &workspace_path);
    let public_url = public_base
        .filter(|base| *base != "missing")
        .map(|base| server::build_workspace_url(base, &workspace_path));
    // QR target: the public workspace URL when a --public-base-url prefix was given,
    // otherwise (bare --public-base-url / "missing") fall back to the featured URL.
    let qr_url = public_base.map(|_| public_url.clone().unwrap_or_else(|| featured_url.clone()));

    WorkspaceAccessSummary {
        workspace_path: display_workspace_path(workspace_root),
        flags,
        local_urls,
        featured_url,
        public_url,
        qr_url,
    }
}

fn resolve_workspace_list_base(
    bind_host: &str,
    _advertised_host: &str,
    port: u16,
    public_base: Option<&str>,
) -> (String, bool) {
    match public_base.filter(|base| *base != "missing") {
        Some(base) => (base.to_string(), true),
        None => (server::local_browser_base_url(bind_host, port), false),
    }
}

/// Move a daemon-issued one-time administrator fragment onto an explicitly
/// requested trusted origin. The capability remains the identity proof; this
/// helper changes only the origin used to redeem it.
fn rehome_admin_bootstrap_url(base: &str, redirect: &str, issued_url: &str) -> String {
    let initial_route = redirect
        .split_once('#')
        .map_or(redirect, |(route, _fragment)| route);
    let target = server::build_workspace_url(base, initial_route);
    match issued_url.split_once('#').map(|(_, fragment)| fragment) {
        Some(fragment) if !fragment.is_empty() => format!("{target}#{fragment}"),
        _ => target,
    }
}

fn print_workspace_access_summary(summary: &WorkspaceAccessSummary) {
    let colors = CliColors::detect();
    println!(
        "{} {}",
        colors.title("Added workspace:"),
        colors.path(&summary.workspace_path)
    );
    println!("{}", format_workspace_flags(summary.flags, colors));
    println!();
    // One line per reachable URL. For wildcard binds this lists localhost plus
    // every LAN interface (with its name), so the user picks the right address
    // for their network instead of getting a single guessed IP.
    for entry in &summary.local_urls {
        if entry.label.is_empty() || entry.label == "localhost" {
            println!("{}", colors.local_url(&entry.url));
        } else {
            println!("{}  ({})", colors.local_url(&entry.url), entry.label);
        }
    }
    if let Some(public_url) = summary.public_url.as_ref() {
        println!("{}", colors.public_url(public_url));
    }
    if let Some(qr_url) = summary.qr_url.as_ref() {
        println!();
        if let Err(e) = server::print_compact_qr(qr_url) {
            eprintln!("Failed to generate QR code: {e}");
        }
    }
}

async fn list_workspaces(
    bind_host: &str,
    advertised_host: &str,
    server: &RunningServer,
    format: WorkspaceListFormat,
    public_base: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let port = server.port();
    let workspaces = server.list_workspaces().await?;

    if workspaces.is_empty() {
        println!("No active workspaces.");
        return Ok(());
    }

    let colors = CliColors::detect();
    let (url_base, use_public_url) =
        resolve_workspace_list_base(bind_host, advertised_host, port, public_base);
    match format {
        WorkspaceListFormat::Cards => {
            for (i, ws) in workspaces.iter().enumerate() {
                let path = display_workspace_scope(ws);
                let url = server::build_workspace_url(
                    &url_base,
                    &server::workspace_url_path(&ws.id, None),
                );
                println!(
                    "{} {}  {}",
                    colors.title(&format!("{}.", i + 1)),
                    colors.id(&ws.id),
                    colors.path(&path)
                );
                println!("   {}", format_workspace_flags(ws.flags, colors));
                println!("   {}", workspace_search_status(ws.search_ready));
                let rendered_url = if use_public_url {
                    colors.public_url(&url)
                } else {
                    colors.local_url(&url)
                };
                println!("   {rendered_url}");
                if i + 1 < workspaces.len() {
                    println!();
                }
            }
        }
        WorkspaceListFormat::Table => {
            let rows = workspaces
                .iter()
                .enumerate()
                .map(|(i, ws)| {
                    let path = display_workspace_scope(ws);
                    let features = format_workspace_feature_tags(ws.flags);
                    let url = server::build_workspace_url(
                        &url_base,
                        &server::workspace_url_path(&ws.id, None),
                    );
                    (i + 1, ws.id.clone(), path, features, ws.search_ready, url)
                })
                .collect::<Vec<_>>();
            let idx_width = rows.len().to_string().chars().count().max(1);
            let id_width = rows
                .iter()
                .map(|(_, id, _, _, _, _)| id.chars().count())
                .max()
                .unwrap_or(2)
                .max(2);
            let path_width = rows
                .iter()
                .map(|(_, _, path, _, _, _)| path.chars().count())
                .max()
                .unwrap_or(4)
                .max(4);
            let feature_width = rows
                .iter()
                .map(|(_, _, _, features, _, _)| features.chars().count())
                .max()
                .unwrap_or(8)
                .max(8);

            println!(
                "{}  {}  {}  {}  SEARCH           URL",
                pad_right("#", idx_width),
                pad_right("ID", id_width),
                pad_right("PATH", path_width),
                pad_right("FEATURES", feature_width)
            );
            println!(
                "{}  {}  {}  {}  ---------------  ---",
                "-".repeat(idx_width),
                "-".repeat(id_width),
                "-".repeat(path_width),
                "-".repeat(feature_width)
            );

            for (idx, id, path, features, search_ready, url) in rows {
                let features_colored = if features == "-" {
                    colors.disabled_flag(&pad_right(&features, feature_width))
                } else {
                    colors.enabled_flag(&pad_right(&features, feature_width))
                };
                let url_colored = if use_public_url {
                    colors.public_url(&url)
                } else {
                    colors.local_url(&url)
                };
                println!(
                    "{}  {}  {}  {}  {}  {}",
                    pad_right(&idx.to_string(), idx_width),
                    colors.id(&pad_right(&id, id_width)),
                    colors.path(&pad_right(&path, path_width)),
                    features_colored,
                    pad_right(workspace_search_status(search_ready), 15),
                    url_colored
                );
            }
        }
    }
    Ok(())
}

async fn detach_workspace(
    server: &RunningServer,
    target: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let workspaces = server.list_workspaces().await?;

    let id = if let Ok(idx) = target.parse::<usize>() {
        if idx == 0 || idx > workspaces.len() {
            return Err(format!("Index {idx} out of range (1-{})", workspaces.len()).into());
        }
        workspaces[idx - 1].id.as_str()
    } else {
        target
    };

    server.remove_workspace(id).await?;

    println!("Workspace '{id}' detached.");
    Ok(())
}

/// Toggle one feature flag on a workspace, resolved by ID or `markon ls` index.
/// Fetches the current flags, flips the requested one, and PUTs the full set
/// back (the mgmt endpoint replaces flags wholesale).
async fn set_workspace_feature(
    server: &RunningServer,
    target: &str,
    feature: &str,
    value: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let on = match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" | "enable" | "enabled" => true,
        "off" | "false" | "0" | "no" | "disable" | "disabled" => false,
        other => return Err(format!("Invalid value '{other}' — use on or off").into()),
    };
    let workspaces = server.list_workspaces().await?;
    let entry = if let Ok(idx) = target.parse::<usize>() {
        if idx == 0 || idx > workspaces.len() {
            return Err(format!("Index {idx} out of range (1-{})", workspaces.len()).into());
        }
        &workspaces[idx - 1]
    } else {
        workspaces
            .iter()
            .find(|w| w.id == target)
            .ok_or_else(|| format!("No workspace with id '{target}'"))?
    };
    let id = entry.id.clone();
    let mut flags = entry.flags;
    if !apply_workspace_feature(&mut flags, feature, on)? {
        println!("{id}: {feature} is always available (baseline capability)");
        return Ok(());
    }
    server.update_flags(&id, flags).await?;
    println!("{id}: {feature} = {}", if on { "on" } else { "off" });
    Ok(())
}

async fn shutdown_server(server: &RunningServer) -> Result<(), Box<dyn std::error::Error>> {
    server.shutdown().await?;

    println!("Markon server is shutting down.");
    Ok(())
}

fn format_data_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

async fn cleanup_data(server: &RunningServer, yes: bool) -> Result<(), Box<dyn std::error::Error>> {
    let stats = server.data_cleanup_stats().await?;
    println!(
        "Persistent data: {}",
        format_data_bytes(stats.database_bytes)
    );
    println!(
        "Obsolete: {} annotation files, {} annotations, {} progress records, {} chat threads / {} messages ({})",
        stats.orphaned_annotation_files,
        stats.orphaned_annotations,
        stats.orphaned_viewed_files,
        stats.orphaned_chat_threads,
        stats.orphaned_chat_messages,
        format_data_bytes(stats.orphaned_payload_bytes),
    );
    if stats.orphaned_items() == 0 {
        println!("Nothing to clean.");
        return Ok(());
    }

    let confirmed = if yes {
        true
    } else if std::io::stdin().is_terminal() {
        Confirm::new()
            .with_prompt("Permanently delete data outside all active workspaces?")
            .default(false)
            .interact()?
    } else {
        return Err("cleanup requires confirmation; rerun with --yes".into());
    };
    if !confirmed {
        println!("Cancelled.");
        return Ok(());
    }

    let result = server.cleanup_orphaned_data().await?;
    println!(
        "Deleted {} annotations, {} progress records, {} chat threads and {} messages. Database: {} → {}.",
        result.deleted_annotations,
        result.deleted_viewed_files,
        result.deleted_chat_threads,
        result.deleted_chat_messages,
        format_data_bytes(result.before.database_bytes),
        format_data_bytes(result.database_bytes_after),
    );
    Ok(())
}

async fn admin_browser_command(
    server: &RunningServer,
    command: AdminCommands,
) -> Result<(), Box<dyn std::error::Error>> {
    let workspaces = server.list_workspaces().await?;
    // Use the registry's stable order to choose a landing workspace.
    let landing = workspaces.first();
    let redirect = landing
        .map(|workspace| server::workspace_url_path(&workspace.id, None))
        .unwrap_or_else(|| "/".to_string());
    match command {
        AdminCommands::Open => {
            // The control socket mints the one-time bootstrap URL server-side
            // (nonce + the server's stable local base) and hands it back whole.
            let url = server.admin_bootstrap(&redirect).await?;
            open::that(&url)?;
            println!("Administrator session opened in your browser.");
        }
        AdminCommands::Code => {
            let (url, code) = server.admin_bootstrap_code(&redirect).await?;
            println!("Open: {url}");
            println!(
                "One-time administrator code: {}",
                CliColors::detect().title(&code)
            );
            println!("Expires in 5 minutes and is invalidated after 5 failed attempts.");
        }
    }
    Ok(())
}

/// Inputs for forwarding the just-opened workspace to an already-running server
/// and reporting it (access summary + best-effort browser open). Shared by the
/// "attach to a live daemon" path and the "spawn a daemon, then attach" path so
/// both render identically.
struct ForwardPlan<'a> {
    target: &'a WorkspaceOpenTarget,
    flags: WorkspaceFlags,
    /// `Some(hash)` only when the CLI passed `--collaborator-access-code`; the
    /// running server then updates the workspace's collaborator hash to it.
    collaborator_hash_if_set: Option<&'a str>,
    configured_host: &'a str,
    advertised_host: &'a str,
    public_base: Option<&'a str>,
    open_browser_target: Option<&'a str>,
}

fn existing_open_workspace<'a>(
    target: &WorkspaceOpenTarget,
    workspaces: &'a [WorkspaceInfo],
) -> Option<&'a WorkspaceInfo> {
    workspaces.iter().find(|workspace| {
        workspace_path_matches(&workspace.path, &target.root)
            && workspace.single_file.as_deref() == target.single_file.as_deref()
    })
}

/// Opening a known workspace is navigation, not a configuration upsert. The
/// live registry owns its flags; defaults apply only to a new registration.
async fn open_workspace_on_server(
    server: &RunningServer,
    plan: &ForwardPlan<'_>,
) -> Result<(String, WorkspaceFlags), ControlError> {
    let workspaces = server.list_workspaces().await?;
    if let Some(existing) = existing_open_workspace(plan.target, &workspaces) {
        if let Some(hash) = plan.collaborator_hash_if_set {
            server.set_access_code(&existing.id, Some(hash)).await?;
        }
        return Ok((existing.id.clone(), existing.flags));
    }
    let id = server
        .add_or_update_open_target(plan.target, plan.flags, plan.collaborator_hash_if_set)
        .await?;
    Ok((id, plan.flags))
}

/// Register (or reuse) the workspace on the running `server` over the control
/// socket, print the access summary, and best-effort open the browser. The bind
/// host/port come from the daemon's discovery lock so the printed URLs match what
/// the daemon actually serves.
async fn forward_to_running_server(
    server: &RunningServer,
    lock_host: &str,
    lock_port: u16,
    plan: &ForwardPlan<'_>,
) {
    match open_workspace_on_server(server, plan).await {
        Ok((workspace_id, flags)) => {
            // Prefer the running daemon's actual bind host (recorded in the
            // lock); fall back to our own resolved host for locks written before
            // the field existed.
            let bind_host = if lock_host.trim().is_empty() {
                plan.configured_host.to_string()
            } else {
                lock_host.to_string()
            };
            let identity_path = plan.target.identity_path();
            let summary = build_workspace_access_summary(
                &identity_path,
                flags,
                &bind_host,
                plan.advertised_host,
                lock_port,
                &workspace_id,
                plan.target.initial_path(),
                plan.public_base,
            );
            print_workspace_access_summary(&summary);
            if let Some(base_option) = plan.open_browser_target {
                let redirect =
                    server::workspace_url_path(&workspace_id, plan.target.initial_path());
                // The daemon mints the one-time bootstrap URL (nonce + its own
                // bind-aware local base) over the control socket. An explicit
                // trusted reverse-proxy origin remains an intentional override.
                match server.admin_bootstrap(&redirect).await {
                    Ok(boot_url) => {
                        let browser_url = if base_option == "local" {
                            boot_url
                        } else {
                            rehome_admin_bootstrap_url(base_option, &redirect, &boot_url)
                        };
                        if let Err(e) = open::that(&browser_url) {
                            server::report_browser_open_failure(e);
                        }
                    }
                    Err(e) => tracing::warn!("failed to create browser admin session: {e}"),
                }
            }
        }
        Err(e) => tracing::error!("failed to add workspace to running server: {e}"),
    }
}

/// Project one resolved [`WorkspaceInit`] onto its declarative
/// [`DaemonWorkspace`] wire form for the config handoff.
fn workspace_init_to_daemon(w: &WorkspaceInit) -> DaemonWorkspace {
    DaemonWorkspace {
        path: w.path.clone(),
        flags: w.flags,
        initial_path: w.initial_path.clone(),
        single_file: w.single_file.clone(),
        collaborator_access_code_hash: w.collaborator_access_code_hash.clone(),
        alias: w.alias.clone(),
    }
}

/// Build the in-process server form from the same core-resolved target used by
/// control-socket registration. This protects the foreground fallback from
/// accidentally widening a single-file open into its parent directory.
fn workspace_init_for_open_target(
    target: &WorkspaceOpenTarget,
    flags: WorkspaceFlags,
    collaborator_access_code_hash: String,
    alias: String,
) -> WorkspaceInit {
    WorkspaceInit {
        path: target.root.clone(),
        flags,
        initial_path: target.initial_path().map(str::to_string),
        single_file: target.single_file.clone(),
        collaborator_access_code_hash,
        alias,
    }
}

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

fn settings_with_public_base_url(value: Option<&str>) -> Result<AppSettings, String> {
    let mut settings = AppSettings::load();
    if let Some(value) = value.filter(|value| *value != "missing") {
        settings.save_public_base_url(value)?;
    }
    Ok(settings)
}

fn selected_public_base_url(settings: &AppSettings, value: Option<&str>) -> Option<String> {
    if value == Some("missing") {
        // A bare flag requests a local QR code without changing the saved URL.
        Some("missing".to_string())
    } else {
        settings.public_base_url().map(str::to_owned)
    }
}

/// Apply a changed default to the owning server as well as its printed links.
/// Recreate the live registry directly, without startup pruning of single files.
async fn refresh_public_base_url_server(
    settings: &AppSettings,
    explicit_clear: bool,
) -> Result<(), String> {
    let Some(lock) = ServerLock::read().filter(ServerLock::is_alive) else {
        return Ok(());
    };
    let desired = settings.public_base_url();
    if desired.is_none() && !explicit_clear {
        return Ok(());
    }
    let current = lock.entry.as_deref().filter(|url| *url != "missing");
    if current == desired {
        return Ok(());
    }
    let server = RunningServer::from_lock(&lock);
    let workspaces = server
        .list_workspaces()
        .await
        .map_err(|error| error.to_string())?;
    let mut config = DaemonConfig::from_settings(settings, lock.port);
    if !lock.host.is_empty() {
        config.host = lock.host;
    }
    if let Some(host) = lock.advertised_host {
        config.advertised_host = host;
    }
    config.workspaces = workspaces
        .into_iter()
        .map(|workspace| DaemonWorkspace {
            path: PathBuf::from(workspace.path),
            flags: workspace.flags,
            initial_path: workspace.single_file.clone(),
            single_file: workspace.single_file,
            collaborator_access_code_hash: workspace.collaborator_access_code_hash,
            alias: workspace.alias,
        })
        .collect();
    server.shutdown().await.map_err(|error| error.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while server.is_reachable() {
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "the previous server did not stop after changing the public base URL".to_string(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    markon_core::daemon::spawn_and_connect(config)
        .await
        .map_err(|error| {
            format!("public base URL saved, but the server could not be refreshed: {error}")
        })?;
    Ok(())
}

#[tokio::main]
async fn main() {
    init_tracing();
    let cli = Cli::parse();
    let cli_public_base_url = cli.public_base_url.clone();
    // Suppress the version banner when we're about to enter the full-screen
    // browser: it would flash on the primary screen just before EnterAlternateScreen
    // and remain as the only on-screen residue after LeaveAlternateScreen on quit.
    let launching_tui =
        matches!(&cli.command, Some(Commands::Ls { format: None })) && tui_enabled();
    if !launching_tui {
        println!("Markon v{}", env!("CARGO_PKG_VERSION"));
    }

    // Handle subcommands.
    if let Some(cmd) = cli.command {
        // Feedback commands run without a server.
        let feedback_cmd = match &cmd {
            Commands::Bug { title, body } => Some((feedback::FeedbackKind::Bug, title, body)),
            Commands::Idea { title, body } => Some((feedback::FeedbackKind::Idea, title, body)),
            Commands::Ask { title, body } => Some((feedback::FeedbackKind::Ask, title, body)),
            _ => None,
        };
        if let Some((kind, title, body)) = feedback_cmd {
            if let Err(e) = feedback::submit(kind, title.clone(), body.clone(), "auto") {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
            return;
        }

        let settings = settings_with_public_base_url(cli_public_base_url.as_deref())
            .unwrap_or_else(|error| {
                eprintln!("Error: {error}");
                std::process::exit(1);
            });
        if !matches!(&cmd, Commands::Shutdown) {
            if let Err(error) = refresh_public_base_url_server(
                &settings,
                cli_public_base_url.as_deref() == Some(""),
            )
            .await
            {
                eprintln!("Error: {error}");
                std::process::exit(1);
            }
        }
        let cli_public_base_url =
            selected_public_base_url(&settings, cli_public_base_url.as_deref());

        // Workspace-management commands talk to the running server over its
        // privileged control socket (recorded in the lock).
        let lock = ServerLock::read();
        let (lock_host, lock_advertised, lock_public_base_url, server) = match lock {
            Some(ref l) if l.is_alive() => (
                l.host.clone(),
                l.advertised_host.clone(),
                l.entry.clone(),
                RunningServer::from_lock(l),
            ),
            _ => {
                eprintln!("Error: No running Markon server found.");
                std::process::exit(1);
            }
        };
        let res = match cmd {
            Commands::Admin { command } => admin_browser_command(&server, command).await,
            Commands::Ls { format } => {
                // Reproduce the daemon's reachable URLs: bind host and advertised
                // host both come from the lock (what the *owning* daemon actually
                // serves under), falling back to the shared global config only for
                // a pre-field lock that didn't record its advertised host.
                let advertised_host = lock_advertised
                    .clone()
                    .unwrap_or_else(|| AppSettings::load().advertised_host);
                let bind_host = if lock_host.trim().is_empty() {
                    "127.0.0.1".to_string()
                } else {
                    lock_host.clone()
                };
                // Prefer the saved default (or a bare flag's local QR override).
                // Legacy installations without a saved URL can still inherit
                // the owning daemon's public base URL from discovery metadata.
                let effective_public_base_url = cli_public_base_url
                    .clone()
                    .or_else(|| lock_public_base_url.clone());
                match format {
                    // Explicit --format cards|table: static render, byte-for-byte
                    // as before.
                    Some(fmt) => {
                        list_workspaces(
                            &bind_host,
                            &advertised_host,
                            &server,
                            fmt,
                            effective_public_base_url.as_deref(),
                        )
                        .await
                    }
                    // Bare `markon ls` on a capable interactive terminal → the
                    // full-screen browser. `launching_tui` folds in the TTY +
                    // capability gate (and the banner was suppressed above).
                    None if launching_tui => {
                        let port = server.port();
                        // Hop onto a blocking-pool thread: the TUI loop is
                        // synchronous crossterm, and control calls run via
                        // Handle::block_on there (legal only off a runtime core
                        // worker — see tui::ls::run). spawn_blocking parks a pool
                        // thread while the multi-thread runtime's core workers keep
                        // driving the IO reactor the async transport needs.
                        let handle = tokio::runtime::Handle::current();
                        let tui_server = server.clone();
                        let tui_public_base_url = effective_public_base_url.clone();
                        let join = tokio::task::spawn_blocking(move || {
                            tui::ls::run(
                                tui_server,
                                handle,
                                bind_host,
                                advertised_host,
                                port,
                                tui_public_base_url,
                            )
                        })
                        .await;
                        match join {
                            Ok(inner) => inner.map_err(|e| -> Box<dyn std::error::Error> { e }),
                            Err(join_err) => {
                                Err(format!("interactive browser task failed: {join_err}").into())
                            }
                        }
                    }
                    // Bare `markon ls` piped / redirected / non-capable terminal →
                    // today's default static cards.
                    None => {
                        list_workspaces(
                            &bind_host,
                            &advertised_host,
                            &server,
                            WorkspaceListFormat::Cards,
                            effective_public_base_url.as_deref(),
                        )
                        .await
                    }
                }
            }
            Commands::Detach { target } => detach_workspace(&server, &target).await,
            Commands::Set {
                target,
                feature,
                value,
            } => set_workspace_feature(&server, &target, &feature, &value).await,
            Commands::Cleanup { yes } => cleanup_data(&server, yes).await,
            Commands::Shutdown => shutdown_server(&server).await,
            Commands::Bug { .. } | Commands::Idea { .. } | Commands::Ask { .. } => {
                unreachable!("handled above")
            }
        };

        if let Err(e) = res {
            // Exit non-zero so scripts / CI (and the Windows smoke harness, which
            // drives these subcommands to prove the control socket works) can tell
            // a failed management op — e.g. a broken control-socket round-trip —
            // from a successful one.
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
        return;
    }

    let open_target = if let Some(ref file_str) = cli.file {
        match WorkspaceOpenTarget::resolve(Path::new(file_str)) {
            Ok(target) => target,
            Err(_) => {
                eprintln!("Error: Path '{file_str}' not found.");
                return;
            }
        }
    } else {
        let current_dir = std::env::current_dir().expect("Cannot determine working directory");
        match WorkspaceOpenTarget::resolve(&current_dir) {
            Ok(target) => target,
            Err(e) => {
                eprintln!("Error: Cannot resolve working directory: {e}");
                return;
            }
        }
    };
    let ws_root = open_target.root.clone();
    let initial_path = open_target.initial_path().map(str::to_string);

    // Workspace IDs are SHA-256(salt + path). For URLs to survive restarts the
    // salt must be stable. AppSettings::load() persists a random salt to
    // settings.json on first run; fall back to it (also matches the GUI path)
    // so a path always hashes to the same id regardless of which surface
    // (CLI / GUI) opens it. The port-derived fallback only kicks in when no
    // settings file exists yet.
    let mut settings = settings_with_public_base_url(cli.public_base_url.as_deref())
        .unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            std::process::exit(1);
        });
    if let Err(error) =
        refresh_public_base_url_server(&settings, cli.public_base_url.as_deref() == Some("")).await
    {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
    let public_base_url = selected_public_base_url(&settings, cli.public_base_url.as_deref());
    let saved_workspace = settings.workspaces.iter().find(|w| {
        w.single_file.as_deref() == open_target.single_file.as_deref()
            && workspace_path_matches(&w.path, &ws_root)
    });
    let flags = saved_workspace
        .map(|w| w.flags)
        .unwrap_or_else(|| default_workspace_flags(&settings));
    let effective_salt = cli.salt.clone().unwrap_or_else(|| {
        if settings.salt.is_empty() {
            format!("markon:{}", cli.port)
        } else {
            settings.salt.clone()
        }
    });
    if let Some(code) = cli.collaborator_access_code.as_deref() {
        if let Err(e) = markon_core::workspace::validate_access_code(code) {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }
    }
    let workspace_collaborator_access_code_hash = resolve_workspace_collaborator_hash(
        saved_workspace
            .map(|w| w.collaborator_access_code_hash.as_str())
            .unwrap_or_default(),
        cli.collaborator_access_code.as_deref(),
        &effective_salt,
    );
    let ws_init = workspace_init_for_open_target(
        &open_target,
        flags,
        workspace_collaborator_access_code_hash.clone(),
        saved_workspace.map(|w| w.alias.clone()).unwrap_or_default(),
    );
    let open_browser_target = cli.open_browser.clone().or_else(|| {
        if cli.file.is_some() {
            Some("local".to_string())
        } else {
            None
        }
    });

    let advertised_host = settings.advertised_host.clone();
    let mut trusted_hosts = settings.trusted_hosts.clone();
    trusted_hosts.extend(cli.trusted_hosts.iter().cloned());
    trusted_hosts.sort();
    trusted_hosts.dedup();
    // Bind host used to build the printed / opened URLs in the register and
    // spawn paths (never prompts; `--host select` is resolved interactively
    // only in the foreground server path below).
    let configured_host = configured_bind_host(cli.host.as_deref(), &settings.host);

    if let Some(lock) = ServerLock::read() {
        if lock.is_alive() {
            let server = RunningServer::from_lock(&lock);
            // Use the advertised host of the owning daemon. Legacy discovery
            // locks without that metadata fall back to the saved preference.
            let effective_advertised = lock
                .advertised_host
                .clone()
                .unwrap_or_else(|| advertised_host.clone());
            // The saved URL was already applied above. Retain discovery fallback
            // for legacy daemons whose public base URL has not been persisted.
            let effective_public_base_url = public_base_url.clone().or_else(|| lock.entry.clone());
            forward_to_running_server(
                &server,
                &lock.host,
                lock.port,
                &ForwardPlan {
                    target: &open_target,
                    flags,
                    collaborator_hash_if_set: cli
                        .collaborator_access_code
                        .as_ref()
                        .map(|_| workspace_collaborator_access_code_hash.as_str()),
                    configured_host: &configured_host,
                    advertised_host: &effective_advertised,
                    public_base: effective_public_base_url.as_deref(),
                    open_browser_target: open_browser_target.as_deref(),
                },
            )
            .await;
            return;
        }
    }

    // Startup cleanup of temporary single-file workspaces, shared by the daemon
    // and foreground paths. Persist immediately so a freshly spawned markond
    // loads the already-pruned state.
    let removed = settings.prune_single_file_workspaces_for_startup();
    if removed > 0 {
        if let Err(e) = settings.save() {
            tracing::warn!(
                removed,
                "failed to persist startup cleanup of temporary workspaces: {e}"
            );
        }
    }

    // Restore persisted workspaces so a cold start doesn't immediately drop them
    // when the persist hook fires. The explicitly-opened workspace keeps its
    // persisted feature flags; only explicit CLI access-code args update its
    // access hashes. The explicit workspace itself is NOT embedded here — it is
    // forwarded to the server over the control socket after readiness, so it is
    // never opened twice (which would race the forward and double-open the
    // browser). The foreground fallback adds it directly below.
    let mut loaded_explicit_workspace = false;
    let restored_workspaces: Vec<WorkspaceInit> = settings
        .workspaces
        .iter()
        .filter(|w| !w.path.is_empty())
        .map(|w| {
            let explicit = w.single_file.as_deref() == open_target.single_file.as_deref()
                && workspace_path_matches(&w.path, &ws_root);
            if explicit {
                loaded_explicit_workspace = true;
            }
            WorkspaceInit {
                path: PathBuf::from(&w.path),
                flags: w.flags,
                initial_path: if explicit {
                    initial_path.clone()
                } else {
                    w.single_file.clone()
                },
                single_file: w.single_file.clone(),
                collaborator_access_code_hash: if explicit {
                    workspace_collaborator_access_code_hash.clone()
                } else {
                    w.collaborator_access_code_hash.clone()
                },
                alias: w.alias.clone(),
            }
        })
        .collect();

    let language = settings.effective_web_language();
    let shortcuts_json = settings.render_shortcuts_json();
    let styles_css = settings.render_styles_css();
    let theme = settings.theme.clone();
    let default_chat_mode = settings.default_chat_mode.clone();
    let collaborator_access_code_hash = settings.collaborator_access_code_hash.clone();
    let db_path = settings.db_path.clone();
    // CLI flag forces inclusion; otherwise inherit the persisted preference so
    // GUI-set values still apply when launching from the command line.
    let print_collapsed_content = cli.print_collapsed_content || settings.print_collapsed_content;

    // --- Daemon path: spawn the standalone `markond` service. ---
    // The CLI is now a pure shell: it resolves a declarative DaemonConfig,
    // writes it to a 0600 file (secrets live in the file, never argv/env), spawns
    // `markond --config <path>` detached, then drives the explicitly-opened
    // workspace in over the control socket — identical to the already-running
    // path above. Falls through to the foreground path only if the spawn itself
    // fails (not a readiness timeout, which is a hard error).
    {
        let daemon_config = DaemonConfig {
            // The daemon must not prompt: use the non-interactive resolved host.
            host: configured_host.clone(),
            advertised_host: advertised_host.clone(),
            trusted_hosts: trusted_hosts.clone(),
            port: cli.port,
            theme: theme.clone(),
            qr: settings
                .public_base_url()
                .map(str::to_owned)
                .or_else(|| public_base_url.clone()),
            // The daemon never opens the browser itself — the CLI does, over the
            // control socket, after forwarding the workspace.
            open_browser: None,
            db_path: db_path.clone(),
            salt: Some(effective_salt.clone()),
            workspaces: restored_workspaces
                .iter()
                .map(workspace_init_to_daemon)
                .collect(),
            language: language.clone(),
            shortcuts_json: shortcuts_json.clone(),
            styles_css: styles_css.clone(),
            default_chat_mode: default_chat_mode.clone(),
            collaborator_access_code_hash: collaborator_access_code_hash.clone(),
            print_collapsed_content,
        };

        println!("Starting Markon server in background...");
        // Spawn markond and drive the explicitly-opened workspace in over the
        // control socket — exactly the same forward the "already-running" path
        // takes above, so output is identical. The shared helper writes the 0600
        // config, spawns detached, waits (bounded) for readiness, and hands back
        // a connected handle (with the daemon's bind host/port for URL building).
        match markon_core::daemon::spawn_and_connect(daemon_config).await {
            Ok(server) => {
                forward_to_running_server(
                    &server,
                    server.host(),
                    server.port(),
                    &ForwardPlan {
                        target: &open_target,
                        flags,
                        collaborator_hash_if_set: cli
                            .collaborator_access_code
                            .as_ref()
                            .map(|_| workspace_collaborator_access_code_hash.as_str()),
                        configured_host: &configured_host,
                        advertised_host: &advertised_host,
                        public_base: public_base_url.as_deref(),
                        open_browser_target: open_browser_target.as_deref(),
                    },
                )
                .await;
                return;
            }
            // Readiness timeout is a hard error (the daemon spawned but never came
            // up); any other error means we couldn't spawn it at all, so fall back
            // to running the server in the foreground.
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                eprintln!("Error: the Markon server did not become ready in time.");
                std::process::exit(1);
            }
            Err(e) => {
                tracing::warn!("failed to spawn markond: {e}; falling back to foreground");
            }
        }
    }

    // --- Foreground path (spawn fallback). ---
    // Reached only when spawning `markond` failed outright (the daemon binary is
    // missing or the OS refused to launch it); this process then serves in the
    // foreground and owns the explicit workspace.
    let mut initial_workspaces = restored_workspaces;
    if !loaded_explicit_workspace {
        initial_workspaces.push(ws_init);
    }

    let server_public_base_url = settings
        .public_base_url()
        .map(str::to_owned)
        .or(public_base_url);
    let settings = Arc::new(Mutex::new(settings));

    // Share one registry with a persist hook so control-socket mutations land in
    // settings.json exactly like GUI-initiated changes do.
    let registry = Arc::new(WorkspaceRegistry::new(effective_salt.clone()));
    registry.set_persist_hook(AppSettings::persist_hook(settings.clone()));

    if let Err(e) = server::start(ServerConfig {
        // `--host select` prompts interactively; otherwise reuse the resolved
        // host (--host > global config settings.host > loopback).
        host: match &cli.host {
            Some(h) if h == "select" => match select_host() {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("Failed to select host: {e}");
                    return;
                }
            },
            _ => configured_host.clone(),
        },
        advertised_host,
        trusted_hosts,
        port: cli.port,
        theme,
        qr: server_public_base_url,
        open_browser: open_browser_target,
        shared_annotation: initial_workspaces.iter().any(|w| w.flags.shared_annotation),
        db_path,
        salt: Some(effective_salt),
        initial_workspaces,
        bound_listener: None,
        registry: Some(registry),
        management_token: None,
        admin_bootstraps: None,
        language,
        shortcuts_json,
        styles_css,
        default_chat_mode,
        collaborator_access_code_hash,
        print_collapsed_content,
    })
    .await
    {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_base_url_aliases_parse_without_changing_browser_selection() {
        for flag in ["--public-base-url", "--public-url", "--entry", "--qr"] {
            let cli =
                Cli::try_parse_from(["markon", flag, "https://md.example.com", "--open-browser"])
                    .unwrap();
            assert_eq!(
                cli.public_base_url.as_deref(),
                Some("https://md.example.com")
            );
            assert_eq!(cli.open_browser.as_deref(), Some("local"));
        }
        let cli = Cli::try_parse_from([
            "markon",
            "--public-base-url",
            "",
            "-b",
            "https://other.example.com",
        ])
        .unwrap();
        assert_eq!(cli.public_base_url.as_deref(), Some(""));
        assert_eq!(
            cli.open_browser.as_deref(),
            Some("https://other.example.com")
        );
    }

    #[test]
    fn unknown_or_monochrome_terminals_use_plain_text() {
        for term in [
            "",
            "dumb",
            "unknown",
            "vt100",
            "xterm-mono",
            "screen-m",
            "custom-terminal",
        ] {
            assert!(
                !known_color_terminal(Some(std::ffi::OsStr::new(term))),
                "{term}"
            );
        }
        assert_eq!(known_color_terminal(None), cfg!(windows));
    }

    #[test]
    fn common_color_terminals_allow_basic_ansi_styles() {
        for term in [
            "xterm",
            "xterm-256color",
            "screen",
            "tmux-256color",
            "linux",
            "xterm-kitty",
            "foot",
        ] {
            assert!(
                known_color_terminal(Some(std::ffi::OsStr::new(term))),
                "{term}"
            );
        }
    }

    fn workspace_info(path: &str, single_file: Option<&str>) -> WorkspaceInfo {
        WorkspaceInfo {
            id: "abcd1234".to_string(),
            path: path.to_string(),
            flags: WorkspaceFlags::default(),
            search_ready: true,
            ephemeral: single_file.is_some(),
            single_file: single_file.map(str::to_string),
            collaborator_access_code_hash: String::new(),
            alias: String::new(),
        }
    }

    #[test]
    fn listing_shows_the_file_a_single_file_workspace_serves() {
        // A file-scoped workspace serves out of the parent directory, so showing
        // `path` alone renders it identically to a directory workspace over the
        // same folder — and both can be open at once, which is exactly when
        // telling them apart matters.
        let directory = workspace_info("/tmp/lab", None);
        let single_file = workspace_info("/tmp/lab", Some("target.md"));

        assert_eq!(display_workspace_scope(&directory), "/tmp/lab");
        assert_eq!(display_workspace_scope(&single_file), "/tmp/lab/target.md");
        assert_ne!(
            display_workspace_scope(&directory),
            display_workspace_scope(&single_file)
        );
    }

    #[test]
    fn reopening_workspace_preserves_live_flags_and_matches_exact_scope() {
        let root = dunce::canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
        let directory = workspace_info(root.to_str().unwrap(), None);
        let mut single = workspace_info(root.to_str().unwrap(), Some("target.md"));
        single.flags = WorkspaceFlags {
            enable_edit: true,
            enable_chat: true,
            enable_live: true,
            shared_annotation: true,
            ..Default::default()
        };
        let workspaces = vec![directory, single.clone()];
        let target = WorkspaceOpenTarget {
            root,
            single_file: Some("target.md".into()),
        };
        assert_eq!(
            existing_open_workspace(&target, &workspaces).unwrap().flags,
            single.flags
        );
        assert_eq!(
            existing_open_workspace(
                &WorkspaceOpenTarget {
                    single_file: None,
                    ..target.clone()
                },
                &workspaces
            )
            .unwrap()
            .flags,
            WorkspaceFlags::default()
        );
        assert!(existing_open_workspace(
            &WorkspaceOpenTarget {
                single_file: Some("other.md".into()),
                ..target
            },
            &workspaces
        )
        .is_none());
    }

    #[test]
    fn admin_subcommands_parse_without_exposing_management_tokens() {
        let open = Cli::try_parse_from(["markon", "admin", "open"]).unwrap();
        assert!(matches!(
            open.command,
            Some(Commands::Admin {
                command: AdminCommands::Open
            })
        ));
        let code = Cli::try_parse_from(["markon", "admin", "code"]).unwrap();
        assert!(matches!(
            code.command,
            Some(Commands::Admin {
                command: AdminCommands::Code
            })
        ));
    }

    #[test]
    fn cli_open_init_preserves_single_file_scope() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../README.md");
        let target = WorkspaceOpenTarget::resolve(&file).unwrap();

        let init = workspace_init_for_open_target(
            &target,
            WorkspaceFlags::default(),
            String::new(),
            String::new(),
        );

        assert_eq!(
            init.path,
            dunce::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap()
        );
        assert_eq!(init.initial_path.as_deref(), Some("README.md"));
        assert_eq!(init.single_file.as_deref(), Some("README.md"));
    }

    #[test]
    fn workspace_summary_lists_local_and_public_urls() {
        let flags = WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: true,
            enable_live: true,
            enable_chat: false,
            shared_annotation: false,
        };
        let summary = build_workspace_access_summary(
            Path::new("/tmp/Downloads"),
            flags,
            "127.0.0.1",
            "",
            5050,
            "30c52d3e",
            None,
            Some("http://md.s17.kookyleo.space/"),
        );

        assert_eq!(summary.workspace_path, "/tmp/Downloads");
        assert_eq!(
            format_workspace_flags(summary.flags, CliColors::plain()),
            "[x] Edit  [ ] Chat  [x] Live  [ ] Share"
        );
        // Loopback bind → a single localhost URL.
        assert_eq!(summary.local_urls.len(), 1);
        assert_eq!(summary.local_urls[0].url, "http://127.0.0.1:5050/30c52d3e/");
        assert_eq!(summary.featured_url, "http://127.0.0.1:5050/30c52d3e/");
        assert_eq!(
            summary.public_url.as_deref(),
            Some("http://md.s17.kookyleo.space/30c52d3e/")
        );
        assert_eq!(
            summary.qr_url.as_deref(),
            Some("http://md.s17.kookyleo.space/30c52d3e/")
        );
    }

    #[test]
    fn workspace_summary_uses_workspace_url_for_local_qr() {
        let flags = WorkspaceFlags {
            enable_search: false,
            enable_viewed: true,
            enable_edit: false,
            enable_live: false,
            enable_chat: false,
            shared_annotation: true,
        };
        let summary = build_workspace_access_summary(
            Path::new("/tmp/notes"),
            flags,
            "127.0.0.1",
            "",
            5050,
            "30c52d3e",
            Some("notes/demo.md"),
            Some("missing"),
        );

        assert_eq!(
            format_workspace_flags(summary.flags, CliColors::plain()),
            "[ ] Edit  [ ] Chat  [ ] Live  [x] Share"
        );
        assert_eq!(
            summary.local_urls[0].url,
            "http://127.0.0.1:5050/30c52d3e/notes/demo.md"
        );
        assert_eq!(
            summary.featured_url,
            "http://127.0.0.1:5050/30c52d3e/notes/demo.md"
        );
        assert_eq!(summary.public_url, None);
        // No --public-base-url → QR falls back to the featured (loopback) workspace URL.
        assert_eq!(
            summary.qr_url.as_deref(),
            Some("http://127.0.0.1:5050/30c52d3e/notes/demo.md")
        );
    }

    #[test]
    fn configured_bind_host_precedence() {
        // Explicit --host wins over everything.
        assert_eq!(
            configured_bind_host(Some("0.0.0.0"), "192.168.1.5"),
            "0.0.0.0"
        );
        assert_eq!(
            configured_bind_host(Some("10.0.0.9"), ""),
            "10.0.0.9".to_string()
        );
        // No --host → fall back to global config when set.
        assert_eq!(configured_bind_host(None, "0.0.0.0"), "0.0.0.0");
        assert_eq!(
            configured_bind_host(None, "  192.168.1.5  "),
            "  192.168.1.5  "
        );
        // No --host and empty config → loopback.
        assert_eq!(configured_bind_host(None, ""), "127.0.0.1");
        assert_eq!(configured_bind_host(None, "   "), "127.0.0.1");
        // The interactive `select` sentinel is not a real host → fall back.
        assert_eq!(configured_bind_host(Some("select"), "0.0.0.0"), "0.0.0.0");
        assert_eq!(configured_bind_host(Some("select"), ""), "127.0.0.1");
    }

    #[test]
    fn explicit_trusted_origin_can_redeem_the_same_admin_bootstrap() {
        assert_eq!(
            rehome_admin_bootstrap_url(
                "https://md.example.com/root/",
                "/workspace/file.md?mode=preview",
                "http://127.0.0.1:6419/workspace/file.md?mode=preview#bootstrap_nonce=abc"
            ),
            "https://md.example.com/root/workspace/file.md?mode=preview#bootstrap_nonce=abc"
        );
        assert_eq!(
            rehome_admin_bootstrap_url(
                "https://md.example.com",
                "/workspace/file.md#heading",
                "http://198.51.100.7:6419/workspace/file.md#bootstrap_nonce=abc"
            ),
            "https://md.example.com/workspace/file.md#bootstrap_nonce=abc"
        );
    }

    #[test]
    fn workspace_summary_for_specific_bind_lists_single_url() {
        let flags = WorkspaceFlags {
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            enable_live: false,
            enable_chat: false,
            shared_annotation: false,
        };
        // A documentation-range IP that is not on this machine: a specific
        // (non-loopback) bind exposes exactly that address, no localhost.
        let summary = build_workspace_access_summary(
            Path::new("/tmp/docs"),
            flags,
            "198.51.100.7",
            "",
            6419,
            "abc123",
            None,
            None,
        );
        assert_eq!(summary.local_urls.len(), 1);
        assert_eq!(
            summary.local_urls[0].url,
            "http://198.51.100.7:6419/abc123/"
        );
        assert_eq!(summary.featured_url, "http://198.51.100.7:6419/abc123/");
        assert_eq!(summary.public_url, None);
        // No --public-base-url flag → no QR is emitted at all.
        assert_eq!(summary.qr_url, None);
    }

    #[test]
    fn workspace_summary_for_specific_ipv6_bind_brackets_url_host() {
        let flags = WorkspaceFlags::default();
        let summary = build_workspace_access_summary(
            Path::new("/tmp/docs"),
            flags,
            "fd00::20",
            "",
            6419,
            "abc123",
            None,
            None,
        );
        assert_eq!(summary.local_urls.len(), 1);
        assert_eq!(summary.local_urls[0].url, "http://[fd00::20]:6419/abc123/");
        assert_eq!(summary.featured_url, "http://[fd00::20]:6419/abc123/");
    }

    #[test]
    fn resolve_workspace_list_base_prefers_public_url_then_stable_local_origin() {
        // --public-base-url / public prefix takes precedence and marks use_public_url.
        assert_eq!(
            resolve_workspace_list_base("0.0.0.0", "", 6419, Some("https://md.example.com")),
            ("https://md.example.com".to_string(), true)
        );
        // "missing" sentinel is treated as no public base URL.
        assert_eq!(
            resolve_workspace_list_base("127.0.0.1", "", 6419, Some("missing")),
            ("http://127.0.0.1:6419".to_string(), false)
        );
        // No public base URL, loopback bind → loopback base.
        assert_eq!(
            resolve_workspace_list_base("127.0.0.1", "", 5050, None),
            ("http://127.0.0.1:5050".to_string(), false)
        );
        // Wildcard binds still open locally on a stable origin instead of the
        // currently-featured LAN interface.
        assert_eq!(
            resolve_workspace_list_base("0.0.0.0", "192.168.1.9", 5050, None),
            ("http://127.0.0.1:5050".to_string(), false)
        );
        // No public base URL, specific bind → that address (deterministic; not on host).
        assert_eq!(
            resolve_workspace_list_base("198.51.100.7", "", 5050, None),
            ("http://198.51.100.7:5050".to_string(), false)
        );
    }

    #[test]
    fn workspace_flags_are_plain_without_color() {
        let flags = WorkspaceFlags {
            enable_search: true,
            enable_viewed: false,
            enable_edit: true,
            enable_live: false,
            enable_chat: false,
            shared_annotation: false,
        };

        assert_eq!(
            format_workspace_flags(flags, CliColors::plain()),
            "[x] Edit  [ ] Chat  [ ] Live  [ ] Share"
        );
    }

    #[test]
    fn workspace_search_readiness_is_separate_from_advanced_flags() {
        let flags = WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: false,
            enable_live: false,
            enable_chat: false,
            shared_annotation: false,
        };

        assert_eq!(
            format_workspace_flags(flags, CliColors::plain()),
            "[ ] Edit  [ ] Chat  [ ] Live  [ ] Share"
        );
        assert_eq!(workspace_search_status(true), "Search ready");
        assert_eq!(workspace_search_status(false), "Search indexing");
    }

    #[test]
    fn cli_capabilities_preserve_legacy_baseline_preferences() {
        let mut flags = WorkspaceFlags::default();
        for name in ["search", "viewed", "progress"] {
            assert!(!apply_workspace_feature(&mut flags, name, true).unwrap());
            assert!(apply_workspace_feature(&mut flags, name, false)
                .unwrap_err()
                .contains("cannot be disabled"));
            assert_eq!(flags, WorkspaceFlags::default());
        }
        for name in ["share", "shared", "annotation", "notes"] {
            assert!(apply_workspace_feature(&mut flags, name, true).unwrap());
            assert!(flags.shared_annotation);
            apply_workspace_feature(&mut flags, name, false).unwrap();
        }
        for (index, name) in ["edit", "chat", "live", "share"].into_iter().enumerate() {
            let mut expected = WorkspaceFlags::default();
            *workspace_flag_mut(&mut expected, index) = true;
            apply_workspace_feature(&mut flags, name, true).unwrap();
            assert_eq!(flags, expected);
            apply_workspace_feature(&mut flags, name, false).unwrap();
        }
    }

    #[test]
    fn workspace_feature_tags_are_compact() {
        let flags = WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: false,
            enable_live: true,
            enable_chat: false,
            shared_annotation: false,
        };

        assert_eq!(format_workspace_feature_tags(flags), "Live");
    }

    #[test]
    fn workspace_collaborator_hash_preserves_saved_value_when_cli_omits_code() {
        let saved_guest = hash_access_code("salt", "guest");

        let guest = resolve_workspace_collaborator_hash(&saved_guest, None, "salt");

        assert_eq!(guest, saved_guest);
    }

    #[test]
    fn workspace_collaborator_hash_uses_cli_code_when_provided() {
        let saved_guest = hash_access_code("salt", "guest");

        let guest = resolve_workspace_collaborator_hash(&saved_guest, Some("newguest"), "salt");

        assert_eq!(guest, hash_access_code("salt", "newguest"));
    }

    #[test]
    fn workspace_collaborator_hash_clears_on_empty_cli_code() {
        let saved_guest = hash_access_code("salt", "guest");

        let guest = resolve_workspace_collaborator_hash(&saved_guest, Some(""), "salt");

        assert!(guest.is_empty());
    }
}
