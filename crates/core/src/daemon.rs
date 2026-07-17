//! Serializable handoff config between the `markon` CLI spawner and the
//! standalone `markond` service binary.
//!
//! The CLI resolves everything declarative the daemon needs (bind host, port,
//! salt, UI/theme knobs, per-workspace state, and secrets like the collaborator
//! access-code hash), writes it to a `0600` JSON file, and spawns
//! `markond --config <path>`. `markond` deserializes it into a [`DaemonConfig`]
//! and rebuilds a runtime [`ServerConfig`] via
//! [`ServerConfig::from_daemon_config`].
//!
//! Only the *declarative* subset of `ServerConfig` lives here. Runtime handles —
//! a pre-bound listener, the shared workspace registry / persist hook, the
//! management token, and the admin-bootstrap store — are NOT serialized; the
//! process that runs the server constructs them locally.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::server::{ServerConfig, WorkspaceInit};
use crate::workspace::WorkspaceFlags;

/// One initial workspace, declarative subset of [`WorkspaceInit`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonWorkspace {
    pub path: PathBuf,
    #[serde(default)]
    pub flags: WorkspaceFlags,
    #[serde(default)]
    pub initial_path: Option<String>,
    #[serde(default)]
    pub single_file: Option<String>,
    #[serde(default)]
    pub collaborator_access_code_hash: String,
    #[serde(default)]
    pub alias: String,
}

impl From<DaemonWorkspace> for WorkspaceInit {
    fn from(w: DaemonWorkspace) -> Self {
        WorkspaceInit {
            path: w.path,
            flags: w.flags,
            initial_path: w.initial_path,
            single_file: w.single_file,
            collaborator_access_code_hash: w.collaborator_access_code_hash,
            alias: w.alias,
        }
    }
}

/// Declarative daemon configuration handed from the CLI to `markond`.
///
/// This is the complete set of `ServerConfig` fields the daemon needs to
/// reconstruct its runtime configuration. Fields that are runtime handles in
/// `ServerConfig` (bound_listener, registry, management_token, admin_bootstraps)
/// are intentionally absent — `markond` builds them itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub host: String,
    #[serde(default)]
    pub advertised_host: String,
    #[serde(default)]
    pub trusted_hosts: Vec<String>,
    pub port: u16,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub qr: Option<String>,
    #[serde(default)]
    pub open_browser: Option<String>,
    #[serde(default)]
    pub db_path: Option<String>,
    #[serde(default)]
    pub salt: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<DaemonWorkspace>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub shortcuts_json: Option<String>,
    #[serde(default)]
    pub styles_css: Option<String>,
    #[serde(default)]
    pub default_chat_mode: String,
    #[serde(default)]
    pub editor_theme: String,
    #[serde(default)]
    pub collaborator_access_code_hash: String,
    #[serde(default)]
    pub print_collapsed_content: bool,
}

fn default_theme() -> String {
    "auto".to_string()
}

impl ServerConfig {
    /// Rebuild a runtime [`ServerConfig`] from a declarative [`DaemonConfig`].
    ///
    /// Runtime handles are left unset: `bound_listener`, `registry`,
    /// `management_token`, and `admin_bootstraps` are all `None` so the daemon
    /// binds fresh, auto-generates a management token, and creates its own
    /// bootstrap store. The caller (`markond`) attaches a registry with a
    /// persist hook before starting the server so workspace mutations mirror
    /// back into `settings.json`.
    pub fn from_daemon_config(cfg: DaemonConfig) -> Self {
        let shared_annotation = cfg.workspaces.iter().any(|w| w.flags.shared_annotation);
        let initial_workspaces = cfg
            .workspaces
            .into_iter()
            .map(WorkspaceInit::from)
            .collect();
        ServerConfig {
            host: cfg.host,
            advertised_host: cfg.advertised_host,
            trusted_hosts: cfg.trusted_hosts,
            port: cfg.port,
            theme: cfg.theme,
            qr: cfg.qr,
            open_browser: cfg.open_browser,
            shared_annotation,
            db_path: cfg.db_path,
            salt: cfg.salt,
            initial_workspaces,
            bound_listener: None,
            registry: None,
            management_token: None,
            admin_bootstraps: None,
            language: cfg.language,
            shortcuts_json: cfg.shortcuts_json,
            styles_css: cfg.styles_css,
            default_chat_mode: cfg.default_chat_mode,
            editor_theme: cfg.editor_theme,
            collaborator_access_code_hash: cfg.collaborator_access_code_hash,
            print_collapsed_content: cfg.print_collapsed_content,
        }
    }
}

