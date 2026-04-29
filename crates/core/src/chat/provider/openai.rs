//! OpenAI Chat Completions provider (streaming, function calling).
//!
//! Issues `POST /v1/chat/completions` with `stream: true`, parses the
//! `data: {...}` SSE chunks, and emits normalized [`ProviderEvent`]s. Our
//! Anthropic-shaped [`Message`]/[`ContentBlock`] model is translated to
//! OpenAI's role/tool_calls layout on the way out. OpenAI does not support
//! prompt caching, so [`SystemBlock::cache`] is ignored — all system blocks
//! are concatenated into a single `system` message.

use super::{ChatRequest, Provider, ProviderError, ProviderEvent};
use crate::chat::config::{ChatRuntimeConfig, ProviderKind};
use crate::chat::message::{ContentBlock, Message, Role, Usage};
use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures::stream::{BoxStream, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::task::{Context, Poll};

pub struct OpenAiProvider {
    cfg: ChatRuntimeConfig,
}

impl OpenAiProvider {
    pub fn new(cfg: ChatRuntimeConfig) -> Self {
        Self { cfg }
    }

    pub fn base_url(&self) -> &str {
        if self.cfg.base_url.is_empty() {
            "https://api.openai.com"
        } else {
            self.cfg.base_url.as_str()
        }
    }
}

#[async_trait]
impl Provider for OpenAiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAI
    }

    async fn stream(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ProviderEvent, ProviderError>>, ProviderError> {
        let url = format!(
            "{}/v1/chat/completions",
            self.base_url().trim_end_matches('/')
        );
        let body = build_body(&request);
        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .bearer_auth(&self.cfg.api_key)
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
        Ok(parse_openai_stream(byte_stream).boxed())
    }
}

fn scrub(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(idx) = out.find("Authorization") {
        out.truncate(idx);
        out.push_str("[redacted]");
    }
    out
}

// ---- Request body construction --------------------------------------------

fn build_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if !req.system.is_empty() {
        let merged = req
            .system
            .iter()
            .map(|b| b.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !merged.is_empty() {
            messages.push(json!({ "role": "system", "content": merged }));
        }
    }
    for m in &req.messages {
        translate_message(m, &mut messages);
    }

    let tools: Vec<Value> = req
        .tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                }
            })
        })
        .collect();

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = Value::String("auto".to_string());
    }
    body
}

fn translate_message(m: &Message, out: &mut Vec<Value>) {
    match m.role {
        Role::User => {
            // tool_results become individual `role: tool` messages, plain text
            // collapses into a single user message.
            let mut user_text = String::new();
            for block in &m.content {
                match block {
                    ContentBlock::Text { text } => {
                        if !user_text.is_empty() {
                            user_text.push('\n');
                        }
                        user_text.push_str(text);
                    }
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => {
                        // Flush any accumulated user text before the tool
                        // results so ordering is preserved.
                        if !user_text.is_empty() {
                            out.push(json!({ "role": "user", "content": user_text.clone() }));
                            user_text.clear();
                        }
                        let body = if *is_error {
                            format!("[error] {content}")
                        } else {
                            content.clone()
                        };
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": body,
                        }));
                    }
                    ContentBlock::ToolUse { .. } => {
                        // Not legal on a user turn; ignore.
                    }
                }
            }
            if !user_text.is_empty() {
                out.push(json!({ "role": "user", "content": user_text }));
            }
        }
        Role::Assistant => {
            let mut text = String::new();
            let mut tool_calls: Vec<Value> = Vec::new();
            for block in &m.content {
                match block {
                    ContentBlock::Text { text: t } => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                    ContentBlock::ToolUse { id, name, input } => {
                        tool_calls.push(json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": serde_json::to_string(input)
                                    .unwrap_or_else(|_| "{}".to_string()),
                            }
                        }));
                    }
                    ContentBlock::ToolResult { .. } => {
                        // Not legal on an assistant turn; ignore.
                    }
                }
            }
            let mut msg = serde_json::Map::new();
            msg.insert("role".into(), Value::String("assistant".into()));
            if !text.is_empty() {
                msg.insert("content".into(), Value::String(text));
            } else if tool_calls.is_empty() {
                // OpenAI rejects assistant messages without content; emit empty
                // string to be safe.
                msg.insert("content".into(), Value::String(String::new()));
            } else {
                msg.insert("content".into(), Value::Null);
            }
            if !tool_calls.is_empty() {
                msg.insert("tool_calls".into(), Value::Array(tool_calls));
            }
            out.push(Value::Object(msg));
        }
    }
}

