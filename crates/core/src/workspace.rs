use crate::chat::edits::PendingEditStore;
use crate::markdown::extract_referenced_assets;
use crate::search::SearchIndex;
use arc_swap::ArcSwapOption;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceFlags {
    #[serde(default)]
    pub enable_search: bool,
    #[serde(default)]
    pub enable_viewed: bool,
    #[serde(default)]
    pub enable_edit: bool,
    #[serde(default)]
    pub enable_live: bool,
    #[serde(default)]
    pub enable_chat: bool,
    #[serde(default)]
    pub shared_annotation: bool,
}

#[derive(Clone)]
pub struct WorkspaceConfig {
    pub path: PathBuf,
    pub flags: WorkspaceFlags,
    /// `Some(name)` → the workspace exposes only `name` (relative to `path`)
    /// plus assets that file references. Used by Open-With on macOS so that
    /// opening `~/Downloads/note.md` does not turn `~/Downloads` into an
    /// indexed, browsable workspace. Ephemeral (not persisted).
    pub single_file: Option<String>,
    /// Per-workspace access-code hash (empty = inherit the server code).
    pub access_code_hash: String,
}

pub(crate) struct WorkspaceEntry {
    pub id: String,
    pub root: PathBuf,
    pub enable_search: AtomicBool,
    pub enable_viewed: AtomicBool,
    pub enable_edit: AtomicBool,
    pub enable_live: AtomicBool,
    pub enable_chat: AtomicBool,
    pub shared_annotation: AtomicBool,
    pub config_tx: broadcast::Sender<()>,
    pub search_index: ArcSwapOption<SearchIndex>,
    /// Set for single-file ephemeral workspaces. Holds the file name (relative
    /// to `root`); routes outside this file + `allowed_assets` return 404.
    pub single_file: Option<String>,
    /// Co-located assets the single-file's markdown references (images,
    /// stylesheets, etc.). Re-derived whenever the file is modified.
    /// Empty (and unread) for normal directory workspaces.
    pub allowed_assets: RwLock<HashSet<String>>,
    /// In-flight `edit_file` proposals from the chat tool, awaiting the
    /// user's accept/reject. Lives on the workspace so HTTP handlers and
    /// the agent loop can share the same store.
    pub pending_edits: Arc<PendingEditStore>,
    /// Per-workspace access-code hash (empty = inherit server code). RwLock so
    /// the GUI can update it live without re-registering the workspace.
    pub access_code_hash: RwLock<String>,
}

impl WorkspaceEntry {
    pub(crate) fn search_ready(&self) -> bool {
        self.enable_search.load(Ordering::Relaxed) && self.search_index.load().is_some()
    }

    pub(crate) fn flags(&self) -> WorkspaceFlags {
        WorkspaceFlags {
            enable_search: self.enable_search.load(Ordering::Relaxed),
            enable_viewed: self.enable_viewed.load(Ordering::Relaxed),
            enable_edit: self.enable_edit.load(Ordering::Relaxed),
            enable_live: self.enable_live.load(Ordering::Relaxed),
            enable_chat: self.enable_chat.load(Ordering::Relaxed),
            shared_annotation: self.shared_annotation.load(Ordering::Relaxed),
        }
    }

    pub(crate) fn is_ephemeral(&self) -> bool {
        self.single_file.is_some()
    }

    pub(crate) fn access_code_hash(&self) -> String {
        self.access_code_hash.read().unwrap().clone()
    }

    /// True when `rel` is the workspace's pinned file or one of the assets it
    /// currently references. Always true for non-single-file workspaces.
    pub(crate) fn allows(&self, rel: &str) -> bool {
        let Some(only) = &self.single_file else {
            return true;
        };
        if rel == only {
            return true;
        }
        self.allowed_assets.read().unwrap().contains(rel)
    }
}

/// Workspace info as serialized to JSON by `GET /api/workspaces`. Lives here
/// because it's built from [`WorkspaceEntry`] state, but its only public
/// contract is the wire format — see `crate::server::api` for the canonical
/// re-export.
#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    /// Workspace **serving root** — what `/{id}/…` resolves under. For
    /// single-file (ephemeral) workspaces this is the parent directory, not
    /// the file itself; the file name lives in `single_file`. Consumers that
    /// render a user-visible path **must** join the two for ephemeral entries
    /// (or filter ephemeral entries out entirely).
    pub path: String,
    #[serde(flatten)]
    pub flags: WorkspaceFlags,
    pub search_ready: bool,
    /// True for single-file workspaces — the GUI's Settings list filters these
    /// out (they're created by Open-With and live in memory only).
    pub ephemeral: bool,
    /// `Some(filename)` only when ephemeral, for callers that want to display
    /// or re-derive the URL. Omitted from the wire format when None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub single_file: Option<String>,
    /// Per-workspace access-code hash (empty = inherit the server code).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub access_code_hash: String,
}