/// Locate the `markond` service binary. A front-end (`markon` CLI, GUI) spawns
/// it rather than re-exec'ing itself, so the two binaries must be found side by
/// side.
///
/// The service must be a sibling of the current executable. This is the normal
/// Cargo install, development, and GUI-sidecar layout. Deliberately do not search
/// `target/*` under the current working directory: an installed `markon` invoked
/// inside an unrelated checkout must never execute that checkout's arbitrary
/// `target/debug/markond` binary.
pub fn locate_markond() -> std::io::Result<PathBuf> {
    // `EXE_SUFFIX` is `.exe` on Windows and empty elsewhere, so the same lookup
    // finds `markond` on unix and `markond.exe` on Windows.
    let bin = format!("markond{}", std::env::consts::EXE_SUFFIX);
    let bin = bin.as_str();
    let exe = std::env::current_exe().map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("could not resolve the current executable: {error}"),
        )
    })?;
    let dir = exe.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "current executable has no parent directory: {}",
                exe.display()
            ),
        )
    })?;
    let candidate = dir.join(bin);
    if candidate.is_file() {
        return Ok(candidate);
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "could not find the '{bin}' service binary beside the current executable (looked in: {}). \
             Ensure the markon front-end and markond are installed side by side.",
            candidate.display()
        ),
    ))
}

