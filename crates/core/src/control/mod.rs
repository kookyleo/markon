//! Control plane — the privileged, same-user management channel for an
//! **already-running** markon server.
//!
//! The "only one server per machine" invariant is shared behavior, not a
//! front-end detail: whoever starts second should hand its workspaces to the
//! server that is already up rather than start a competing one (which would open
//! a second connection to the same annotation database — see the single-instance
//! discussion around [`crate::workspace::ServerLock`]). Keeping the client here
//! lets the CLI (forwarding `markon <dir>` to a running daemon) and the GUI
//! (attaching as a controller when a daemon is already up) go through one
//! implementation.
//!
//! **Transport** (see [`transport`]): a cross-platform local socket — a Unix
//! domain socket (`~/.markon/control.sock`, `0600`) on unix, a named pipe on
//! Windows — carrying length-prefixed JSON frames. Connecting over that socket
//! *is* the authorization: it is reachable only by the same local user, so there
//! is no token. Privilege is "which listener you arrived on".

pub mod proto;
pub mod transport;

pub use proto::{ControlRequest, ControlResponse};
pub use transport::{
    bind, dispatch, serve, AdminBootstrapCodeFn, AdminBootstrapFn, ControlContext, ControlServer,
    ControlSocketName,
};

use crate::data_maintenance::{DataCleanupResult, DataCleanupStats};
use crate::workspace::{expand_and_canonicalize, WorkspaceFlags, WorkspaceInfo};

/// Error talking to a running server's control socket.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    /// The socket could not be reached / read / written, or a frame was
    /// malformed.
    #[error("control socket transport error: {0}")]
    Transport(#[from] std::io::Error),
    /// The server processed the request but reported a failure.
    #[error("running markon server rejected the request: {0}")]
    Server(String),
    /// The server answered, but with a response variant the caller didn't expect
    /// for this request (a protocol mismatch).
    #[error("unexpected control response for this request")]
    Unexpected,
}

/// A handle to a running server, addressed by its control-socket name (a
/// filesystem path on unix, a pipe name on Windows). Each management method
/// opens a fresh connection, sends one framed request, and reads one framed
/// response. It also carries the server's web TCP port so a front-end can build
/// browser/QR URLs without a second discovery step.
#[derive(Clone)]
pub struct RunningServer {
    socket: ControlSocketName,
    /// The server's web TCP port (for building browser URLs). `0` when unknown —
    /// e.g. a socket-only handle built directly in a test.
    web_port: u16,
    /// The server's bind host (from the discovery lock), for building the
    /// printed / opened URLs. Empty when unknown (a socket-only handle).
    web_host: String,
    /// The advertised host active in the *owning* server process (from the lock).
    /// A controller (GUI/CLI) attached to a daemon another process started with a
    /// different `--entry` must build featured/QR URLs from this, not its own
    /// preference. `None` for a socket-only handle or a pre-field lock.
    web_advertised_host: Option<String>,
    /// `markond` package version from the discovery lock. Empty for a legacy
    /// daemon that predates versioned discovery.
    service_version: String,
}

impl RunningServer {
    /// Build a handle for an explicit control-socket name (e.g. a test's temp
    /// socket). The web port is unknown (`0`); use [`RunningServer::from_lock`]
    /// or [`RunningServer::discover`] when a browser port is needed.
    pub fn new(socket: ControlSocketName) -> Self {
        Self {
            socket,
            web_port: 0,
            web_host: String::new(),
            web_advertised_host: None,
            service_version: String::new(),
        }
    }

    /// Build a handle from a discovery [`ServerLock`](crate::workspace::ServerLock):
    /// resolves the recorded control socket (falling back to the default name for
    /// pre-split locks that predate the field) and captures the web port.
    pub fn from_lock(lock: &crate::workspace::ServerLock) -> Self {
        let socket = if lock.control_socket.is_empty() {
            ControlSocketName::default_name()
                .unwrap_or_else(|_| ControlSocketName::from_raw(String::new()))
        } else {
            ControlSocketName::from_raw(lock.control_socket.clone())
        };
        Self {
            socket,
            web_port: lock.port,
            web_host: lock.host.clone(),
            web_advertised_host: lock.advertised_host.clone(),
            service_version: lock.service_version.clone(),
        }
    }

    /// Discover the machine's running server via the on-disk lock, returning a
    /// handle only when that server is actually live (the lock's liveness probe
    /// now prefers the control socket). `None` means "no server to attach to".
    pub fn discover() -> Option<Self> {
        let lock = crate::workspace::ServerLock::read()?;
        lock.is_alive().then(|| Self::from_lock(&lock))
    }

    /// The control-socket name this handle targets.
    pub fn socket(&self) -> &ControlSocketName {
        &self.socket
    }

