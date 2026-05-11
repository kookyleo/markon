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
//! - [`api`]      — types whose only public contract is the JSON wire format
//!   for the chat HTTP / SSE surface. Consolidated here so callers can see
//!   the wire schema at a glance instead of digging through implementation
//!   modules.

pub mod api;
pub mod config;
pub mod models;

pub(crate) mod agent;
pub(crate) mod message;
pub(crate) mod prompt;
pub(crate) mod provider;
pub(crate) mod routes;
pub(crate) mod storage;
pub(crate) mod tools;
