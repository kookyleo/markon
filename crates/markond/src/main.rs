//! markond — the standalone Markon background service.
//!
//! The `markon` CLI resolves a declarative [`DaemonConfig`], writes it to a
//! `0600` JSON file, and spawns `markond --config <path>`. This binary reads
//! that file, rebuilds a runtime [`ServerConfig`], attaches a workspace
//! registry wired to a persist hook (so control-socket mutations mirror back
//! into `settings.json` exactly like the GUI does), then runs the web app and
//! the privileged control socket until shutdown.
//!
//! The config file carries secrets (the collaborator access-code hash), so it
//! is deleted immediately after it has been read.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use markon_core::daemon::DaemonConfig;
use markon_core::server::{self, ServerConfig};
use markon_core::settings::AppSettings;
use markon_core::workspace::WorkspaceRegistry;

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

/// Minimal arg parse: the only accepted form is `--config <path>` (or
/// `--config=<path>`). Anything else is a usage error.
fn parse_config_path() -> Result<PathBuf, String> {
    let mut args = std::env::args().skip(1);
    let Some(arg) = args.next() else {
        return Err("missing required --config <path> argument".to_string());
    };
    if let Some(rest) = arg.strip_prefix("--config=") {
        return Ok(PathBuf::from(rest));
    }
    if arg == "--config" {
        return args
            .next()
            .map(PathBuf::from)
            .ok_or_else(|| "--config requires a path argument".to_string());
    }
    Err(format!("unexpected argument: {arg}"))
}

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();

    let config_path = match parse_config_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("markond: {e}");
            eprintln!("usage: markond --config <path>");
            return ExitCode::FAILURE;
        }
    };

    let raw = match std::fs::read(&config_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!(
                "markond: failed to read config file {}: {e}",
                config_path.display()
            );
            return ExitCode::FAILURE;
        }
    };
    // The handoff file holds the collaborator access-code hash; remove it as
    // soon as it is read so the secret does not linger on disk.
    if let Err(e) = std::fs::remove_file(&config_path) {
        tracing::warn!(
            "failed to remove daemon config file {}: {e}",
            config_path.display()
        );
    }

    let daemon_config: DaemonConfig = match serde_json::from_slice(&raw) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("markond: failed to parse config file: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut server_config = ServerConfig::from_daemon_config(daemon_config);

    // Wire a workspace registry to a persist hook so mutations arriving over
    // the control socket (e.g. `markon <dir>` forwarded by the CLI) are written
    // back into settings.json — matching the GUI-initiated persistence path.
    // The salt must match what ServerConfig will use for cookie signing and
    // workspace-id hashing, so derive it identically to server::start.
    let effective_salt = server_config
        .salt
        .clone()
        .unwrap_or_else(|| format!("markon:{}", server_config.port));
    server_config.salt = Some(effective_salt.clone());

    let settings = Arc::new(Mutex::new(AppSettings::load()));
    let registry = Arc::new(WorkspaceRegistry::new(effective_salt));
    registry.set_persist_hook(AppSettings::persist_hook(settings));
    server_config.registry = Some(registry);

    if let Err(e) = server::start(server_config).await {
        eprintln!("markond: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
