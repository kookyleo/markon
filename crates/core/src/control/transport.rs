//! Cross-platform local-socket transport for the control plane.
//!
//! One process (the running markon server) binds a local socket and serves a
//! strict request/response protocol; privileged front-ends (CLI, GUI) connect to
//! it. The socket is a Unix domain socket on unix (a `0600` file under
//! `~/.markon/`, so only the same user can reach it) and a named pipe on Windows.
//! Framing is length-prefixed (`tokio_util::codec::LengthDelimitedCodec`) and
//! each frame's payload is a `serde_json`-encoded [`ControlRequest`] /
//! [`ControlResponse`].
//!
//! The server is a plain tokio accept loop — NOT axum: per connection it reads
//! one framed request, dispatches it against a [`WorkspaceRegistry`], and writes
//! one framed response.

use std::io;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use interprocess::local_socket::tokio::{prelude::*, Listener, Stream};
use interprocess::local_socket::{ListenerOptions, Name};
use tokio::sync::mpsc;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use super::proto::{ControlRequest, ControlResponse};
use crate::data_maintenance::{cleanup_orphaned_data, data_cleanup_stats};
use crate::workspace::{expand_and_canonicalize, WorkspaceConfig, WorkspaceRegistry};
use rusqlite::Connection;
use std::sync::Mutex;

/// Maximum time a single accepted connection may take to deliver its one framed
/// request. A client that connects and then stalls (or dribbles a partial length
/// prefix) is dropped after this deadline instead of parking its handler task
/// forever.
const CONNECTION_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Preserve the old HTTP management client's bounded request behavior. A
/// connected but wedged service must not hang a CLI command or the GUI forever.
const CLIENT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Backoff applied after a failed `accept()` so a persistent error (e.g. `EMFILE`
/// under FD exhaustion) can't spin a core in a tight retry loop.
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

/// Resolved location of the control socket. The transport needs two different
/// kinds of identifier depending on platform, so this newtype keeps the raw
/// string and knows how to turn it into an `interprocess` [`Name`]:
///
/// * unix — a filesystem path (default `~/.markon/control.sock`). The path is
///   also what we unlink (stale socket) and `chmod 0600`.
/// * windows — a namespaced pipe name (default `markon-control`), which
///   `interprocess` maps to `\\.\pipe\markon-control`.
///
/// Other code records the resolved value via [`ControlSocketName::as_str`] so a
/// client can later be pointed at the same socket (stage 2 wires discovery to a
/// file; for now callers pass the name explicitly).
#[derive(Clone, Debug)]
pub struct ControlSocketName {
    raw: String,
}

impl ControlSocketName {
    /// The default control socket for this machine/user.
    pub fn default_name() -> io::Result<Self> {
        #[cfg(unix)]
        {
            let path = default_socket_path()?;
            Ok(Self {
                raw: path.to_string_lossy().into_owned(),
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                raw: "markon-control".to_string(),
            })
        }
    }

    /// Build a name from an explicit raw value: on unix a filesystem path (used
    /// by tests to bind a socket in a temp dir), on windows a namespaced pipe
    /// name.
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self { raw: raw.into() }
    }

    /// The recorded socket identifier — a filesystem path (unix) or pipe name
    /// (windows). This is the value to persist for discovery.
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// The socket file path (unix only), for stale-unlink and permission fixups.
    #[cfg(unix)]
    fn path(&self) -> PathBuf {
        PathBuf::from(&self.raw)
    }

    /// Turn the recorded identifier into an `interprocess` [`Name`].
    fn to_name(&self) -> io::Result<Name<'_>> {
        #[cfg(unix)]
        {
            use interprocess::local_socket::GenericFilePath;
            self.raw.as_str().to_fs_name::<GenericFilePath>()
        }
        #[cfg(windows)]
        {
            use interprocess::local_socket::GenericNamespaced;
            self.raw.as_str().to_ns_name::<GenericNamespaced>()
        }
    }
}

#[cfg(unix)]
fn default_socket_path() -> io::Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME directory required"))?;
    Ok(home.join(".markon").join("control.sock"))
}