/// Write `config` to a fresh `0600` temp file so the collaborator access-code
/// hash never appears in argv or the environment. Returns the file path;
/// `markond` deletes it after reading.
fn write_daemon_config(config: &DaemonConfig) -> std::io::Result<PathBuf> {
    use std::io::Write;

    let json = serde_json::to_vec(config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Unique, unpredictable name in the per-user temp dir.
    let name = format!(
        "markond-config-{}-{}.json",
        std::process::id(),
        temp_suffix()
    );
    let path = std::env::temp_dir().join(name);

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // On unix the shared temp dir is world-traversable, so set 0600 from creation
    // — the secret-bearing file is never briefly world-readable. On Windows
    // `temp_dir()` resolves to the per-user `%TEMP%`, whose default ACL already
    // restricts the file to the owning user, so `create_new` alone is enough.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    file.write_all(&json)?;
    Ok(path)
}

/// Small non-cryptographic suffix to keep the temp filename unique without a
/// uuid dependency. Combined with the pid and the 0600 mode this is only about
/// avoiding collisions, not secrecy (the file contents carry the secret).
fn temp_suffix() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Bounded readiness poll: wait until the just-spawned daemon publishes its
/// discovery lock and that lock reports a live control socket, returning it.
///
/// This is a *connectability* poll (the lock's liveness probe prefers the
/// control socket), not a fixed-duration "coordination" sleep — it returns the
/// instant the socket answers and gives up after the deadline, so a forward that
/// follows can never race the daemon's bind.
async fn wait_for_ready() -> Option<crate::workspace::ServerLock> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(lock) = crate::workspace::ServerLock::read() {
            if lock.is_alive() {
                return Some(lock);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        // Short backoff between connectability probes (a retry cadence, not a
        // guessed "the daemon should be up by now" delay).
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Locate `markond`, write `config` to a `0600` temp file (so the collaborator
/// access-code hash never appears in argv/env), spawn `markond --config <path>`
/// fully detached, then wait (bounded) for it to become ready and return a
/// [`RunningServer`](crate::control::RunningServer) connected to its control
/// socket. This is the one spawn path shared by every front-end.
///
/// Ownership of the config file passes to the daemon, which unlinks it after
/// reading. As a safety net against a daemon that dies before that read (loader/
/// exec failure, OOM, immediate signal) — which would orphan the secret-bearing
/// file in the shared temp dir — this helper also removes the file once the
/// readiness handshake resolves (success or timeout); the removal is a no-op when
/// the daemon already unlinked it.
///
/// Errors: [`ErrorKind::NotFound`](std::io::ErrorKind::NotFound) when `markond`
/// can't be located, the spawn error's kind when the process can't be launched,
/// or [`ErrorKind::TimedOut`](std::io::ErrorKind::TimedOut) when the daemon never
/// became ready. Callers wanting to fall back to running in the foreground can
/// distinguish a spawn failure from a readiness timeout by the error kind.
pub async fn spawn_and_connect(
    config: DaemonConfig,
) -> std::io::Result<crate::control::RunningServer> {
    use std::process::Stdio;

    let markond = locate_markond()?;
    let config_path = write_daemon_config(&config)?;

    let mut command = std::process::Command::new(&markond);
    command
        .arg("--config")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // markond is a console binary; when a GUI (which has no console) spawns it,
    // Windows would otherwise allocate a fresh console window. CREATE_NO_WINDOW
    // runs it windowless. Lifecycle independence needs nothing extra: a Windows
    // child is not tied to the parent's lifetime, so not waiting on it already
    // lets it outlive the front-end.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    if let Err(e) = command.spawn() {
        // Spawn failed before the daemon could take ownership of the config file;
        // remove it so no secret-bearing file is orphaned.
        let _ = std::fs::remove_file(&config_path);
        return Err(std::io::Error::new(
            e.kind(),
            format!("spawn {}: {e}", markond.display()),
        ));
    }

    let ready = wait_for_ready().await;
    // Bounded cleanup of the 0600 secret file once the handshake resolves either
    // way (no-op if the daemon already unlinked it after reading).
    let _ = std::fs::remove_file(&config_path);
    match ready {
        Some(lock) => Ok(crate::control::RunningServer::from_lock(&lock)),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "the markon server did not become ready in time",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let cfg = DaemonConfig {
            host: "127.0.0.1".to_string(),
            advertised_host: "192.168.1.5".to_string(),
            trusted_hosts: vec!["md.example.com".to_string()],
            port: 6419,
            theme: "auto".to_string(),
            qr: Some("https://md.example.com".to_string()),
            open_browser: None,
            db_path: Some("/tmp/x.sqlite".to_string()),
            salt: Some("markon:6419".to_string()),
            workspaces: vec![DaemonWorkspace {
                path: PathBuf::from("/tmp/docs"),
                flags: WorkspaceFlags {
                    enable_search: true,
                    shared_annotation: true,
                    ..Default::default()
                },
                initial_path: Some("readme.md".to_string()),
                single_file: None,
                collaborator_access_code_hash: "deadbeef".to_string(),
                alias: "docs".to_string(),
            }],
            language: Some("en".to_string()),
            shortcuts_json: None,
            styles_css: None,
            default_chat_mode: "in_page".to_string(),
            editor_theme: "follow".to_string(),
            collaborator_access_code_hash: "cafef00d".to_string(),
            print_collapsed_content: true,
        };

        let json = serde_json::to_string(&cfg).unwrap();
        let back: DaemonConfig = serde_json::from_str(&json).unwrap();
        let server = ServerConfig::from_daemon_config(back);

        assert_eq!(server.host, "127.0.0.1");
        assert_eq!(server.port, 6419);
        assert_eq!(server.advertised_host, "192.168.1.5");
        assert_eq!(server.trusted_hosts, vec!["md.example.com".to_string()]);
        assert_eq!(server.qr.as_deref(), Some("https://md.example.com"));
        assert!(server.open_browser.is_none());
        assert_eq!(server.salt.as_deref(), Some("markon:6419"));
        assert!(server.shared_annotation, "derived from workspace flags");
        assert_eq!(server.initial_workspaces.len(), 1);
        let ws = &server.initial_workspaces[0];
        assert_eq!(ws.path, PathBuf::from("/tmp/docs"));
        assert_eq!(ws.collaborator_access_code_hash, "deadbeef");
        assert_eq!(ws.alias, "docs");
        assert_eq!(server.collaborator_access_code_hash, "cafef00d");
        assert!(server.print_collapsed_content);
        // Runtime handles are never reconstructed from the declarative config.
        assert!(server.registry.is_none());
        assert!(server.bound_listener.is_none());
        assert!(server.management_token.is_none());
        assert!(server.admin_bootstraps.is_none());
    }
}
