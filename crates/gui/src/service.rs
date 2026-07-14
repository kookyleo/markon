//! The GUI's connection to the independent `markond` service.
//!
//! Phase 2: the GUI is a **pure frontend**. It never runs `server::start`
//! in-process. On boot it discovers an already-running `markond` (see
//! [`RunningServer::discover`]) or spawns one via
//! [`markon_core::daemon::spawn_and_connect`], then drives everything over the
//! control socket. The service is independent of the GUI's own lifecycle:
//! quitting the GUI never stops `markond` (there is no `Drop` that shuts the
//! service down).
//!
//! [`ServiceConnection`] is the thin wrapper the app state holds. It is either
//! attached to a live [`RunningServer`] or detached (a control call failed, or
//! discover/spawn found nothing) with the last error recorded for the UI.

use crate::commands::effective_port;
use markon_core::control::RunningServer;
use markon_core::daemon::{DaemonConfig, DaemonWorkspace};
use markon_core::settings::AppSettings;
use markon_core::workspace::WorkspaceFlags;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The GUI's live handle to the markon service. `None` server = detached.
#[derive(Default)]
pub struct ServiceConnection {
    server: Option<RunningServer>,
    last_error: Option<String>,
}

impl ServiceConnection {
    /// A connection attached to a live service.
    pub fn attached(server: RunningServer) -> Self {
        Self {
            server: Some(server),
            last_error: None,
        }
    }

    /// A detached connection carrying the reason it isn't connected.
    pub fn detached(err: impl Into<String>) -> Self {
        Self {
            server: None,
            last_error: Some(err.into()),
        }
    }

    /// Clone the live handle out so an async command can drop the (non-Send)
    /// lock guard before awaiting a control call. `None` when detached.
    pub fn handle(&self) -> Option<RunningServer> {
        self.server.clone()
    }

    /// Whether a service is currently attached.
    pub fn is_connected(&self) -> bool {
        self.server.is_some()
    }

    /// The service's web TCP port (for building browser/QR URLs). `0` when
    /// detached.
    pub fn port(&self) -> u16 {
        self.server.as_ref().map(RunningServer::port).unwrap_or(0)
    }

    /// The last recorded connection error, if any.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    /// UI status string: `"connected"` or `"disconnected"`.
    pub fn mode(&self) -> &'static str {
        if self.server.is_some() {
            "connected"
        } else {
            "disconnected"
        }
    }
}

/// Project one persisted [`WorkspaceSettings`](markon_core::settings::WorkspaceSettings)
/// onto its declarative [`DaemonWorkspace`] wire form. Mirrors the CLI's
/// `workspace_init_to_daemon` and `AppSettings::to_server_config` mapping so the
/// daemon starts with exactly the workspaces the GUI persisted.
fn workspaces_for_daemon(settings: &AppSettings) -> Vec<DaemonWorkspace> {
    settings
        .workspaces
        .iter()
        .filter(|w| !w.path.is_empty())
        .map(|w| DaemonWorkspace {
            path: PathBuf::from(&w.path),
            flags: w.flags,
            initial_path: w.single_file.clone(),
            single_file: w.single_file.clone(),
            collaborator_access_code_hash: w.collaborator_access_code_hash.clone(),
            alias: w.alias.clone(),
        })
        .collect()
}

/// Build the declarative [`DaemonConfig`] the GUI hands to `markond` — the same
/// mechanism the CLI uses. Runtime handles (listener, registry, tokens) are
/// never part of this; the daemon constructs them itself.
pub fn daemon_config_from_settings(settings: &AppSettings, port: u16) -> DaemonConfig {
    DaemonConfig {
        host: settings.host.clone(),
        advertised_host: settings.advertised_host.clone(),
        trusted_hosts: settings.trusted_hosts.clone(),
        port,
        // Web pages resolve light/dark at runtime; theme is not a server concern.
        theme: "auto".to_string(),
        qr: None,
        // The daemon never opens a browser itself; the GUI opens URLs over the
        // control socket (admin bootstrap) when the user asks.
        open_browser: None,
        db_path: settings.db_path.clone(),
        salt: Some(settings.salt.clone()),
        workspaces: workspaces_for_daemon(settings),
        language: Some(if settings.web_language == "auto" {
            settings.language.clone()
        } else {
            settings.web_language.clone()
        }),
        shortcuts_json: settings.render_shortcuts_json(),
        styles_css: settings.render_styles_css(),
        default_chat_mode: settings.default_chat_mode.clone(),
        editor_theme: settings.web_editor_theme.clone(),
        collaborator_access_code_hash: settings.collaborator_access_code_hash.clone(),
        print_collapsed_content: settings.print_collapsed_content,
    }
}

