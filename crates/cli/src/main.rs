use clap::Parser;
use dialoguer::Select;
use local_ip_address::list_afinet_netifas;
use markon_core::server::{self, ServerConfig, WorkspaceInit};
use markon_core::settings::AppSettings;
use markon_core::workspace::{ServerLock, WorkspaceFlags, WorkspaceRegistry};
use serde::Deserialize;
use std::io::IsTerminal;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn get_available_hosts() -> Vec<(String, String)> {
    let mut hosts = vec![
        (
            "127.0.0.1".to_string(),
            "Localhost (local only)".to_string(),
        ),
        (
            "0.0.0.0".to_string(),
            "All interfaces (LAN accessible)".to_string(),
        ),
    ];
    if let Ok(ifaces) = list_afinet_netifas() {
        for (name, ip) in ifaces {
            let ip_str = ip.to_string();
            if ip_str != "127.0.0.1" && !ip_str.starts_with("169.254") {
                hosts.push((ip_str.clone(), format!("{ip_str} ({name})")));
            }
        }
    }
    hosts
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

/// markon - Turn your markdown on.
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

    /// Theme selection (light, dark, auto).
    #[arg(
        short = 't', long, default_value = "auto",
        value_parser = clap::builder::PossibleValuesParser::new(["light", "dark", "auto"])
    )]
    theme: String,

    /// Public entry URL prefix (proxy/domain). Used for QR code and "accessible at" logs.
    #[arg(long, alias = "qr", value_name = "URL_PREFIX", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "missing")]
    entry: Option<String>,

    /// Automatically open browser (best-effort). Default is true if a path is provided.
    #[arg(short = 'b', long, value_name = "BASE_URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "local")]
    open_browser: Option<String>,

    /// Enable shared annotations (new server only).
    #[arg(long, action = clap::ArgAction::SetTrue)]
    shared_annotation: bool,

    /// Salt for workspace ID generation.
    #[arg(long)]
    salt: Option<String>,

    /// Enable full-text search for the workspace.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_search: bool,

    /// Enable section viewed checkboxes for the workspace.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_viewed: bool,

    /// Enable live collaboration (view sync).
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_live: bool,

    /// Enable Markdown file editing for the workspace.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_edit: bool,

    /// Enable AI chat (read-only assistant) for the workspace.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_chat: bool,

    /// Internal flag for daemonization.
    #[arg(long, hide = true)]
    daemon_internal: bool,
}