    /// The server's web TCP port, for building browser/QR URLs. `0` if this
    /// handle was built without a known port (see [`RunningServer::new`]).
    pub fn port(&self) -> u16 {
        self.web_port
    }

    /// The server's bind host, for building browser/QR URLs. Empty if this handle
    /// was built without a known host (see [`RunningServer::new`]).
    pub fn host(&self) -> &str {
        &self.web_host
    }

    /// The advertised host active in the *owning* server process (from the lock),
    /// or `None` when this handle predates the field or was built socket-only. A
    /// controller must prefer this over its own `--entry` preference when building
    /// featured / QR URLs, so the address it prints matches the address the daemon
    /// actually serves under.
    pub fn advertised_host(&self) -> Option<&str> {
        self.web_advertised_host.as_deref()
    }

    /// Version of the discovered service, or an empty string for legacy locks.
    pub fn service_version(&self) -> &str {
        &self.service_version
    }

    /// Best-effort liveness probe, mirroring
    /// [`ServerLock::is_alive`](crate::workspace::ServerLock::is_alive): `true`
    /// while this server still answers on its control socket or its web TCP port.
    ///
    /// A respawn uses this to wait for a shut-down daemon to fully release *both*
    /// before starting a replacement — `shutdown()` returns as soon as the daemon
    /// ACKs the request, long before it frees the port and removes its discovery
    /// lock, so the replacement would otherwise race the old process for the fixed
    /// port (`EADDRINUSE`) or latch the stale lock during readiness polling.
    pub fn is_reachable(&self) -> bool {
        // The control socket is the authoritative "server is up" signal; a
        // same-user connect proves liveness. A missing/stale socket refuses.
        if !self.socket.as_str().is_empty() && transport::probe(&self.socket) {
            return true;
        }
        // Fall back to the web TCP port so we only report "down" once the port is
        // actually free — the daemon removes its lock before the listener drops,
        // so the socket probe alone can't guarantee the port was released.
        if self.web_port == 0 {
            return false;
        }
        let connect_host = if crate::net::host_is_wildcard_v6(&self.web_host) {
            "::1"
        } else if crate::net::host_is_wildcard_v4(&self.web_host) || self.web_host.is_empty() {
            "127.0.0.1"
        } else {
            self.web_host.as_str()
        };
        let Ok(addr) = crate::net::bind_socket_addr(connect_host, self.web_port) else {
            return false;
        };
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_ok()
    }

    async fn call(&self, req: ControlRequest) -> Result<ControlResponse, ControlError> {
        match transport::request(&self.socket, &req).await? {
            ControlResponse::Err(msg) => Err(ControlError::Server(msg)),
            other => Ok(other),
        }
    }

