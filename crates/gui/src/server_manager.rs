use markon_core::server::ServerConfig;
use markon_core::workspace::{PersistHook, WorkspaceRegistry};
use std::sync::Arc;

pub struct ServerManager {
    abort_tx: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    port: u16,
    last_error: Option<String>,
    /// Shared with the server's AppState; allows Tauri commands to add/remove workspaces.
    pub registry: Arc<WorkspaceRegistry>,
}

impl Default for ServerManager {
    fn default() -> Self {
        Self {
            abort_tx: None,
            thread: None,
            port: 0,
            last_error: None,
            registry: Arc::new(WorkspaceRegistry::new("markon:0".into())),
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

        // Pre-bind synchronously so a bad address (e.g. NIC IP saved in a
        // previous network) fails loudly here instead of leaving the async
        // start to silently die in the spawned thread.
        let bind_addr = format!("{}:{}", config.host, config.port);
        let (config, actual_port) = match std::net::TcpListener::bind(&bind_addr) {
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
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        if let Some(tx) = self.abort_tx.take() {
            let _ = tx.send(());
        }
    }
}