/// The privileged operations the control server can service. `shutdown` and
/// `admin_bootstrap` are optional so a bare registry (e.g. in tests) can still be
/// served; when absent the corresponding requests answer
/// [`ControlResponse::Err`].
#[derive(Clone)]
pub struct ControlContext {
    pub registry: Arc<WorkspaceRegistry>,
    /// The running service's persistent store. Present in production; optional
    /// for registry-only transport tests and minimal embedders.
    pub db: Option<Arc<Mutex<Connection>>>,
    /// Signal channel the running server watches to exit (mirrors the HTTP
    /// `/api/shutdown` handler). `None` → `Shutdown` is unsupported.
    pub shutdown: Option<mpsc::Sender<()>>,
    /// Mint a one-time admin bootstrap URL for the given redirect. `None` →
    /// `AdminBootstrap` is unsupported. Wiring the real issuer (which needs the
    /// server's public base URL) is out of scope for stage 1.
    pub admin_bootstrap: Option<AdminBootstrapFn>,
    /// Mint a manual-entry admin URL and pairing code. `None` means the older
    /// URL-only bootstrap flow is the only supported mode.
    pub admin_bootstrap_code: Option<AdminBootstrapCodeFn>,
}

/// Given a redirect path, return the full one-time admin bootstrap URL (or an
/// error message).
pub type AdminBootstrapFn = Arc<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

/// Given a redirect path, return `(manual_entry_url, one_time_code)`.
pub type AdminBootstrapCodeFn = Arc<dyn Fn(&str) -> Result<(String, String), String> + Send + Sync>;

impl ControlContext {
    /// A context backed only by a registry — `Shutdown` and `AdminBootstrap`
    /// answer `Err`.
    pub fn new(registry: Arc<WorkspaceRegistry>) -> Self {
        Self {
            registry,
            db: None,
            shutdown: None,
            admin_bootstrap: None,
            admin_bootstrap_code: None,
        }
    }
}

/// Dispatch one request against the context, producing exactly one response.
/// Pure apart from the registry / shutdown side effects, so it is unit-testable
/// without any socket.
pub fn dispatch(req: ControlRequest, ctx: &ControlContext) -> ControlResponse {
    match req {
        ControlRequest::ListWorkspaces => ControlResponse::Workspaces(ctx.registry.info_list()),
        ControlRequest::AddWorkspace {
            path,
            flags,
            collaborator_access_code_hash,
            single_file,
            alias,
        } => {
            let path = match expand_and_canonicalize(&path) {
                Ok(p) => p,
                Err(e) => return ControlResponse::Err(format!("invalid path: {e}")),
            };
            // Defense-in-depth (mirrors the old management HTTP handler): a
            // single-file workspace name must be exactly one workspace-relative
            // path component, so it can never point outside the served root even
            // if a privileged client is buggy.
            if let Some(name) = single_file.as_deref() {
                let mut components = std::path::Path::new(name).components();
                let exactly_one_normal =
                    matches!(components.next(), Some(std::path::Component::Normal(_)))
                        && components.next().is_none();
                if !exactly_one_normal {
                    return ControlResponse::Err(
                        "single_file must be one workspace-relative file name".to_string(),
                    );
                }
            }
            // Same call the in-process add makes: `single_file` selects a
            // temporary single-file workspace vs. an ordinary directory one.
            let id = ctx.registry.add(WorkspaceConfig {
                path,
                flags,
                single_file,
                collaborator_access_code_hash,
                alias,
            });
            ControlResponse::WorkspaceId(id)
        }
        ControlRequest::UpdateFlags { id, flags } => {
            if ctx.registry.update_flags(&id, flags) {
                ControlResponse::Ok
            } else {
                ControlResponse::Err(format!("no such workspace: {id}"))
            }
        }
        ControlRequest::SetAlias { id, alias } => {
            if ctx.registry.set_alias(&id, &alias) {
                ControlResponse::Ok
            } else {
                ControlResponse::Err(format!("no such workspace: {id}"))
            }
        }
        ControlRequest::RemoveWorkspace { id } => {
            if ctx.registry.remove(&id) {
                ControlResponse::Ok
            } else {
                ControlResponse::Err(format!("no such workspace: {id}"))
            }
        }
        ControlRequest::DataCleanupStats => {
            let Some(db) = &ctx.db else {
                return ControlResponse::Err("persistent data store unavailable".to_string());
            };
            let conn = db.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match data_cleanup_stats(&conn, &ctx.registry) {
                Ok(stats) => ControlResponse::DataCleanupStats(stats),
                Err(error) => ControlResponse::Err(error),
            }
        }
        ControlRequest::CleanupOrphanedData => {
            let Some(db) = &ctx.db else {
                return ControlResponse::Err("persistent data store unavailable".to_string());
            };
            let mut conn = db.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match cleanup_orphaned_data(&mut conn, &ctx.registry) {
                Ok(result) => ControlResponse::DataCleanupResult(result),
                Err(error) => ControlResponse::Err(error),
            }
        }
        ControlRequest::SetAccessCode {
            id,
            collaborator_access_code_hash,
        } => match collaborator_access_code_hash {
            Some(hash) => {
                if ctx.registry.set_collaborator_access_code(&id, &hash) {
                    ControlResponse::Ok
                } else {
                    ControlResponse::Err(format!("no such workspace: {id}"))
                }
            }
            // Mirror the HTTP handler: a `None` hash is a no-op success.
            None => ControlResponse::Ok,
        },
        ControlRequest::AdminBootstrap { redirect } => match &ctx.admin_bootstrap {
            Some(issue) => match issue(&redirect) {
                Ok(url) => ControlResponse::Url(url),
                Err(e) => ControlResponse::Err(e),
            },
            None => ControlResponse::Err("admin bootstrap unsupported".to_string()),
        },
        ControlRequest::AdminBootstrapCode { redirect } => match &ctx.admin_bootstrap_code {
            Some(issue) => match issue(&redirect) {
                Ok((url, code)) => ControlResponse::AdminCode { url, code },
                Err(e) => ControlResponse::Err(e),
            },
            None => ControlResponse::Err("admin code bootstrap unsupported".to_string()),
        },
        ControlRequest::Shutdown => match &ctx.shutdown {
            Some(tx) => {
                let _ = tx.try_send(());
                ControlResponse::Ok
            }
            None => ControlResponse::Err("shutdown unsupported".to_string()),
        },
    }
}

