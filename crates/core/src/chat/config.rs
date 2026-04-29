//! Runtime resolution of `settings.json::chat` into something the agent can use.

use crate::settings::{ChatProviderSettings, ChatSettings};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    OpenAI,
}

impl ProviderKind {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "openai" | "oai" => Self::OpenAI,
            _ => Self::Anthropic,
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-4-6",
            Self::OpenAI => "gpt-4o",
        }
    }
}

/// Snapshot of chat config used to handle a single request. Resolved from the
/// shared [`ChatSettings`] at request time so changing keys via the GUI takes
/// effect on the next message.
#[derive(Debug, Clone)]
pub struct ChatRuntimeConfig {
    pub provider: ProviderKind,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
}

impl ChatRuntimeConfig {
    pub fn from_settings(s: &ChatSettings) -> Result<Self, &'static str> {
        let provider = ProviderKind::parse(&s.provider);
        let block: &ChatProviderSettings = match provider {
            ProviderKind::Anthropic => &s.anthropic,
            ProviderKind::OpenAI => &s.openai,
        };
        let api_key = block.api_key.trim();
        if api_key.is_empty() {
            return Err("missing API key for the selected chat provider");
        }
        let model = if block.model.trim().is_empty() {
            provider.default_model().to_string()
        } else {
            block.model.trim().to_string()
        };
        Ok(Self {
            provider,
            model,
            api_key: api_key.to_string(),
            base_url: block.base_url.trim().to_string(),
        })
    }
}
