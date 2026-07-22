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
use std::io::Write;

const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
const LOG_BACKUPS: usize = 3;

fn rotated_log_path(path: &std::path::Path, index: usize) -> PathBuf {
    path.with_file_name(format!(
        "{}.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("markond.log"),
        index
    ))
}

fn rotate_log(path: &std::path::Path, backups: usize) -> std::io::Result<()> {
    for index in (1..=backups).rev() {
        let source = if index == 1 {
            path.to_path_buf()
        } else {
            rotated_log_path(path, index - 1)
        };
        let target = rotated_log_path(path, index);
        if target.exists() {
            std::fs::remove_file(&target)?;
        }
        if source.exists() {
            std::fs::rename(source, target)?;
        }
    }
    Ok(())
}

fn open_append_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

struct RollingLogWriter {
    path: PathBuf,
    // `Option` lets rotation take and close the current handle before renaming
    // it. Unix permits renaming an open file, but Windows does not.
    file: Option<std::fs::File>,
    bytes_written: u64,
    max_bytes: u64,
    backups: usize,
}

impl RollingLogWriter {
    fn open(path: PathBuf, max_bytes: u64, backups: usize) -> std::io::Result<Self> {
        if path.metadata().map(|meta| meta.len()).unwrap_or(0) >= max_bytes {
            rotate_log(&path, backups)?;
        }
        let file = open_append_file(&path)?;
        let bytes_written = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes_written,
            max_bytes,
            backups,
        })
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }
        let rotation = rotate_log(&self.path, self.backups);
        let reopened = open_append_file(&self.path);
        match reopened {
            Ok(file) => {
                self.bytes_written = file.metadata()?.len();
                self.file = Some(file);
                rotation
            }
            Err(error) => Err(error),
        }
    }

    fn file_mut(&mut self) -> std::io::Result<&mut std::fs::File> {
        self.file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("rolling log file is unavailable"))
    }
}

impl Write for RollingLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.bytes_written >= self.max_bytes {
            self.rotate()?;
        }
        let remaining = (self.max_bytes - self.bytes_written) as usize;
        let written = self.file_mut()?.write(&buf[..buf.len().min(remaining)])?;
        self.bytes_written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file_mut()?.flush()
    }
}

fn open_log_writer() -> std::io::Result<(PathBuf, RollingLogWriter)> {
    let log_dir = dirs::home_dir()
        .ok_or_else(|| std::io::Error::other("HOME directory required"))?
        .join(".markon")
        .join("logs");
    std::fs::create_dir_all(&log_dir)?;
    let path = log_dir.join("markond.log");
    let writer = RollingLogWriter::open(path.clone(), LOG_MAX_BYTES, LOG_BACKUPS)?;
    Ok((path, writer))
}

fn init_tracing() -> Option<PathBuf> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    match open_log_writer() {
        Ok((path, writer)) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_target(false)
                .with_ansi(false)
                .with_writer(Mutex::new(writer))
                .compact()
                .init();
            Some(path)
        }
        Err(error) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_target(false)
                .compact()
                .init();
            eprintln!("markond: failed to open persistent log: {error}");
            None
        }
    }
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
    let log_path = init_tracing();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        pid = std::process::id(),
        log = %log_path.as_deref().unwrap_or_else(|| std::path::Path::new("stderr")).display(),
        "markond starting"
    );

    let config_path = match parse_config_path() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "invalid markond invocation");
            return ExitCode::FAILURE;
        }
    };

    let raw = match std::fs::read(&config_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::error!(error = %e, "failed to read daemon config");
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
            tracing::error!(error = %e, "failed to parse daemon config");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(
        host = %daemon_config.host,
        port = daemon_config.port,
        workspaces = daemon_config.workspaces.len(),
        "daemon config loaded"
    );

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
        tracing::error!(error = %e, "markon server exited with error");
        return ExitCode::FAILURE;
    }
    tracing::info!("markond stopped");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_log_stays_bounded_and_keeps_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("markond.log");
        std::fs::write(&path, vec![b'x'; 31]).unwrap();
        std::fs::write(rotated_log_path(&path, 1), b"older").unwrap();

        let mut writer = RollingLogWriter::open(path.clone(), 32, 3).unwrap();
        writer.write_all(b"yz").unwrap();
        writer.flush().unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"z");
        assert_eq!(std::fs::read(rotated_log_path(&path, 1)).unwrap().len(), 32);
        assert_eq!(std::fs::read(rotated_log_path(&path, 2)).unwrap(), b"older");
        assert!(!rotated_log_path(&path, LOG_BACKUPS + 1).exists());
    }
}
