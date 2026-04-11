use markon_core::server::ServerConfig;
use markon_core::workspace::WorkspaceRegistry;
use std::sync::Arc;

pub struct ServerManager {
    abort_tx: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    port: u16,
    running: bool,
    /// Shared with the server's AppState; allows Tauri commands to add/remove workspaces.
    pub registry: Arc<WorkspaceRegistry>,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            abort_tx: None,
            thread: None,
            port: 0,
            running: false,
            registry: Arc::new(WorkspaceRegistry::new("markon:0".into())),
        }
    }

    pub fn start(&mut self, mut config: ServerConfig) {
        self.stop();

        // Stable salt based on port — same dir+port = same workspace ID.
        let salt = format!("markon:{}", config.port);
        self.registry = Arc::new(WorkspaceRegistry::new(salt.clone()));
        config.salt = Some(salt);
        config.registry = Some(self.registry.clone());

        // Pre-bind to hold the port synchronously before the async runtime starts.
        let bind_addr = format!("{}:{}", config.host, config.port);
        let (config, actual_port) = match std::net::TcpListener::bind(&bind_addr) {
            Ok(listener) => {
                let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(config.port);
                let mut c = config;
                c.port = actual_port;
                c.bound_listener = Some(listener);
                (c, actual_port)
            }
            Err(e) => {
                eprintln!("[ServerManager] pre-bind failed {bind_addr}: {e}");
                let p = config.port;
                (config, p)
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
                                eprintln!("[server] {e}");
                            }
                        }
                        _ = rx => {}
                    }
                });
        });

        self.abort_tx = Some(tx);
        self.thread = Some(thread);
        self.port = actual_port;
        self.running = true;
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.abort_tx.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.running = false;
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for ServerManager {
    fn drop(&mut self) {
        if let Some(tx) = self.abort_tx.take() {
            let _ = tx.send(());
        }
    }
}
