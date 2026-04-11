use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use markon_core::server::{ServerConfig, WorkspaceInit};

fn default_true() -> bool { true }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortMode {
    Auto,
    Spec,
}

impl Default for PortMode {
    fn default() -> Self {
        PortMode::Spec
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    pub path: String,
    pub enable_search: bool,
    pub enable_viewed: bool,
    pub enable_edit: bool,
    pub shared_annotation: bool,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            path: String::new(),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub port_mode: PortMode,
    pub port: u16,
    pub host: String,
    pub theme: String,
    /// UI language: "auto" (follow system), "zh", "en".
    #[serde(default)]
    pub language: String,
    /// Browser page theme: "auto" (follow GUI), "light", "dark".
    #[serde(default)]
    pub web_theme: String,
    /// Browser page language: "auto" (follow GUI), "zh", "en".
    #[serde(default)]
    pub web_language: String,
    pub db_path: Option<String>,
    pub workspaces: Vec<WorkspaceSettings>,
    /// Whether the app stays resident in the menu bar (close hides; false = close exits).
    #[serde(default = "default_true")]
    pub tray_resident: bool,
    /// Default feature flags applied to newly added workspaces.
    #[serde(default = "default_true")]
    pub default_search: bool,
    #[serde(default = "default_true")]
    pub default_viewed: bool,
    #[serde(default)]
    pub default_edit: bool,
    #[serde(default)]
    pub default_shared_annotation: bool,
    /// Custom CSS variable overrides for browser page styling.
    /// Keys = CSS variable names without `--markon-` prefix, values = CSS values.
    #[serde(default)]
    pub web_styles: std::collections::HashMap<String, String>,
    /// Custom keyboard shortcut overrides. Keys = shortcut name (e.g. "UNDO"),
    /// values = { key, ctrl, shift } partial objects (desc is not stored).
    #[serde(default)]
    pub shortcuts: std::collections::HashMap<String, serde_json::Value>,
    /// Check for updates on launch via GitHub releases.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Last Settings window size. None on first run → use config defaults.
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
            default_edit: false,
            default_shared_annotation: false,
            web_styles: std::collections::HashMap::new(),
            shortcuts: std::collections::HashMap::new(),
            auto_update: true,
            window_width: None,
            window_height: None,
        }
    }
}

impl AppSettings {
    pub fn settings_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".markon")
            .join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::settings_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(settings) = serde_json::from_str(&content) {
                    return settings;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::settings_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn to_server_config(&self, port: u16) -> ServerConfig {
        if let Some(ref db) = self.db_path {
            if !db.is_empty() {
                std::env::set_var("MARKON_SQLITE_PATH", db);
            }
        }

        let initial_workspaces: Vec<WorkspaceInit> = self
            .workspaces
            .iter()
            .filter(|w| !w.path.is_empty())
            .map(|w| WorkspaceInit {
                path: PathBuf::from(&w.path),
                enable_search: w.enable_search,
                enable_viewed: w.enable_viewed,
                enable_edit: w.enable_edit,
                shared_annotation: w.shared_annotation,
                initial_path: None,
            })
            .collect();

        // DB is activated if any workspace enables shared annotation.
        let shared_annotation = initial_workspaces.iter().any(|w| w.shared_annotation);

        // "auto" for web settings → inherit from GUI settings.
        let effective_web_theme = if self.web_theme == "auto" || self.web_theme.is_empty() {
            self.theme.clone()
        } else {
            self.web_theme.clone()
        };
        let effective_web_lang = if self.web_language == "auto" || self.web_language.is_empty() {
            self.language.clone()
        } else {
            self.web_language.clone()
        };

        ServerConfig {
            host: self.host.clone(),
            port,
            theme: effective_web_theme,
            qr: None,
            open_browser: None,
            shared_annotation,
            salt: None,
            initial_workspaces,
            bound_listener: None,
            registry: None,
            management_token: None,
            language: Some(effective_web_lang),
            styles_css: if self.web_styles.is_empty() {
                None
            } else {
                Some(self.web_styles.iter()
                    .map(|(k, v)| format!("--markon-{}: {};", k, v))
                    .collect::<Vec<_>>()
                    .join(" "))
            },
            shortcuts_json: if self.shortcuts.is_empty() {
                None
            } else {
                serde_json::to_string(&self.shortcuts).ok()
            },
        }
    }
}