/// A bound-but-not-yet-serving control listener.
///
/// Binding is separated from the accept loop so a caller can await the bind
/// (which guarantees the socket exists on disk / the pipe is registered) and
/// only *then* hand out its [`name`](ControlServer::name) — there is no race
/// window in which a client could connect before the socket is ready.
pub struct ControlServer {
    name: ControlSocketName,
    listener: Listener,
}

impl ControlServer {
    /// The socket name this server is bound to (record it for discovery).
    pub fn name(&self) -> &ControlSocketName {
        &self.name
    }

    /// Run the accept loop until `stop` resolves. Each accepted connection is
    /// handled on its own task: read one framed [`ControlRequest`],
    /// [`dispatch`] it, write one framed [`ControlResponse`]. Errors on a single
    /// connection are logged and dropped — they never take down the loop.
    pub async fn run(
        self,
        ctx: ControlContext,
        mut stop: impl std::future::Future<Output = ()> + Unpin,
    ) -> io::Result<()> {
        tracing::debug!(socket = %self.name.as_str(), "control server listening");
        loop {
            tokio::select! {
                _ = &mut stop => {
                    tracing::debug!("control server stopping");
                    break;
                }
                accepted = self.listener.accept() => {
                    match accepted {
                        Ok(stream) => {
                            let ctx = ctx.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_connection(stream, &ctx).await {
                                    tracing::debug!("control connection error: {e}");
                                }
                            });
                        }
                        Err(e) => {
                            // A persistent accept() error (FD exhaustion, etc.)
                            // would otherwise busy-loop this task and peg a core;
                            // back off briefly before retrying.
                            tracing::warn!("control accept error: {e}");
                            tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                        }
                    }
                }
            }
        }

        #[cfg(unix)]
        let _ = std::fs::remove_file(self.name.path());

        Ok(())
    }
}

