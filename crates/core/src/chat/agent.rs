//! Agent loop: drive provider stream, execute tool_use, append tool_result,
//! repeat until the provider returns a stop_reason other than `tool_use`.

use crate::chat::message::{ContentBlock, Message, Role, Usage};
use crate::chat::provider::{ChatRequest, Provider, ProviderEvent, SystemBlock};
use crate::chat::storage::ChatStorage;
use crate::chat::tools::{ToolContext, ToolError, ToolRegistry};
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Streaming events emitted to the SSE client.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Sent first, once we know which thread we're posting to (creating a new
    /// one if the request didn't supply an id).
    ThreadAssigned { thread_id: String, title: String },
    /// Assistant text delta.
    Text { delta: String },
    /// Tool call has begun (after the model finishes producing its `input`).
    ToolStart {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Tool produced a result (or error) — the agent is about to send it back
    /// to the model.
    ToolEnd {
        id: String,
        output: String,
        is_error: bool,
    },
    /// One full provider turn ended; agent may loop again with tool results.
    TurnEnd { stop_reason: String, usage: Usage },
    /// The whole agent loop has ended for this user turn.
    Done {
        total_usage: Usage,
        final_message_seq: Option<i64>,
    },
    /// Fatal error; stream is about to close.
    Error { message: String },
}

#[derive(Debug)]
pub struct AgentRequest {
    pub thread_id: String,
    pub thread_title: String,
    pub workspace_id: String,
    pub workspace_root: std::path::PathBuf,
    /// Full prior history (already persisted).
    pub history: Vec<Message>,
    /// The new user turn we just appended (already persisted).
    pub user_message: Message,
    pub system: Vec<SystemBlock>,
    pub model: String,
    pub max_steps: u8,
    pub max_tokens: u32,
}

pub struct Agent {
    pub provider: Arc<dyn Provider>,
    pub tools: Arc<ToolRegistry>,
    pub storage: ChatStorage,
}

