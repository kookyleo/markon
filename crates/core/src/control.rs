//! Client for driving an **already-running** markon server over its loopback
//! management API (`/api/workspace*`, `/api/shutdown`).
//!
//! The "only one server per machine" invariant is shared behavior, not a
//! front-end detail: whoever starts second should hand its workspaces to the
//! server that is already up rather than start a competing one (which would open
//! a second connection to the same annotation database — see the single-instance
//! discussion around [`ServerLock`]). Keeping the client here lets the CLI
//! (forwarding `markon <dir>` to a running daemon) and the GUI (attaching as a
//! controller when a daemon is already up) go through one implementation instead
//! of each re-deriving the HTTP calls.
//!
//! All requests target `127.0.0.1` and carry the management token from the lock,
//! so they satisfy the server's `require_local_and_token` guard.

use crate::workspace::{ServerLock, WorkspaceFlags, WorkspaceInfo};
use std::time::Duration;

/// Error talking to a running server's management API.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("request to the running markon server failed: {0}")]
    Http(#[from] reqwest::Error),
}

/// A handle to a running server, addressed by its loopback port + management
/// token (as recorded in the on-disk [`ServerLock`]).
#[derive(Clone)]
pub struct RunningServer {
    port: u16,
    token: String,
    bind_host: String,
    advertised_host: Option<String>,
    client: reqwest::Client,
}

impl RunningServer {
    /// Build a handle for an explicit port + token (e.g. from a lock the caller
    /// already read).
    pub fn new(port: u16, token: String) -> Self {
        Self::with_hosts(port, token, String::new(), None)
    }

