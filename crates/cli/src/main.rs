use clap::Parser;
use dialoguer::Select;
use local_ip_address::list_afinet_netifas;
use markon_core::server::{self, ServerConfig, WorkspaceInit};
use markon_core::settings::AppSettings;
use markon_core::workspace::ServerLock;
use std::path::Path;

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
    #[arg(short = 't', long, default_value = "auto")]
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

    /// Internal flag for daemonization.
    #[arg(long, hide = true)]
    daemon_internal: bool,
}

#[derive(clap::Subcommand, Debug)]
enum Commands {
    /// List all active workspaces in the running server.
    Ls,
    /// Remove a workspace from the running server by ID or index.
    Detach {
        /// Workspace ID or index (from 'markon ls').
        target: String,
    },
    /// Shutdown the background Markon server.
    Shutdown,
}

fn list_workspaces(port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
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
    if arr.is_empty() {
        println!("No active workspaces.");
        return Ok(());
    }

    println!("{:<4} {:<10} PATH", "#", "ID");
    println!("{:-<4} {:-<10} {:-<20}", "", "", "");
    for (i, ws) in arr.iter().enumerate() {
        let id = ws["id"].as_str().unwrap_or("?");
        let path = ws["path"].as_str().unwrap_or("?");
        println!("{:<4} {:<10} {}", i + 1, id, path);
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
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
    enable_live: bool,
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
        // Already registered — update flags in-place.
        let id = existing["id"].as_str().ok_or("no id in workspace")?;
        client
            .put(format!("http://127.0.0.1:{port}/api/workspace/{id}"))
            .header("X-Markon-Token", token)
            .json(&serde_json::json!({
                "enable_search": enable_search,
                "enable_viewed": enable_viewed,
                "enable_edit": enable_edit,
                "enable_live": enable_live,
            }))
            .send()?
            .error_for_status()?;
        return Ok(format!("http://127.0.0.1:{port}/{id}/"));
    }

    // Not registered — add as new workspace.
    let resp: serde_json::Value = client
        .post(format!("http://127.0.0.1:{port}/api/workspace"))
        .header("X-Markon-Token", token)
        .json(&serde_json::json!({
            "path": ws_path,
            "enable_search": enable_search,
            "enable_viewed": enable_viewed,
            "enable_edit": enable_edit,
            "enable_live": enable_live,
        }))
        .send()?
        .error_for_status()?
        .json()?;
    let id = resp["id"].as_str().ok_or("no id in response")?;
    Ok(format!("http://127.0.0.1:{port}/{id}/"))
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
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
            Commands::Ls => list_workspaces(port, &token),
            Commands::Detach { target } => detach_workspace(port, &token, &target),
            Commands::Shutdown => shutdown_server(port, &token),
        };

        if let Err(e) = res {
            eprintln!("Error: {e}");
        }
        return;
    }

    let theme = match cli.theme.as_str() {
        "light" | "dark" | "auto" => cli.theme.clone(),
        _ => {
            eprintln!("Invalid theme '{}'. Use: light, dark, or auto", cli.theme);
            return;
        }
    };

    // Resolve the workspace directory from the file/dir argument.
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

    let ws_init = WorkspaceInit {
        path: ws_root.clone(),
        enable_search: cli.enable_search,
        enable_viewed: cli.enable_viewed,
        enable_edit: cli.enable_edit,
        enable_live: cli.enable_live,
        shared_annotation: cli.shared_annotation,
        initial_path: initial_path.clone(),
    };

    let effective_salt = cli
        .salt
        .clone()
        .unwrap_or_else(|| format!("markon:{}", cli.port));
    let id = markon_core::workspace::hash_id(&ws_root, &effective_salt);
    let workspace_url = match &initial_path {
        Some(p) => format!(
            "http://127.0.0.1:{}/{}/{}",
            cli.port,
            id,
            p.trim_start_matches('/')
        ),
        None => format!("http://127.0.0.1:{}/{}/", cli.port, id),
    };

    let open_browser_target = cli.open_browser.clone().or_else(|| {
        if cli.file.is_some() {
            Some("local".to_string())
        } else {
            None
        }
    });

    if let Some(lock) = ServerLock::read() {
        if lock.is_alive() {
            match add_or_update_workspace(
                lock.port,
                &lock.token,
                &ws_root.to_string_lossy(),
                cli.enable_search,
                cli.enable_viewed,
                cli.enable_edit,
                cli.enable_live,
            ) {
                Ok(url) => {
                    println!("Added workspace: {url}");
                    if open_browser_target.is_some() {
                        if let Err(e) = open::that(&url) {
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
                    println!("Starting Markon server in background...");
                    println!("Added workspace: {workspace_url}");
                    return;
                }
                Err(e) => {
                    eprintln!("Failed to daemonize: {e}. Falling back to foreground.");
                }
            }
        }
    }

    let settings = AppSettings::load();

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
        registry: None,
        management_token: None,
        language: settings.effective_web_language(),
        shortcuts_json: settings.render_shortcuts_json(),
        styles_css: settings.render_styles_css(),
    })
    .await
    {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
