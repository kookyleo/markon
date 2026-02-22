mod assets;
mod markdown;
mod search;
mod server;

use clap::Parser;
use dialoguer::Select;
use local_ip_address::list_afinet_netifas;
use std::path::Path;

/// Get list of available network interfaces with IP addresses
fn get_available_hosts() -> Vec<(String, String)> {
    let mut hosts = vec![
        ("127.0.0.1".to_string(), "Localhost (local only)".to_string()),
        ("0.0.0.0".to_string(), "All interfaces (LAN accessible)".to_string()),
    ];

    // Get all network interfaces
    if let Ok(network_interfaces) = list_afinet_netifas() {
        for (name, ip) in network_interfaces {
            let ip_str = ip.to_string();
            // Skip localhost (already added)
            if ip_str != "127.0.0.1" && !ip_str.starts_with("169.254") {
                // Skip link-local addresses
                hosts.push((ip_str.clone(), format!("{} ({})", ip_str, name)));
            }
        }
    }

    hosts
}

/// Interactive host selection
fn select_host() -> Result<String, Box<dyn std::error::Error>> {
    let hosts = get_available_hosts();
    let items: Vec<&str> = hosts.iter().map(|(_, desc)| desc.as_str()).collect();

    let selection = Select::new()
        .with_prompt("Select host address to bind")
        .items(&items)
        .default(0)
        .interact()?;

    Ok(hosts[selection].0.clone())
}

/// Preview Markdown files locally with GitHub styling.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Cli {
    /// The markdown file to render.
    file: Option<String>,

    /// The port to use for the server.
    #[arg(short, long, default_value_t = 6419)]
    port: u16,

    /// The host address to bind to.
    /// - Not specified: binds to 127.0.0.1 (localhost only)
    /// - --host: interactive selection of available network interfaces
    /// - --host <IP>: binds to specific IP address (e.g., --host 0.0.0.0 for LAN access)
    #[arg(long, value_name = "IP", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "select")]
    host: Option<String>,

    /// Theme selection (light, dark, auto).
    #[arg(short = 't', long, default_value = "auto")]
    theme: String,

    /// Generate QR code for server address.
    /// Optionally specify a base URL (e.g., http://192.168.1.100:6419) to override the default local address.
    #[arg(long, value_name = "BASE_URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "missing")]
    qr: Option<String>,

    /// Automatically open browser after starting the server.
    /// Optionally specify a base URL (e.g., http://example.com:8080) to override the default local address.
    #[arg(short = 'b', long, value_name = "BASE_URL", action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "local")]
    open_browser: Option<String>,

    /// Enable shared annotations.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    shared_annotation: bool,

    /// Enable section viewed checkbox feature.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_viewed: bool,

    /// Enable directory-level search functionality.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_search: bool,

    /// Enable Markdown file editing feature.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    enable_edit: bool,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Print version on startup
    println!("Markon v{}", env!("CARGO_PKG_VERSION"));

    // Validate theme parameter
    let theme = match cli.theme.as_str() {
        "light" | "dark" | "auto" => cli.theme.clone(),
        _ => {
            eprintln!("Invalid theme '{}'. Use: light, dark, or auto", cli.theme);
            return;
        }
    };

    // Determine host address to bind to
    let host = match cli.host {
        None => "127.0.0.1".to_string(), // Default: localhost only
        Some(ref h) if h == "select" => {
            // Interactive selection
            match select_host() {
                Ok(selected) => selected,
                Err(e) => {
                    eprintln!("Failed to select host: {}", e);
                    return;
                }
            }
        }
        Some(h) => h, // Use specified host
    };

    let file_to_render = if let Some(file) = cli.file {
        if !Path::new(&file).exists() {
            eprintln!("Error: File '{file}' not found.");
            return;
        }
        Some(file)
    } else {
        None
    };

    server::start(server::ServerConfig {
        host,
        port: cli.port,
        file_path: file_to_render,
        theme,
        qr: cli.qr,
        open_browser: cli.open_browser,
        shared_annotation: cli.shared_annotation,
        enable_viewed: cli.enable_viewed,
        enable_search: cli.enable_search,
        enable_edit: cli.enable_edit,
    })
    .await;
}
