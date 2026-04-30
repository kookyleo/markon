//! Anthropic Messages API provider with streaming + prompt cache.
//!
//! Uses `reqwest` (with the `stream` feature) to issue a streaming
//! `POST /v1/messages` call, parses the SSE event stream, and emits normalized
//! [`ProviderEvent`]s. Applies `cache_control: { type: "ephemeral" }` to every
//! [`SystemBlock`] whose `cache: true`, and to the last tool definition iff
//! the system has at least one cached block — that is the Anthropic recipe
//! for caching the (system + tools) prefix together.

use super::{ChatRequest, Provider, ProviderError, ProviderEvent, SystemBlock};
use crate::chat::config::{ChatRuntimeConfig, ProviderKind};
use crate::chat::message::{ContentBlock, Usage};
use crate::chat::tools::ToolSchema;
use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures::stream::{BoxStream, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::task::{Context, Poll};

pub struct AnthropicProvider {
    cfg: ChatRuntimeConfig,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(cfg: ChatRuntimeConfig) -> Self {
        Self {
            cfg,
            client: reqwest::Client::new(),
        }
    }

    pub fn base_url(&self) -> &str {
        if self.cfg.base_url.is_empty() {
            "https://api.anthropic.com"
        } else {
            self.cfg.base_url.as_str()
        }
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    async fn stream(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ProviderEvent, ProviderError>>, ProviderError> {
        let url = format!("{}/v1/messages", self.base_url().trim_end_matches('/'));
        let body = build_body(&request);
        let resp = self
            .client
            .post(&url)
            .header("x-api-key", &self.cfg.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "prompt-caching-2024-07-31")
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|e| ProviderError::Network(scrub(&e.to_string())))?;

        let status = resp.status();
        if !status.is_success() {
            let code = status.as_u16();
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<failed to read error body: {e}>"));
            return Err(ProviderError::Api {
                status: code,
                message: scrub(&text),
            });
        }

        let byte_stream = resp
            .bytes_stream()
            .map(|res| res.map_err(|e| ProviderError::Network(scrub(&e.to_string()))));
        Ok(parse_anthropic_stream(byte_stream).boxed())
    }
}

fn build_body(req: &ChatRequest) -> Value {
    let system_arr: Vec<Value> = req
        .system
        .iter()
        .map(|b: &SystemBlock| {
            if b.cache {
                json!({
                    "type": "text",
                    "text": b.text,
                    "cache_control": { "type": "ephemeral" }
                })
            } else {
                json!({ "type": "text", "text": b.text })
            }
        })
        .collect();

    let any_cached = req.system.iter().any(|b| b.cache);
    let mut tools_arr: Vec<Value> = req
        .tools
        .iter()
        .map(|t: &ToolSchema| {
            json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            })
        })
        .collect();
    if any_cached {
        if let Some(last) = tools_arr.last_mut() {
            if let Some(obj) = last.as_object_mut() {
                obj.insert(
                    "cache_control".to_string(),
                    json!({ "type": "ephemeral" }),
                );
            }
        }
    }

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "messages": req.messages,
    });
    if !system_arr.is_empty() {
        body["system"] = Value::Array(system_arr);
    }
    if !tools_arr.is_empty() {
        body["tools"] = Value::Array(tools_arr);
    }
    body
}

/// Defense-in-depth: never let credentials slip into a user-visible error.
/// The runtime layer already validates the key, so we only mask any header
/// echo that an upstream might surface.
fn scrub(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(idx) = out.find("x-api-key") {
        out.truncate(idx);
        out.push_str("[redacted]");
    }
    out
}

// ---- SSE parsing -----------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct AnthroUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    cache_creation_input_tokens: u32,
    #[serde(default)]
    cache_read_input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct MessageStartPayload {
    #[serde(default)]
    message: MessageStartInner,
}

#[derive(Debug, Default, Deserialize)]
struct MessageStartInner {
    #[serde(default)]
    usage: AnthroUsage,
}

