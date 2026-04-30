//! Provider abstraction for streaming chat completions.

pub mod anthropic;
pub mod openai;

use crate::chat::config::{ChatRuntimeConfig, ProviderKind};
use crate::chat::message::{ContentBlock, Message, Usage};
use crate::chat::tools::ToolSchema;
use async_trait::async_trait;
use futures::stream::BoxStream;
use std::sync::Arc;

/// One block of the system prompt. Multiple blocks let providers that support
/// prompt-caching (Anthropic) place a `cache_control: ephemeral` breakpoint
/// at the end of any block whose tail is stable across turns.
#[derive(Debug, Clone)]
pub struct SystemBlock {
    pub text: String,
    pub cache: bool,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Vec<SystemBlock>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSchema>,
    pub max_tokens: u32,
}

/// Streaming events emitted by a provider, normalized across vendors.
#[derive(Debug, Clone)]
pub enum ProviderEvent {
    /// Plain text delta from the assistant.
    TextDelta(String),
    /// A tool_use block has been opened. `input` is `null` until [`ToolUseEnd`].
    ToolUseStart { id: String, name: String },
    /// Final, fully-parsed tool input once the block closes.
    ToolUseEnd {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Stream finished. `stop_reason` is provider-specific.
    MessageEnd {
        stop_reason: String,
        usage: Usage,
        /// Full assistant content as the provider saw it (text + tool_use
        /// blocks in order). Used by the agent loop to append to history
        /// without re-parsing the stream.
        content: Vec<ContentBlock>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("auth error: {0}")]
    Auth(String),
    #[error("api error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("decode error: {0}")]
    Decode(String),
    #[error("provider misconfigured: {0}")]
    Config(&'static str),
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn stream(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ProviderEvent, ProviderError>>, ProviderError>;
}

/// Build a provider from resolved runtime config.
pub fn build(cfg: ChatRuntimeConfig) -> Arc<dyn Provider> {
    match cfg.provider {
        ProviderKind::Anthropic => Arc::new(anthropic::AnthropicProvider::new(cfg)),
        ProviderKind::OpenAI => Arc::new(openai::OpenAiProvider::new(cfg)),
    }
}

/// Find the offset of the first SSE event terminator (`\n\n` or `\r\n\r\n`)
/// in the buffer. Returns `(offset, terminator_len)` so callers can split off
/// `offset + terminator_len` bytes.
pub(super) fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some((i, 2));
        }
        if i + 3 < buf.len()
            && buf[i] == b'\r'
            && buf[i + 1] == b'\n'
            && buf[i + 2] == b'\r'
            && buf[i + 3] == b'\n'
        {
            return Some((i, 4));
        }
        i += 1;
    }
    None
}