/// Forward this install's persisted **directory** workspaces to an already-
/// running service. Single-file/ephemeral entries are skipped (they're pruned at
/// startup and have no place on a shared service). Failures are logged, not
/// fatal: one bad path shouldn't block attaching.
async fn forward_persisted(remote: &RunningServer, settings: &Arc<Mutex<AppSettings>>) {
    let to_forward: Vec<(String, WorkspaceFlags, Option<String>)> = {
        let s = settings.lock().unwrap();
        s.workspaces
            .iter()
            .filter(|w| w.single_file.is_none())
            .map(|w| {
                (
                    w.path.clone(),
                    w.flags,
                    (!w.collaborator_access_code_hash.is_empty())
                        .then(|| w.collaborator_access_code_hash.clone()),
                )
            })
            .collect()
    };
    for (path, flags, hash) in to_forward {
        if let Err(e) = remote
            .add_or_update_workspace(&path, flags, hash.as_deref())
            .await
        {
            tracing::warn!(%path, "failed to forward workspace to the markon service: {e}");
        }
    }
}

/// Spawn a fresh `markond` from the current settings (workspaces baked into the
/// config). Unix-only: the service-split spawn path
/// ([`markon_core::daemon::spawn_and_connect`]) is `#[cfg(unix)]`.
#[cfg(unix)]
async fn spawn_service(settings: &Arc<Mutex<AppSettings>>) -> ServiceConnection {
    let config = {
        let s = settings.lock().unwrap();
        daemon_config_from_settings(&s, effective_port(&s))
    };
    match markon_core::daemon::spawn_and_connect(config).await {
        Ok(remote) => {
            tracing::info!(port = remote.port(), "spawned the markon service");
            ServiceConnection::attached(remote)
        }
        Err(e) => {
            tracing::error!("failed to spawn the markon service: {e}");
            ServiceConnection::detached(format!("remote-server-error: {e}"))
        }
    }
}

#[cfg(not(unix))]
async fn spawn_service(settings: &Arc<Mutex<AppSettings>>) -> ServiceConnection {
    let _ = settings;
    tracing::error!(
        "no running markon service found and spawning markond is not supported on this platform"
    );
    ServiceConnection::detached(
        "remote-server-error: no running markon service found".to_string(),
    )
}

/// Boot / reconnect path: attach to an already-running service (forwarding this
/// install's persisted workspaces) or spawn a new one. Either way the returned
/// connection is what the GUI drives; `markond` outlives the GUI.
pub async fn attach_or_spawn(settings: &Arc<Mutex<AppSettings>>) -> ServiceConnection {
    if let Some(remote) = RunningServer::discover() {
        tracing::info!(port = remote.port(), "attached to the running markon service");
        forward_persisted(&remote, settings).await;
        return ServiceConnection::attached(remote);
    }
    spawn_service(settings).await
}

/// Reconfiguration path: RESPAWN the shared service. Shuts down the currently-
/// attached `markond` (this restarts it for everyone connected — the caller must
/// have warned the user) and spawns a fresh one carrying the updated config.
pub async fn respawn(
    settings: &Arc<Mutex<AppSettings>>,
    current: Option<RunningServer>,
) -> ServiceConnection {
    if let Some(remote) = current {
        match remote.shutdown().await {
            // `shutdown()` returns the instant the daemon ACKs the request, before
            // it frees its web TCP port and removes its discovery lock. Spawning
            // the replacement now would race the still-live old daemon for the
            // fixed port (EADDRINUSE) or let `spawn_and_connect` latch the stale
            // lock. Wait (bounded) for the old daemon to become fully unreachable
            // first.
            Ok(()) => wait_for_service_down(&remote).await,
            Err(e) => {
                tracing::warn!(
                    "failed to shut down the running markon service before respawn: {e}"
                );
            }
        }
    }
    spawn_service(settings).await
}

/// Poll (bounded) until a shut-down daemon is fully unreachable — both its
/// control socket and its web TCP port — so a replacement can be spawned without
/// racing the old process for the port or its discovery lock. Gives up after the
/// deadline and lets the caller spawn anyway (logged), rather than hang forever.
async fn wait_for_service_down(remote: &RunningServer) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if !remote.is_reachable() {
            return;
        }
        if Instant::now() >= deadline {
            tracing::warn!(
                "old markon service still reachable after shutdown; spawning replacement anyway"
            );
            return;
        }
        // Short retry cadence between reachability probes (not a guessed delay).
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