#[derive(Debug, Deserialize)]
struct ContentBlockStartPayload {
    index: usize,
    content_block: ContentBlockStartInner,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlockStartInner {
    Text {
        #[serde(default)]
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct ContentBlockDeltaPayload {
    index: usize,
    delta: BlockDelta,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BlockDelta {
    TextDelta {
        #[serde(default)]
        text: String,
    },
    InputJsonDelta {
        #[serde(default)]
        partial_json: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct ContentBlockStopPayload {
    index: usize,
}

#[derive(Debug, Deserialize)]
struct MessageDeltaPayload {
    #[serde(default)]
    delta: MessageDeltaInner,
    #[serde(default)]
    usage: AnthroUsage,
}

#[derive(Debug, Default, Deserialize)]
struct MessageDeltaInner {
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorPayload {
    #[serde(default)]
    error: ErrorInner,
}

#[derive(Debug, Default, Deserialize)]
struct ErrorInner {
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    message: String,
}

/// In-flight state for a single content block, keyed by `index`.
enum BlockState {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        /// While streaming this is the raw partial-json buffer. After the
        /// block stops we replace it with the parsed JSON's stringified form
        /// so `assemble_content` can rebuild the final ContentBlock.
        buffer: String,
        finalized: bool,
    },
}

struct ParserState {
    blocks: HashMap<usize, BlockState>,
    order: Vec<usize>,
    usage: Usage,
    stop_reason: Option<String>,
    finished: bool,
}

impl ParserState {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
            order: Vec::new(),
            usage: Usage::default(),
            stop_reason: None,
            finished: false,
        }
    }

    fn assemble_content(&self) -> Vec<ContentBlock> {
        let mut out = Vec::with_capacity(self.order.len());
        for idx in &self.order {
            if let Some(block) = self.blocks.get(idx) {
                match block {
                    BlockState::Text(text) => out.push(ContentBlock::Text {
                        text: text.clone(),
                    }),
                    BlockState::ToolUse {
                        id,
                        name,
                        buffer,
                        finalized,
                    } => {
                        let input = if *finalized {
                            serde_json::from_str::<Value>(buffer)
                                .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                        } else if buffer.trim().is_empty() {
                            Value::Object(serde_json::Map::new())
                        } else {
                            serde_json::from_str::<Value>(buffer)
                                .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                        };
                        out.push(ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input,
                        });
                    }
                }
            }
        }
        out
    }
}

fn merge_usage(target: &mut Usage, src: &AnthroUsage) {
    // Anthropic only sends a field when it changed; keep prior value otherwise.
    if src.input_tokens > 0 {
        target.input_tokens = src.input_tokens;
    }
    if src.cache_creation_input_tokens > 0 {
        target.cache_creation_input_tokens = src.cache_creation_input_tokens;
    }
    if src.cache_read_input_tokens > 0 {
        target.cache_read_input_tokens = src.cache_read_input_tokens;
    }
    if src.output_tokens > 0 {
        target.output_tokens = src.output_tokens;
    }
}

fn handle_sse_chunk(
    chunk: &str,
    state: &mut ParserState,
    queue: &mut VecDeque<Result<ProviderEvent, ProviderError>>,
) {
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
            // SSE: leading single space after the colon is part of the field
            // separator and should be stripped.
            let trimmed = rest.strip_prefix(' ').unwrap_or(rest);
            data_lines.push(trimmed);
        }
    }
    let data = data_lines.join("\n");
    let Some(name) = event_name else {
        return;
    };
    if data.is_empty() && name != "ping" {
        return;
    }
    handle_event(&name, &data, state, queue);
}

fn handle_event(
    name: &str,
    data: &str,
    state: &mut ParserState,
    queue: &mut VecDeque<Result<ProviderEvent, ProviderError>>,
) {
    match name {
        "ping" => {}
        "message_start" => {
            if let Ok(p) = serde_json::from_str::<MessageStartPayload>(data) {
                merge_usage(&mut state.usage, &p.message.usage);
            }
        }
        "content_block_start" => match serde_json::from_str::<ContentBlockStartPayload>(data) {
            Ok(p) => {
                state.order.push(p.index);
                match p.content_block {
                    ContentBlockStartInner::Text { text } => {
                        state.blocks.insert(p.index, BlockState::Text(text));
                    }
                    ContentBlockStartInner::ToolUse { id, name } => {
                        state.blocks.insert(
                            p.index,
                            BlockState::ToolUse {
                                id: id.clone(),
                                name: name.clone(),
                                buffer: String::new(),
                                finalized: false,
                            },
                        );
                        queue.push_back(Ok(ProviderEvent::ToolUseStart { id, name }));
                    }
                    ContentBlockStartInner::Other => {
                        // Forward-compat: keep the index slot in `order` so
                        // assemble_content stays in source order even if we
                        // can't represent the block.
                    }
                }
            }
            Err(e) => {
                queue.push_back(Err(ProviderError::Decode(format!(
                    "content_block_start: {e}"
                ))));
            }
        },
        "content_block_delta" => match serde_json::from_str::<ContentBlockDeltaPayload>(data) {
            Ok(p) => match (state.blocks.get_mut(&p.index), p.delta) {
                (Some(BlockState::Text(t)), BlockDelta::TextDelta { text }) => {
                    t.push_str(&text);
                    queue.push_back(Ok(ProviderEvent::TextDelta(text)));
                }
                (
                    Some(BlockState::ToolUse { buffer, .. }),
                    BlockDelta::InputJsonDelta { partial_json },
                ) => {
                    buffer.push_str(&partial_json);
                }
                _ => {}
            },
            Err(e) => {
                queue.push_back(Err(ProviderError::Decode(format!(
                    "content_block_delta: {e}"
                ))));
            }
        },
        "content_block_stop" => match serde_json::from_str::<ContentBlockStopPayload>(data) {
            Ok(p) => {
                let mut emit: Option<(String, String, Value)> = None;
                if let Some(BlockState::ToolUse {
                    id,
                    name,
                    buffer,
                    finalized,
                }) = state.blocks.get_mut(&p.index)
                {
                    let input: Value = if buffer.trim().is_empty() {
                        Value::Object(serde_json::Map::new())
                    } else {
                        serde_json::from_str::<Value>(buffer)
                            .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
                    };
                    *buffer = input.to_string();
                    *finalized = true;
                    emit = Some((id.clone(), name.clone(), input));
                }
                if let Some((id, name, input)) = emit {
                    queue.push_back(Ok(ProviderEvent::ToolUseEnd { id, name, input }));
                }
            }
            Err(e) => {
                queue.push_back(Err(ProviderError::Decode(format!(
                    "content_block_stop: {e}"
                ))));
            }
        },
        "message_delta" => match serde_json::from_str::<MessageDeltaPayload>(data) {
            Ok(p) => {
                if let Some(sr) = p.delta.stop_reason {
                    state.stop_reason = Some(sr);
                }
                merge_usage(&mut state.usage, &p.usage);
            }
            Err(e) => {
                queue.push_back(Err(ProviderError::Decode(format!("message_delta: {e}"))));
            }
        },
        "message_stop" => {
            let content = state.assemble_content();
            let stop_reason = state
                .stop_reason
                .clone()
                .unwrap_or_else(|| "end_turn".to_string());
            queue.push_back(Ok(ProviderEvent::MessageEnd {
                stop_reason,
                usage: state.usage.clone(),
                content,
            }));
            state.finished = true;
        }
        "error" => match serde_json::from_str::<ErrorPayload>(data) {
            Ok(p) => {
                let status = p
                    .error
                    .kind
                    .as_deref()
                    .and_then(http_status_from_kind)
                    .unwrap_or(500);
                queue.push_back(Err(ProviderError::Api {
                    status,
                    message: p.error.message,
                }));
                state.finished = true;
            }
            Err(e) => {
                queue.push_back(Err(ProviderError::Decode(format!("error event: {e}"))));
                state.finished = true;
            }
        },
        _ => {
            // Unknown event — ignore for forward-compatibility.
        }
    }
}

fn http_status_from_kind(kind: &str) -> Option<u16> {
    match kind {
        "invalid_request_error" => Some(400),
        "authentication_error" => Some(401),
        "permission_error" => Some(403),
        "not_found_error" => Some(404),
        "rate_limit_error" => Some(429),
        "api_error" => Some(500),
        "overloaded_error" => Some(529),
        _ => None,
    }
}

/// Parse a raw byte stream of Anthropic SSE events into a stream of
/// normalized [`ProviderEvent`]s. Public to the crate so tests can drive it
/// without spinning a real HTTP server.
pub(crate) fn parse_anthropic_stream<S>(
    byte_stream: S,
) -> impl Stream<Item = Result<ProviderEvent, ProviderError>> + Send + 'static
where
    S: Stream<Item = Result<Bytes, ProviderError>> + Send + 'static,
{
    AnthropicSseStream {
        upstream: Box::pin(byte_stream),
        buf: BytesMut::new(),
        queue: VecDeque::new(),
        state: ParserState::new(),
        upstream_done: false,
    }
}

struct AnthropicSseStream<S> {
    upstream: Pin<Box<S>>,
    buf: BytesMut,
    queue: VecDeque<Result<ProviderEvent, ProviderError>>,
    state: ParserState,
    upstream_done: bool,
}

impl<S> Stream for AnthropicSseStream<S>
where
    S: Stream<Item = Result<Bytes, ProviderError>> + Send + 'static,
{
    type Item = Result<ProviderEvent, ProviderError>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(ev) = this.queue.pop_front() {
                return Poll::Ready(Some(ev));
            }
            if this.state.finished {
                return Poll::Ready(None);
            }
            if let Some((pos, term_len)) = super::find_event_end(&this.buf) {
                let raw = this.buf.split_to(pos + term_len);
                let chunk = String::from_utf8_lossy(&raw).to_string();
                handle_sse_chunk(&chunk, &mut this.state, &mut this.queue);
                continue;
            }
            if this.upstream_done {
                if !this.buf.is_empty() {
                    let chunk = String::from_utf8_lossy(&this.buf).to_string();
                    this.buf.clear();
                    handle_sse_chunk(&chunk, &mut this.state, &mut this.queue);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::message::{Message, Role};
    use bytes::Bytes;
    use futures::stream;

    fn drive(raw: &'static str) -> Vec<Result<ProviderEvent, ProviderError>> {
        let s = stream::once(async move {
            Ok::<_, ProviderError>(Bytes::from_static(raw.as_bytes()))
        });
        let mut parsed = parse_anthropic_stream(s);
        let mut events = Vec::new();
        // Tests run on the tokio runtime via `#[tokio::test]`.
        futures::executor::block_on(async {
            while let Some(ev) = parsed.next().await {
                events.push(ev);
            }
        });
        events
    }

    #[test]
    fn parses_text_and_tool_use_stream() {
        let raw = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu_1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a.txt\\\"}\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":42}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let events: Vec<_> = drive(raw).into_iter().map(|r| r.unwrap()).collect();
        let mut deltas = Vec::new();
        let mut tool_start = None;
        let mut tool_end = None;
        let mut end = None;
        for ev in events {
            match ev {
                ProviderEvent::TextDelta(t) => deltas.push(t),
                ProviderEvent::ToolUseStart { id, name } => tool_start = Some((id, name)),
                ProviderEvent::ToolUseEnd { id, name, input } => {
                    tool_end = Some((id, name, input))
                }
                ProviderEvent::MessageEnd {
                    stop_reason,
                    usage,
                    content,
                } => end = Some((stop_reason, usage, content)),
            }
        }
        assert_eq!(deltas, vec!["Hello".to_string(), " world".to_string()]);
        assert_eq!(tool_start.as_ref().unwrap().0, "tu_1");
        assert_eq!(tool_start.unwrap().1, "read_file");
        let (tid, tname, tinput) = tool_end.unwrap();
        assert_eq!(tid, "tu_1");
        assert_eq!(tname, "read_file");
        assert_eq!(tinput.get("path").and_then(|v| v.as_str()), Some("a.txt"));
        let (stop_reason, usage, content) = end.unwrap();
        assert_eq!(stop_reason, "tool_use");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 42);
        assert_eq!(content.len(), 2);
        match &content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello world"),
            _ => panic!("expected text"),
        }
        match &content[1] {
            ContentBlock::ToolUse { input, .. } => {
                assert_eq!(input.get("path").and_then(|v| v.as_str()), Some("a.txt"));
            }
            _ => panic!("expected tool_use"),
        }
    }