    /// The running server's live workspace list.
    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>, ControlError> {
        match self.call(ControlRequest::ListWorkspaces).await? {
            ControlResponse::Workspaces(w) => Ok(w),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Register a workspace, returning its id. The collaborator hash is already
    /// salted by the caller (empty = inherit / no per-workspace code).
    pub async fn add_workspace(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        collaborator_access_code_hash: &str,
    ) -> Result<String, ControlError> {
        match self
            .call(ControlRequest::AddWorkspace {
                path: path.to_string(),
                flags,
                collaborator_access_code_hash: collaborator_access_code_hash.to_string(),
                single_file: None,
                alias: String::new(),
            })
            .await?
        {
            ControlResponse::WorkspaceId(id) => Ok(id),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Register a temporary single-file (Open-With) workspace, returning its id.
    /// `path` is the file's parent directory and `single_file` the file name; the
    /// resulting workspace exposes only that file (plus locally referenced
    /// assets). Mirrors the in-process single-file add so both backends behave
    /// identically. The collaborator hash is already salted (empty = inherit).
    pub async fn add_single_file(
        &self,
        path: &str,
        single_file: &str,
        flags: WorkspaceFlags,
        collaborator_access_code_hash: &str,
    ) -> Result<String, ControlError> {
        match self
            .call(ControlRequest::AddWorkspace {
                path: path.to_string(),
                flags,
                collaborator_access_code_hash: collaborator_access_code_hash.to_string(),
                single_file: Some(single_file.to_string()),
                alias: String::new(),
            })
            .await?
        {
            ControlResponse::WorkspaceId(id) => Ok(id),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Register a workspace, or — if `path` is already registered — update its
    /// flags (and access code, if supplied), returning the existing id. Mirrors
    /// the CLI's forward semantics so both front-ends behave identically.
    pub async fn add_or_update_workspace(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        collaborator_access_code_hash: Option<&str>,
    ) -> Result<String, ControlError> {
        self.add_or_update_workspace_scoped(path, flags, None, collaborator_access_code_hash, None)
            .await
    }

    /// Register a directory or single-file workspace while preserving its full
    /// persisted identity and metadata. GUI attach/reconnect uses this to replay
    /// the settings snapshot without collapsing a single-file workspace into its
    /// parent directory or dropping its alias.
    pub async fn add_or_update_workspace_scoped(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        single_file: Option<&str>,
        collaborator_access_code_hash: Option<&str>,
        alias: Option<&str>,
    ) -> Result<String, ControlError> {
        // The server stores canonical roots. Normalize before matching so macOS
        // `/var` -> `/private/var`, symlinks, and `..` cannot make an existing
        // identity look new and bypass the explicit metadata updates below.
        let canonical_path = expand_and_canonicalize(path)
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string());
        let existing = self
            .list_workspaces()
            .await?
            .into_iter()
            .find(|w| w.path == canonical_path && w.single_file.as_deref() == single_file);
        if let Some(existing) = existing {
            // Mirror the embedded registry's `add`, which refreshes the flags of
            // an already-registered identity: re-adding the same path applies the
            // supplied flags in both backends so they stay observably identical.
            self.update_flags(&existing.id, flags).await?;
            if let Some(hash) = collaborator_access_code_hash {
                self.set_access_code(&existing.id, Some(hash)).await?;
            }
            if let Some(alias) = alias {
                self.set_alias(&existing.id, alias).await?;
            }
            return Ok(existing.id);
        }
        match self
            .call(ControlRequest::AddWorkspace {
                path: canonical_path,
                flags,
                collaborator_access_code_hash: collaborator_access_code_hash
                    .unwrap_or("")
                    .to_string(),
                single_file: single_file.map(str::to_string),
                alias: alias.unwrap_or("").to_string(),
            })
            .await?
        {
            ControlResponse::WorkspaceId(id) => Ok(id),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Replace a workspace's feature flags wholesale.
    pub async fn update_flags(&self, id: &str, flags: WorkspaceFlags) -> Result<(), ControlError> {
        match self
            .call(ControlRequest::UpdateFlags {
                id: id.to_string(),
                flags,
            })
            .await?
        {
            ControlResponse::Ok => Ok(()),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Set (or clear, with an empty string) a workspace's display alias.
    pub async fn set_alias(&self, id: &str, alias: &str) -> Result<(), ControlError> {
        match self
            .call(ControlRequest::SetAlias {
                id: id.to_string(),
                alias: alias.to_string(),
            })
            .await?
        {
            ControlResponse::Ok => Ok(()),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Detach a workspace.
    pub async fn remove_workspace(&self, id: &str) -> Result<(), ControlError> {
        match self
            .call(ControlRequest::RemoveWorkspace { id: id.to_string() })
            .await?
        {
            ControlResponse::Ok => Ok(()),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Inspect persistent rows outside all currently registered workspaces.
    pub async fn data_cleanup_stats(&self) -> Result<DataCleanupStats, ControlError> {
        match self.call(ControlRequest::DataCleanupStats).await? {
            ControlResponse::DataCleanupStats(stats) => Ok(stats),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Permanently remove persistent rows outside all registered workspaces.
    pub async fn cleanup_orphaned_data(&self) -> Result<DataCleanupResult, ControlError> {
        match self.call(ControlRequest::CleanupOrphanedData).await? {
            ControlResponse::DataCleanupResult(result) => Ok(result),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Set (`Some(hash)`) or leave (`None`) a workspace's collaborator access
    /// code. The hash must already be salted with the shared per-install salt.
    pub async fn set_access_code(
        &self,
        id: &str,
        collaborator_access_code_hash: Option<&str>,
    ) -> Result<(), ControlError> {
        match self
            .call(ControlRequest::SetAccessCode {
                id: id.to_string(),
                collaborator_access_code_hash: collaborator_access_code_hash.map(str::to_string),
            })
            .await?
        {
            ControlResponse::Ok => Ok(()),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Mint a one-time administrator bootstrap URL that redirects to `redirect`.
    pub async fn admin_bootstrap(&self, redirect: &str) -> Result<String, ControlError> {
        match self
            .call(ControlRequest::AdminBootstrap {
                redirect: redirect.to_string(),
            })
            .await?
        {
            ControlResponse::Url(url) => Ok(url),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Mint a one-time administrator pairing code and its manual-entry URL.
    pub async fn admin_bootstrap_code(
        &self,
        redirect: &str,
    ) -> Result<(String, String), ControlError> {
        match self
            .call(ControlRequest::AdminBootstrapCode {
                redirect: redirect.to_string(),
            })
            .await?
        {
            ControlResponse::AdminCode { url, code } => Ok((url, code)),
            _ => Err(ControlError::Unexpected),
        }
    }

    /// Ask the running server to exit.
    pub async fn shutdown(&self) -> Result<(), ControlError> {
        match self.call(ControlRequest::Shutdown).await? {
            ControlResponse::Ok => Ok(()),
            _ => Err(ControlError::Unexpected),
        }
    }
}

#[cfg(test)]
mod tests;
