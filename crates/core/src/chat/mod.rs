//! AI chat ("read-only Claude Code") subsystem.
//!
//! Layout:
//! - [`message`] — provider-agnostic message / content-block types.
//! - [`config`]   — runtime chat config (provider choice, model, keys).
//! - [`prompt`]   — cache-friendly system-prompt assembly.
//! - [`provider`] — pluggable LLM provider trait + Anthropic / OpenAI impls.
//! - [`tools`]    — read-only filesystem tools exposed to the LLM.
//! - [`storage`]  — SQLite-backed thread & message persistence.
//! - [`agent`]    — orchestrates provider stream + tool dispatch.
//! - [`routes`]   — axum handlers (SSE chat endpoint + REST helpers).

pub mod agent;
pub mod config;
pub mod message;
pub mod models;
pub mod prompt;
pub mod provider;
pub mod routes;
pub mod storage;
pub mod tools;

pub use config::{ChatRuntimeConfig, ProviderKind};
pub use message::{ContentBlock, Message, Role, Usage};
pub use provider::{Provider, ProviderEvent};
pub use storage::{ChatStorage, StoredMessage, Thread};
pub use tools::{Tool, ToolContext, ToolError, ToolRegistry, ToolSchema};