// ---- SSE parsing -----------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ChunkEnvelope {
    #[serde(default)]
    choices: Vec<ChoiceDelta>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChoiceDelta {
    #[serde(default)]
    delta: DeltaInner,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct DeltaInner {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDelta {
    /// OpenAI streams use `index` to disambiguate concurrent tool calls; the
    /// id and name only appear on the first chunk for each index.
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "type")]
    _kind: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
}

struct ToolBuf {
    id: String,
    name: String,
    args: String,
    started: bool,
    finalized: bool,
}

struct OpenAiState {
    text: String,
    tools: BTreeMap<usize, ToolBuf>,
    usage: Usage,
    finish_reason: Option<String>,
    finished: bool,
}

impl OpenAiState {
    fn new() -> Self {
        Self {
            text: String::new(),
            tools: BTreeMap::new(),
            usage: Usage::default(),
            finish_reason: None,
            finished: false,
        }
    }

    fn assemble_content(&self) -> Vec<ContentBlock> {
        let mut out = Vec::new();
        if !self.text.is_empty() {
            out.push(ContentBlock::Text {
                text: self.text.clone(),
            });
        }
        for tool in self.tools.values() {
            let input = if tool.args.trim().is_empty() {
                Value::Object(serde_json::Map::new())
            } else {
                serde_json::from_str::<Value>(&tool.args)
                    .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
            };
            out.push(ContentBlock::ToolUse {
                id: tool.id.clone(),
                name: tool.name.clone(),
                input,
            });
        }
        out
    }
}

fn map_finish_reason(r: &str) -> String {
    match r {
        "tool_calls" => "tool_use".to_string(),
        "stop" => "end_turn".to_string(),
        other => other.to_string(),
    }
}

/// Find the first SSE event terminator (`\n\n` or `\r\n\r\n`).
fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
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

fn handle_chunk(
    chunk: &str,
    state: &mut OpenAiState,
    queue: &mut VecDeque<Result<ProviderEvent, ProviderError>>,
) {
    let mut data_lines: Vec<&str> = Vec::new();
    for line in chunk.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            let trimmed = rest.strip_prefix(' ').unwrap_or(rest);
            data_lines.push(trimmed);
        }
        // OpenAI doesn't use `event:` lines; ignore other fields.
    }
    let data = data_lines.join("\n");
    if data.is_empty() {
        return;
    }
    if data == "[DONE]" {
        finalize(state, queue);
        return;
    }
    match serde_json::from_str::<ChunkEnvelope>(&data) {
        Ok(env) => apply_envelope(env, state, queue),
        Err(e) => {
            queue.push_back(Err(ProviderError::Decode(format!("chunk: {e}"))));
        }
    }
}

fn apply_envelope(
    env: ChunkEnvelope,
    state: &mut OpenAiState,
    queue: &mut VecDeque<Result<ProviderEvent, ProviderError>>,
) {
    if let Some(u) = env.usage {
        state.usage.input_tokens = u.prompt_tokens;
        state.usage.output_tokens = u.completion_tokens;
    }
    for choice in env.choices {
        if let Some(text) = choice.delta.content {
            if !text.is_empty() {
                state.text.push_str(&text);
                queue.push_back(Ok(ProviderEvent::TextDelta(text)));
            }
        }
        if let Some(tool_calls) = choice.delta.tool_calls {
            for tc in tool_calls {
                let entry = state.tools.entry(tc.index).or_insert_with(|| ToolBuf {
                    id: String::new(),
                    name: String::new(),
                    args: String::new(),
                    started: false,
                    finalized: false,
                });
                if let Some(id) = tc.id {
                    if !id.is_empty() {
                        entry.id = id;
                    }
                }
                if let Some(func) = tc.function {
                    if let Some(name) = func.name {
                        if !name.is_empty() {
                            entry.name = name;
                        }
                    }
                    if let Some(args) = func.arguments {
                        entry.args.push_str(&args);
                    }
                }
                if !entry.started && !entry.id.is_empty() && !entry.name.is_empty() {
                    entry.started = true;
                    queue.push_back(Ok(ProviderEvent::ToolUseStart {
                        id: entry.id.clone(),
                        name: entry.name.clone(),
                    }));
                }
            }
        }
        if let Some(reason) = choice.finish_reason {
            state.finish_reason = Some(reason);
        }
    }
}

