use crate::server::{ServerConfig, WorkspaceInit};
use crate::workspace::{PersistHook, WorkspaceFlags, WorkspaceRegistry};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn default_true() -> bool {
    true
}
fn default_stable() -> String {
    "stable".to_string()
}
fn default_auto() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortMode {
    Auto,
    #[default]
    Spec,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    pub path: String,
    #[serde(flatten, default)]
    pub flags: WorkspaceFlags,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub port_mode: PortMode,
    pub port: u16,
    pub host: String,
    pub theme: String,
    #[serde(default = "default_auto")]
    pub language: String,
    #[serde(default = "default_auto")]
    pub web_theme: String,
    #[serde(default = "default_auto")]
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
            if let Ok(mut s) = serde_json::from_str::<Self>(&c) {
                s.normalize();
                return s;
            }
        }
        Self::default()
    }

    /// Clean up settings loaded from disk:
    /// - drop duplicate workspaces (keep first occurrence, preserving its flags)
    /// - coerce empty language/theme strings to "auto" so existing files written
    ///   before the auto-default fix don't show blank dropdowns
    fn normalize(&mut self) {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        self.workspaces.retain(|w| seen.insert(w.path.clone()));
        for field in [&mut self.language, &mut self.web_theme, &mut self.web_language] {
            if field.is_empty() {
                *field = "auto".to_string();
            }
        }
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
                flags: w.flags,
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
            shared_annotation: initial_workspaces.iter().any(|w| w.flags.shared_annotation),
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
            styles_css: self.render_styles_css(),
            shortcuts_json: self.render_shortcuts_json(),
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
    /// Build a registry persist-hook that mirrors every registry mutation
    /// back into the shared `AppSettings` and writes to disk. CLI daemon and
    /// GUI both wire this so workspace changes initiated from either side
    /// end up with the same persistent state.
    pub fn persist_hook(settings: Arc<Mutex<AppSettings>>) -> PersistHook {
        Arc::new(move |reg| {
            let mut s = settings.lock().unwrap();
            s.sync_from_registry(reg);
            let _ = s.save();
        })
    }

    pub fn render_shortcuts_json(&self) -> Option<String> {
        if self.shortcuts.is_empty() {
            None
        } else {
            serde_json::to_string(&self.shortcuts).ok()
        }
    }
    /// Overwrite `workspaces` with the current registry contents.
    pub fn sync_from_registry(&mut self, registry: &WorkspaceRegistry) {
        self.workspaces = registry
            .info_list()
            .into_iter()
            .map(|info| WorkspaceSettings {
                path: info.path,
                flags: info.flags,
            })
            .collect();
    }

    pub fn render_styles_css(&self) -> Option<String> {
        if self.web_styles.is_empty() {
            return None;
        }
        Some(
            self.web_styles
                .iter()
                .map(|(k, v)| format!("{k}: {v};"))
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}
