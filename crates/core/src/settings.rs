use crate::server::{ServerConfig, WorkspaceInit};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn default_true() -> bool {
    true
}
fn default_stable() -> String {
    "stable".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortMode {
    Auto,
    #[default]
    Spec,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    pub path: String,
    pub enable_search: bool,
    pub enable_viewed: bool,
    pub enable_edit: bool,
    pub enable_live: bool,
    pub shared_annotation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub port_mode: PortMode,
    pub port: u16,
    pub host: String,
    pub theme: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub web_theme: String,
    #[serde(default)]
    pub web_language: String,
    pub db_path: Option<String>,
    pub workspaces: Vec<WorkspaceSettings>,
    #[serde(default = "default_true")]
    pub tray_resident: bool,
    #[serde(default = "default_true")]
    pub default_search: bool,
    #[serde(default = "default_true")]
    pub default_viewed: bool,
    #[serde(default)]
    pub default_live: bool,
    #[serde(default)]
    pub default_edit: bool,
    #[serde(default)]
    pub default_shared_annotation: bool,
    #[serde(default)]
    pub web_styles: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub shortcuts: std::collections::HashMap<String, serde_json::Value>,
    #[serde(default = "default_true")]
    pub auto_update: bool,
    #[serde(default = "default_stable")]
    pub update_channel: String,
    #[serde(default)]
    pub window_width: Option<u32>,
    #[serde(default)]
    pub window_height: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            port_mode: PortMode::Spec,
            port: 6419,
            host: "127.0.0.1".to_string(),
            theme: "auto".to_string(),
            language: "auto".to_string(),
            web_theme: "auto".to_string(),
            web_language: "auto".to_string(),
            db_path: None,
            workspaces: vec![],
            tray_resident: true,
            default_search: true,
            default_viewed: true,
            default_live: false,
            default_edit: false,
            default_shared_annotation: false,
            web_styles: std::collections::HashMap::new(),
            shortcuts: std::collections::HashMap::new(),
            auto_update: true,
            update_channel: "stable".to_string(),
            window_width: None,
            window_height: None,
        }
    }
}

impl AppSettings {
    pub fn settings_path() -> PathBuf {
        dirs::home_dir()
            .unwrap()
            .join(".markon")
            .join("settings.json")
    }
    pub fn load() -> Self {
        let p = Self::settings_path();
        if let Ok(c) = std::fs::read_to_string(p) {
            if let Ok(s) = serde_json::from_str::<Self>(&c) {
                return s;
            }
        }
        Self::default()
    }
    pub fn save(&self) -> Result<(), String> {
        let p = Self::settings_path();
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let c = serde_json::to_string_pretty(self).unwrap();
        std::fs::write(p, c).map_err(|e| e.to_string())
    }
    pub fn to_server_config(&self, port: u16) -> ServerConfig {
        let initial_workspaces: Vec<WorkspaceInit> = self
            .workspaces
            .iter()
            .filter(|w| !w.path.is_empty())
            .map(|w| WorkspaceInit {
                path: PathBuf::from(&w.path),
                enable_search: w.enable_search,
                enable_viewed: w.enable_viewed,
                enable_edit: w.enable_edit,
                enable_live: w.enable_live,
                shared_annotation: w.shared_annotation,
                initial_path: None,
            })
            .collect();
        ServerConfig {
            host: self.host.clone(),
            port,
            theme: if self.web_theme == "auto" {
                self.theme.clone()
            } else {
                self.web_theme.clone()
            },
            qr: None,
            open_browser: None,
            shared_annotation: initial_workspaces.iter().any(|w| w.shared_annotation),
            salt: None,
            initial_workspaces,
            bound_listener: None,
            registry: None,
            management_token: None,
            language: if self.web_language == "auto" {
                Some(self.language.clone())
            } else {
                Some(self.web_language.clone())
            },
            styles_css: None,
            shortcuts_json: None,
        }
    }
    pub fn effective_web_language(&self) -> Option<String> {
        let l = if self.web_language == "auto" {
            &self.language
        } else {
            &self.web_language
        };
        if l == "auto" || l.is_empty() {
            None
        } else {
            Some(l.clone())
        }
    }
    pub fn render_shortcuts_json(&self) -> Option<String> {
        if self.shortcuts.is_empty() {
            None
        } else {
            serde_json::to_string(&self.shortcuts).ok()
        }
    }
    pub fn render_styles_css(&self) -> Option<String> {
        None
    }
}