fn finalize(
    state: &mut OpenAiState,
    queue: &mut VecDeque<Result<ProviderEvent, ProviderError>>,
) {
    if state.finished {
        return;
    }
    // Emit ToolUseEnd for any tool that was started but not yet finalized.
    for tool in state.tools.values_mut() {
        if !tool.started || tool.finalized {
            continue;
        }
        let input = if tool.args.trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_str::<Value>(&tool.args)
                .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
        };
        tool.finalized = true;
        queue.push_back(Ok(ProviderEvent::ToolUseEnd {
            id: tool.id.clone(),
            name: tool.name.clone(),
            input,
        }));
    }
    let stop_reason = state
        .finish_reason
        .clone()
        .map(|r| map_finish_reason(&r))
        .unwrap_or_else(|| "end_turn".to_string());
    queue.push_back(Ok(ProviderEvent::MessageEnd {
        stop_reason,
        usage: state.usage.clone(),
        content: state.assemble_content(),
    }));
    state.finished = true;
}

/// Parse a raw byte stream of OpenAI SSE chunks into [`ProviderEvent`]s.
pub(crate) fn parse_openai_stream<S>(
    byte_stream: S,
) -> impl Stream<Item = Result<ProviderEvent, ProviderError>> + Send + 'static
where
    S: Stream<Item = Result<Bytes, ProviderError>> + Send + 'static,
{
    OpenAiSseStream {
        upstream: Box::pin(byte_stream),
        buf: BytesMut::new(),
        queue: VecDeque::new(),
        state: OpenAiState::new(),
        upstream_done: false,
    }
}

struct OpenAiSseStream<S> {
    upstream: Pin<Box<S>>,
    buf: BytesMut,
    queue: VecDeque<Result<ProviderEvent, ProviderError>>,
    state: OpenAiState,
    upstream_done: bool,
}

