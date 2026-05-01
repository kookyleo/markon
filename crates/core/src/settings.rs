use crate::server::{ServerConfig, WorkspaceInit};
use crate::workspace::{generate_token, PersistHook, WorkspaceFlags, WorkspaceRegistry};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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
fn default_in_page() -> String {
    "in_page".to_string()
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

/// Per-provider configuration block. Each provider keeps its own complete
/// set of fields so switching the active provider doesn't lose values.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatProviderSettings {
    #[serde(default)]
    pub api_key: String,
    /// Override model id; empty = use provider's built-in default.
    #[serde(default)]
    pub model: String,
    /// Override API base URL (proxies / compatible servers); empty = official.
    #[serde(default)]
    pub base_url: String,
    /// Cached chat-model ids fetched from the provider's `/v1/models` endpoint.
    /// Refreshed by the GUI on demand; surfaced to the model picker as
    /// autocomplete options. Empty until the user clicks "refresh".
    #[serde(default)]
    pub models: Vec<String>,
}

/// Chat (AI assistant) configuration shared across CLI / GUI / server.
/// `provider` selects the active block; both `anthropic` and `openai` keep
/// their own complete settings so switching back doesn't lose values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSettings {
    /// "anthropic" | "openai".
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub anthropic: ChatProviderSettings,
    #[serde(default)]
    pub openai: ChatProviderSettings,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            anthropic: ChatProviderSettings::default(),
            openai: ChatProviderSettings::default(),
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
    #[serde(default = "default_auto")]
    pub language: String,
    #[serde(default = "default_auto")]
    pub web_theme: String,
    #[serde(default = "default_auto")]
    pub web_language: String,
    pub db_path: Option<String>,
    /// Per-install random salt for workspace-id hashing. Empty on first run;
    /// `load()` lazily generates one and persists it. Keeping it stable across
    /// restarts means bookmarked workspace URLs survive; randomizing per install
    /// means the URL is not derivable from the file path alone.
    #[serde(default)]
    pub salt: String,
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
    pub default_chat: bool,
    /// Default chat surface form: "in_page" (floating panel embedded in the
    /// markdown view) or "popout" (a standalone window opened via window.open).
    /// Drives:
    ///   • sphere click → expand panel vs spawn popout
    ///   • selection 聊聊 button → quote into in-page chat vs popout
    ///   • TOGGLE_CHAT shortcut
    /// In every case Shift inverts the choice for that single click/press.
    #[serde(default = "default_in_page")]
    pub default_chat_mode: String,
    #[serde(default)]
    pub default_shared_annotation: bool,
    #[serde(default)]
    pub chat: ChatSettings,
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
            salt: String::new(),
            workspaces: vec![],
            tray_resident: true,
            default_search: true,
            default_viewed: true,
            default_live: false,
            default_edit: false,
            default_chat: false,
            default_chat_mode: default_in_page(),
            default_shared_annotation: false,
            chat: ChatSettings::default(),
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
    /// Returns the canonical settings path rooted at `home`. Extracted so
    /// tests can inject a tempdir without mutating `HOME`.
    pub(crate) fn settings_path_at(home: &Path) -> PathBuf {
        home.join(".markon").join("settings.json")
    }

    pub fn settings_path() -> PathBuf {
        let home = dirs::home_dir().expect("HOME directory required");
        Self::settings_path_at(&home)
    }

    /// Load from `home/.markon/settings.json`. Generates and persists a salt
    /// on first run. Used by tests to inject a controlled home directory.
    pub(crate) fn load_at(home: &Path) -> Self {
        let p = Self::settings_path_at(home);
        let mut s = if let Ok(c) = std::fs::read_to_string(&p) {
            serde_json::from_str::<Self>(&c).unwrap_or_default()
        } else {
            Self::default()
        };
        s.normalize();
        if s.salt.is_empty() {
            s.salt = generate_token();
            let _ = s.save_at(home);
        }
        s
    }

    pub fn load() -> Self {
        let home = dirs::home_dir().expect("HOME directory required");
        Self::load_at(&home)
    }

    /// Clean up settings loaded from disk:
    /// - drop duplicate workspaces (keep first occurrence, preserving its flags)
    /// - coerce empty language/theme strings to "auto" so existing files written
    ///   before the auto-default fix don't show blank dropdowns
    /// - canonicalize default_chat_mode so downstream code can compare directly
    fn normalize(&mut self) {
        use std::collections::HashSet;
        let mut seen = HashSet::new();
        self.workspaces.retain(|w| seen.insert(w.path.clone()));
        for field in [
            &mut self.language,
            &mut self.web_theme,
            &mut self.web_language,
        ] {
            if field.is_empty() {
                *field = "auto".to_string();
            }
        }
        if self.default_chat_mode != "popout" {
            self.default_chat_mode = "in_page".to_string();
        }
    }
    pub(crate) fn save_at(&self, home: &Path) -> Result<(), String> {
        let p = Self::settings_path_at(home);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let c = serde_json::to_string_pretty(self).unwrap();
        std::fs::write(p, c).map_err(|e| e.to_string())
    }

    pub fn save(&self) -> Result<(), String> {
        let home = dirs::home_dir().expect("HOME directory required");
        self.save_at(&home)
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
            salt: Some(self.salt.clone()),
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
            default_chat_mode: self.default_chat_mode.clone(),
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
    /// Overwrite `workspaces` with the current registry contents. Ephemeral
    /// (single-file) workspaces are skipped — they're created on demand by
    /// Open-With, live in memory only, and should not pile up in settings.json.
    pub fn sync_from_registry(&mut self, registry: &WorkspaceRegistry) {
        self.workspaces = registry
            .info_list()
            .into_iter()
            .filter(|info| !info.ephemeral)
            .map(|info| WorkspaceSettings {
                path: info.path,
                flags: info.flags,
            })
            .collect();
    }

    /// Render `web_styles` (GUI-supplied overrides) as a complete CSS block
    /// targeting the `--markon-*` design tokens defined in `editor.css`.
    ///
    /// Storage convention from the GUI panel (`STYLE_DEFS` in `index.html`):
    ///   • duo-color entries are keyed `<base>.light` / `<base>.dark`
    ///     (e.g. `primary.light`, `muted.dark`)
    ///   • single-value entries are keyed by the bare token name
    ///     (`ui-font`, `ui-font-size`, `panel-opacity`)
    ///
    /// Routing rules:
    ///   • `<base>.light`  → `:root`                       as `--markon-<base>`
    ///   • `<base>.dark`   → `html[data-theme="dark"]`     as `--markon-<base>`
    ///   • bare key        → `:root`                       as `--markon-<key>`
    ///   • unknown suffix (anything other than `.light`/`.dark`) is treated
    ///     as a single value and routed to `:root` so malformed/legacy
    ///     storage doesn't panic.
    ///
    /// Selector blocks are emitted in a fixed order — `:root` first, then
    /// the dark override — so callers/tests get stable framing even though
    /// HashMap iteration over individual properties is unordered.
    /// Returns `None` when neither selector would have any content.
    pub fn render_styles_css(&self) -> Option<String> {
        if self.web_styles.is_empty() {
            return None;
        }
        let mut root: Vec<String> = Vec::new();
        let mut dark: Vec<String> = Vec::new();
        for (k, v) in &self.web_styles {
            if let Some(base) = k.strip_suffix(".light") {
                root.push(format!("--markon-{base}: {v};"));
            } else if let Some(base) = k.strip_suffix(".dark") {
                dark.push(format!("--markon-{base}: {v};"));
            } else {
                // Bare key (single-value token) or unknown suffix — both go
                // to `:root` so unexpected data is rendered harmlessly rather
                // than dropped or panicking.
                root.push(format!("--markon-{k}: {v};"));
            }
        }
        if root.is_empty() && dark.is_empty() {
            return None;
        }
        let mut out = String::new();
        if !root.is_empty() {
            out.push_str(":root { ");
            out.push_str(&root.join(" "));
            out.push_str(" }");
        }
        if !dark.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str("html[data-theme=\"dark\"] { ");
            out.push_str(&dark.join(" "));
            out.push_str(" }");
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::WorkspaceConfig;

    /// Self-cleaning tempdir; each test gets an isolated `home` so they can
    /// run in parallel without touching the real `HOME` env var.
    struct TempHome(PathBuf);
    impl TempHome {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "markon-test-{}-{}",
                label,
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&base).expect("create tempdir");
            TempHome(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // First load generates a non-empty salt and persists it; second load
    // returns the same salt (workspace-id stability contract).
    #[test]
    fn load_generates_salt_and_persists_it() {
        let home = TempHome::new("salt");
        let s1 = AppSettings::load_at(home.path());
        assert!(!s1.salt.is_empty());

        assert!(AppSettings::settings_path_at(home.path()).exists());

        let s2 = AppSettings::load_at(home.path());
        assert_eq!(s1.salt, s2.salt, "salt must be stable across load() calls");
    }

    #[test]
    fn load_missing_file_returns_default() {
        let home = TempHome::new("missing");
        let s = AppSettings::load_at(home.path());
        let d = AppSettings::default();
        assert_eq!(s.port, d.port);
        assert_eq!(s.host, d.host);
        assert_eq!(s.language, "auto");
        assert_eq!(s.web_theme, "auto");
        assert_eq!(s.default_chat_mode, "in_page");
    }

    #[test]
    fn load_corrupt_file_returns_default() {
        let home = TempHome::new("corrupt");
        let p = AppSettings::settings_path_at(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"{garbage").unwrap();

        let s = AppSettings::load_at(home.path());
        assert_eq!(s.port, AppSettings::default().port);
        assert_eq!(s.default_chat_mode, "in_page");
    }

    #[test]
    fn normalize_dedup_and_coerce() {
        let mut s = AppSettings {
            workspaces: vec![
                WorkspaceSettings {
                    path: "/a".to_string(),
                    flags: WorkspaceFlags::default(),
                },
                WorkspaceSettings {
                    path: "/b".to_string(),
                    flags: WorkspaceFlags::default(),
                },
                WorkspaceSettings {
                    path: "/a".to_string(),
                    flags: WorkspaceFlags::default(),
                },
            ],
            language: String::new(),
            web_theme: String::new(),
            web_language: String::new(),
            default_chat_mode: "sidebar".to_string(),
            ..AppSettings::default()
        };

        s.normalize();

        assert_eq!(s.workspaces.len(), 2);
        assert_eq!(s.workspaces[0].path, "/a");
        assert_eq!(s.workspaces[1].path, "/b");
        assert_eq!(s.language, "auto");
        assert_eq!(s.web_theme, "auto");
        assert_eq!(s.web_language, "auto");
        assert_eq!(s.default_chat_mode, "in_page");

        s.default_chat_mode = "popout".to_string();
        s.normalize();
        assert_eq!(s.default_chat_mode, "popout");
    }

    #[test]
    fn sync_from_registry_skips_ephemeral() {
        let reg = WorkspaceRegistry::new("testsalt".to_string());
        let home = TempHome::new("reg");
        let ws_path = home.path().to_path_buf();

        reg.add(WorkspaceConfig {
            path: ws_path.clone(),
            flags: WorkspaceFlags::default(),
            single_file: None,
        });
        reg.add(WorkspaceConfig {
            path: ws_path.clone(),
            flags: WorkspaceFlags::default(),
            single_file: Some("note.md".to_string()),
        });

        let mut s = AppSettings::default();
        s.sync_from_registry(&reg);

        assert_eq!(s.workspaces.len(), 1, "ephemeral entry must be excluded");
        assert_eq!(s.workspaces[0].path, ws_path.to_string_lossy());
    }

    /// Helper: build settings with the given `web_styles` map and nothing else.
    fn settings_with_styles(pairs: &[(&str, &str)]) -> AppSettings {
        let mut s = AppSettings::default();
        for (k, v) in pairs {
            s.web_styles.insert((*k).to_string(), (*v).to_string());
        }
        s
    }

    #[test]
    fn render_styles_css_empty_returns_none() {
        let s = AppSettings::default();
        assert!(s.web_styles.is_empty());
        assert!(s.render_styles_css().is_none());
    }

    #[test]
    fn render_styles_css_light_only_emits_root_block() {
        let s = settings_with_styles(&[("primary.light", "#0969da"), ("muted.light", "#656d76")]);
        let css = s.render_styles_css().expect("should render");
        assert!(css.starts_with(":root { "), "got: {css}");
        assert!(css.contains("--markon-primary: #0969da;"), "got: {css}");
        assert!(css.contains("--markon-muted: #656d76;"), "got: {css}");
        assert!(
            !css.contains("html[data-theme=\"dark\"]"),
            "dark block must be absent when no dark keys: {css}"
        );
        // Reverse-assert old bug shape never reappears.
        assert!(!css.contains("primary.light:"), "leaked dotted key: {css}");
        assert!(css.contains("--markon-"), "must carry token prefix: {css}");
    }

    #[test]
    fn render_styles_css_dark_only_emits_dark_block_only() {
        let s = settings_with_styles(&[("primary.dark", "#58a6ff")]);
        let css = s.render_styles_css().expect("should render");
        assert!(
            !css.contains(":root {"),
            "no :root block when no light/single-value keys: {css}"
        );
        assert!(
            css.contains("html[data-theme=\"dark\"] { --markon-primary: #58a6ff; }"),
            "got: {css}"
        );
        assert!(!css.contains("primary.dark:"), "leaked dotted key: {css}");
        assert!(css.contains("--markon-"), "must carry token prefix: {css}");
    }

    #[test]
    fn render_styles_css_mixed_routes_keys_correctly() {
        let s = settings_with_styles(&[
            ("primary.light", "#0969da"),
            ("primary.dark", "#58a6ff"),
            ("muted.light", "#656d76"),
            ("ui-font", "Inter"),
            ("ui-font-size", "0.95"),
            ("panel-opacity", "0.85"),
        ]);
        let css = s.render_styles_css().expect("should render");

        // Both selector blocks present, in fixed order: :root then dark.
        let root_idx = css.find(":root {").expect("root block present");
        let dark_idx = css
            .find("html[data-theme=\"dark\"] {")
            .expect("dark block present");
        assert!(
            root_idx < dark_idx,
            "selector block order must be :root before dark: {css}"
        );

        // Light + single-value tokens routed to :root with --markon- prefix.
        // Use HashMap-order-agnostic membership checks.
        let root_block = &css[root_idx..dark_idx];
        assert!(
            root_block.contains("--markon-primary: #0969da;"),
            "got: {root_block}"
        );
        assert!(
            root_block.contains("--markon-muted: #656d76;"),
            "got: {root_block}"
        );
        assert!(
            root_block.contains("--markon-ui-font: Inter;"),
            "got: {root_block}"
        );
        assert!(
            root_block.contains("--markon-ui-font-size: 0.95;"),
            "got: {root_block}"
        );
        assert!(
            root_block.contains("--markon-panel-opacity: 0.85;"),
            "got: {root_block}"
        );

        // Dark override carries only the .dark entries — single-value tokens
        // must NOT leak into the dark block.
        let dark_block = &css[dark_idx..];
        assert!(
            dark_block.contains("--markon-primary: #58a6ff;"),
            "got: {dark_block}"
        );
        assert!(
            !dark_block.contains("--markon-ui-font"),
            "single-value token leaked into dark block: {dark_block}"
        );
        assert!(
            !dark_block.contains("--markon-panel-opacity"),
            "single-value token leaked into dark block: {dark_block}"
        );

        // Reverse assertions: none of the legacy-bug shapes should appear.
        assert!(!css.contains("primary.light:"), "leaked dotted key: {css}");
        assert!(!css.contains("primary.dark:"), "leaked dotted key: {css}");
        assert!(
            !css.contains(" ui-font:") && !css.starts_with("ui-font:"),
            "bare (un-prefixed) property leaked: {css}"
        );
        assert!(css.contains("--markon-"), "must carry token prefix: {css}");
    }

    #[test]
    fn render_styles_css_unknown_suffix_falls_back_to_root() {
        // An out-of-spec key (e.g. legacy/typo) must not panic; route to :root
        // verbatim under the --markon- prefix so the result is still legal CSS.
        let s = settings_with_styles(&[("primary.weird", "#abcdef")]);
        let css = s.render_styles_css().expect("should render");
        assert!(
            css.contains(":root { --markon-primary.weird: #abcdef; }"),
            "got: {css}"
        );
        assert!(!css.contains("html[data-theme=\"dark\"]"), "got: {css}");
    }

    #[test]
    fn to_server_config_propagates_salt_and_workspaces() {
        let s = AppSettings {
            salt: "mysalt".to_string(),
            workspaces: vec![WorkspaceSettings {
                path: "/docs".to_string(),
                flags: WorkspaceFlags::default(),
            }],
            ..AppSettings::default()
        };

        let cfg = s.to_server_config(7777);

        assert_eq!(cfg.salt, Some("mysalt".to_string()));
        assert_eq!(cfg.port, 7777);
        assert_eq!(cfg.initial_workspaces.len(), 1);
        assert_eq!(cfg.initial_workspaces[0].path, Path::new("/docs"));
    }
}