/// Invoked whenever the registry mutates (add / update_flags / remove).
/// The host (GUI or CLI daemon) wires this to persist workspaces to
/// `~/.markon/settings.json` so CLI-driven and GUI-driven changes are
/// treated identically.
pub type PersistHook = Arc<dyn Fn(&WorkspaceRegistry) + Send + Sync>;

pub struct WorkspaceRegistry {
    inner: RwLock<HashMap<String, Arc<WorkspaceEntry>>>,
    pub(crate) salt: String,
    persist: RwLock<Option<PersistHook>>,
    /// Shared broadcaster the server populates once its WS channel is alive.
    /// Watchers spawned by `add()` capture a clone of this Arc and read it
    /// lazily on each event, so setting the broadcaster after some entries
    /// already exist still wires them up correctly.
    live_tx: Arc<ArcSwapOption<broadcast::Sender<String>>>,
}

/// Stable workspace id: truncated SHA-256 of salt + path.
pub fn hash_id(path: &Path, salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b"\0");
    h.update(path.as_os_str().to_string_lossy().as_bytes());
    let digest = h.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

/// Hash an access code for storage and comparison. Salted with the per-install
/// salt (so the stored value isn't a bare SHA-256 of a often-weak code, and so
/// it can't be precomputed without reading the 0600 settings file) and
/// domain-separated from workspace-id hashing.
///
/// The result is truncated to **as many leading hex chars as the code has
/// characters**, so the stored length equals the code length — the panel uses
/// that to render the right number of `•` in the "code is set" token without
/// being able to recover the code. Verification stays consistent because both
/// store and check route through this function: the candidate is truncated by
/// *its own* length, so the correct code (same length) still matches, and a
/// wrong-length guess can't. Trade-off: very short codes are checked against
/// only a few hex chars — rely on a reasonable code length (the per-IP unlock
/// cooldown also throttles guessing).
pub fn hash_access_code(salt: &str, code: &str) -> String {
    let hex = access_code_digest(salt, code);
    let n = code.chars().count().min(hex.len());
    hex[..n].to_string()
}

/// Full (untruncated) salted digest of an access code, as 64 hex chars.
fn access_code_digest(salt: &str, code: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b"\0mk-access\0");
    h.update(code.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Verify a submitted access code against a stored hash. Owns both schemes:
/// the current length-truncated form (see [`hash_access_code`]) and, when the
/// stored value is a full 64-char digest, the legacy untruncated form written
/// before truncation existed — so codes set by older builds keep unlocking
/// after an upgrade instead of silently never matching.
pub fn access_code_matches(salt: &str, code: &str, stored: &str) -> bool {
    if stored.is_empty() {
        return false;
    }
    let full = access_code_digest(salt, code);
    let n = code.chars().count().min(full.len());
    if ct_eq(&full.as_bytes()[..n], stored.as_bytes()) {
        return true;
    }
    stored.len() == full.len() && ct_eq(full.as_bytes(), stored.as_bytes())
}

/// Constant-time byte comparison (length leak is fine — lengths aren't secret).
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Cryptographically-random 32-hex-char token. Used as the management API
/// bearer (`X-Markon-Token`) and as the per-install salt for workspace IDs.
/// Backed by `uuid::Uuid::new_v4` which sources 122 bits of entropy from the
/// OS RNG — a meaningful upgrade over a hash of `SystemTime + pid`.
pub(crate) fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Write a file that holds secrets (management token, salt, provider api keys)
/// with owner-only (0600) permissions and **no world-readable window**: on Unix
/// the file is created with mode 0600 up front (closing the create-then-chmod
/// TOCTOU gap), then re-tightened afterwards in case it pre-existed with looser
/// bits (`mode()` only applies on creation). On non-Unix we fall back to a plain
/// write — files under the user profile inherit restrictive per-user ACLs.
pub(crate) fn write_file_user_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents)?;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

