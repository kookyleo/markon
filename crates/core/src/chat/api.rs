//! Public wire-format types for the chat HTTP / SSE surface.
//!
//! Everything re-exported from this module is part of the JSON contract the
//! browser and any external API consumer talks to. Types live in their
//! implementation modules (`storage`, `message`, `agent`) at `pub(crate)`
//! visibility; this module lifts only the wire-relevant ones back into the
//! public API. Keeping the public surface separate from the implementation
//! makes it obvious what is and isn't a contract.
//!
//! Wire layout:
//! - SSE stream of [`AgentEvent`] from `POST /api/chat/{ws}`.
//! - `Thread` + [`Message`] / [`Role`] / [`ContentBlock`] / [`Usage`] in
//!   `GET /api/chat/{ws}/threads/{thread_id}` (rehydrated history).
//! - [`ThreadSummary`] list in `GET /api/chat/{ws}/threads`.

pub use crate::chat::agent::AgentEvent;
pub use crate::chat::message::{ContentBlock, Message, Role, Usage};
pub use crate::chat::storage::{Thread, ThreadSummary};
