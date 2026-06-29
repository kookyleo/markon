use crate::server::{ServerConfig, WorkspaceInit};
use crate::workspace::{PersistHook, WorkspaceFlags, WorkspaceRegistry};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Emit a one-shot warning when a provider api_key is being persisted
/// in plaintext. Anything more elaborate (OS keychain, encryption) is
/// future work — for now we make sure the operator at least knows the
/// file is sensitive.
fn warn_sensitive_secret_persisted_once(path: &Path) {
    static WARNED: OnceLock<()> = OnceLock::new();
    WARNED.get_or_init(|| {
        tracing::warn!(
            path = %path.display(),
            "chat provider api_key persisted in plaintext at this path; \
             restrict access to your user account only"
        );
    });
}

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
fn default_follow() -> String {
    "follow".to_string()
}

/// A stable, per-device identifier (never random), used as the root of the
/// workspace-id salt. Read from OS-provided machine identity so it survives
/// reinstalls and settings resets, yet differs across machines.
fn machine_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains("IOPlatformUUID") {
                if let Some(start) = line.find("= \"") {
                    let rest = &line[start + 3..];
                    if let Some(end) = rest.find('"') {
                        return Some(rest[..end].to_string());
                    }
                }
            }
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/machine-id")
            .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if let Some(idx) = line.find("REG_SZ") {
                let value = line[idx + "REG_SZ".len()..].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        None
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// Deterministic, device-bound workspace-id salt. SHA-256 of a domain tag plus
/// the machine id — so a workspace id is reproducible on this device but not
/// guessable from the (public) port and path alone.
pub(crate) fn device_salt() -> String {
    use sha2::{Digest, Sha256};
    let id = machine_id().unwrap_or_else(|| "markon-fallback-device".to_string());
    let mut hasher = Sha256::new();
    hasher.update(b"markon-workspace-salt-v1\0");
    hasher.update(id.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::from("device:");
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn recover_field<T: DeserializeOwned>(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    target: &mut T,
) {
    let Some(value) = object.get(key) else {
        return;
    };
    if let Ok(parsed) = serde_json::from_value::<T>(value.clone()) {
        *target = parsed;
    }
}

fn recover_bool(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> bool {
    object
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn recover_workspace_flags(object: &serde_json::Map<String, serde_json::Value>) -> WorkspaceFlags {
    WorkspaceFlags {
        enable_search: recover_bool(object, "enable_search"),
        enable_viewed: recover_bool(object, "enable_viewed"),
        enable_edit: recover_bool(object, "enable_edit"),
        enable_live: recover_bool(object, "enable_live"),
        enable_chat: recover_bool(object, "enable_chat"),
        shared_annotation: recover_bool(object, "shared_annotation"),
    }
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
    /// Per-workspace access code (salted hash); overrides the server-level code
    /// for this workspace. Empty = inherit the server code (or no gate).
    #[serde(default)]
    pub access_code_hash: String,
    /// Per-workspace collaborator access code. Empty = inherit the server-level
    /// collaborator code (or no collaborator token).
    #[serde(default)]
    pub collaborator_access_code_hash: String,
    /// Optional short display name shown instead of the path. Empty = none.
    #[serde(default)]
    pub alias: String,
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
    /// Preferred LAN address to feature when `host` is a wildcard (0.0.0.0):
    /// the IP used for the headline workspace URL, QR code, and browser
    /// auto-open. Empty = no preference (fall back to the first interface).
    #[serde(default)]
    pub advertised_host: String,
    pub theme: String,
    #[serde(default = "default_auto")]
    pub language: String,
    #[serde(default = "default_auto")]
    pub web_theme: String,
    #[serde(default = "default_auto")]
    pub web_language: String,
    /// Source-editor colour preset for the web view: "follow" (track the page
    /// theme via the --mk-editor-* layer) or "vscode-dark" (the named dark
    /// preset). Emitted as the `data-editor-theme` attribute on <html>.
    #[serde(default = "default_follow")]
    pub web_editor_theme: String,
    /// Server-level access code, stored as a salted hash (see
    /// `workspace::hash_access_code`). Empty = no gate (current behaviour).
    /// A workspace's own `access_code_hash` overrides this for that workspace.
    #[serde(default)]
    pub access_code_hash: String,
    /// Server-level collaborator access code. Empty = no collaborator token
    /// unless a workspace defines its own.
    #[serde(default)]
    pub collaborator_access_code_hash: String,
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
    ///   • selection chat button → quote into in-page chat vs popout
    ///   • TOGGLE_CHAT shortcut
    /// In every case Shift inverts the choice for that single click/press.
    #[serde(default = "default_in_page")]
    pub default_chat_mode: String,
    #[serde(default)]
    pub default_shared_annotation: bool,
    /// GUI onboarding state: once the user manually removes the bundled example
    /// workspace from the Workspaces tab, do not auto-add it again.
    #[serde(default)]
    pub example_workspace_hidden: bool,
    /// When false (default), `<details>`-style collapsed sections are hidden
    /// in print and replaced by a small placeholder; when true the collapsed
    /// content is forced visible so it shows up in the printed output.
    #[serde(default)]
    pub print_collapsed_content: bool,
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
            advertised_host: String::new(),
            theme: "auto".to_string(),
            language: "auto".to_string(),
            web_theme: "auto".to_string(),
            web_language: "auto".to_string(),
            web_editor_theme: "follow".to_string(),
            access_code_hash: String::new(),
            collaborator_access_code_hash: String::new(),
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
            example_workspace_hidden: false,
            print_collapsed_content: false,
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

    pub fn example_workspace_path_at(home: &Path) -> PathBuf {
        home.join(".markon").join("example")
    }

    pub fn example_workspace_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| Self::example_workspace_path_at(&home))
    }

    /// Load from `home/.markon/settings.json`. Generates and persists a salt
    /// on first run. Used by tests to inject a controlled home directory.
    pub(crate) fn load_at(home: &Path) -> Self {
        let p = Self::settings_path_at(home);
        let mut should_persist_missing_salt = false;
        let mut s = match std::fs::read_to_string(&p) {
            Ok(c) => {
                should_persist_missing_salt = true;
                serde_json::from_str::<Self>(&c).unwrap_or_else(|err| {
                    tracing::warn!(
                        path = %p.display(),
                        error = %err,
                        "failed to parse settings.json; recovering identity fields without overwriting the file"
                    );
                    should_persist_missing_salt = false;
                    Self::recover_from_json_value(&c).unwrap_or_default()
                })
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                should_persist_missing_salt = true;
                Self::default()
            }
            Err(err) => {
                tracing::warn!(
                    path = %p.display(),
                    error = %err,
                    "failed to read settings.json; using the device-derived salt without overwriting the file"
                );
                should_persist_missing_salt = false;
                Self::default()
            }
        };
        s.normalize();
        // Root every workspace id in a per-device, deterministic salt: never random
        // (a reset/corrupt settings.json recomputes the same ids) and not derivable
        // from the public port/path (which a fixed or port-based salt would be).
        // Recomputed each load and never honoured from disk, so copying settings.json
        // to another machine cannot transplant this device's ids.
        let device = device_salt();
        if s.salt != device {
            s.salt = device;
            if should_persist_missing_salt {
                let _ = s.save_at(home);
            }
        }
        s
    }

    fn recover_from_json_value(raw: &str) -> Option<Self> {
        let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
        let object = value.as_object()?;
        let mut settings = Self::default();

        recover_field(object, "port_mode", &mut settings.port_mode);
        recover_field(object, "port", &mut settings.port);
        recover_field(object, "host", &mut settings.host);
        recover_field(object, "advertised_host", &mut settings.advertised_host);
        recover_field(object, "theme", &mut settings.theme);
        recover_field(object, "language", &mut settings.language);
        recover_field(object, "web_theme", &mut settings.web_theme);
        recover_field(object, "web_language", &mut settings.web_language);
        recover_field(object, "web_editor_theme", &mut settings.web_editor_theme);
        recover_field(object, "access_code_hash", &mut settings.access_code_hash);
        recover_field(
            object,
            "collaborator_access_code_hash",
            &mut settings.collaborator_access_code_hash,
        );
        recover_field(object, "db_path", &mut settings.db_path);
        recover_field(object, "salt", &mut settings.salt);
        recover_field(object, "tray_resident", &mut settings.tray_resident);
        recover_field(object, "default_search", &mut settings.default_search);
        recover_field(object, "default_viewed", &mut settings.default_viewed);
        recover_field(object, "default_live", &mut settings.default_live);
        recover_field(object, "default_edit", &mut settings.default_edit);
        recover_field(object, "default_chat", &mut settings.default_chat);
        recover_field(object, "default_chat_mode", &mut settings.default_chat_mode);
        recover_field(
            object,
            "default_shared_annotation",
            &mut settings.default_shared_annotation,
        );
        recover_field(
            object,
            "example_workspace_hidden",
            &mut settings.example_workspace_hidden,
        );
        recover_field(
            object,
            "print_collapsed_content",
            &mut settings.print_collapsed_content,
        );
        recover_field(object, "chat", &mut settings.chat);
        recover_field(object, "web_styles", &mut settings.web_styles);
        recover_field(object, "shortcuts", &mut settings.shortcuts);
        recover_field(object, "auto_update", &mut settings.auto_update);
        recover_field(object, "update_channel", &mut settings.update_channel);
        recover_field(object, "window_width", &mut settings.window_width);
        recover_field(object, "window_height", &mut settings.window_height);

        if let Some(workspaces) = object.get("workspaces").and_then(|v| v.as_array()) {
            settings.workspaces = workspaces
                .iter()
                .filter_map(Self::recover_workspace)
                .collect();
        }

        Some(settings)
    }

    fn recover_workspace(value: &serde_json::Value) -> Option<WorkspaceSettings> {
        let object = value.as_object()?;
        let mut workspace = WorkspaceSettings::default();
        recover_field(object, "path", &mut workspace.path);
        if workspace.path.is_empty() {
            return None;
        }
        recover_field(object, "access_code_hash", &mut workspace.access_code_hash);
        recover_field(
            object,
            "collaborator_access_code_hash",
            &mut workspace.collaborator_access_code_hash,
        );
        recover_field(object, "alias", &mut workspace.alias);
        workspace.flags = serde_json::from_value::<WorkspaceFlags>(value.clone())
            .unwrap_or_else(|_| recover_workspace_flags(object));
        Some(workspace)
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
        if self.web_editor_theme != "vscode-dark" {
            self.web_editor_theme = "follow".to_string();
        }
    }
    pub(crate) fn save_at(&self, home: &Path) -> Result<(), String> {
        let p = Self::settings_path_at(home);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let c = serde_json::to_string_pretty(self).unwrap();
        // The file stores plaintext provider api_key fields and the salt.
        // Create it 0600 up front (no world-readable window) on Unix; Windows
        // files under the user profile inherit restrictive per-user ACLs.
        crate::workspace::write_file_user_private(&p, c.as_bytes()).map_err(|e| e.to_string())?;
        if self.has_sensitive_provider_secret() {
            warn_sensitive_secret_persisted_once(&p);
        }
        Ok(())
    }

    /// True when at least one chat provider has an api_key set. Used to
    /// gate the "plaintext key on disk" warning so we don't spam users
    /// who haven't configured chat at all.
    fn has_sensitive_provider_secret(&self) -> bool {
        !self.chat.anthropic.api_key.trim().is_empty()
            || !self.chat.openai.api_key.trim().is_empty()
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
                access_code_hash: w.access_code_hash.clone(),
                collaborator_access_code_hash: w.collaborator_access_code_hash.clone(),
                alias: w.alias.clone(),
            })
            .collect();
        ServerConfig {
            host: self.host.clone(),
            advertised_host: self.advertised_host.clone(),
            port,
            // Web pages resolve theme at runtime and persist page-local
            // overrides in the browser. The persisted `web_theme` field is
            // kept only for old settings.json compatibility and is no longer
            // allowed to make light/dark a server-level concern.
            theme: "auto".to_string(),
            qr: None,
            open_browser: None,
            shared_annotation: initial_workspaces.iter().any(|w| w.flags.shared_annotation),
            db_path: self.db_path.clone(),
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
            editor_theme: self.web_editor_theme.clone(),
            access_code_hash: self.access_code_hash.clone(),
            collaborator_access_code_hash: self.collaborator_access_code_hash.clone(),
            print_collapsed_content: self.print_collapsed_content,
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
    pub(crate) fn sync_from_registry(&mut self, registry: &WorkspaceRegistry) {
        self.workspaces = registry
            .info_list()
            .into_iter()
            .filter(|info| !info.ephemeral)
            .map(|info| WorkspaceSettings {
                path: info.path,
                flags: info.flags,
                access_code_hash: info.access_code_hash,
                collaborator_access_code_hash: info.collaborator_access_code_hash,
                alias: info.alias,
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
        // Map a legacy flat colour key to its Primer-style canonical token, so
        // Page Styles overrides saved under the old names keep applying after
        // the token rename. Non-colour keys (typography, opacity, …) and
        // already-canonical names pass through unchanged.
        fn canonical(name: &str) -> &str {
            match name {
                "primary" => "accent",
                "primary-hover" => "accent-hover",
                "primary-bg" => "accent-muted",
                "canvas" => "bg-default",
                "subtle" => "bg-muted",
                "elevated" => "bg-elevated",
                "elevated-2" => "bg-elevated-2",
                "overlay" => "bg-overlay",
                "hover" => "bg-hover",
                "text" => "fg-default",
                "muted" => "fg-muted",
                "muted-hover" => "fg-muted-hover",
                "text-muted" => "fg-subtle",
                "border" => "border-default",
                "border-strong" => "border-emphasis",
                other => other,
            }
        }
        // The result is injected into a `<style>` block via `| safe`, so a key
        // or value containing CSS/HTML metacharacters could break out of the
        // declaration (`;` `}`) or the style element (`<` `>`). Legitimate
        // design-token values (colours, fonts, numbers) never contain these;
        // drop any entry that does so it falls back to the default token.
        fn css_safe(s: &str) -> bool {
            !s.contains(['<', '>', '{', '}', ';'])
        }
        if self.web_styles.is_empty() {
            return None;
        }
        let mut root: Vec<String> = Vec::new();
        let mut dark: Vec<String> = Vec::new();
        for (k, v) in &self.web_styles {
            if !css_safe(k) || !css_safe(v) {
                continue;
            }
            if let Some(base) = k.strip_suffix(".light") {
                root.push(format!("--markon-{}: {v};", canonical(base)));
            } else if let Some(base) = k.strip_suffix(".dark") {
                dark.push(format!("--markon-{}: {v};", canonical(base)));
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
    use crate::workspace::{hash_id, WorkspaceConfig};

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
    fn load_legacy_settings_with_workspaces_adopts_device_salt() {
        let home = TempHome::new("legacy-workspace-salt");
        let p = AppSettings::settings_path_at(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            r#"{
                "port": 7777,
                "workspaces": [
                    {
                        "path": "/tmp/docs",
                        "enable_viewed": true
                    }
                ]
            }"#,
        )
        .unwrap();

        let loaded = AppSettings::load_at(home.path());

        // A legacy file with no salt adopts the deterministic, device-bound salt —
        // never the (guessable) port-derived value.
        assert_eq!(loaded.salt, device_salt());
        assert!(loaded.salt.starts_with("device:"));
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(
            hash_id(Path::new(&loaded.workspaces[0].path), &loaded.salt),
            hash_id(Path::new("/tmp/docs"), &device_salt())
        );

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(saved["salt"].as_str(), Some(device_salt().as_str()));
        assert_eq!(saved["workspaces"][0]["path"].as_str(), Some("/tmp/docs"));
    }

    /// Repro: a per-workspace access_code_hash must survive the real
    /// settings.json save→load round-trip (the `#[serde(flatten)]` flags sit
    /// next to it) AND flow into the server config used to reseed the registry
    /// after a restart. If it doesn't, a restarted workspace loses its code and
    /// the gate falls back to the global code.
    #[test]
    fn workspace_access_code_hash_survives_settings_round_trip() {
        let home = TempHome::new("ws-access");
        let mut s = AppSettings::load_at(home.path());
        s.access_code_hash = "aeadd".into(); // global
        s.collaborator_access_code_hash = "c011ab".into(); // global collaborator
        s.workspaces = vec![WorkspaceSettings {
            path: "/tmp/ws".into(),
            flags: WorkspaceFlags {
                enable_search: true,
                ..Default::default()
            },
            access_code_hash: "6d243".into(),
            collaborator_access_code_hash: "c0de".into(),
            ..Default::default()
        }];
        // save_at (NOT save()) — write into the TempHome, never the real ~/.markon.
        s.save_at(home.path()).unwrap();

        let back = AppSettings::load_at(home.path());
        assert_eq!(back.workspaces.len(), 1);
        assert_eq!(
            back.workspaces[0].access_code_hash, "6d243",
            "per-workspace access code dropped on load"
        );
        assert_eq!(
            back.workspaces[0].collaborator_access_code_hash, "c0de",
            "per-workspace collaborator access code dropped on load"
        );
        assert!(back.workspaces[0].flags.enable_search);
        assert_eq!(
            back.access_code_hash, "aeadd",
            "global code dropped on load"
        );
        assert_eq!(
            back.collaborator_access_code_hash, "c011ab",
            "global collaborator code dropped on load"
        );

        let cfg = back.to_server_config(8080);
        assert_eq!(
            cfg.initial_workspaces[0].access_code_hash, "6d243",
            "access code must reach the server config that reseeds the registry"
        );
        assert_eq!(
            cfg.initial_workspaces[0].collaborator_access_code_hash, "c0de",
            "collaborator access code must reach the server config that reseeds the registry"
        );
        assert_eq!(
            cfg.collaborator_access_code_hash, "c011ab",
            "global collaborator access code must reach the server config"
        );
    }

    #[test]
    fn workspace_settings_ignore_unknown_version_fields() {
        let s: AppSettings = serde_json::from_str(
            r#"{
                "salt": "s",
                "workspaces": [
                    {
                        "path": "/docs",
                        "enable_viewed": true,
                        "snapshot_scope": {"asset_cap": 1024},
                        "git_auto_snapshot": false,
                        "access_code_hash": "abc",
                        "collaborator_access_code_hash": "def"
                    }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(s.workspaces.len(), 1);
        assert_eq!(s.workspaces[0].path, "/docs");
        assert!(s.workspaces[0].flags.enable_viewed);
        assert_eq!(s.workspaces[0].access_code_hash, "abc");
        assert_eq!(s.workspaces[0].collaborator_access_code_hash, "def");
        assert!(!s.example_workspace_hidden);

        let cfg = s.to_server_config(6419);
        assert_eq!(cfg.initial_workspaces[0].path, PathBuf::from("/docs"));
        assert!(cfg.initial_workspaces[0].flags.enable_viewed);
        assert_eq!(cfg.initial_workspaces[0].access_code_hash, "abc");
        assert_eq!(
            cfg.initial_workspaces[0].collaborator_access_code_hash,
            "def"
        );
    }

    #[test]
    fn load_schema_mismatch_recovers_salt_workspaces_and_ids() {
        let home = TempHome::new("recover-schema");
        let p = AppSettings::settings_path_at(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            r#"{
                "port": "not-a-number",
                "host": "127.0.0.1",
                "salt": "stable-salt",
                "default_chat_mode": "popout",
                "workspaces": [
                    {
                        "path": "/tmp/docs",
                        "enable_viewed": true,
                        "enable_search": "bad-bool",
                        "access_code_hash": "owner",
                        "collaborator_access_code_hash": "guest"
                    }
                ]
            }"#,
        )
        .unwrap();

        let loaded = AppSettings::load_at(home.path());

        // The salt is always the deterministic device salt — even a recoverable
        // on-disk salt is not honoured (so a copied file can't transplant ids).
        assert_eq!(loaded.salt, device_salt());
        assert_eq!(loaded.default_chat_mode, "popout");
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].path, "/tmp/docs");
        assert!(loaded.workspaces[0].flags.enable_viewed);
        assert_eq!(loaded.workspaces[0].access_code_hash, "owner");
        assert_eq!(loaded.workspaces[0].collaborator_access_code_hash, "guest");
        assert_eq!(
            hash_id(Path::new(&loaded.workspaces[0].path), &loaded.salt),
            hash_id(Path::new("/tmp/docs"), &device_salt())
        );

        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(
            raw.contains(r#""port": "not-a-number""#),
            "load_at must not overwrite a schema-mismatched settings file"
        );
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
        assert!(!s.example_workspace_hidden);
    }

    #[test]
    fn web_theme_is_ignored_by_server_config() {
        let s = AppSettings {
            theme: "dark".to_string(),
            web_theme: "auto".to_string(),
            ..AppSettings::default()
        };

        assert_eq!(s.to_server_config(6419).theme, "auto");

        let explicit = AppSettings {
            theme: "dark".to_string(),
            web_theme: "light".to_string(),
            ..AppSettings::default()
        };

        assert_eq!(explicit.to_server_config(6419).theme, "auto");
    }

    #[cfg(unix)]
    #[test]
    fn save_chmods_settings_file_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let home = TempHome::new("chmod");
        let mut s = AppSettings::load_at(home.path());
        s.chat.anthropic.api_key = "sk-ant-test-key-1234567890".to_string();
        s.save_at(home.path()).expect("save");
        let p = AppSettings::settings_path_at(home.path());
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
    }

    #[test]
    fn load_corrupt_file_returns_default() {
        let home = TempHome::new("corrupt");
        let p = AppSettings::settings_path_at(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"{garbage").unwrap();

        let s = AppSettings::load_at(home.path());
        let s2 = AppSettings::load_at(home.path());
        assert_eq!(s.port, AppSettings::default().port);
        assert_eq!(s.default_chat_mode, "in_page");
        assert_eq!(
            s.salt, s2.salt,
            "corrupt settings fallback salt must not randomly change every launch"
        );
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "{garbage",
            "corrupt settings must not be overwritten during load"
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_unreadable_file_uses_stable_recovery_salt() {
        use std::os::unix::fs::PermissionsExt;

        let home = TempHome::new("unreadable");
        let p = AppSettings::settings_path_at(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, br#"{"salt":"hidden","workspaces":[]}"#).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();

        let s1 = AppSettings::load_at(home.path());
        let s2 = AppSettings::load_at(home.path());

        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            s1.salt, s2.salt,
            "unreadable settings fallback salt must not randomly change every launch"
        );
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            r#"{"salt":"hidden","workspaces":[]}"#
        );
    }

    #[test]
    fn normalize_dedup_and_coerce() {
        let mut s = AppSettings {
            workspaces: vec![
                WorkspaceSettings {
                    path: "/a".to_string(),
                    flags: WorkspaceFlags::default(),
                    access_code_hash: String::new(),
                    collaborator_access_code_hash: String::new(),
                    ..Default::default()
                },
                WorkspaceSettings {
                    path: "/b".to_string(),
                    flags: WorkspaceFlags::default(),
                    access_code_hash: String::new(),
                    collaborator_access_code_hash: String::new(),
                    ..Default::default()
                },
                WorkspaceSettings {
                    path: "/a".to_string(),
                    flags: WorkspaceFlags::default(),
                    access_code_hash: String::new(),
                    collaborator_access_code_hash: String::new(),
                    ..Default::default()
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

        // web_editor_theme: default is "follow"; unknown/blank values are
        // canonicalized back to "follow", and "vscode-dark" is preserved.
        assert_eq!(s.web_editor_theme, "follow");
        s.web_editor_theme = "vscode-dark".to_string();
        s.normalize();
        assert_eq!(s.web_editor_theme, "vscode-dark");
        s.web_editor_theme = "bogus".to_string();
        s.normalize();
        assert_eq!(s.web_editor_theme, "follow");
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
            access_code_hash: "abc".to_string(),
            collaborator_access_code_hash: "def".to_string(),
            ..Default::default()
        });
        reg.add(WorkspaceConfig {
            path: ws_path.clone(),
            flags: WorkspaceFlags::default(),
            single_file: Some("note.md".to_string()),
            access_code_hash: String::new(),
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });

        let mut s = AppSettings::default();
        s.sync_from_registry(&reg);

        assert_eq!(s.workspaces.len(), 1, "ephemeral entry must be excluded");
        assert_eq!(s.workspaces[0].path, ws_path.to_string_lossy());
        assert_eq!(s.workspaces[0].access_code_hash, "abc");
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
        // Legacy keys migrate to the Primer-style canonical tokens.
        assert!(css.contains("--markon-accent: #0969da;"), "got: {css}");
        assert!(css.contains("--markon-fg-muted: #656d76;"), "got: {css}");
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
            css.contains("html[data-theme=\"dark\"] { --markon-accent: #58a6ff; }"),
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
            root_block.contains("--markon-accent: #0969da;"),
            "got: {root_block}"
        );
        assert!(
            root_block.contains("--markon-fg-muted: #656d76;"),
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
            dark_block.contains("--markon-accent: #58a6ff;"),
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
            db_path: Some("/tmp/markon.sqlite".to_string()),
            workspaces: vec![WorkspaceSettings {
                path: "/docs".to_string(),
                flags: WorkspaceFlags::default(),
                access_code_hash: String::new(),
                collaborator_access_code_hash: String::new(),
                ..Default::default()
            }],
            ..AppSettings::default()
        };

        let cfg = s.to_server_config(7777);

        assert_eq!(cfg.salt, Some("mysalt".to_string()));
        assert_eq!(cfg.db_path, Some("/tmp/markon.sqlite".to_string()));
        assert_eq!(cfg.port, 7777);
        assert_eq!(cfg.initial_workspaces.len(), 1);
        assert_eq!(cfg.initial_workspaces[0].path, Path::new("/docs"));
        // editor preset defaults to "follow" and rides through to the config.
        assert_eq!(cfg.editor_theme, "follow");
    }

    #[test]
    fn advertised_host_defaults_empty_and_propagates() {
        // Absent from older settings.json → empty (serde default).
        let s: AppSettings = serde_json::from_str(r#"{"host":"0.0.0.0"}"#).unwrap();
        assert_eq!(s.host, "0.0.0.0");
        assert_eq!(s.advertised_host, "");

        // Set value flows through to the server config.
        let s2 = AppSettings {
            host: "0.0.0.0".to_string(),
            advertised_host: "192.168.1.20".to_string(),
            ..AppSettings::default()
        };
        assert_eq!(s2.to_server_config(6419).advertised_host, "192.168.1.20");
    }
}