/// Expand `~` / `～` and canonicalize (dunce strips the `\\?\` verbatim prefix
/// on Windows so UI-visible paths stay clean).
pub fn expand_and_canonicalize(raw: &str) -> std::io::Result<PathBuf> {
    let normalized = if raw.starts_with('～') {
        raw.replacen('～', "~", 1)
    } else {
        raw.to_string()
    };
    let expanded = if normalized.starts_with("~/") || normalized == "~" {
        dirs::home_dir()
            .map(|home| {
                if normalized == "~" {
                    home
                } else {
                    home.join(&normalized[2..])
                }
            })
            .unwrap_or_else(|| PathBuf::from(&normalized))
    } else {
        PathBuf::from(&normalized)
    };
    dunce::canonicalize(&expanded).or(Ok(expanded))
}

impl WorkspaceRegistry {
    pub fn new(salt: String) -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            salt,
            persist: RwLock::new(None),
            live_tx: Arc::new(ArcSwapOption::empty()),
        }
    }
    pub fn set_persist_hook(&self, hook: PersistHook) {
        *self.persist.write().unwrap() = Some(hook);
    }
    /// Wire a broadcast sender that watchers use to push file-change events to
    /// connected browser tabs. Pass `None` to disconnect (e.g. on shutdown).
    pub(crate) fn set_live_broadcaster(&self, tx: Option<broadcast::Sender<String>>) {
        self.live_tx.store(tx.map(Arc::new));
    }
    fn notify_persist(&self) {
        let hook = self.persist.read().unwrap().clone();
        if let Some(hook) = hook {
            hook(self);
        }
    }
    pub fn add(&self, config: WorkspaceConfig) -> String {
        // Hash on the workspace's identity, not its serving root: a single-file
        // workspace and an enclosing directory workspace coexist with distinct
        // ids even though they share the same `root` (parent dir). Same file
        // re-opened → same id → idempotent reuse.
        let identity = match &config.single_file {
            Some(name) => config.path.join(name),
            None => config.path.clone(),
        };
        let id = hash_id(&identity, &self.salt);
        // Idempotent: same identity registered twice just updates flags on the
        // existing entry instead of spawning a second indexer thread.
        if self.inner.read().unwrap().contains_key(&id) {
            self.update_flags(&id, config.flags);
            return id;
        }
        let (config_tx, _) = broadcast::channel(4);
        let single_file = config.single_file.clone();
        let entry = Arc::new(WorkspaceEntry {
            id: id.clone(),
            root: config.path.clone(),
            enable_search: AtomicBool::new(config.flags.enable_search),
            enable_viewed: AtomicBool::new(config.flags.enable_viewed),
            enable_edit: AtomicBool::new(config.flags.enable_edit),
            enable_live: AtomicBool::new(config.flags.enable_live),
            enable_chat: AtomicBool::new(config.flags.enable_chat),
            shared_annotation: AtomicBool::new(config.flags.shared_annotation),
            config_tx,
            search_index: ArcSwapOption::empty(),
            single_file: single_file.clone(),
            allowed_assets: RwLock::new(HashSet::new()),
            pending_edits: Arc::new(PendingEditStore::new()),
            access_code_hash: RwLock::new(config.access_code_hash),
        });
        self.inner
            .write()
            .unwrap()
            .insert(id.clone(), entry.clone());
        match single_file {
            Some(name) => {
                // Seed allowed_assets from the file's current content, then watch
                // for external edits to keep it fresh. Search indexing is
                // suppressed regardless of `enable_search` — single-file mode
                // skips the tantivy spin-up entirely (use Cmd/Ctrl+F instead).
                refresh_allowed_assets(&entry, &name);
                spawn_single_file_watcher(config.path, entry, name, self.live_tx.clone());
            }
            None => {
                if config.flags.enable_search {
                    spawn_search_indexer(config.path, entry);
                }
            }
        }
        self.notify_persist();
        id
    }
    pub fn update_flags(&self, id: &str, flags: WorkspaceFlags) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id).cloned() else {
            return false;
        };
        drop(guard);
        let was_search = entry
            .enable_search
            .swap(flags.enable_search, Ordering::Relaxed);
        entry
            .enable_viewed
            .store(flags.enable_viewed, Ordering::Relaxed);
        entry
            .enable_edit
            .store(flags.enable_edit, Ordering::Relaxed);
        entry
            .enable_live
            .store(flags.enable_live, Ordering::Relaxed);
        entry
            .enable_chat
            .store(flags.enable_chat, Ordering::Relaxed);
        entry
            .shared_annotation
            .store(flags.shared_annotation, Ordering::Relaxed);
        let _ = entry.config_tx.send(());
        if flags.enable_search && !was_search && entry.search_index.load().is_none() {
            let root = entry.root.clone();
            spawn_search_indexer(root, entry);
        }
        self.notify_persist();
        true
    }
    pub fn remove(&self, id: &str) -> bool {
        let removed = self.inner.write().unwrap().remove(id).is_some();
        if removed {
            self.notify_persist();
        }
        removed
    }
    pub(crate) fn get(&self, id: &str) -> Option<Arc<WorkspaceEntry>> {
        self.inner.read().unwrap().get(id).cloned()
    }
    /// Set (or clear, with an empty string) a workspace's access-code hash and
    /// persist. Returns false if the id isn't registered.
    pub fn set_access_code(&self, id: &str, hash: &str) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id) else {
            return false;
        };
        *entry.access_code_hash.write().unwrap() = hash.to_string();
        drop(guard);
        self.notify_persist();
        true
    }
    pub(crate) fn list(&self) -> Vec<Arc<WorkspaceEntry>> {
        self.inner.read().unwrap().values().cloned().collect()
    }
    pub fn info_list(&self) -> Vec<WorkspaceInfo> {
        self.list()
            .into_iter()
            .map(|e| WorkspaceInfo {
                id: e.id.clone(),
                path: e.root.to_string_lossy().to_string(),
                flags: e.flags(),
                search_ready: e.search_ready(),
                ephemeral: e.is_ephemeral(),
                single_file: e.single_file.clone(),
                access_code_hash: e.access_code_hash(),
            })
            .collect()
    }
}

