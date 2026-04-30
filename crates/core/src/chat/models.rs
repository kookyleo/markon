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

/// Filter out non-chat models. Black-list approach so we don't have to know
/// every OpenAI-compatible vendor's id prefix in advance — anything that
/// isn't obviously embeddings / audio / image / moderation / rerank stays.
fn is_chat_model(provider: ProviderKind, id: &str) -> bool {
    // Anthropic's listing is chat-only today; trust it instead of guessing.
    // Lazy lowercase on the OpenAI path keeps the Anthropic path allocation-free
    // and forces a non-exhaustive-match warning if a third ProviderKind ever lands.
    let id = match provider {
        ProviderKind::Anthropic => return true,
        ProviderKind::OpenAI => id.to_ascii_lowercase(),
    };
    // OpenAI + every OpenAI-compatible vendor (xAI / DeepSeek / Groq /
    // Together / Mistral / Moonshot / Zhipu / DashScope / Ollama / vLLM ...).
    // We can't enumerate their model prefixes, so we drop the families that
    // clearly aren't chat instead.
    const REJECT_SUBSTRINGS: &[&str] = &[
        "embedding",
        "embed", // bge-*, voyage-*, etc.
        "rerank",
        "moderation",
        "whisper",
        "transcribe",
        "tts", // text-to-speech
        "speech",
        "audio",
        "dall-e",
        "image",          // gpt-image-*, image-gen, etc.
        "vision-preview", // older preview-only vision endpoints
        "guard",          // safety/guard models (e.g. llama-guard)
        "code-search",
    ];
    const REJECT_PREFIXES: &[&str] = &[
        "text-", // text-embedding-3, text-moderation-*, text-davinci-*
        "babbage", "curie", "ada-", "davinci", // legacy completion-only models
    ];
    if REJECT_PREFIXES.iter().any(|p| id.starts_with(p)) {
        return false;
    }
    if REJECT_SUBSTRINGS.iter().any(|s| id.contains(s)) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_passes_everything_through() {
        assert!(is_chat_model(ProviderKind::Anthropic, "claude-sonnet-4-6"));
        assert!(is_chat_model(ProviderKind::Anthropic, "claude-3-5-haiku"));
    }

    #[test]
    fn openai_compatible_keeps_third_party_chat_ids() {
        // OpenAI + every OpenAI-compatible vendor we care about.
        assert!(is_chat_model(ProviderKind::OpenAI, "gpt-4o"));
        assert!(is_chat_model(ProviderKind::OpenAI, "o1-mini"));
        assert!(is_chat_model(ProviderKind::OpenAI, "o3-mini"));
        assert!(is_chat_model(ProviderKind::OpenAI, "grok-4"));
        assert!(is_chat_model(ProviderKind::OpenAI, "deepseek-chat"));
        assert!(is_chat_model(ProviderKind::OpenAI, "moonshot-v1-8k"));
        assert!(is_chat_model(ProviderKind::OpenAI, "glm-4-plus"));
        assert!(is_chat_model(ProviderKind::OpenAI, "qwen-plus"));
        assert!(is_chat_model(
            ProviderKind::OpenAI,
            "llama-3.1-70b-instruct"
        ));
        assert!(is_chat_model(ProviderKind::OpenAI, "mistral-large-latest"));
    }

    #[test]
    fn openai_filter_drops_non_chat() {
        assert!(!is_chat_model(
            ProviderKind::OpenAI,
            "text-embedding-3-small"
        ));
        assert!(!is_chat_model(
            ProviderKind::OpenAI,
            "text-moderation-latest"
        ));
        assert!(!is_chat_model(ProviderKind::OpenAI, "whisper-1"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "tts-1-hd"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "dall-e-3"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "gpt-image-1"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "babbage-002"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "davinci-002"));
        assert!(!is_chat_model(ProviderKind::OpenAI, "voyage-rerank-2")); // rerank
        assert!(!is_chat_model(ProviderKind::OpenAI, "llama-guard-3-8b")); // safety
                                                                           // Note: vendor-specific embedding ids without "embed" in the string
                                                                           // (e.g. "bge-large-en") will leak through — accepted trade-off for
                                                                           // a black-list approach. Users will notice when the API rejects them.
    }
}
