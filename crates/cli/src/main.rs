use clap::Parser;
use dialoguer::Select;
use markon_core::net::{available_bind_hosts, BindHostKind};
use markon_core::server::{self, ServerConfig, WorkspaceInit};
use markon_core::settings::AppSettings;
use markon_core::workspace::{
    expand_and_canonicalize, hash_access_code, ServerLock, WorkspaceFlags, WorkspaceRegistry,
};
use serde::{Deserialize, Serialize};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod feedback;

const DAEMON_COLLABORATOR_ACCESS_CODE_HASH_ENV: &str =
    "MARKON_DAEMON_COLLABORATOR_ACCESS_CODE_HASH";

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

    /// Public entry URL prefix (proxy/domain). Used for QR code and "accessible at" logs.
    #[arg(long, alias = "qr", value_name = "URL_PREFIX", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "missing")]
    entry: Option<String>,

    /// Additional exact Host/origin accepted by the server (repeatable).
    #[arg(long = "trusted-host", value_name = "HOST_OR_ORIGIN", action = clap::ArgAction::Append)]
    trusted_hosts: Vec<String>,

    /// Automatically open browser (best-effort). Default is true if a path is provided.
    #[arg(short = 'b', long, value_name = "BASE_URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "local")]
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

    /// Internal flag for daemonization.
    #[arg(long, hide = true)]
    daemon_internal: bool,
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
        /// Output format.
        #[arg(long, value_enum, default_value_t = WorkspaceListFormat::Cards)]
        format: WorkspaceListFormat,
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
        /// Feature: search | viewed | edit | live | chat | shared
        feature: String,
        /// on | off
        value: String,
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
    /// The featured workspace URL (LAN IP for wildcard binds) — used for the
    /// browser auto-open and as the QR fallback.
    featured_url: String,
    public_url: Option<String>,
    qr_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceListEntry {
    id: String,
    path: String,
    #[serde(flatten)]
    flags: WorkspaceFlags,
    #[serde(default)]
    search_ready: bool,
}

#[derive(Debug, Clone, Copy)]
struct CliColors {
    enabled: bool,
}