/// Read the single-file's current content and replace `entry.allowed_assets`
/// with the asset paths it references. Errors (file gone, unreadable) clear
/// the set — a missing source can't legitimately bless any sibling.
fn refresh_allowed_assets(entry: &WorkspaceEntry, file_name: &str) {
    let abs = entry.root.join(file_name);
    let new_set = match std::fs::read_to_string(&abs) {
        Ok(content) => extract_referenced_assets(&content),
        Err(_) => HashSet::new(),
    };
    *entry.allowed_assets.write().unwrap() = new_set;
}

/// Shared scaffold for the notify-based watchers below: spawn a thread that
/// owns the channel and watcher, forward Ok events, and run `on_event` for
/// each one. The thread exits (dropping the watcher) when the watch cannot
/// be established or the channel closes.
fn spawn_watch_thread(
    root: PathBuf,
    mode: RecursiveMode,
    mut on_event: impl FnMut(notify::Event) + Send + 'static,
) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(move |res| {
            if let Ok(e) = res {
                let _ = tx.send(e);
            }
        }) else {
            return;
        };
        if watcher.watch(&root, mode).is_err() {
            return;
        }
        while let Ok(event) = rx.recv() {
            on_event(event);
        }
    });
}

/// Watch the parent directory of a single-file workspace and:
///   * filter events down to `{file_name} ∪ allowed_assets`
///   * on changes to `file_name`, re-derive the asset allowlist so that newly
///     referenced images become accessible (and removed ones stop being)
///   * push a `file_changed` WS message so the open browser tab reloads.
///
/// `notify` cannot reliably watch a single file across platforms, so the
/// minimum viable scope is the parent directory — non-recursive.
fn spawn_single_file_watcher(
    root: PathBuf,
    entry: Arc<WorkspaceEntry>,
    file_name: String,
    live_tx: Arc<ArcSwapOption<broadcast::Sender<String>>>,
) {
    let target = root.join(&file_name);
    spawn_watch_thread(
        root.clone(),
        RecursiveMode::NonRecursive,
        move |event: notify::Event| {
            for path in event.paths {
                let Ok(rel) = path.strip_prefix(&root) else {
                    continue;
                };
                let rel_str = rel.to_string_lossy().to_string();
                let touched_pinned = path == target;
                let touched_asset = entry.allowed_assets.read().unwrap().contains(&rel_str);
                if !(touched_pinned || touched_asset) {
                    continue;
                }
                let mut should_broadcast = false;
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        if touched_pinned {
                            refresh_allowed_assets(&entry, &file_name);
                        }
                        should_broadcast = true;
                    }
                    // Don't broadcast for Remove: the file just went away,
                    // reloading would 404 the tab.
                    EventKind::Remove(_) if touched_pinned => {
                        entry.allowed_assets.write().unwrap().clear();
                    }
                    _ => {}
                }
                if should_broadcast {
                    if let Some(tx) = live_tx.load_full() {
                        let payload = serde_json::json!({
                            "type": "file_changed",
                            "workspace_id": entry.id,
                            "path": rel_str,
                        })
                        .to_string();
                        let _ = tx.send(payload);
                    }
                }
            }
        },
    );
}

