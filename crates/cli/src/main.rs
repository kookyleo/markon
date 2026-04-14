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
    /// The markdown file or directory to open.
    file: Option<String>,

    /// Port for the server (used when starting a new server).
    #[arg(short, long, default_value_t = 6419)]
    port: u16,

    /// Host address to bind (interactive if flag given without value).
    #[arg(long, value_name = "IP", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "select")]
    host: Option<String>,

    /// Theme selection (light, dark, auto).
    #[arg(short = 't', long, default_value = "auto")]
    theme: String,

    /// Public entry URL (proxy/domain). Used as QR code base and browser open URL.
    #[arg(long, alias = "qr", value_name = "URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "missing")]
    entry: Option<String>,

    /// Automatically open browser after starting the server.
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

    /// Enable Markdown file editing for the workspace.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_edit: bool,
}

/// Add or update a workspace in a running server.
/// If the path is already registered, updates its flags; otherwise adds it.
/// Returns the workspace URL.
fn add_or_update_workspace(
    port: u16,
    token: &str,
    ws_path: &str,
    enable_search: bool,
    enable_viewed: bool,
    enable_edit: bool,
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
        // dunce::canonicalize avoids the Windows \\?\ verbatim prefix on the
        // printed URL / startup banner.
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
        // No argument → use current working directory.
        (
            std::env::current_dir().expect("Cannot determine working directory"),
            None,
        )
    };

    // Check if a server is already running.
    if let Some(lock) = ServerLock::read() {
        if lock.is_alive() {
            // Add workspace to running server and open browser.
            match add_or_update_workspace(
                lock.port,
                &lock.token,
                &ws_root.to_string_lossy(),
                cli.enable_search,
                cli.enable_viewed,
                cli.enable_edit,
            ) {
                Ok(url) => {
                    let open_url = match &initial_path {
                        Some(p) => format!("{}{}", url.trim_end_matches('/'), p),
                        None => url,
                    };
                    println!("Added workspace, opening {open_url}");
                    if let Err(e) = open::that(&open_url) {
                        eprintln!("Failed to open browser: {e}");
                    }
                }
                Err(e) => eprintln!("Failed to add workspace to running server: {e}"),
            }
            return;
        }
    }

    // No running server — start one.
    let host = match cli.host {
        None => "127.0.0.1".to_string(),
        Some(ref h) if h == "select" => match select_host() {
            Ok(h) => h,
            Err(e) => {
                eprintln!("Failed to select host: {e}");
                return;
            }
        },
        Some(h) => h,
    };

    // Determine open_browser: if no explicit flag, auto-open when there's a file arg.
    let open_browser = cli.open_browser.or_else(|| {
        if cli.file.is_some() {
            Some("local".to_string())
        } else {
            None
        }
    });

    let ws_init = WorkspaceInit {
        path: ws_root,
        enable_search: cli.enable_search,
        enable_viewed: cli.enable_viewed,
        enable_edit: cli.enable_edit,
        shared_annotation: cli.shared_annotation,
        initial_path,
    };

    // Load customizations (web styles, shortcuts, language) from the GUI's
    // settings file if present. CLI arguments take precedence over the file.
    let settings = AppSettings::load();

    if let Err(e) = server::start(ServerConfig {
        host,
        port: cli.port,
        theme,
        qr: cli.entry,
        open_browser,
        shared_annotation: cli.shared_annotation,
        salt: cli.salt,
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