impl CliColors {
    fn detect() -> Self {
        let enabled = std::io::stdout().is_terminal()
            && std::env::var_os("NO_COLOR").is_none()
            && std::env::var("TERM")
                .map(|term| term != "dumb")
                .unwrap_or(true);
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

/// One row per workspace flag: (enabled, card label, tag label). Single source
/// of truth for flag order and naming across the card and table renderings.
fn workspace_flag_entries(
    flags: WorkspaceFlags,
    search_ready: bool,
) -> [(bool, &'static str, &'static str); 6] {
    let (search_card, search_tag) = if flags.enable_search && search_ready {
        ("Search (ready)", "Search ready")
    } else {
        ("Search", "Search")
    };
    [
        (flags.enable_search, search_card, search_tag),
        (flags.enable_viewed, "Viewed tracking", "Viewed"),
        (flags.enable_edit, "Edit", "Edit"),
        (flags.enable_live, "Live", "Live"),
        (flags.enable_chat, "Chat", "Chat"),
        (flags.shared_annotation, "Shared notes", "Shared notes"),
    ]
}

fn format_workspace_flags(flags: WorkspaceFlags, search_ready: bool, colors: CliColors) -> String {
    workspace_flag_entries(flags, search_ready)
        .into_iter()
        .map(|(enabled, card_label, _)| {
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

fn format_workspace_feature_tags(flags: WorkspaceFlags, search_ready: bool) -> String {
    let features: Vec<&str> = workspace_flag_entries(flags, search_ready)
        .into_iter()
        .filter(|(enabled, _, _)| *enabled)
        .map(|(_, _, tag_label)| tag_label)
        .collect();
    if features.is_empty() {
        "-".to_string()
    } else {
        features.join(" | ")
    }
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

fn resolve_workspace_collaborator_hash_from_env_or_cli(
    saved_collaborator_hash: &str,
    collaborator_access_code: Option<&str>,
    salt: &str,
) -> String {
    if let Ok(daemon_collaborator_hash) = std::env::var(DAEMON_COLLABORATOR_ACCESS_CODE_HASH_ENV) {
        return daemon_collaborator_hash;
    }

    resolve_workspace_collaborator_hash(saved_collaborator_hash, collaborator_access_code, salt)
}

#[cfg(any(unix, test))]
fn daemon_args_without_access_codes<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut out = Vec::new();
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--collaborator-access-code" {
            skip_next = true;
            continue;
        }
        if arg.starts_with("--collaborator-access-code=") {
            continue;
        }
        out.push(arg);
    }
    out
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
    entry: Option<&str>,
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
    let public_url = entry
        .filter(|base| *base != "missing")
        .map(|base| server::build_workspace_url(base, &workspace_path));
    // QR target: the public URL when a real --entry prefix was given,
    // otherwise (bare --entry / "missing") fall back to the featured URL.
    let qr_url = entry.map(|_| public_url.clone().unwrap_or_else(|| featured_url.clone()));

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
    advertised_host: &str,
    port: u16,
    entry: Option<&str>,
) -> (String, bool) {
    match entry.filter(|base| *base != "missing") {
        Some(base) => (base.to_string(), true),
        None => (
            server::featured_base_url(bind_host, advertised_host, port),
            false,
        ),
    }
}

fn print_workspace_access_summary(summary: &WorkspaceAccessSummary) {
    let colors = CliColors::detect();
    println!(
        "{} {}",
        colors.title("Added workspace:"),
        colors.path(&summary.workspace_path)
    );
    println!("{}", format_workspace_flags(summary.flags, false, colors));
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

/// Fetch the running server's workspace list (GET /api/workspaces).
async fn fetch_workspaces(
    client: &reqwest::Client,
    port: u16,
    token: &str,
) -> Result<Vec<WorkspaceListEntry>, Box<dyn std::error::Error>> {
    Ok(client
        .get(format!("http://127.0.0.1:{port}/api/workspaces"))
        .header("X-Markon-Token", token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn list_workspaces(
    bind_host: &str,
    advertised_host: &str,
    port: u16,
    token: &str,
    format: WorkspaceListFormat,
    entry: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Must use the async reqwest client. reqwest::blocking::Client::new()
    // spins up its own internal tokio runtime; constructing it from inside
    // an outer tokio runtime (we run under #[tokio::main]) panics on drop
    // with "Cannot drop a runtime in a context where blocking is not
    // allowed". Same applies to every other CLI -> server HTTP call below.
    let client = reqwest::Client::new();
    let workspaces = fetch_workspaces(&client, port, token).await?;

    if workspaces.is_empty() {
        println!("No active workspaces.");
        return Ok(());
    }

    let colors = CliColors::detect();
    let (url_base, use_entry_url) =
        resolve_workspace_list_base(bind_host, advertised_host, port, entry);
    match format {
        WorkspaceListFormat::Cards => {
            for (i, ws) in workspaces.iter().enumerate() {
                let path = display_workspace_path(Path::new(&ws.path));
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
                println!(
                    "   {}",
                    format_workspace_flags(ws.flags, ws.search_ready, colors)
                );
                let rendered_url = if use_entry_url {
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
                    let path = display_workspace_path(Path::new(&ws.path));
                    let features = format_workspace_feature_tags(ws.flags, ws.search_ready);
                    let url = server::build_workspace_url(
                        &url_base,
                        &server::workspace_url_path(&ws.id, None),
                    );
                    (i + 1, ws.id.clone(), path, features, url)
                })
                .collect::<Vec<_>>();
            let idx_width = rows.len().to_string().chars().count().max(1);
            let id_width = rows
                .iter()
                .map(|(_, id, _, _, _)| id.chars().count())
                .max()
                .unwrap_or(2)
                .max(2);
            let path_width = rows
                .iter()
                .map(|(_, _, path, _, _)| path.chars().count())
                .max()
                .unwrap_or(4)
                .max(4);
            let feature_width = rows
                .iter()
                .map(|(_, _, _, features, _)| features.chars().count())
                .max()
                .unwrap_or(8)
                .max(8);

            println!(
                "{}  {}  {}  {}  URL",
                pad_right("#", idx_width),
                pad_right("ID", id_width),
                pad_right("PATH", path_width),
                pad_right("FEATURES", feature_width)
            );
            println!(
                "{}  {}  {}  {}  ---",
                "-".repeat(idx_width),
                "-".repeat(id_width),
                "-".repeat(path_width),
                "-".repeat(feature_width)
            );

            for (idx, id, path, features, url) in rows {
                let features_colored = if features == "-" {
                    colors.disabled_flag(&pad_right(&features, feature_width))
                } else {
                    colors.enabled_flag(&pad_right(&features, feature_width))
                };
                let url_colored = if use_entry_url {
                    colors.public_url(&url)
                } else {
                    colors.local_url(&url)
                };
                println!(
                    "{}  {}  {}  {}  {}",
                    pad_right(&idx.to_string(), idx_width),
                    colors.id(&pad_right(&id, id_width)),
                    colors.path(&pad_right(&path, path_width)),
                    features_colored,
                    url_colored
                );
            }
        }
    }
    Ok(())
}

async fn detach_workspace(
    port: u16,
    token: &str,
    target: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let workspaces = fetch_workspaces(&client, port, token).await?;

    let id = if let Ok(idx) = target.parse::<usize>() {
        if idx == 0 || idx > workspaces.len() {
            return Err(format!("Index {idx} out of range (1-{})", workspaces.len()).into());
        }
        workspaces[idx - 1].id.as_str()
    } else {
        target
    };

    client
        .delete(format!("http://127.0.0.1:{port}/api/workspace/{id}"))
        .header("X-Markon-Token", token)
        .send()
        .await?
        .error_for_status()?;

    println!("Workspace '{id}' detached.");
    Ok(())
}

/// Toggle one feature flag on a workspace, resolved by ID or `markon ls` index.
/// Fetches the current flags, flips the requested one, and PUTs the full set
/// back (the mgmt endpoint replaces flags wholesale).
async fn set_workspace_feature(
    port: u16,
    token: &str,
    target: &str,
    feature: &str,
    value: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let on = match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" | "enable" | "enabled" => true,
        "off" | "false" | "0" | "no" | "disable" | "disabled" => false,
        other => return Err(format!("Invalid value '{other}' — use on or off").into()),
    };
    let client = reqwest::Client::new();
    let workspaces = fetch_workspaces(&client, port, token).await?;
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
    match feature.to_ascii_lowercase().as_str() {
        "search" => flags.enable_search = on,
        "viewed" => flags.enable_viewed = on,
        "edit" => flags.enable_edit = on,
        "live" => flags.enable_live = on,
        "chat" => flags.enable_chat = on,
        "shared" | "annotation" | "notes" => flags.shared_annotation = on,
        other => {
            return Err(format!(
                "Unknown feature '{other}' — use search, viewed, edit, live, chat, or shared"
            )
            .into())
        }
    }
    client
        .put(format!("http://127.0.0.1:{port}/api/workspace/{id}"))
        .header("X-Markon-Token", token)
        .json(&flags)
        .send()
        .await?
        .error_for_status()?;
    println!("{id}: {feature} = {}", if on { "on" } else { "off" });
    Ok(())
}

async fn shutdown_server(port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    client
        .post(format!("http://127.0.0.1:{port}/api/shutdown"))
        .header("X-Markon-Token", token)
        .send()
        .await?
        .error_for_status()?;

    println!("Markon server is shutting down.");
    Ok(())
}

#[derive(Serialize)]
struct AdminBootstrapRequest<'a> {
    mode: &'a str,
    redirect: &'a str,
}

#[derive(Deserialize)]
struct AdminBootstrapResponse {
    path: String,
    nonce: Option<String>,
    code: Option<String>,
}

async fn request_admin_bootstrap(
    port: u16,
    token: &str,
    mode: &str,
    redirect: &str,
) -> Result<AdminBootstrapResponse, Box<dyn std::error::Error>> {
    Ok(reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/admin/bootstrap"))
        .header("X-Markon-Token", token)
        .json(&AdminBootstrapRequest { mode, redirect })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn admin_browser_command(
    port: u16,
    token: &str,
    command: AdminCommands,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let workspaces = fetch_workspaces(&client, port, token).await?;
    let redirect = workspaces
        .first()
        .map(|workspace| server::workspace_url_path(&workspace.id, None))
        .unwrap_or_else(|| "/".to_string());
    let base = format!("http://127.0.0.1:{port}");
    match command {
        AdminCommands::Open => {
            let bootstrap = request_admin_bootstrap(port, token, "url", &redirect).await?;
            let nonce = bootstrap.nonce.ok_or("server did not return a nonce")?;
            let url = format!(
                "{}#nonce={nonce}",
                server::build_workspace_url(&base, &bootstrap.path)
            );
            open::that(&url)?;
            println!("Administrator session opened in your browser.");
        }
        AdminCommands::Code => {
            let bootstrap = request_admin_bootstrap(port, token, "code", &redirect).await?;
            let code = bootstrap
                .code
                .ok_or("server did not return a pairing code")?;
            let url = server::build_workspace_url(&base, &bootstrap.path);
            println!("Open: {url}");
            println!("One-time administrator code: {code}");
            println!("Expires in 5 minutes and is invalidated after 5 failed attempts.");
        }
    }
    Ok(())
}

async fn add_or_update_workspace(
    port: u16,
    token: &str,
    ws_path: &str,
    flags: WorkspaceFlags,
    collaborator_access_code_hash: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();

    // Mirrors the server's AddWorkspaceRequest so a new WorkspaceFlags field is
    // carried automatically. The collaborator hash is already salted on the CLI
    // side and is optional: omitted means "inherit global/no change".
    #[derive(Serialize)]
    struct AddWorkspaceBody<'a> {
        path: &'a str,
        #[serde(flatten)]
        flags: WorkspaceFlags,
        #[serde(default, skip_serializing_if = "str::is_empty")]
        collaborator_access_code_hash: &'a str,
    }

    #[derive(Serialize)]
    struct WorkspaceAccessBody<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        collaborator_access_code_hash: Option<&'a str>,
    }

    // Check if this path is already a registered workspace.
    let workspaces = fetch_workspaces(&client, port, token).await?;

    if let Some(existing) = workspaces.iter().find(|w| w.path == ws_path) {
        let id = &existing.id;
        if collaborator_access_code_hash.is_some() {
            client
                .put(format!("http://127.0.0.1:{port}/api/workspace/{id}/access"))
                .header("X-Markon-Token", token)
                .json(&WorkspaceAccessBody {
                    collaborator_access_code_hash,
                })
                .send()
                .await?
                .error_for_status()?;
        }
        return Ok(id.clone());
    }

    let resp: serde_json::Value = client
        .post(format!("http://127.0.0.1:{port}/api/workspace"))
        .header("X-Markon-Token", token)
        .json(&AddWorkspaceBody {
            path: ws_path,
            flags,
            collaborator_access_code_hash: collaborator_access_code_hash.unwrap_or_default(),
        })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let id = resp["id"].as_str().ok_or("no id in response")?;
    Ok(id.to_string())
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

#[tokio::main]
async fn main() {
    init_tracing();
    let cli = Cli::parse();
    let cli_entry = cli.entry.clone();
    println!("Markon v{}", env!("CARGO_PKG_VERSION"));

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

        // Workspace-management commands talk to the running server.
        let lock = ServerLock::read();
        let (port, token, lock_host) = match lock {
            Some(ref l) if l.is_alive() => (l.port, l.token.clone(), l.host.clone()),
            _ => {
                eprintln!("Error: No running Markon server found.");
                return;
            }
        };

        let res = match cmd {
            Commands::Admin { command } => admin_browser_command(port, &token, command).await,
            Commands::Ls { format } => {
                // Reproduce the daemon's reachable URLs: bind host from the
                // lock, advertised preference from the shared global config.
                let advertised_host = AppSettings::load().advertised_host;
                let bind_host = if lock_host.trim().is_empty() {
                    "127.0.0.1".to_string()
                } else {
                    lock_host.clone()
                };
                list_workspaces(
                    &bind_host,
                    &advertised_host,
                    port,
                    &token,
                    format,
                    cli_entry.as_deref(),
                )
                .await
            }
            Commands::Detach { target } => detach_workspace(port, &token, &target).await,
            Commands::Set {
                target,
                feature,
                value,
            } => set_workspace_feature(port, &token, &target, &feature, &value).await,
            Commands::Shutdown => shutdown_server(port, &token).await,
            Commands::Bug { .. } | Commands::Idea { .. } | Commands::Ask { .. } => {
                unreachable!("handled above")
            }
        };

        if let Err(e) = res {
            eprintln!("Error: {e}");
        }
        return;
    }

    let (ws_root, initial_path) = if let Some(ref file_str) = cli.file {
        let path = Path::new(file_str);
        let canonical = match dunce::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("Error: Path '{file_str}' not found.");
                return;
            }
        };
        if canonical.is_dir() {
            (canonical, None)
        } else {
            let parent = canonical.parent().unwrap().to_path_buf();
            let filename = canonical.file_name().unwrap().to_string_lossy().to_string();
            (parent, Some(filename))
        }
    } else {
        (
            std::env::current_dir().expect("Cannot determine working directory"),
            None,
        )
    };

    // Workspace IDs are SHA-256(salt + path). For URLs to survive restarts the
    // salt must be stable. AppSettings::load() persists a random salt to
    // settings.json on first run; fall back to it (also matches the GUI path)
    // so a path always hashes to the same id regardless of which surface
    // (CLI / GUI) opens it. The port-derived fallback only kicks in when no
    // settings file exists yet.
    let mut settings = AppSettings::load();
    let saved_workspace = settings
        .workspaces
        .iter()
        .find(|w| w.single_file.is_none() && workspace_path_matches(&w.path, &ws_root));
    let flags = saved_workspace
        .map(|w| w.flags)
        .unwrap_or_else(|| default_workspace_flags(&settings));
    let ws_init = WorkspaceInit {
        path: ws_root.clone(),
        flags,
        initial_path: initial_path.clone(),
        single_file: None,
        collaborator_access_code_hash: String::new(),
        alias: saved_workspace.map(|w| w.alias.clone()).unwrap_or_default(),
    };
    let effective_salt = cli.salt.clone().unwrap_or_else(|| {
        if settings.salt.is_empty() {
            format!("markon:{}", cli.port)
        } else {
            settings.salt.clone()
        }
    });
    let workspace_collaborator_access_code_hash =
        resolve_workspace_collaborator_hash_from_env_or_cli(
            saved_workspace
                .map(|w| w.collaborator_access_code_hash.as_str())
                .unwrap_or_default(),
            cli.collaborator_access_code.as_deref(),
            &effective_salt,
        );
    let ws_init = WorkspaceInit {
        collaborator_access_code_hash: workspace_collaborator_access_code_hash.clone(),
        ..ws_init
    };
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
            match add_or_update_workspace(
                lock.port,
                &lock.token,
                &ws_root.to_string_lossy(),
                flags,
                cli.collaborator_access_code
                    .as_ref()
                    .map(|_| workspace_collaborator_access_code_hash.as_str()),
            )
            .await
            {
                Ok(workspace_id) => {
                    // Prefer the running daemon's actual bind host (recorded in
                    // the lock); fall back to our own resolved host for locks
                    // written before the field existed.
                    let bind_host = if lock.host.trim().is_empty() {
                        configured_host.clone()
                    } else {
                        lock.host.clone()
                    };
                    let summary = build_workspace_access_summary(
                        &ws_root,
                        flags,
                        &bind_host,
                        &advertised_host,
                        lock.port,
                        &workspace_id,
                        initial_path.as_deref(),
                        cli.entry.as_deref(),
                    );
                    print_workspace_access_summary(&summary);
                    if let Some(base_option) = open_browser_target.as_deref() {
                        let base = if base_option == "local" {
                            server::featured_base_url(&bind_host, &advertised_host, lock.port)
                        } else {
                            base_option.to_string()
                        };
                        let redirect =
                            server::workspace_url_path(&workspace_id, initial_path.as_deref());
                        match request_admin_bootstrap(lock.port, &lock.token, "url", &redirect)
                            .await
                        {
                            Ok(bootstrap) => {
                                if let Some(nonce) = bootstrap.nonce {
                                    let browser_url = format!(
                                        "{}#nonce={nonce}",
                                        server::build_workspace_url(&base, &bootstrap.path)
                                    );
                                    if let Err(e) = open::that(&browser_url) {
                                        tracing::warn!("best-effort browser open failed: {e}");
                                    }
                                } else {
                                    tracing::warn!("server returned no browser bootstrap nonce");
                                }
                            }
                            Err(e) => tracing::warn!("failed to create browser admin session: {e}"),
                        }
                    }
                }
                Err(e) => tracing::error!("failed to add workspace to running server: {e}"),
            }
            return;
        }
    }

    #[cfg(unix)]
    if !cli.daemon_internal {
        let mut args = daemon_args_without_access_codes(std::env::args().skip(1));
        args.push("--daemon-internal".to_string());

        use std::process::Stdio;
        let id = markon_core::workspace::hash_id(&ws_root, &effective_salt);
        let current_exe = std::env::current_exe().expect("Failed to get current executable");
        let mut command = std::process::Command::new(current_exe);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if cli.collaborator_access_code.is_some() {
            command.env(
                DAEMON_COLLABORATOR_ACCESS_CODE_HASH_ENV,
                &workspace_collaborator_access_code_hash,
            );
        }
        let res = command.spawn();

        match res {
            Ok(_) => {
                let summary = build_workspace_access_summary(
                    &ws_root,
                    flags,
                    &configured_host,
                    &advertised_host,
                    cli.port,
                    &id,
                    initial_path.as_deref(),
                    cli.entry.as_deref(),
                );
                println!("Starting Markon server in background...");
                print_workspace_access_summary(&summary);
                return;
            }
            Err(e) => {
                tracing::warn!("failed to daemonize: {e}; falling back to foreground");
            }
        }
    }

    let removed = settings.prune_single_file_workspaces_for_startup();
    if removed > 0 {
        if let Err(e) = settings.save() {
            tracing::warn!(
                removed,
                "failed to persist startup cleanup of temporary workspaces: {e}"
            );
        }
    }

    // Restore persisted workspaces so a daemon cold-start doesn't immediately
    // drop them when the persist hook fires. The explicitly-opened workspace
    // keeps its persisted feature flags; only explicit CLI access-code args
    // update its access hashes.
    let mut loaded_explicit_workspace = false;
    let mut initial_workspaces: Vec<WorkspaceInit> = settings
        .workspaces
        .iter()
        .filter(|w| !w.path.is_empty())
        .map(|w| {
            let explicit = w.single_file.is_none() && workspace_path_matches(&w.path, &ws_root);
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
    if !loaded_explicit_workspace {
        initial_workspaces.push(ws_init);
    }

    let language = settings.effective_web_language();
    let shortcuts_json = settings.render_shortcuts_json();
    let styles_css = settings.render_styles_css();
    let default_chat_mode = settings.default_chat_mode.clone();
    let editor_theme = settings.web_editor_theme.clone();
    let collaborator_access_code_hash = settings.collaborator_access_code_hash.clone();
    let db_path = settings.db_path.clone();
    // CLI flag forces inclusion; otherwise inherit the persisted preference so
    // GUI-set values still apply when launching from the command line.
    let print_collapsed_content = cli.print_collapsed_content || settings.print_collapsed_content;

    let settings = Arc::new(Mutex::new(settings));

    // Share one registry with a persist hook so HTTP API mutations
    // (e.g. `markon <dir>` into the running daemon) land in settings.json
    // exactly like GUI-initiated changes do.
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
        theme: "auto".to_string(),
        qr: cli.entry,
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
        editor_theme,
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
            format_workspace_flags(summary.flags, false, CliColors::plain()),
            "[x] Search  [x] Viewed tracking  [x] Edit  [x] Live  [ ] Chat  [ ] Shared notes"
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
            format_workspace_flags(summary.flags, false, CliColors::plain()),
            "[ ] Search  [x] Viewed tracking  [ ] Edit  [ ] Live  [ ] Chat  [x] Shared notes"
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
        // No --entry → QR falls back to the featured (loopback) workspace URL.
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
        // No --entry/--qr flag → no QR is emitted at all.
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
    fn resolve_workspace_list_base_prefers_entry_then_featured() {
        // --entry / public prefix takes precedence and marks use_entry_url.
        assert_eq!(
            resolve_workspace_list_base("0.0.0.0", "", 6419, Some("https://md.example.com")),
            ("https://md.example.com".to_string(), true)
        );
        // "missing" sentinel is treated as no entry.
        assert_eq!(
            resolve_workspace_list_base("127.0.0.1", "", 6419, Some("missing")),
            ("http://127.0.0.1:6419".to_string(), false)
        );
        // No entry, loopback bind → loopback base.
        assert_eq!(
            resolve_workspace_list_base("127.0.0.1", "", 5050, None),
            ("http://127.0.0.1:5050".to_string(), false)
        );
        // No entry, specific bind → that address (deterministic; not on host).
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
            format_workspace_flags(flags, false, CliColors::plain()),
            "[x] Search  [ ] Viewed tracking  [x] Edit  [ ] Live  [ ] Chat  [ ] Shared notes"
        );
    }

    #[test]
    fn workspace_list_flags_show_ready_search_state() {
        let flags = WorkspaceFlags {
            enable_search: true,
            enable_viewed: true,
            enable_edit: false,
            enable_live: false,
            enable_chat: false,
            shared_annotation: false,
        };

        assert_eq!(
            format_workspace_flags(flags, true, CliColors::plain()),
            "[x] Search (ready)  [x] Viewed tracking  [ ] Edit  [ ] Live  [ ] Chat  [ ] Shared notes"
        );
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

        assert_eq!(
            format_workspace_feature_tags(flags, true),
            "Search ready | Viewed | Live"
        );
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

    #[test]
    fn daemon_args_strip_plaintext_access_codes() {
        let args = daemon_args_without_access_codes(
            [
                "--collaborator-access-code=guest secret",
                "--host",
                "0.0.0.0",
                "README.md",
            ]
            .into_iter()
            .map(String::from),
        );

        assert_eq!(args, ["--host", "0.0.0.0", "README.md"]);
    }
}
