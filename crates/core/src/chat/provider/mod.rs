//! Provider abstraction for streaming chat completions.

pub mod anthropic;
pub mod openai;

use crate::chat::config::{ChatRuntimeConfig, ProviderKind};
use crate::chat::message::{ContentBlock, Message, Usage};
use crate::chat::tools::ToolSchema;
use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures::stream::{BoxStream, Stream};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

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

pub(super) type EventQueue = VecDeque<Result<ProviderEvent, ProviderError>>;

/// Generic SSE-stream driver shared by Anthropic and OpenAI providers. Owns
/// the upstream byte stream and a parser `State`, splits the buffer on event
/// terminators, and dispatches each chunk through `on_chunk`. When the
/// upstream closes and the buffer is fully drained, `on_eof` runs once — used
/// by OpenAI to defensively `finalize()` if the server didn't send `[DONE]`,
/// and a no-op for Anthropic. The `eof_dispatched` flag prevents the loop
/// from busy-spinning when the EOF handler doesn't flip the finished bit.
pub(super) struct SseStreamDriver<S, State> {
    upstream: Pin<Box<S>>,
    buf: BytesMut,
    queue: EventQueue,
    state: State,
    on_chunk: fn(&str, &mut State, &mut EventQueue),
    on_eof: fn(&mut State, &mut EventQueue),
    is_finished: fn(&State) -> bool,
    upstream_done: bool,
    eof_dispatched: bool,
}

impl<S, State> SseStreamDriver<S, State>
where
    S: Stream<Item = Result<Bytes, ProviderError>> + Send + 'static,
{
    pub(super) fn new(
        upstream: S,
        state: State,
        on_chunk: fn(&str, &mut State, &mut EventQueue),
        on_eof: fn(&mut State, &mut EventQueue),
        is_finished: fn(&State) -> bool,
    ) -> Self {
        Self {
            upstream: Box::pin(upstream),
            buf: BytesMut::new(),
            queue: VecDeque::new(),
            state,
            on_chunk,
            on_eof,
            is_finished,
            upstream_done: false,
            eof_dispatched: false,
        }
    }
}

impl<S, State> Stream for SseStreamDriver<S, State>
where
    S: Stream<Item = Result<Bytes, ProviderError>> + Send + 'static,
    State: Unpin,
{
    type Item = Result<ProviderEvent, ProviderError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(ev) = this.queue.pop_front() {
                return Poll::Ready(Some(ev));
            }
            if (this.is_finished)(&this.state) {
                return Poll::Ready(None);
            }
            if let Some((pos, term_len)) = find_event_end(&this.buf) {
                let raw = this.buf.split_to(pos + term_len);
                let chunk = String::from_utf8_lossy(&raw).to_string();
                (this.on_chunk)(&chunk, &mut this.state, &mut this.queue);
                continue;
            }
            if this.upstream_done {
                if !this.buf.is_empty() {
                    let chunk = String::from_utf8_lossy(&this.buf).to_string();
                    this.buf.clear();
                    (this.on_chunk)(&chunk, &mut this.state, &mut this.queue);
                    continue;
                }
                if !this.eof_dispatched {
                    this.eof_dispatched = true;
                    (this.on_eof)(&mut this.state, &mut this.queue);
                    continue;
                }
                return Poll::Ready(None);
            }
            match this.upstream.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => {
                    this.buf.extend_from_slice(&bytes);
                    continue;
                }
                Poll::Ready(Some(Err(e))) => {
                    return Poll::Ready(Some(Err(e)));
                }
                Poll::Ready(None) => {
                    this.upstream_done = true;
                    continue;
                }
                Poll::Pending => return Poll::Pending,
            }
        }
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
