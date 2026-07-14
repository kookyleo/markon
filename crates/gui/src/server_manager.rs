use markon_core::admin_auth::AdminBootstrapStore;
use markon_core::control::RunningServer;
use markon_core::server::{self, ServerConfig};
use markon_core::workspace::{PersistHook, WorkspaceRegistry};
use std::sync::Arc;

/// Where this GUI's workspace commands are actually served from.
///
/// The machine invariant is "one markon server". On boot the GUI probes for an
/// already-running server (see `RunningServer::discover`): if one is up it
/// attaches as a *controller* (`Remote`) and drives that server's registry over
/// its loopback management API instead of binding a second server; otherwise it
/// owns an in-process `Embedded` server. Every registry-touching command
/// dispatches on this enum so both modes behave identically to the frontend.
pub enum ServerBackend {
    Embedded(ServerManager),
    /// Attached to a server another process started. We do NOT own its
    /// lifecycle — dropping this (app quit) must not stop that server, which is
    /// why `RunningServer` has no `Drop` that shuts anything down.
    Remote(RunningServer),
}

impl ServerBackend {
    /// Port the browser should hit — the embedded server's bound port, or the
    /// remote server's loopback port.
    pub fn port(&self) -> u16 {
        match self {
            ServerBackend::Embedded(m) => m.port(),
            ServerBackend::Remote(r) => r.port(),
        }
    }

    /// Whether a server is reachable. A remote is assumed live (discovery
    /// TCP-probed it; a dead remote surfaces as a per-command error instead).
    pub fn is_running(&self) -> bool {
        match self {
            ServerBackend::Embedded(m) => m.is_running(),
            ServerBackend::Remote(_) => true,
        }
    }

    pub fn last_error(&self) -> Option<String> {
        match self {
            ServerBackend::Embedded(m) => m.last_error(),
            ServerBackend::Remote(_) => None,
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, ServerBackend::Remote(_))
    }

    /// Clone the remote handle so an async command can drop the (non-Send) lock
    /// guard before awaiting the HTTP call. `None` in embedded mode.
    pub fn remote(&self) -> Option<RunningServer> {
        match self {
            ServerBackend::Remote(r) => Some(r.clone()),
            ServerBackend::Embedded(_) => None,
        }
    }

    /// `"remote"` when attached to another process's server, else `"embedded"`.
    pub fn mode(&self) -> &'static str {
        match self {
            ServerBackend::Embedded(_) => "embedded",
            ServerBackend::Remote(_) => "remote",
        }
    }
}

pub struct ServerManager {
    abort_tx: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    port: u16,
    last_error: Option<String>,
    /// Shared with the server's AppState; allows Tauri commands to add/remove workspaces.
    pub registry: Arc<WorkspaceRegistry>,
    admin_bootstraps: Arc<AdminBootstrapStore>,
}

impl Default for ServerManager {
    fn default() -> Self {
        Self {
            abort_tx: None,
            thread: None,
            port: 0,
            last_error: None,
            registry: Arc::new(WorkspaceRegistry::new("markon:0".into())),
            admin_bootstraps: Arc::new(AdminBootstrapStore::new()),
        }
    }
}

impl ServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &mut self,
        mut config: ServerConfig,
        persist: Option<PersistHook>,
    ) -> Result<(), String> {
        self.stop();
        self.last_error = None;

        // Use the salt the caller put into ServerConfig (GUI: per-install random
        // salt from AppSettings). Fall back to a port-derived constant only for
        // callers that didn't set one — preserves the original CLI behavior.
        let salt = config
            .salt
            .clone()
            .unwrap_or_else(|| format!("markon:{}", config.port));
        self.registry = Arc::new(WorkspaceRegistry::new(salt.clone()));
        if let Some(hook) = persist {
            self.registry.set_persist_hook(hook);
        }
        config.salt = Some(salt);
        config.registry = Some(self.registry.clone());
        self.admin_bootstraps = Arc::new(AdminBootstrapStore::new());
        config.admin_bootstraps = Some(self.admin_bootstraps.clone());

        // Pre-bind synchronously so a bad address (e.g. NIC IP saved in a
        // previous network) fails loudly here instead of leaving the async
        // start to silently die in the spawned thread.
        let bind_addr = markon_core::net::bind_socket_addr(&config.host, config.port)?;
        let (config, actual_port) = match std::net::TcpListener::bind(bind_addr) {
            Ok(listener) => {
                let actual_port = listener
                    .local_addr()
                    .map(|a| a.port())
                    .unwrap_or(config.port);
                let mut c = config;
                c.port = actual_port;
                c.bound_listener = Some(listener);
                (c, actual_port)
            }
            Err(e) => {
                let msg = format!("Failed to bind {bind_addr}: {e}");
                tracing::error!("{msg}");
                self.last_error = Some(msg.clone());
                self.port = 0;
                return Err(msg);
            }
        };

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let thread = std::thread::spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("Failed to build tokio runtime")
                .block_on(async move {
                    tokio::select! {
                        r = markon_core::server::start(config) => {
                            if let Err(e) = r {
                                tracing::error!("server error: {e}");
                            }
                        }
                        _ = rx => {}
                    }
                });
        });

        self.abort_tx = Some(tx);
        self.thread = Some(thread);
        self.port = actual_port;
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.abort_tx.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub fn is_running(&self) -> bool {
        self.thread.is_some()
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.clone()
    }

    /// Wrap a workspace URL in a one-time browser administrator bootstrap.
    pub fn admin_url(&self, base: &str, redirect: &str) -> String {
        let nonce = self.admin_bootstraps.issue_url(redirect);
        format!(
            "{}#nonce={nonce}",
            server::build_workspace_url(base, "/_/admin/bootstrap")
        )
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        if let Some(tx) = self.abort_tx.take() {
            let _ = tx.send(());
        }
    }
}