    #[test]
    fn empty_tool_input_becomes_empty_object() {
        let raw = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"x\",\"name\":\"noop\",\"input\":{}}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let events: Vec<_> = drive(raw).into_iter().map(|r| r.unwrap()).collect();
        let mut saw = false;
        for ev in events {
            if let ProviderEvent::ToolUseEnd { input, .. } = ev {
                assert!(input.is_object());
                assert_eq!(input.as_object().unwrap().len(), 0);
                saw = true;
            }
        }
        assert!(saw, "expected ToolUseEnd with empty object input");
    }

    #[test]
    fn malformed_data_yields_decode_error() {
        let raw = "event: content_block_start\ndata: {not json\n\n";
        let events = drive(raw);
        assert!(events
            .iter()
            .any(|e| matches!(e, Err(ProviderError::Decode(_)))));
    }

    #[test]
    fn error_event_maps_status() {
        let raw = concat!(
            "event: error\n",
            "data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}\n\n",
        );
        let events = drive(raw);
        assert!(events.iter().any(|e| matches!(
            e,
            Err(ProviderError::Api { status: 429, .. })
        )));
    }

    #[test]
    fn build_body_applies_cache_breakpoints() {
        let req = ChatRequest {
            model: "claude".into(),
            system: vec![
                SystemBlock {
                    text: "a".into(),
                    cache: false,
                },
                SystemBlock {
                    text: "b".into(),
                    cache: true,
                },
            ],
            messages: vec![Message {
                role: Role::User,
                content: vec![ContentBlock::Text { text: "hi".into() }],
            }],
            tools: vec![
                ToolSchema {
                    name: "t1".into(),
                    description: "d".into(),
                    input_schema: serde_json::json!({"type":"object"}),
                },
                ToolSchema {
                    name: "t2".into(),
                    description: "d".into(),
                    input_schema: serde_json::json!({"type":"object"}),
                },
            ],
            max_tokens: 8,
        };
        let body = build_body(&req);
        let sys = body["system"].as_array().unwrap();
        assert!(sys[0].get("cache_control").is_none());
        assert_eq!(sys[1]["cache_control"]["type"], "ephemeral");
        let tools = body["tools"].as_array().unwrap();
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"]["type"], "ephemeral");
        assert_eq!(body["stream"], serde_json::Value::Bool(true));
    }

