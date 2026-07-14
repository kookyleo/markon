//! Round-trip tests: stand up the control server on a temp socket backed by an
//! in-memory [`WorkspaceRegistry`], then drive every [`RunningServer`] method
//! through the real local-socket transport and assert correctness.

use super::*;
use crate::control::transport::{bind, ControlContext};
use crate::workspace::{WorkspaceFlags, WorkspaceRegistry};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

/// Bind a control server on a unique temp socket, spawn its accept loop, and
/// return a client plus the plumbing needed to drive/observe it. Binding is
/// awaited before we return, so the client can connect with no startup race
/// (and no `sleep`).
struct Harness {
    client: RunningServer,
    registry: Arc<WorkspaceRegistry>,
    shutdown_rx: mpsc::Receiver<()>,
    stop_tx: oneshot::Sender<()>,
    server_task: tokio::task::JoinHandle<()>,
    _tmp: tempfile::TempDir,
}

async fn harness() -> Harness {
    let tmp = tempfile::TempDir::new().unwrap();
    let socket_path = tmp.path().join("control.sock");
    let name = ControlSocketName::from_raw(socket_path.to_string_lossy().into_owned());

    let registry = Arc::new(WorkspaceRegistry::new("test-salt".into()));
    let (shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let admin: AdminBootstrapFn =
        Arc::new(|redirect: &str| Ok(format!("http://127.0.0.1:7000{redirect}#nonce=abc")));

    let ctx = ControlContext {
        registry: registry.clone(),
        shutdown: Some(shutdown_tx),
        admin_bootstrap: Some(admin),
    };

    // Bind synchronously (awaited) so the socket exists before any connect.
    let server = bind(&name).unwrap();
    let (stop_tx, stop_rx) = oneshot::channel();
    let server_task = tokio::spawn(async move {
        let stop = async move {
            let _ = stop_rx.await;
        };
        server.run(ctx, Box::pin(stop)).await.unwrap();
    });

    Harness {
        client: RunningServer::new(name),
        registry,
        shutdown_rx,
        stop_tx,
        server_task,
        _tmp: tmp,
    }
}

impl Harness {
    async fn teardown(self) {
        let _ = self.stop_tx.send(());
        let _ = self.server_task.await;
    }
}

#[tokio::test]
async fn control_round_trips_every_method() {
    let mut h = harness().await;
    let dir = tempfile::TempDir::new().unwrap();
    let dir_path = dir.path().to_string_lossy().into_owned();

    // list — empty to start.
    assert!(h.client.list_workspaces().await.unwrap().is_empty());

    // add_workspace — returns the registry's id and the entry becomes visible.
    let flags = WorkspaceFlags {
        enable_search: true,
        enable_edit: true,
        ..Default::default()
    };
    let id = h
        .client
        .add_workspace(&dir_path, flags, "")
        .await
        .unwrap();
    let listed = h.client.list_workspaces().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, id);
    assert_eq!(listed[0].flags, flags);
    // The registry actually holds it.
    assert!(h.registry.get(&id).is_some());

    // update_flags — replaces flags wholesale.
    let new_flags = WorkspaceFlags {
        enable_live: true,
        ..Default::default()
    };
    h.client.update_flags(&id, new_flags).await.unwrap();
    assert_eq!(
        h.client.list_workspaces().await.unwrap()[0].flags,
        new_flags
    );

    // set_access_code — Some(hash) persists onto the entry.
    let hash = "a".repeat(64);
    h.client.set_access_code(&id, Some(&hash)).await.unwrap();
    assert_eq!(
        h.client.list_workspaces().await.unwrap()[0].collaborator_access_code_hash,
        hash
    );
    // None is a no-op success and leaves the code intact.
    h.client.set_access_code(&id, None).await.unwrap();
    assert_eq!(
        h.client.list_workspaces().await.unwrap()[0].collaborator_access_code_hash,
        hash
    );

    // add_or_update_workspace — same path updates in place, returns same id.
    let same_id = h
        .client
        .add_or_update_workspace(&dir_path, flags, None)
        .await
        .unwrap();
    assert_eq!(same_id, id);
    assert_eq!(h.client.list_workspaces().await.unwrap()[0].flags, flags);

    // admin_bootstrap — routed through the injected issuer.
    let url = h.client.admin_bootstrap("/workspace/").await.unwrap();
    assert_eq!(url, "http://127.0.0.1:7000/workspace/#nonce=abc");

    // remove_workspace — detaches; list goes empty.
    h.client.remove_workspace(&id).await.unwrap();
    assert!(h.client.list_workspaces().await.unwrap().is_empty());
    assert!(h.registry.get(&id).is_none());

    // shutdown — signals the injected channel.
    h.client.shutdown().await.unwrap();
    assert!(h.shutdown_rx.recv().await.is_some());

    h.teardown().await;
}

#[tokio::test]
async fn control_maps_server_errors() {
    let h = harness().await;

    // update/remove/set on an unknown id come back as ControlError::Server.
    let err = h
        .client
        .update_flags("deadbeef", WorkspaceFlags::default())
        .await
        .unwrap_err();
    assert!(matches!(err, ControlError::Server(_)), "got {err:?}");

    let err = h.client.remove_workspace("deadbeef").await.unwrap_err();
    assert!(matches!(err, ControlError::Server(_)), "got {err:?}");

    let err = h
        .client
        .set_access_code("deadbeef", Some("x"))
        .await
        .unwrap_err();
    assert!(matches!(err, ControlError::Server(_)), "got {err:?}");

    h.teardown().await;
}

#[tokio::test]
async fn control_transport_error_when_no_server() {
    // Point a client at a socket nobody is serving: connect fails as a transport
    // error, not a panic.
    let tmp = tempfile::TempDir::new().unwrap();
    let name =
        ControlSocketName::from_raw(tmp.path().join("absent.sock").to_string_lossy().into_owned());
    let client = RunningServer::new(name);
    let err = client.list_workspaces().await.unwrap_err();
    assert!(matches!(err, ControlError::Transport(_)), "got {err:?}");
}