fn spawn_search_indexer(root: PathBuf, entry: Arc<WorkspaceEntry>) {
    std::thread::spawn(move || {
        if let Ok(idx) = SearchIndex::new(&root) {
            let idx = Arc::new(idx);
            entry.search_index.store(Some(idx.clone()));
            start_file_watcher(idx, root);
        }
    });
}

fn start_file_watcher(index: Arc<SearchIndex>, root: PathBuf) {
    spawn_watch_thread(
        root,
        RecursiveMode::Recursive,
        move |event: notify::Event| {
            for path in event.paths {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        let _ = index.update_file(&path);
                    }
                    EventKind::Remove(_) => {
                        let _ = index.delete_file(&path);
                    }
                    _ => {}
                }
            }
        },
    );
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ServerLock {
    pub port: u16,
    pub token: String,
    /// Bind host the daemon was started with (e.g. `0.0.0.0`). Lets a CLI that
    /// registers a workspace into an already-running daemon reproduce the same
    /// reachable/featured URLs. `#[serde(default)]` keeps old lock files (which
    /// predate this field) readable — they deserialize to an empty string,
    /// which callers treat as loopback.
    #[serde(default)]
    pub host: String,
}
impl ServerLock {
    pub(crate) fn path() -> PathBuf {
        dirs::home_dir()
            .expect("HOME directory required")
            .join(".markon")
            .join("server.lock")
    }
    pub(crate) fn write(&self) -> std::io::Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_file_user_private(&path, serde_json::to_string(self).unwrap().as_bytes())
    }
    pub fn read() -> Option<Self> {
        let path = Self::path();
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("cannot read server lock {}: {e}", path.display());
                }
                return None;
            }
        };
        match serde_json::from_str(&content) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!(
                    "corrupted server lock file {}: {e}; ignoring",
                    path.display()
                );
                None
            }
        }
    }
    pub(crate) fn remove() {
        let _ = std::fs::remove_file(Self::path());
    }
    pub fn is_alive(&self) -> bool {
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], self.port)),
            std::time::Duration::from_millis(500),
        )
        .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_id_is_deterministic() {
        let p = std::path::Path::new("/tmp/test");
        assert_eq!(hash_id(p, "s"), hash_id(p, "s"));
    }

    #[test]
    fn hash_id_depends_on_salt() {
        let p = std::path::Path::new("/tmp/test");
        assert_ne!(hash_id(p, "a"), hash_id(p, "b"));
    }

    #[test]
    fn access_code_hash_len_equals_code_len() {
        assert_eq!(hash_access_code("s", "test123").len(), 7);
        assert_eq!(hash_access_code("s", "").len(), 0);
    }

    #[test]
    fn access_code_matches_current_scheme() {
        let stored = hash_access_code("s", "test123");
        assert!(access_code_matches("s", "test123", &stored));
        assert!(!access_code_matches("s", "test124", &stored));
        // Wrong length can't match a truncated hash.
        assert!(!access_code_matches("s", "test1234", &stored));
        // Empty stored hash gates nothing.
        assert!(!access_code_matches("s", "anything", ""));
    }

    #[test]
    fn access_code_matches_legacy_full_hash() {
        // Pre-truncation builds stored the full 64-char digest; those codes
        // must keep unlocking after an upgrade.
        let legacy = access_code_digest("s", "test123");
        assert_eq!(legacy.len(), 64);
        assert!(access_code_matches("s", "test123", &legacy));
        assert!(!access_code_matches("s", "wrong", &legacy));
    }

    #[test]
    fn server_lock_host_defaults_when_absent() {
        // Old lock files predate the `host` field; they must still deserialize.
        let old = r#"{"port":6419,"token":"abc"}"#;
        let lock: ServerLock = serde_json::from_str(old).unwrap();
        assert_eq!(lock.port, 6419);
        assert_eq!(lock.token, "abc");
        assert_eq!(lock.host, "");
    }

    #[test]
    fn server_lock_host_round_trips() {
        let lock = ServerLock {
            port: 6419,
            token: "tok".into(),
            host: "0.0.0.0".into(),
        };
        let json = serde_json::to_string(&lock).unwrap();
        let back: ServerLock = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "0.0.0.0");
        assert_eq!(back.port, 6419);
        assert_eq!(back.token, "tok");
    }
}
