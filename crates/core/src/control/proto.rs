//! Wire protocol for the **control plane** — the same-user local-socket channel
//! that carries privileged management/admin operations.
//!
//! The transport is a cross-platform local socket (Unix domain socket on unix,
//! Windows named pipe) carrying length-prefixed frames; each frame is one JSON
//! value. The exchange is strictly request/response: a client writes exactly one
//! [`ControlRequest`] frame and reads exactly one [`ControlResponse`] frame.
//!
//! Authorization is the socket itself: reaching the control listener means a
//! local, same-user process opened it (the socket is created `0600` on unix, and
//! a named pipe is scoped to the current session on Windows). There is no token —
//! privilege is "which listener you arrived on".

use crate::workspace::{WorkspaceFlags, WorkspaceInfo};
use serde::{Deserialize, Serialize};

/// A single privileged management/admin request. One request maps to exactly one
/// [`ControlResponse`]. Field semantics mirror the legacy loopback HTTP API so
/// both front-ends (CLI, GUI) behave identically regardless of transport.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ControlRequest {
    /// List every registered workspace (the live registry snapshot).
    ListWorkspaces,
    /// Register a workspace at `path` with `flags`. The collaborator hash is
    /// already salted by the caller; an empty string means "no per-workspace
    /// code" (inherit the server-level code).
    ///
    /// `single_file` is `Some(name)` for a temporary Open-With single-file
    /// workspace rooted at `path` (the file's parent dir) that exposes only
    /// `name`; `None` for an ordinary directory workspace. It mirrors
    /// [`crate::workspace::WorkspaceConfig::single_file`] so a front-end can
    /// register either kind over the socket exactly like the in-process add.
    AddWorkspace {
        path: String,
        flags: WorkspaceFlags,
        collaborator_access_code_hash: String,
        #[serde(default)]
        single_file: Option<String>,
        #[serde(default)]
        alias: String,
    },
    /// Replace a workspace's feature flags wholesale.
    UpdateFlags { id: String, flags: WorkspaceFlags },
    /// Set (or clear, with an empty string) a workspace's display alias.
    SetAlias { id: String, alias: String },
    /// Detach a workspace by id.
    RemoveWorkspace { id: String },
    /// Set (`Some(hash)`) or leave (`None`) a workspace's collaborator access
    /// code hash. The hash must already be salted with the shared install salt.
    SetAccessCode {
        id: String,
        collaborator_access_code_hash: Option<String>,
    },
    /// Mint a one-time administrator bootstrap URL that redirects to `redirect`
    /// after the browser exchanges it for an admin session.
    AdminBootstrap { redirect: String },
    /// Mint a one-time administrator pairing code and return the manual-entry
    /// URL. This preserves the non-browser-launching `markon admin code` flow.
    AdminBootstrapCode { redirect: String },
    /// Ask the running server to exit.
    Shutdown,
}

/// The single response to a [`ControlRequest`]. Handlers that don't produce data
/// answer [`ControlResponse::Ok`]; failures answer [`ControlResponse::Err`] with
/// a human-readable message that the client maps back to a `ControlError`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ControlResponse {
    /// Answer to [`ControlRequest::ListWorkspaces`].
    Workspaces(Vec<WorkspaceInfo>),
    /// A newly created / matched workspace id (answer to `AddWorkspace`).
    WorkspaceId(String),
    /// A URL (answer to `AdminBootstrap`).
    Url(String),
    /// Manual administrator bootstrap details (answer to
    /// `AdminBootstrapCode`).
    AdminCode { url: String, code: String },
    /// A data-less success.
    Ok,
    /// A failure, carrying a human-readable reason.
    Err(String),
}