impl<S> Stream for OpenAiSseStream<S>
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
            if let Some((pos, term_len)) = find_event_end(&this.buf) {
                let raw = this.buf.split_to(pos + term_len);
                let chunk = String::from_utf8_lossy(&raw).to_string();
                handle_chunk(&chunk, &mut this.state, &mut this.queue);
                continue;
            }
            if this.upstream_done {
                if !this.buf.is_empty() {
                    let chunk = String::from_utf8_lossy(&this.buf).to_string();
                    this.buf.clear();
                    handle_chunk(&chunk, &mut this.state, &mut this.queue);
                    continue;
                }
                // Upstream closed without [DONE] — emit MessageEnd defensively.
                if !this.state.finished {
                    finalize(&mut this.state, &mut this.queue);
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
    use crate::chat::provider::SystemBlock;
    use crate::chat::tools::ToolSchema;
    use bytes::Bytes;
    use futures::stream;

    fn drive_static(raw: &'static str) -> Vec<Result<ProviderEvent, ProviderError>> {
        let s = stream::once(async move {
            Ok::<_, ProviderError>(Bytes::from_static(raw.as_bytes()))
        });
        let mut parsed = parse_openai_stream(s);
        futures::executor::block_on(async {
            let mut out = Vec::new();
            while let Some(ev) = parsed.next().await {
                out.push(ev);
            }
            out
        })
    }

    #[test]
    fn parses_text_only_completion() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );
        let events: Vec<_> = drive_static(raw).into_iter().map(|r| r.unwrap()).collect();
        let mut text = String::new();
        let mut end = None;
        for ev in events {
            match ev {
                ProviderEvent::TextDelta(t) => text.push_str(&t),
                ProviderEvent::MessageEnd {
                    stop_reason,
                    usage,
                    content,
                } => end = Some((stop_reason, usage, content)),
                _ => {}
            }
        }
        assert_eq!(text, "Hello");
        let (stop_reason, usage, content) = end.unwrap();
        assert_eq!(stop_reason, "end_turn");
        assert_eq!(usage.input_tokens, 3);
        assert_eq!(usage.output_tokens, 2);
        assert_eq!(content.len(), 1);
    }

    #[test]
    fn parses_tool_call_completion() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":7}}\n\n",
            "data: [DONE]\n\n",
        );
        let events: Vec<_> = drive_static(raw).into_iter().map(|r| r.unwrap()).collect();
        let mut start = None;
        let mut end = None;
        let mut msg_end = None;
        for ev in events {
            match ev {
                ProviderEvent::ToolUseStart { id, name } => start = Some((id, name)),
                ProviderEvent::ToolUseEnd { id, name, input } => end = Some((id, name, input)),
                ProviderEvent::MessageEnd {
                    stop_reason,
                    usage,
                    content,
                } => msg_end = Some((stop_reason, usage, content)),
                _ => {}
            }
        }
        let (sid, sname) = start.expect("ToolUseStart");
        assert_eq!(sid, "call_1");
        assert_eq!(sname, "read_file");
        let (eid, ename, input) = end.expect("ToolUseEnd");
        assert_eq!(eid, "call_1");
        assert_eq!(ename, "read_file");
        assert_eq!(input.get("path").and_then(|v| v.as_str()), Some("a.txt"));
        let (stop_reason, usage, content) = msg_end.unwrap();
        assert_eq!(stop_reason, "tool_use");
        assert_eq!(usage.input_tokens, 5);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(content.len(), 1);
        match &content[0] {
            ContentBlock::ToolUse { input, .. } => {
                assert_eq!(input.get("path").and_then(|v| v.as_str()), Some("a.txt"));
            }
            _ => panic!("expected tool_use content"),
        }
    }

    #[test]
    fn handles_missing_usage_chunk() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let events: Vec<_> = drive_static(raw).into_iter().map(|r| r.unwrap()).collect();
        let end = events
            .iter()
            .find_map(|e| match e {
                ProviderEvent::MessageEnd { usage, .. } => Some(usage.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(end.input_tokens, 0);
        assert_eq!(end.output_tokens, 0);
    }

    #[test]
    fn malformed_chunk_yields_decode_error() {
        let raw = "data: {not json\n\n";
        let events = drive_static(raw);
        assert!(events
            .iter()
            .any(|e| matches!(e, Err(ProviderError::Decode(_)))));
    }

    #[test]
    fn empty_tool_arguments_become_empty_object() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"type\":\"function\",\"function\":{\"name\":\"noop\",\"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let events: Vec<_> = drive_static(raw).into_iter().map(|r| r.unwrap()).collect();
        let mut found = false;
        for ev in events {
            if let ProviderEvent::ToolUseEnd { input, .. } = ev {
                assert!(input.is_object());
                assert_eq!(input.as_object().unwrap().len(), 0);
                found = true;
            }
        }
        assert!(found);
    }

    #[test]
    fn build_body_translates_messages_and_ignores_cache() {
        let req = ChatRequest {
            model: "gpt".into(),
            system: vec![
                SystemBlock {
                    text: "rule one".into(),
                    cache: true,
                },
                SystemBlock {
                    text: "rule two".into(),
                    cache: false,
                },
            ],
            messages: vec![
                Message {
                    role: Role::User,
                    content: vec![ContentBlock::Text { text: "hi".into() }],
                },
                Message {
                    role: Role::Assistant,
                    content: vec![
                        ContentBlock::Text {
                            text: "ok".into(),
                        },
                        ContentBlock::ToolUse {
                            id: "tu_1".into(),
                            name: "read_file".into(),
                            input: serde_json::json!({"path":"a.txt"}),
                        },
                    ],
                },
                Message {
                    role: Role::User,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "tu_1".into(),
                        content: "file contents".into(),
                        is_error: false,
                    }],
                },
            ],
            tools: vec![ToolSchema {
                name: "read_file".into(),
                description: "Read".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }],
            max_tokens: 16,
        };
        let body = build_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        // system + user + assistant + tool = 4
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0]["role"], "system");
        assert!(msgs[0]["content"]
            .as_str()
            .unwrap()
            .contains("rule one"));
        assert!(msgs[0]["content"]
            .as_str()
            .unwrap()
            .contains("rule two"));
        // No cache_control anywhere.
        for m in msgs {
            assert!(m.get("cache_control").is_none());
        }
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[2]["role"], "assistant");
        let tool_calls = msgs[2]["tool_calls"].as_array().unwrap();
        assert_eq!(tool_calls[0]["id"], "tu_1");
        assert_eq!(tool_calls[0]["function"]["name"], "read_file");
        // arguments must be a JSON string, not an object.
        assert!(tool_calls[0]["function"]["arguments"].is_string());
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "tu_1");
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["stream_options"]["include_usage"], true);
    }
}
