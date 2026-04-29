//! Live model-listing for the configured chat providers.
//!
//! Both Anthropic and OpenAI expose a `GET /v1/models` endpoint that returns
//! the catalogue available to the caller's key. Different providers (and
//! third-party compatible servers) return slightly different shapes; we only
//! pull `data[].id` and apply a coarse "is this a chat model?" filter so the
//! GUI's autocomplete doesn't get polluted with embedding/audio/image models.

use crate::chat::config::ProviderKind;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// Fetch the list of chat-capable model IDs from the given provider's API.
/// Returns ids only — caller decides how to render them.
///
/// `base_url` empty falls back to the official endpoint.
pub async fn list_models(
    provider: ProviderKind,
    api_key: &str,
    base_url: &str,
) -> Result<Vec<String>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("missing API key".into());
    }
    let base = match (base_url.trim(), provider) {
        ("", ProviderKind::Anthropic) => "https://api.anthropic.com",
        ("", ProviderKind::OpenAI) => "https://api.openai.com",
        (b, _) => b,
    };
    let url = format!("{}/v1/models", base.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    match provider {
        ProviderKind::Anthropic => {
            req = req
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        }
        ProviderKind::OpenAI => {
            req = req.header("authorization", format!("Bearer {key}"));
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", body.trim()));
    }
    let parsed: ModelsResponse = resp.json().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = parsed
        .data
        .into_iter()
        .map(|m| m.id)
        .filter(|id| is_chat_model(provider, id))
        .collect();
    // Stable order, newest-looking ids first via reverse alpha (works well for
    // both `claude-sonnet-4-6` > `claude-3-5-sonnet` and `gpt-4o` > `gpt-4`).
    ids.sort();
    ids.reverse();
    ids.dedup();
    Ok(ids)
}

/// Filter out non-chat models. Conservative: only allow ids whose prefix
/// matches a known chat family.
fn is_chat_model(provider: ProviderKind, id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    match provider {
        // Anthropic only ships chat models — accept everything claude-*.
        ProviderKind::Anthropic => id.starts_with("claude-"),
        // OpenAI ships embeddings, whisper, dall-e, tts, etc. through the
        // same listing — accept only chat-shaped ids.
        ProviderKind::OpenAI => {
            id.starts_with("gpt-")
                || id.starts_with("chatgpt-")
                || id.starts_with("o1")
                || id.starts_with("o3")
                || id.starts_with("o4")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_filter_keeps_claude_only() {
        assert!(is_chat_model(ProviderKind::Anthropic, "claude-sonnet-4-6"));
        assert!(is_chat_model(ProviderKind::Anthropic, "claude-3-5-haiku"));
        assert!(!is_chat_model(ProviderKind::Anthropic, "text-embedding-3"));
    }

    #[test]
    fn openai_filter_drops_non_chat() {
        assert!(is_chat_model(ProviderKind::OpenAI, "gpt-4o"));
        assert!(is_chat_model(ProviderKind::OpenAI, "o1-mini"));
        assert!(is_chat_model(ProviderKind::OpenAI, "o3-mini"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "text-embedding-3"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "whisper-1"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "dall-e-3"));
    }
}