impl Agent {
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        storage: ChatStorage,
    ) -> Self {
        Self {
            provider,
            tools,
            storage,
        }
    }

    /// Run the agent loop and forward events on `sink`. Returns once the loop
    /// terminates (success, error, or sink closed).
    pub async fn run(&self, request: AgentRequest, sink: mpsc::Sender<AgentEvent>) {
        // Tell the client which thread we landed in *before* we burn API budget.
        let _ = sink
            .send(AgentEvent::ThreadAssigned {
                thread_id: request.thread_id.clone(),
                title: request.thread_title.clone(),
            })
            .await;

        let mut messages = request.history.clone();
        messages.push(request.user_message);
        let tool_schemas = self.tools.schemas();
        let tool_ctx = ToolContext {
            workspace_root: request.workspace_root.clone(),
        };

        let mut total_usage = Usage::default();
        let mut last_seq: Option<i64> = None;

        for step in 0..request.max_steps {
            let chat_req = ChatRequest {
                model: request.model.clone(),
                system: request.system.clone(),
                messages: messages.clone(),
                tools: tool_schemas.clone(),
                max_tokens: request.max_tokens,
            };

            let mut stream = match self.provider.stream(chat_req).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = sink
                        .send(AgentEvent::Error {
                            message: format!("provider: {e}"),
                        })
                        .await;
                    return;
                }
            };

            let mut turn_content: Vec<ContentBlock> = Vec::new();
            let mut turn_usage = Usage::default();
            let mut stop_reason = String::from("end_turn");

            while let Some(ev) = stream.next().await {
                match ev {
                    Ok(ProviderEvent::TextDelta(text)) => {
                        if sink.send(AgentEvent::Text { delta: text }).await.is_err() {
                            return; // client disconnected
                        }
                    }
                    Ok(ProviderEvent::ToolUseStart { id, name }) => {
                        // We forward the start now (without input) so the UI can
                        // render an "calling X..." pill immediately.
                        let _ = sink
                            .send(AgentEvent::ToolStart {
                                id,
                                name,
                                input: serde_json::Value::Null,
                            })
                            .await;
                    }
                    Ok(ProviderEvent::ToolUseEnd { .. }) => {
                        // Final tool input arrives in `MessageEnd.content`; we
                        // dispatch from there in one place to keep ordering
                        // deterministic relative to text blocks.
                    }
                    Ok(ProviderEvent::MessageEnd {
                        stop_reason: reason,
                        usage,
                        content,
                    }) => {
                        turn_content = content;
                        turn_usage = usage;
                        stop_reason = reason;
                    }
                    Err(e) => {
                        let _ = sink
                            .send(AgentEvent::Error {
                                message: format!("provider stream: {e}"),
                            })
                            .await;
                        return;
                    }
                }
            }

            total_usage.add(&turn_usage);
            let _ = sink
                .send(AgentEvent::TurnEnd {
                    stop_reason: stop_reason.clone(),
                    usage: turn_usage,
                })
                .await;

            // Persist the assistant turn now (before tool execution) so the
            // record exists even if a tool blows up mid-loop.
            match self
                .storage
                .append_message(&request.thread_id, Role::Assistant, &turn_content)
            {
                Ok(stored) => {
                    last_seq = Some(stored.seq);
                }
                Err(e) => {
                    let _ = sink
                        .send(AgentEvent::Error {
                            message: format!("persist assistant: {e}"),
                        })
                        .await;
                    return;
                }
            }

            messages.push(Message {
                role: Role::Assistant,
                content: turn_content.clone(),
            });

            // Decide whether to loop. Anthropic uses "tool_use"; OpenAI we
            // already mapped to the same string in the provider layer.
            if stop_reason != "tool_use" {
                break;
            }

            // Collect all tool_uses in the order they appeared.
            let tool_uses: Vec<(String, String, serde_json::Value)> = turn_content
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::ToolUse { id, name, input } => {
                        Some((id.clone(), name.clone(), input.clone()))
                    }
                    _ => None,
                })
                .collect();

            if tool_uses.is_empty() {
                // Provider claimed tool_use but emitted none — bail rather than
                // spin forever.
                break;
            }

            let mut tool_results: Vec<ContentBlock> = Vec::new();
            for (id, name, input) in tool_uses {
                let (output, is_error) =
                    match self.tools.dispatch(&tool_ctx, &name, input.clone()).await {
                        Ok(out) => (out, false),
                        Err(ToolError::NotFound(p)) => (format!("not found: {p}"), true),
                        Err(e) => (e.to_tool_message(), true),
                    };
                let _ = sink
                    .send(AgentEvent::ToolStart {
                        id: id.clone(),
                        name: name.clone(),
                        input,
                    })
                    .await;
                let _ = sink
                    .send(AgentEvent::ToolEnd {
                        id: id.clone(),
                        output: output.clone(),
                        is_error,
                    })
                    .await;
                tool_results.push(ContentBlock::ToolResult {
                    tool_use_id: id,
                    content: output,
                    is_error,
                });
            }

            // Persist the synthetic user-turn carrying tool results, then add
            // it to the in-memory history for the next provider call.
            if let Err(e) =
                self.storage
                    .append_message(&request.thread_id, Role::User, &tool_results)
            {
                let _ = sink
                    .send(AgentEvent::Error {
                        message: format!("persist tool results: {e}"),
                    })
                    .await;
                return;
            }
            messages.push(Message {
                role: Role::User,
                content: tool_results,
            });

            // Last iteration — prevent runaway.
            if step + 1 == request.max_steps {
                let _ = sink
                    .send(AgentEvent::Error {
                        message: format!(
                            "agent reached max_steps={} without finishing — stopping",
                            request.max_steps
                        ),
                    })
                    .await;
                return;
            }
        }

        let _ = sink
            .send(AgentEvent::Done {
                total_usage,
                final_message_seq: last_seq,
            })
            .await;
    }
}

/// Helper: convert a slice of [`ContentBlock`] into a single string for
/// places that need a flat representation (titles, summaries).
pub fn flatten_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        if let ContentBlock::Text { text } = b {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}

/// Generate a thread title from the first user message — first sentence,
/// trimmed to 64 chars. Plain heuristic; the user can rename.
pub fn auto_title(text: &str) -> String {
    let trimmed = text.trim();
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let first_sentence = first_line
        .split(['.', '。', '!', '?', '\n'])
        .next()
        .unwrap_or("");
    let take = 64;
    let mut out: String = first_sentence.chars().take(take).collect();
    if first_sentence.chars().count() > take {
        out.push('…');
    }
    if out.is_empty() {
        "New chat".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_title_takes_first_sentence() {
        assert_eq!(auto_title("Hello there. Second sentence."), "Hello there");
        assert_eq!(auto_title("中文标题。多余的内容"), "中文标题");
        assert_eq!(auto_title(""), "New chat");
    }

    #[test]
    fn flatten_text_concatenates_text_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "first".into(),
            },
            ContentBlock::ToolUse {
                id: "x".into(),
                name: "grep".into(),
                input: serde_json::json!({}),
            },
            ContentBlock::Text {
                text: "second".into(),
            },
        ];
        assert_eq!(flatten_text(&blocks), "first\nsecond");
    }
}