    fn with_hosts(
        port: u16,
        token: String,
        bind_host: String,
        advertised_host: Option<String>,
    ) -> Self {
        Self {
            port,
            token,
            bind_host,
            advertised_host,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(1))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("failed to build markon control client"),
        }
    }

    pub fn from_lock(lock: ServerLock) -> Self {
        Self::with_hosts(lock.port, lock.token, lock.host, lock.advertised_host)
    }

    /// Discover a *live* server from the on-disk lock. Returns `None` when no
    /// lock exists or the lock is stale (its TCP probe fails), i.e. when the
    /// caller is free to start its own server.
    pub fn discover() -> Option<Self> {
        let lock = ServerLock::read()?;
        if !lock.is_alive() {
            return None;
        }
        Some(Self::from_lock(lock))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Bind host recorded by the process that owns the server. Empty only for
    /// legacy lock files; callers should then fall back to their configured
    /// host. This must drive browser URLs in controller mode — the attached
    /// GUI's own bind preference may differ from a CLI `--host` override.
    pub fn bind_host(&self) -> &str {
        &self.bind_host
    }

    pub fn advertised_host(&self) -> Option<&str> {
        self.advertised_host.as_deref()
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// GET `/api/workspaces` — the running server's live workspace list.
    pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>, ControlError> {
        Ok(self
            .client
            .get(self.url("/api/workspaces"))
            .header("X-Markon-Token", &self.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// POST `/api/workspace` — register a workspace, returning its id. The
    /// collaborator hash is already salted by the caller (empty = inherit /
    /// no change).
    pub async fn add_workspace(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        single_file: Option<&str>,
        collaborator_access_code_hash: &str,
        alias: &str,
    ) -> Result<String, ControlError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            path: &'a str,
            #[serde(flatten)]
            flags: WorkspaceFlags,
            #[serde(skip_serializing_if = "Option::is_none")]
            single_file: Option<&'a str>,
            #[serde(skip_serializing_if = "str::is_empty")]
            collaborator_access_code_hash: &'a str,
            #[serde(skip_serializing_if = "str::is_empty")]
            alias: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Resp {
            id: String,
        }
        let resp: Resp = self
            .client
            .post(self.url("/api/workspace"))
            .header("X-Markon-Token", &self.token)
            .json(&Body {
                path,
                flags,
                single_file,
                collaborator_access_code_hash,
                alias,
            })
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(resp.id)
    }

    /// Register a workspace, or update selected properties of an existing
    /// `(path, single_file)` identity and return its id. GUI callers set
    /// `update_existing_flags` to mirror `WorkspaceRegistry::add`; CLI callers
    /// leave it false so opening a path cannot reset configured features.
    pub async fn add_or_update_workspace(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        update_existing_flags: bool,
        single_file: Option<&str>,
        collaborator_access_code_hash: Option<&str>,
        alias: Option<&str>,
    ) -> Result<String, ControlError> {
        let existing = self
            .list_workspaces()
            .await?
            .into_iter()
            .find(|w| w.path == path && w.single_file.as_deref() == single_file);
        if let Some(existing) = existing {
            // GUI registration mirrors the embedded registry's `add`, which
            // refreshes flags for an existing identity. CLI forwarding passes
            // false to preserve its historical contract: opening an already
            // registered path must not reset explicitly configured features.
            if update_existing_flags {
                self.update_flags(&existing.id, flags).await?;
            }
            if let Some(hash) = collaborator_access_code_hash {
                self.set_access_code(&existing.id, Some(hash)).await?;
            }
            if let Some(alias) = alias {
                self.set_alias(&existing.id, alias).await?;
            }
            return Ok(existing.id);
        }
        self.add_workspace(
            path,
            flags,
            single_file,
            collaborator_access_code_hash.unwrap_or(""),
            alias.unwrap_or(""),
        )
        .await
    }

    /// PUT `/api/workspace/{id}` — replace a workspace's feature flags wholesale.
    pub async fn update_flags(&self, id: &str, flags: WorkspaceFlags) -> Result<(), ControlError> {
        self.client
            .put(self.url(&format!("/api/workspace/{id}")))
            .header("X-Markon-Token", &self.token)
            .json(&flags)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// DELETE `/api/workspace/{id}` — detach a workspace.
    pub async fn remove_workspace(&self, id: &str) -> Result<(), ControlError> {
        self.client
            .delete(self.url(&format!("/api/workspace/{id}")))
            .header("X-Markon-Token", &self.token)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// PUT `/api/workspace/{id}/access` — set (`Some(hash)`) or leave a
    /// workspace's collaborator access code. The hash must already be salted
    /// with the shared per-install salt.
    pub async fn set_access_code(
        &self,
        id: &str,
        collaborator_access_code_hash: Option<&str>,
    ) -> Result<(), ControlError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            collaborator_access_code_hash: Option<&'a str>,
        }
        self.client
            .put(self.url(&format!("/api/workspace/{id}/access")))
            .header("X-Markon-Token", &self.token)
            .json(&Body {
                collaborator_access_code_hash,
            })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// PUT `/api/workspace/{id}/alias` — set or clear the display alias.
    pub async fn set_alias(&self, id: &str, alias: &str) -> Result<(), ControlError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            alias: &'a str,
        }
        self.client
            .put(self.url(&format!("/api/workspace/{id}/alias")))
            .header("X-Markon-Token", &self.token)
            .json(&Body { alias })
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// POST `/api/shutdown` — ask the running server to exit.
    pub async fn shutdown(&self) -> Result<(), ControlError> {
        self.client
            .post(self.url("/api/shutdown"))
            .header("X-Markon-Token", &self.token)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Json, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post, put};
    use axum::Router;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    async fn capture_add(
        State(captured): State<Arc<Mutex<Option<Value>>>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(
            headers
                .get("X-Markon-Token")
                .and_then(|value| value.to_str().ok()),
            Some("management-token")
        );
        *captured.lock().unwrap() = Some(body);
        Json(json!({ "id": "deadbeef" }))
    }

    #[tokio::test]
    async fn add_workspace_carries_single_file_scope_and_alias() {
        let captured = Arc::new(Mutex::new(None));
        let app = Router::new()
            .route("/api/workspace", post(capture_add))
            .with_state(captured.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let server = RunningServer::new(port, "management-token".into());
        let id = server
            .add_workspace(
                "/tmp/docs",
                WorkspaceFlags::default(),
                Some("note.md"),
                "hash",
                "Pinned note",
            )
            .await
            .unwrap();
        assert_eq!(id, "deadbeef");
        let body = captured.lock().unwrap().take().unwrap();
        assert_eq!(body["path"], "/tmp/docs");
        assert_eq!(body["single_file"], "note.md");
        assert_eq!(body["collaborator_access_code_hash"], "hash");
        assert_eq!(body["alias"], "Pinned note");
        task.abort();
    }

    #[test]
    fn running_server_preserves_active_hosts_from_lock() {
        let server = RunningServer::from_lock(ServerLock {
            port: 6419,
            token: "token".into(),
            host: "0.0.0.0".into(),
            advertised_host: Some(String::new()),
        });
        assert_eq!(server.bind_host(), "0.0.0.0");
        assert_eq!(server.advertised_host(), Some(""));
    }

    async fn existing_workspaces() -> Json<Value> {
        Json(json!([{
            "id": "deadbeef",
            "path": "/tmp/docs",
            "enable_search": true,
            "enable_viewed": false,
            "enable_edit": false,
            "enable_live": false,
            "enable_chat": false,
            "shared_annotation": false,
            "search_ready": true,
            "ephemeral": false,
            "alias": ""
        }]))
    }

    async fn count_flag_update(State(count): State<Arc<AtomicUsize>>) -> StatusCode {
        count.fetch_add(1, Ordering::Relaxed);
        StatusCode::OK
    }

    #[tokio::test]
    async fn existing_workspace_flag_update_is_an_explicit_policy() {
        let count = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/api/workspaces", get(existing_workspaces))
            .route("/api/workspace/{id}", put(count_flag_update))
            .with_state(count.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let server = RunningServer::new(port, "management-token".into());

        let id = server
            .add_or_update_workspace(
                "/tmp/docs",
                WorkspaceFlags::default(),
                false,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(id, "deadbeef");
        assert_eq!(count.load(Ordering::Relaxed), 0);

        server
            .add_or_update_workspace(
                "/tmp/docs",
                WorkspaceFlags::default(),
                true,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 1);
        task.abort();
    }
}
