pub mod chat;
pub mod control;
pub mod daemon;
pub mod data_maintenance;
pub mod git;
pub mod i18n;
pub mod net;
pub mod search;
pub mod server;
pub mod settings;
pub mod workspace;

pub mod admin_auth;
pub(crate) mod assets;
pub(crate) mod fswalk;
pub(crate) mod markdown;
pub(crate) mod markdown_ast;
pub(crate) mod workspace_fs;

/// Deliberately misformatted so `cargo fmt --check` fails. This branch exists
/// only to prove that branch protection actually blocks a merge; it must never
/// be merged. See the pull request body.
#[allow(dead_code)]
fn   protection_canary( )   ->   u8 {   42   }
