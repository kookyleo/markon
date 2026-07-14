//! Serializable handoff config between the `markon` CLI spawner and the
//! standalone `markond` service binary.
//!
//! The CLI resolves everything declarative the daemon needs (bind host, port,
//! salt, UI/theme knobs, per-workspace state, and secrets like the collaborator
//! access-code hash), writes it to a `0600` JSON file, and spawns
//! `markond --config <path>`. `markond` deserializes it into a [`DaemonConfig`]
//! and rebuilds a runtime [`ServerConfig`] via
//! [`ServerConfig::from_daemon_config`].
//!
//! Only the *declarative* subset of `ServerConfig` lives here. Runtime handles —
//! a pre-bound listener, the shared workspace registry / persist hook, the
//! management token, and the admin-bootstrap store — are NOT serialized; the
//! process that runs the server constructs them locally.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::server::{ServerConfig, WorkspaceInit};
use crate::workspace::WorkspaceFlags;

/// One initial workspace, declarative subset of [`WorkspaceInit`].
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaemonWorkspace {
    pub path: PathBuf,
    #[serde(default)]
    pub flags: WorkspaceFlags,
    #[serde(default)]
    pub initial_path: Option<String>,
    #[serde(default)]
    pub single_file: Option<String>,
    #[serde(default)]
    pub collaborator_access_code_hash: String,
    #[serde(default)]
    pub alias: String,
}

impl From<DaemonWorkspace> for WorkspaceInit {
    fn from(w: DaemonWorkspace) -> Self {
        WorkspaceInit {
            path: w.path,
            flags: w.flags,
            initial_path: w.initial_path,
            single_file: w.single_file,
            collaborator_access_code_hash: w.collaborator_access_code_hash,
            alias: w.alias,
        }
    }
}

/// Declarative daemon configuration handed from the CLI to `markond`.
///
/// This is the complete set of `ServerConfig` fields the daemon needs to
/// reconstruct its runtime configuration. Fields that are runtime handles in
/// `ServerConfig` (bound_listener, registry, management_token, admin_bootstraps)
/// are intentionally absent — `markond` builds them itself.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub host: String,
    #[serde(default)]
    pub advertised_host: String,
    #[serde(default)]
    pub trusted_hosts: Vec<String>,
    pub port: u16,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub qr: Option<String>,
    #[serde(default)]
    pub open_browser: Option<String>,
    #[serde(default)]
    pub db_path: Option<String>,
    #[serde(default)]
    pub salt: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<DaemonWorkspace>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub shortcuts_json: Option<String>,
    #[serde(default)]
    pub styles_css: Option<String>,
    #[serde(default)]
    pub default_chat_mode: String,
    #[serde(default)]
    pub editor_theme: String,
    #[serde(default)]
    pub collaborator_access_code_hash: String,
    #[serde(default)]
    pub print_collapsed_content: bool,
}

fn default_theme() -> String {
    "auto".to_string()
}

impl ServerConfig {
    /// Rebuild a runtime [`ServerConfig`] from a declarative [`DaemonConfig`].
    ///
    /// Runtime handles are left unset: `bound_listener`, `registry`,
    /// `management_token`, and `admin_bootstraps` are all `None` so the daemon
    /// binds fresh, auto-generates a management token, and creates its own
    /// bootstrap store. The caller (`markond`) attaches a registry with a
    /// persist hook before starting the server so workspace mutations mirror
    /// back into `settings.json`.
    pub fn from_daemon_config(cfg: DaemonConfig) -> Self {
        let shared_annotation = cfg.workspaces.iter().any(|w| w.flags.shared_annotation);
        let initial_workspaces = cfg
            .workspaces
            .into_iter()
            .map(WorkspaceInit::from)
            .collect();
        ServerConfig {
            host: cfg.host,
            advertised_host: cfg.advertised_host,
            trusted_hosts: cfg.trusted_hosts,
            port: cfg.port,
            theme: cfg.theme,
            qr: cfg.qr,
            open_browser: cfg.open_browser,
            shared_annotation,
            db_path: cfg.db_path,
            salt: cfg.salt,
            initial_workspaces,
            bound_listener: None,
            registry: None,
            management_token: None,
            admin_bootstraps: None,
            language: cfg.language,
            shortcuts_json: cfg.shortcuts_json,
            styles_css: cfg.styles_css,
            default_chat_mode: cfg.default_chat_mode,
            editor_theme: cfg.editor_theme,
            collaborator_access_code_hash: cfg.collaborator_access_code_hash,
            print_collapsed_content: cfg.print_collapsed_content,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let cfg = DaemonConfig {
            host: "127.0.0.1".to_string(),
            advertised_host: "192.168.1.5".to_string(),
            trusted_hosts: vec!["md.example.com".to_string()],
            port: 6419,
            theme: "auto".to_string(),
            qr: Some("https://md.example.com".to_string()),
            open_browser: None,
            db_path: Some("/tmp/x.sqlite".to_string()),
            salt: Some("markon:6419".to_string()),
            workspaces: vec![DaemonWorkspace {
                path: PathBuf::from("/tmp/docs"),
                flags: WorkspaceFlags {
                    enable_search: true,
                    shared_annotation: true,
                    ..Default::default()
                },
                initial_path: Some("readme.md".to_string()),
                single_file: None,
                collaborator_access_code_hash: "deadbeef".to_string(),
                alias: "docs".to_string(),
            }],
            language: Some("en".to_string()),
            shortcuts_json: None,
            styles_css: None,
            default_chat_mode: "in_page".to_string(),
            editor_theme: "follow".to_string(),
            collaborator_access_code_hash: "cafef00d".to_string(),
            print_collapsed_content: true,
        };

        let json = serde_json::to_string(&cfg).unwrap();
        let back: DaemonConfig = serde_json::from_str(&json).unwrap();
        let server = ServerConfig::from_daemon_config(back);

        assert_eq!(server.host, "127.0.0.1");
        assert_eq!(server.port, 6419);
        assert_eq!(server.advertised_host, "192.168.1.5");
        assert_eq!(server.trusted_hosts, vec!["md.example.com".to_string()]);
        assert_eq!(server.qr.as_deref(), Some("https://md.example.com"));
        assert!(server.open_browser.is_none());
        assert_eq!(server.salt.as_deref(), Some("markon:6419"));
        assert!(server.shared_annotation, "derived from workspace flags");
        assert_eq!(server.initial_workspaces.len(), 1);
        let ws = &server.initial_workspaces[0];
        assert_eq!(ws.path, PathBuf::from("/tmp/docs"));
        assert_eq!(ws.collaborator_access_code_hash, "deadbeef");
        assert_eq!(ws.alias, "docs");
        assert_eq!(server.collaborator_access_code_hash, "cafef00d");
        assert!(server.print_collapsed_content);
        // Runtime handles are never reconstructed from the declarative config.
        assert!(server.registry.is_none());
        assert!(server.bound_listener.is_none());
        assert!(server.management_token.is_none());
        assert!(server.admin_bootstraps.is_none());
    }
}
