use markon_core::server::{ServerConfig, WorkspaceInit};
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
    pub shared_annotation: bool,
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
    /// Update channel: "stable" (default) only receives promoted releases;
    /// "rc" also receives release-candidate builds.
    #[serde(default = "default_stable")]
    pub update_channel: String,
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
            update_channel: "stable".to_string(),
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
                // Split into base / light / dark CSS blocks
                let mut base = Vec::new();
                let mut light = Vec::new();
                let mut dark = Vec::new();
                for (k, v) in &self.web_styles {
                    if let Some(name) = k.strip_suffix(".light") {
                        light.push(format!("--markon-{}: {};", name, v));
                    } else if let Some(name) = k.strip_suffix(".dark") {
                        dark.push(format!("--markon-{}: {};", name, v));
                    } else {
                        base.push(format!("--markon-{}: {};", k, v));
                    }
                }
                let mut css = String::new();
                if !base.is_empty() || !light.is_empty() {
                    css.push_str(&base.join(" "));
                    css.push_str(&light.join(" "));
                }
                if !dark.is_empty() {
                    css.push_str(&format!(
                        "}} @media (prefers-color-scheme:dark) {{ :root {{ {}",
                        dark.join(" ")
                    ));
                }
                Some(css)
            },
            shortcuts_json: if self.shortcuts.is_empty() {
                None
            } else {
                serde_json::to_string(&self.shortcuts).ok()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values() {
        let s = AppSettings::default();
        assert_eq!(s.port, 6419);
        assert_eq!(s.host, "127.0.0.1");
        assert_eq!(s.theme, "auto");
        assert_eq!(s.language, "auto");
        assert_eq!(s.web_theme, "auto");
        assert_eq!(s.web_language, "auto");
        assert!(s.tray_resident);
        assert!(s.default_search);
        assert!(s.default_viewed);
        assert!(!s.default_edit);
        assert!(!s.default_shared_annotation);
        assert!(s.auto_update);
        assert_eq!(s.update_channel, "stable");
        assert!(s.workspaces.is_empty());
        assert!(s.web_styles.is_empty());
        assert!(s.shortcuts.is_empty());
        assert_eq!(s.port_mode, PortMode::Spec);
    }

    #[test]
    fn serde_roundtrip() {
        let original = AppSettings::default();
        let json = serde_json::to_string(&original).unwrap();
        let parsed: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.port, original.port);
        assert_eq!(parsed.host, original.host);
        assert_eq!(parsed.theme, original.theme);
        assert_eq!(parsed.tray_resident, original.tray_resident);
        assert_eq!(parsed.update_channel, original.update_channel);
    }

    #[test]
    fn serde_defaults_on_partial_json() {
        // Minimal JSON — all missing fields should get serde defaults
        let json = r#"{"port": 9999}"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.port, 9999);
        assert!(s.tray_resident); // default_true
        assert!(s.default_search); // default_true
        assert_eq!(s.update_channel, "stable"); // default_stable
        assert_eq!(s.host, "127.0.0.1"); // #[serde(default)] uses AppSettings::default()
    }

    #[test]
    fn to_server_config_empty_workspaces_filtered() {
        let s = AppSettings {
            workspaces: vec![
                WorkspaceSettings {
                    path: "".into(),
                    ..Default::default()
                },
                WorkspaceSettings {
                    path: "/valid".into(),
                    enable_search: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert_eq!(config.initial_workspaces.len(), 1);
        assert_eq!(
            config.initial_workspaces[0].path.to_str().unwrap(),
            "/valid"
        );
        assert!(config.initial_workspaces[0].enable_search);
    }

    #[test]
    fn to_server_config_web_theme_auto_inherits() {
        let s = AppSettings {
            theme: "dark".into(),
            web_theme: "auto".into(),
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert_eq!(config.theme, "dark");
    }

    #[test]
    fn to_server_config_web_theme_explicit() {
        let s = AppSettings {
            theme: "dark".into(),
            web_theme: "light".into(),
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert_eq!(config.theme, "light");
    }

    #[test]
    fn to_server_config_web_language_auto_inherits() {
        let s = AppSettings {
            language: "zh".into(),
            web_language: "auto".into(),
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert_eq!(config.language, Some("zh".into()));
    }

    #[test]
    fn to_server_config_web_language_explicit() {
        let s = AppSettings {
            language: "zh".into(),
            web_language: "en".into(),
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert_eq!(config.language, Some("en".into()));
    }

    #[test]
    fn to_server_config_shared_annotation_from_workspaces() {
        let s = AppSettings {
            workspaces: vec![
                WorkspaceSettings {
                    path: "/a".into(),
                    shared_annotation: false,
                    ..Default::default()
                },
                WorkspaceSettings {
                    path: "/b".into(),
                    shared_annotation: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let config = s.to_server_config(8080);
        assert!(config.shared_annotation);
    }

    #[test]
    fn to_server_config_no_shared_annotation() {
        let s = AppSettings::default();
        let config = s.to_server_config(8080);
        assert!(!config.shared_annotation);
    }

    #[test]
    fn to_server_config_styles_css_empty() {
        let s = AppSettings::default();
        let config = s.to_server_config(8080);
        assert!(config.styles_css.is_none());
    }

    #[test]
    fn to_server_config_styles_css_base_only() {
        let mut s = AppSettings::default();
        s.web_styles.insert("font-size".into(), "16px".into());
        let config = s.to_server_config(8080);
        let css = config.styles_css.unwrap();
        assert!(css.contains("--markon-font-size: 16px;"));
    }

    #[test]
    fn to_server_config_styles_css_light_dark_split() {
        let mut s = AppSettings::default();
        s.web_styles.insert("bg.light".into(), "#fff".into());
        s.web_styles.insert("bg.dark".into(), "#000".into());
        let config = s.to_server_config(8080);
        let css = config.styles_css.unwrap();
        assert!(css.contains("--markon-bg: #fff;"));
        assert!(css.contains("--markon-bg: #000;"));
        assert!(css.contains("prefers-color-scheme:dark"));
    }

    #[test]
    fn to_server_config_shortcuts_empty() {
        let s = AppSettings::default();
        let config = s.to_server_config(8080);
        assert!(config.shortcuts_json.is_none());
    }

    #[test]
    fn to_server_config_shortcuts_present() {
        let mut s = AppSettings::default();
        s.shortcuts
            .insert("UNDO".into(), serde_json::json!({"key": "z", "ctrl": true}));
        let config = s.to_server_config(8080);
        let json = config.shortcuts_json.unwrap();
        assert!(json.contains("UNDO"));
    }

    #[test]
    fn to_server_config_port_passthrough() {
        let s = AppSettings::default();
        let config = s.to_server_config(3000);
        assert_eq!(config.port, 3000);
    }

    #[test]
    fn workspace_settings_default() {
        let ws = WorkspaceSettings::default();
        assert!(ws.path.is_empty());
        assert!(!ws.enable_search);
        assert!(!ws.enable_viewed);
        assert!(!ws.enable_edit);
        assert!(!ws.shared_annotation);
    }
}
