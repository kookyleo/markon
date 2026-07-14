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
    client: reqwest::Client,
}

impl RunningServer {
    /// Build a handle for an explicit port + token (e.g. from a lock the caller
    /// already read).
    pub fn new(port: u16, token: String) -> Self {
        Self {
            port,
            token,
            client: reqwest::Client::new(),
        }
    }

    /// Discover a *live* server from the on-disk lock. Returns `None` when no
    /// lock exists or the lock is stale (its TCP probe fails), i.e. when the
    /// caller is free to start its own server.
    pub fn discover() -> Option<Self> {
        let lock = ServerLock::read()?;
        if !lock.is_alive() {
            return None;
        }
        Some(Self::new(lock.port, lock.token))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
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
        collaborator_access_code_hash: &str,
    ) -> Result<String, ControlError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            path: &'a str,
            #[serde(flatten)]
            flags: WorkspaceFlags,
            #[serde(skip_serializing_if = "str::is_empty")]
            collaborator_access_code_hash: &'a str,
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
                collaborator_access_code_hash,
            })
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(resp.id)
    }

    /// Register a workspace, or — if `path` is already registered — update its
    /// access code, returning the existing id. Mirrors the CLI's forward
    /// semantics so both front-ends behave identically.
    pub async fn add_or_update_workspace(
        &self,
        path: &str,
        flags: WorkspaceFlags,
        collaborator_access_code_hash: Option<&str>,
    ) -> Result<String, ControlError> {
        let existing = self
            .list_workspaces()
            .await?
            .into_iter()
            .find(|w| w.path == path);
        if let Some(existing) = existing {
            // Mirror the embedded registry's `add`, which refreshes the flags of
            // an already-registered identity: re-adding the same path applies the
            // supplied flags in both backends so they stay observably identical.
            self.update_flags(&existing.id, flags).await?;
            if let Some(hash) = collaborator_access_code_hash {
                self.set_access_code(&existing.id, Some(hash)).await?;
            }
            return Ok(existing.id);
        }
        self.add_workspace(path, flags, collaborator_access_code_hash.unwrap_or(""))
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
