//! Provider abstraction for streaming chat completions.

pub(crate) mod anthropic;
pub(crate) mod openai;

use crate::chat::config::{ChatRuntimeConfig, ProviderKind};
use crate::chat::message::{ContentBlock, Message, Usage};
use crate::chat::tools::ToolSchema;
use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures::stream::{BoxStream, Stream, StreamExt};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

/// One block of the system prompt. Multiple blocks let providers that support
/// prompt-caching (Anthropic) place a `cache_control: ephemeral` breakpoint
/// at the end of any block whose tail is stable across turns.
#[derive(Debug, Clone)]
pub(crate) struct SystemBlock {
    pub text: String,
    pub cache: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ChatRequest {
    pub model: String,
    pub system: Vec<SystemBlock>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSchema>,
    pub max_tokens: u32,
}

/// Streaming events emitted by a provider, normalized across vendors.
#[derive(Debug, Clone)]
pub(crate) enum ProviderEvent {
    /// Plain text delta from the assistant.
    TextDelta(String),
    /// A tool_use block has been opened. `input` is `null` until [`ToolUseEnd`].
    ToolUseStart { id: String, name: String },
    /// Final, fully-parsed tool input once the block closes.
    #[allow(dead_code)]
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
pub(crate) enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("api error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("decode error: {0}")]
    Decode(String),
}

#[async_trait]
pub(crate) trait Provider: Send + Sync {
    async fn stream(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ProviderEvent, ProviderError>>, ProviderError>;
}

/// Build a provider from resolved runtime config.
pub(crate) fn build(cfg: ChatRuntimeConfig) -> Arc<dyn Provider> {
    match cfg.provider {
        ProviderKind::Anthropic => Arc::new(anthropic::AnthropicProvider::new(cfg)),
        ProviderKind::OpenAI => Arc::new(openai::OpenAiProvider::new(cfg)),
    }
}

pub(super) type EventQueue = VecDeque<Result<ProviderEvent, ProviderError>>;

/// Process-wide HTTP client shared by all providers. `build()` runs once per
/// chat message, so a per-instance `reqwest::Client::new()` would discard the
/// connection pool (and its keep-alive TCP/TLS sessions) on every turn.
pub(super) fn http_client() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// Send a streaming request and hand back the response byte stream. Shared by
/// both providers, which only differ in URL, headers and body: scrubs
/// credentials from transport errors, turns a non-2xx response into
/// [`ProviderError::Api`] with a scrubbed body, and scrubs every downstream
/// chunk error as well.
pub(super) async fn send_sse(
    req: reqwest::RequestBuilder,
    api_key: &str,
) -> Result<impl Stream<Item = Result<Bytes, ProviderError>> + Send + 'static, ProviderError> {
    let resp = req
        .send()
        .await
        .map_err(|e| ProviderError::Network(scrub_credentials(&e.to_string(), api_key)))?;
    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let text = resp
            .text()
            .await
            .unwrap_or_else(|e| format!("<failed to read error body: {e}>"));
        return Err(ProviderError::Api {
            status: code,
            message: scrub_credentials(&text, api_key),
        });
    }
    let api_key = api_key.to_string();
    Ok(resp.bytes_stream().map(move |res| {
        res.map_err(|e| ProviderError::Network(scrub_credentials(&e.to_string(), &api_key)))
    }))
}

/// Strip credentials from a provider-error message before it crosses the
/// network boundary back to the browser. Two layers of defense:
///
/// 1. **Exact-match redaction** — substring-replace the live API key with
///    `[redacted]`. Zero false positives, perfectly safe for the actual key
///    that's in use.
/// 2. **Prefix-shape redaction** — mask tokens that *look* like credentials
///    (`sk-…`, `sk-ant-…`, Bearer values, header echoes) in case an upstream
///    leaks a stale or related credential we don't have the literal value
///    for.
///
/// Old behavior just truncated everything after the first `x-api-key` /
/// `Authorization` substring, which silently destroyed diagnostic info and
/// did nothing if the key showed up under any other shape.
pub(super) fn scrub_credentials(msg: &str, api_key: &str) -> String {
    let mut out = msg.to_string();
    if api_key.len() >= 8 {
        out = out.replace(api_key, "[redacted]");
    }
    mask_credential_shapes(&out)
}

fn mask_credential_shapes(s: &str) -> String {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Order matters: the header-echo alternative is greedier (it eats
        // any value tokens following `Authorization:` up to end-of-line) so
        // listing it first stops the bearer-token alternative from leaving
        // the actual key behind.
        regex::Regex::new(
            r"(?ix)
              ( (?:x-api-key|authorization)\s*[:=]\s*[^\r\n,;]+
              | bearer\s+[A-Za-z0-9_\-\.=]{16,}
              | sk-ant-[A-Za-z0-9_\-]{8,}
              | sk-[A-Za-z0-9_\-]{16,}
              )",
        )
        .expect("scrub regex must compile")
    });
    re.replace_all(s, "[redacted]").into_owned()
}

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

/// Split one SSE event chunk into its `event:` name (if any) and the joined
/// `data:` payload. Handles `\r` line endings, skips blank/comment lines, and
/// strips the optional single space after the field colon (per the SSE spec
/// it is part of the field separator). Anthropic uses the event name; OpenAI
/// ignores it.
pub(super) fn parse_sse_fields(chunk: &str) -> (Option<String>, String) {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for line in chunk.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event_name = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    (event_name, data_lines.join("\n"))
}

/// Parse a streamed tool-input buffer into JSON, falling back to an empty
/// object when the buffer is blank (blank is not valid JSON, so the
/// parse-failure fallback covers it) or malformed.
pub(super) fn parse_tool_input(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()))
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

#[cfg(test)]
mod scrub_tests {
    use super::scrub_credentials;

    #[test]
    fn redacts_exact_key_anywhere_in_message() {
        let msg = "request failed: x-api-key was sk-ant-api03-EXAMPLEKEY123, please retry";
        let out = scrub_credentials(msg, "sk-ant-api03-EXAMPLEKEY123");
        assert!(!out.contains("sk-ant-api03-EXAMPLEKEY123"));
        assert!(out.contains("[redacted]"));
        assert!(out.contains("please retry"));
    }

    #[test]
    fn redacts_bearer_token_shape() {
        let msg = "upstream said: Authorization: Bearer abcdefghijklmnop1234";
        let out = scrub_credentials(msg, "different-key");
        assert!(!out.contains("abcdefghijklmnop1234"));
    }

    #[test]
    fn redacts_unknown_sk_prefix() {
        let msg = "leaked sk-proj-AAAA1111BBBB2222 in body";
        let out = scrub_credentials(msg, "");
        assert!(!out.contains("sk-proj-AAAA1111BBBB2222"));
    }

    #[test]
    fn empty_api_key_does_not_panic_or_overmatch() {
        let msg = "hello world";
        assert_eq!(scrub_credentials(msg, ""), "hello world");
    }

    #[test]
    fn short_api_key_is_ignored_to_avoid_collisions() {
        let msg = "abc happens in many words";
        assert_eq!(scrub_credentials(msg, "abc"), "abc happens in many words");
    }
}