    #[test]
    fn build_body_skips_tool_cache_without_system_breakpoint() {
        let req = ChatRequest {
            model: "claude".into(),
            system: vec![SystemBlock {
                text: "a".into(),
                cache: false,
            }],
            messages: vec![],
            tools: vec![ToolSchema {
                name: "t1".into(),
                description: "d".into(),
                input_schema: serde_json::json!({}),
            }],
            max_tokens: 1,
        };
        let body = build_body(&req);
        assert!(body["tools"][0].get("cache_control").is_none());
    }

    #[test]
    fn handles_split_chunks_across_events() {
        // Same as the simple text case but split mid-event to exercise buffering.
        let part1 = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text";
        let part2 = b"\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let s = stream::iter(vec![
            Ok::<_, ProviderError>(Bytes::from_static(part1)),
            Ok::<_, ProviderError>(Bytes::from_static(part2)),
        ]);
        let mut parsed = parse_anthropic_stream(s);
        let events: Vec<_> = futures::executor::block_on(async {
            let mut out = Vec::new();
            while let Some(e) = parsed.next().await {
                out.push(e.unwrap());
            }
            out
        });
        let mut text = String::new();
        for e in events {
            if let ProviderEvent::TextDelta(t) = e {
                text.push_str(&t);
            }
        }
        assert_eq!(text, "hi");
    }
}