/// Bind the control socket at `name`.
///
/// On unix a stale socket file is unlinked first (a leftover file from a crashed
/// process would otherwise make bind fail with `EADDRINUSE`) and the fresh
/// socket is `chmod`ed to `0600` so only the same user can connect. A socket
/// belonging to a *live* server is never removed — that would silently hijack a
/// running server's control plane — so bind fails with `AddrInUse` in that case.
pub fn bind(name: &ControlSocketName) -> io::Result<ControlServer> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Create (or tighten) the enclosing directory to `0700` *before* the
        // socket exists. The socket file is momentarily created under the process
        // umask (which may be group/other-permissive) and only chmod'ed to 0600
        // afterwards; an owner-only parent directory means no other user can even
        // traverse to the socket during that window, closing the bind->chmod race.
        if let Some(parent) = name.path().parent() {
            std::fs::create_dir_all(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        // The socket file is a rendezvous point, not state, so removing a *stale*
        // one (left by a crashed process) is safe. But if a live server is still
        // listening on this path, unlinking it would steal its control plane while
        // it keeps serving — refuse instead. `probe` connects successfully only
        // when a real server is accepting on the socket.
        if name.path().exists() {
            if probe(name) {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "a live markon control server is already bound to this socket",
                ));
            }
            let _ = std::fs::remove_file(name.path());
        }
    }

    let listener = ListenerOptions::new()
        .name(name.to_name()?)
        .create_tokio()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Restrict the socket to the owner. There is a brief window between bind
        // and chmod, but the enclosing directory (`~/.markon`, forced to `0700`
        // above) is owner-only, so no other user can traverse to the socket in
        // the interim.
        std::fs::set_permissions(name.path(), std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(ControlServer {
        name: name.clone(),
        listener,
    })
}

/// Bind the control socket at `name` and serve requests until `stop` resolves.
/// Convenience wrapper over [`bind`] + [`ControlServer::run`] for callers that
/// don't need to observe the "bound" moment.
pub async fn serve(
    name: &ControlSocketName,
    ctx: ControlContext,
    stop: impl std::future::Future<Output = ()> + Unpin,
) -> io::Result<()> {
    bind(name)?.run(ctx, stop).await
}

/// Synchronously test whether a control socket is accepting connections. Returns
/// `true` only when a connect succeeds, i.e. a live server is listening; a
/// missing socket, a stale socket file (connection refused), or a pipe with no
/// server all yield `false`. Cross-platform: a Unix domain socket connect on
/// unix, a named-pipe connect on Windows — so it can back a liveness probe on
/// both platforms.
pub fn probe(name: &ControlSocketName) -> bool {
    use interprocess::local_socket::traits::Stream as _;
    match name.to_name() {
        Ok(n) => interprocess::local_socket::Stream::connect(n).is_ok(),
        Err(_) => false,
    }
}

/// One request/one response over a single accepted connection.
async fn handle_connection(stream: Stream, ctx: &ControlContext) -> io::Result<()> {
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    // Bound how long we wait for the client's single request frame: a peer that
    // connects and then stalls (or sends a partial length prefix) must not park
    // this task indefinitely.
    let next = match tokio::time::timeout(CONNECTION_READ_TIMEOUT, framed.next()).await {
        Ok(next) => next,
        Err(_) => return Ok(()), // read deadline exceeded; drop the connection
    };
    let Some(frame) = next else {
        return Ok(()); // client hung up before sending anything
    };
    let frame = frame?;
    let response = match serde_json::from_slice::<ControlRequest>(&frame) {
        Ok(req) => dispatch(req, ctx),
        Err(e) => ControlResponse::Err(format!("malformed request: {e}")),
    };
    let bytes =
        serde_json::to_vec(&response).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    framed.send(Bytes::from(bytes)).await?;
    framed.flush().await?;
    Ok(())
}

/// Open a fresh connection to the control socket, send one request, and read the
/// single response. Used by the client ([`super::RunningServer`]).
pub(super) async fn request(
    name: &ControlSocketName,
    req: &ControlRequest,
) -> io::Result<ControlResponse> {
    tokio::time::timeout(CLIENT_REQUEST_TIMEOUT, request_inner(name, req))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "control request timed out"))?
}

async fn request_inner(
    name: &ControlSocketName,
    req: &ControlRequest,
) -> io::Result<ControlResponse> {
    let stream = Stream::connect(name.to_name()?).await?;
    let mut framed = Framed::new(stream, LengthDelimitedCodec::new());
    let bytes =
        serde_json::to_vec(req).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    framed.send(Bytes::from(bytes)).await?;
    framed.flush().await?;
    let Some(frame) = framed.next().await else {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "control server closed the connection without responding",
        ));
    };
    let frame = frame?;
    serde_json::from_slice::<ControlResponse>(&frame)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