#[derive(clap::Subcommand, Debug)]
enum Commands {
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
    /// Shutdown the background Markon server.
    Shutdown,
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
    local_url: String,
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

fn format_workspace_flags(
    flags: WorkspaceFlags,
    search_ready: bool,
    colors: CliColors,
) -> String {
    let search_label = if flags.enable_search && search_ready {
        "Search (ready)"
    } else {
        "Search"
    };
    [
        (flags.enable_search, search_label),
        (flags.enable_viewed, "Viewed tracking"),
        (flags.enable_edit, "Edit"),
        (flags.enable_live, "Live"),
        (flags.enable_chat, "Chat"),
        (flags.shared_annotation, "Shared notes"),
    ]
    .into_iter()
    .map(|(enabled, label)| {
        let plain = format!("[{}] {label}", if enabled { "x" } else { " " });
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
    let mut features = Vec::new();
    if flags.enable_search {
        features.push(if search_ready {
            "Search ready".to_string()
        } else {
            "Search".to_string()
        });
    }
    if flags.enable_viewed {
        features.push("Viewed".to_string());
    }
    if flags.enable_edit {
        features.push("Edit".to_string());
    }
    if flags.enable_live {
        features.push("Live".to_string());
    }
    if flags.enable_chat {
        features.push("Chat".to_string());
    }
    if flags.shared_annotation {
        features.push("Shared notes".to_string());
    }
    if features.is_empty() {
        "-".to_string()
    } else {
        features.join(" | ")
    }
}

fn pad_right(text: &str, width: usize) -> String {
    let pad = width.saturating_sub(text.chars().count());
    format!("{text}{}", " ".repeat(pad))
}

fn build_workspace_access_summary(
    workspace_root: &Path,
    flags: WorkspaceFlags,
    local_base: &str,
    workspace_id: &str,
    initial_path: Option<&str>,
    entry: Option<&str>,
) -> WorkspaceAccessSummary {
    let workspace_path = server::workspace_url_path(workspace_id, initial_path);
    let local_url = server::build_workspace_url(local_base, &workspace_path);
    let public_url = entry
        .filter(|base| *base != "missing")
        .map(|base| server::build_workspace_url(base, &workspace_path));
    let qr_url = entry.map(|base| {
        if base == "missing" {
            local_url.clone()
        } else {
            server::build_workspace_url(base, &workspace_path)
        }
    });

    WorkspaceAccessSummary {
        workspace_path: display_workspace_path(workspace_root),
        flags,
        local_url,
        public_url,
        qr_url,
    }
}

fn build_browser_target_url(
    local_base: &str,
    workspace_id: &str,
    initial_path: Option<&str>,
    open_browser: Option<&str>,
) -> Option<String> {
    let workspace_path = server::workspace_url_path(workspace_id, initial_path);
    open_browser.map(|base| {
        if base == "local" {
            server::build_workspace_url(local_base, &workspace_path)
        } else {
            server::build_workspace_url(base, &workspace_path)
        }
    })
}

fn resolve_workspace_list_base(port: u16, entry: Option<&str>) -> (String, bool) {
    match entry.filter(|base| *base != "missing") {
        Some(base) => (base.to_string(), true),
        None => (format!("http://127.0.0.1:{port}"), false),
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
    println!("{}", colors.local_url(&summary.local_url));
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

fn list_workspaces(
    port: u16,
    token: &str,
    format: WorkspaceListFormat,
    entry: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();
    let workspaces: Vec<WorkspaceListEntry> = client
        .get(format!("http://127.0.0.1:{port}/api/workspaces"))
        .header("X-Markon-Token", token)
        .send()?
        .error_for_status()?
        .json()?;

    if workspaces.is_empty() {
        println!("No active workspaces.");
        return Ok(());
    }

    let colors = CliColors::detect();
    let (url_base, use_entry_url) = resolve_workspace_list_base(port, entry);
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

fn detach_workspace(
    port: u16,
    token: &str,
    target: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();
    let workspaces: serde_json::Value = client
        .get(format!("http://127.0.0.1:{port}/api/workspaces"))
        .header("X-Markon-Token", token)
        .send()?
        .error_for_status()?
        .json()?;

    let arr = workspaces
        .as_array()
        .ok_or("Invalid response from server")?;
    let id = if let Ok(idx) = target.parse::<usize>() {
        if idx == 0 || idx > arr.len() {
            return Err(format!("Index {idx} out of range (1-{})", arr.len()).into());
        }
        arr[idx - 1]["id"].as_str().ok_or("Workspace has no id")?
    } else {
        target
    };

    client
        .delete(format!("http://127.0.0.1:{port}/api/workspace/{id}"))
        .header("X-Markon-Token", token)
        .send()?
        .error_for_status()?;

    println!("Workspace '{id}' detached.");
    Ok(())
}

fn shutdown_server(port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();
    client
        .post(format!("http://127.0.0.1:{port}/api/shutdown"))
        .header("X-Markon-Token", token)
        .send()?
        .error_for_status()?;

    println!("Markon server is shutting down.");
    Ok(())
}

fn add_or_update_workspace(
    port: u16,
    token: &str,
    ws_path: &str,
    flags: WorkspaceFlags,
) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();

    // Check if this path is already a registered workspace.
    let workspaces: serde_json::Value = client
        .get(format!("http://127.0.0.1:{port}/api/workspaces"))
        .header("X-Markon-Token", token)
        .send()?
        .error_for_status()?
        .json()?;

    if let Some(existing) = workspaces
        .as_array()
        .and_then(|arr| arr.iter().find(|w| w["path"].as_str() == Some(ws_path)))
    {
        let id = existing["id"].as_str().ok_or("no id in workspace")?;
        client
            .put(format!("http://127.0.0.1:{port}/api/workspace/{id}"))
            .header("X-Markon-Token", token)
            .json(&flags)
            .send()?
            .error_for_status()?;
        return Ok(id.to_string());
    }

    let resp: serde_json::Value = client
        .post(format!("http://127.0.0.1:{port}/api/workspace"))
        .header("X-Markon-Token", token)
        .json(&serde_json::json!({
            "path": ws_path,
            "enable_search": flags.enable_search,
            "enable_viewed": flags.enable_viewed,
            "enable_edit": flags.enable_edit,
            "enable_live": flags.enable_live,
            "enable_chat": flags.enable_chat,
            "shared_annotation": flags.shared_annotation,
        }))
        .send()?
        .error_for_status()?
        .json()?;
    let id = resp["id"].as_str().ok_or("no id in response")?;
    Ok(id.to_string())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let cli_entry = cli.entry.clone();
    println!("Markon v{}", env!("CARGO_PKG_VERSION"));

    // Handle subcommands for workspace management.
    if let Some(cmd) = cli.command {
        let lock = ServerLock::read();
        let (port, token) = match lock {
            Some(ref l) if l.is_alive() => (l.port, l.token.clone()),
            _ => {
                eprintln!("Error: No running Markon server found.");
                return;
            }
        };

        let res = match cmd {
            Commands::Ls { format } => list_workspaces(port, &token, format, cli_entry.as_deref()),
            Commands::Detach { target } => detach_workspace(port, &token, &target),
            Commands::Shutdown => shutdown_server(port, &token),
        };

        if let Err(e) = res {
            eprintln!("Error: {e}");
        }
        return;
    }

    let theme = cli.theme.clone();

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

    let flags = WorkspaceFlags {
        enable_search: cli.enable_search,
        enable_viewed: cli.enable_viewed,
        enable_edit: cli.enable_edit,
        enable_live: cli.enable_live,
        enable_chat: cli.enable_chat,
        shared_annotation: cli.shared_annotation,
    };
    let ws_init = WorkspaceInit {
        path: ws_root.clone(),
        flags,
        initial_path: initial_path.clone(),
    };

    let effective_salt = cli
        .salt
        .clone()
        .unwrap_or_else(|| format!("markon:{}", cli.port));
    let id = markon_core::workspace::hash_id(&ws_root, &effective_salt);

    let open_browser_target = cli.open_browser.clone().or_else(|| {
        if cli.file.is_some() {
            Some("local".to_string())
        } else {
            None
        }
    });

    if let Some(lock) = ServerLock::read() {
        if lock.is_alive() {
            match add_or_update_workspace(lock.port, &lock.token, &ws_root.to_string_lossy(), flags)
            {
                Ok(workspace_id) => {
                    let local_base = format!("http://127.0.0.1:{}", lock.port);
                    let summary = build_workspace_access_summary(
                        &ws_root,
                        flags,
                        &local_base,
                        &workspace_id,
                        initial_path.as_deref(),
                        cli.entry.as_deref(),
                    );
                    print_workspace_access_summary(&summary);
                    if let Some(browser_url) = build_browser_target_url(
                        &local_base,
                        &workspace_id,
                        initial_path.as_deref(),
                        open_browser_target.as_deref(),
                    ) {
                        if let Err(e) = open::that(&browser_url) {
                            eprintln!("[info] Best-effort browser open failed: {e}");
                        }
                    }
                }
                Err(e) => eprintln!("Failed to add workspace to running server: {e}"),
            }
            return;
        }
    }

    if !cli.daemon_internal {
        let current_exe = std::env::current_exe().expect("Failed to get current executable");
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        args.push("--daemon-internal".to_string());

        #[cfg(unix)]
        {
            use std::process::Stdio;
            let res = std::process::Command::new(current_exe)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();

            match res {
                Ok(_) => {
                    let local_base = format!("http://127.0.0.1:{}", cli.port);
                    let summary = build_workspace_access_summary(
                        &ws_root,
                        flags,
                        &local_base,
                        &id,
                        initial_path.as_deref(),
                        cli.entry.as_deref(),
                    );
                    println!("Starting Markon server in background...");
                    print_workspace_access_summary(&summary);
                    return;
                }
                Err(e) => {
                    eprintln!("Failed to daemonize: {e}. Falling back to foreground.");
                }
            }
        }
    }

    let settings = Arc::new(Mutex::new(AppSettings::load()));

    // Share one registry with a persist hook so HTTP API mutations
    // (e.g. `markon <dir>` into the running daemon) land in settings.json
    // exactly like GUI-initiated changes do.
    let registry = Arc::new(WorkspaceRegistry::new(effective_salt.clone()));
    registry.set_persist_hook(AppSettings::persist_hook(settings.clone()));

    let (language, shortcuts_json, styles_css, default_chat_mode) = {
        let s = settings.lock().unwrap();
        (
            s.effective_web_language(),
            s.render_shortcuts_json(),
            s.render_styles_css(),
            s.default_chat_mode.clone(),
        )
    };

    if let Err(e) = server::start(ServerConfig {
        host: match cli.host {
            None => "127.0.0.1".to_string(),
            Some(ref h) if h == "select" => match select_host() {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("Failed to select host: {e}");
                    return;
                }
            },
            Some(h) => h,
        },
        port: cli.port,
        theme,
        qr: cli.entry,
        open_browser: open_browser_target,
        shared_annotation: cli.shared_annotation,
        salt: Some(effective_salt),
        initial_workspaces: vec![ws_init],
        bound_listener: None,
        registry: Some(registry),
        management_token: None,
        language,
        shortcuts_json,
        styles_css,
        default_chat_mode,
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
            "http://127.0.0.1:5050",
            "30c52d3e",
            None,
            Some("http://md.s17.kookyleo.space/"),
        );

        assert_eq!(summary.workspace_path, "/tmp/Downloads");
        assert_eq!(
            format_workspace_flags(summary.flags, false, CliColors::plain()),
            "[x] Search  [x] Viewed tracking  [x] Edit  [x] Live  [ ] Chat  [ ] Shared notes"
        );
        assert_eq!(summary.local_url, "http://127.0.0.1:5050/30c52d3e/");
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
            "http://127.0.0.1:5050",
            "30c52d3e",
            Some("notes/demo.md"),
            Some("missing"),
        );

        assert_eq!(
            format_workspace_flags(summary.flags, false, CliColors::plain()),
            "[ ] Search  [x] Viewed tracking  [ ] Edit  [ ] Live  [ ] Chat  [x] Shared notes"
        );
        assert_eq!(
            summary.local_url,
            "http://127.0.0.1:5050/30c52d3e/notes/demo.md"
        );
        assert_eq!(summary.public_url, None);
        assert_eq!(
            summary.qr_url.as_deref(),
            Some("http://127.0.0.1:5050/30c52d3e/notes/demo.md")
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
    fn workspace_list_base_prefers_entry_when_present() {
        assert_eq!(
            resolve_workspace_list_base(6419, Some("http://docs.example.com")),
            ("http://docs.example.com".to_string(), true)
        );
        assert_eq!(
            resolve_workspace_list_base(6419, Some("missing")),
            ("http://127.0.0.1:6419".to_string(), false)
        );
    }
}
