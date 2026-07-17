use crate::chat::edits::PendingEditStore;
use crate::fswalk::path_to_forward_slash;
use crate::markdown::extract_referenced_assets_for_file;
use crate::search::SearchIndex;
use crate::workspace_fs::WorkspaceFs;
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

const LIVE_RELOAD_EXTENSIONS: &[&str] = &[
    "md", "markdown", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "css", "js",
];
const LIVE_RELOAD_IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target"];

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

#[derive(Clone, Default)]
pub struct WorkspaceConfig {
    pub path: PathBuf,
    pub flags: WorkspaceFlags,
    /// `Some(name)` → a single-file workspace rooted at the file's parent
    /// directory. It exposes only `name` plus local assets that file explicitly
    /// references and that canonicalize inside `path`. Used by Open-With on
    /// macOS so opening `~/Downloads/note.md` can render `logo.svg` next to it
    /// without turning `~/Downloads` into an indexed, browsable workspace.
    /// Treated as temporary; settings may persist it so startup policy can
    /// either restore or automatically remove it.
    pub single_file: Option<String>,
    /// Per-workspace collaborator access-code hash (empty = inherit the
    /// server-level collaborator code).
    pub collaborator_access_code_hash: String,
    /// Optional short display name shown instead of the (often long) path.
    /// Purely cosmetic — never part of `hash_id`.
    pub alias: String,
}

pub(crate) struct WorkspaceEntry {
    pub id: String,
    pub fs: Arc<WorkspaceFs>,
    pub enable_search: AtomicBool,
    pub enable_viewed: AtomicBool,
    pub enable_edit: AtomicBool,
    pub enable_live: AtomicBool,
    pub enable_chat: AtomicBool,
    pub shared_annotation: AtomicBool,
    pub config_tx: broadcast::Sender<()>,
    /// Collaboration events are scoped to this workspace by construction.
    /// Channel events are further isolated by document/surface identity;
    /// workspace events (currently file watcher reloads) reach every socket
    /// attached to this entry.
    pub events_tx: broadcast::Sender<WorkspaceEvent>,
    pub search_index: ArcSwapOption<SearchIndex>,
    /// Set for temporary single-file workspaces. Holds the file name (relative
    /// to the filesystem capability root). Serving policy lives in `fs`.
    pub single_file: Option<String>,
    /// In-flight `edit_file` proposals from the chat tool, awaiting the
    /// user's accept/reject. Lives on the workspace so HTTP handlers and
    /// the agent loop can share the same store.
    pub pending_edits: Arc<PendingEditStore>,
    /// Per-workspace collaborator access-code hash (empty = inherit the
    /// server-level collaborator code).
    pub collaborator_access_code_hash: RwLock<String>,
    /// Optional short display name (empty = none). RwLock so the GUI/web can
    /// rename a workspace live without re-registering it.
    pub alias: RwLock<String>,
    /// Shutdown flag for the background watch thread. `remove()` sets it before
    /// dropping the map entry; the watch loop observes it and exits, dropping
    /// its own `Arc<WorkspaceEntry>` so the OS thread and the in-RAM search
    /// index this entry holds are freed instead of leaking after removal.
    stopped: Arc<AtomicBool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceEvent {
    Channel { channel: String, payload: String },
    Workspace { payload: String },
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
        self.fs.is_single_file()
    }

    pub(crate) fn collaborator_access_code_hash(&self) -> String {
        self.collaborator_access_code_hash.read().unwrap().clone()
    }

    pub(crate) fn alias(&self) -> String {
        self.alias.read().unwrap().clone()
    }
}

/// Workspace info as serialized to JSON by `GET /api/workspaces`. Lives here
/// because it's built from [`WorkspaceEntry`] state, but its only public
/// contract is the wire format — see `crate::server::api` for the canonical
/// re-export.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceInfo {
    pub id: String,
    /// Workspace **serving root** — what `/{id}/…` resolves under. For
    /// temporary single-file workspaces this is the parent directory, not
    /// the file itself; the file name lives in `single_file`. Consumers that
    /// render a user-visible path **must** join the two for ephemeral entries
    /// (or filter ephemeral entries out entirely).
    pub path: String,
    #[serde(flatten)]
    pub flags: WorkspaceFlags,
    pub search_ready: bool,
    /// True for temporary single-file workspaces created by Open-With.
    pub ephemeral: bool,
    /// `Some(filename)` only when ephemeral, for callers that want to display
    /// or re-derive the URL. Omitted from the wire format when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub single_file: Option<String>,
    /// Per-workspace collaborator access-code hash (empty = inherit the server code).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub collaborator_access_code_hash: String,
    /// Optional short display name (empty = none).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub alias: String,
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

/// Minimum length (in characters) for a newly set collaborator access code.
/// Empty means "clear the code" and is always allowed; a non-empty code shorter
/// than this is rejected at the set-code entry points (GUI / CLI). Existing
/// full-width hashes are not re-validated; legacy truncated hashes deliberately
/// fail closed and must be replaced by a local administrator.
pub const MIN_ACCESS_CODE_LEN: usize = 8;

/// Validate a would-be access code before hashing. `Ok(())` for the empty
/// string (which clears the code) and for any code of at least
/// [`MIN_ACCESS_CODE_LEN`] characters; `Err(message)` otherwise. Callers should
/// `trim()` first (empty-after-trim clears). Centralized here so the GUI command
/// and the CLI flag enforce the same floor.
pub fn validate_access_code(code: &str) -> Result<(), String> {
    let code = code.trim();
    let len = code.chars().count();
    if !code.is_empty() && len < MIN_ACCESS_CODE_LEN {
        return Err(format!(
            "access code must be at least {MIN_ACCESS_CODE_LEN} characters (got {len})"
        ));
    }
    Ok(())
}

/// Hash an access code for storage and comparison. Salted with the per-install
/// salt (so the stored value isn't a bare SHA-256 of an often-weak code, and so
/// it can't be precomputed without reading the 0600 settings file) and
/// domain-separated from workspace-id hashing.
///
/// Returns the **full** 64-hex-char digest. An earlier scheme truncated this to
/// the code's character count (to let the panel render one `•` per character),
/// which capped the effective strength at 4·N bits and let any string sharing
/// the same leading N hex chars unlock — so a short code was far weaker than it
/// looked. Storing the full digest removes both problems; the panel now shows a
/// fixed "code is set" marker instead of the real length. Legacy truncated
/// hashes cannot be migrated safely without the plaintext code: accepting them
/// would preserve the prefix-collision vulnerability, so verification rejects
/// them and requires a local administrator to set a new code.
///
/// An empty `code` hashes to the empty string, preserving the "no code stored"
/// sentinel that setters and [`access_code_matches`] treat as "gate disabled".
pub fn hash_access_code(salt: &str, code: &str) -> String {
    if code.is_empty() {
        return String::new();
    }
    access_code_digest(salt, code)
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

/// Verify a submitted access code against the current full 64-hex-char digest
/// (see [`hash_access_code`]). Legacy length-truncated hashes deliberately fail
/// closed: continuing to compare only their prefix would keep the exact
/// collision weakness this format change removes.
pub fn access_code_matches(salt: &str, code: &str, stored: &str) -> bool {
    if stored.is_empty() {
        return false;
    }
    let full = access_code_digest(salt, code);
    ct_eq(full.as_bytes(), stored.as_bytes())
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
/// with owner-only (0600) permissions and **no world-readable window**, and
/// **atomically** — a crash mid-write must never leave a truncated
/// `settings.json` (which holds the per-install salt and provider API keys).
///
/// Strategy: write the full contents into a uniquely-named temp file in the
/// **same directory** (so `rename` stays on one filesystem and is therefore
/// atomic), fsync it, then `rename` it over the destination. `rename(2)`
/// atomically replaces the destination inode, so a reader/observer always sees
/// either the old complete file or the new complete file — never a partial one.
/// On Unix the temp is created with mode 0600 up front (closing the
/// create-then-chmod TOCTOU gap); since `rename` swaps in that fresh inode, the
/// destination ends up 0600 regardless of any looser bits it previously had. On
/// non-Unix we temp+rename as well — files under the user profile inherit
/// restrictive per-user ACLs. On any error the temp file is removed.
pub(crate) fn write_file_user_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Unique temp name in the destination directory: pid + a process-global
    // counter guarantees no collision between concurrent or repeated writes.
    static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("settings");
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{stem}.tmp.{}.{seq}", std::process::id()));

    let write_tmp = || -> std::io::Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        Ok(())
    };

    if let Err(e) = write_tmp() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        tracing::warn!(
            "atomic rename of {} onto {} failed: {e}",
            tmp.display(),
            path.display()
        );
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
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
        }
    }
    pub fn set_persist_hook(&self, hook: PersistHook) {
        *self.persist.write().unwrap() = Some(hook);
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
            self.notify_persist();
            return id;
        }
        let (config_tx, _) = broadcast::channel(4);
        let (events_tx, _) = broadcast::channel(100);
        let single_file = config.single_file.clone();
        let workspace_fs = Arc::new(WorkspaceFs::new(
            config.path.clone(),
            single_file.as_deref(),
        ));
        let entry = Arc::new(WorkspaceEntry {
            id: id.clone(),
            fs: workspace_fs,
            enable_search: AtomicBool::new(config.flags.enable_search),
            enable_viewed: AtomicBool::new(config.flags.enable_viewed),
            enable_edit: AtomicBool::new(config.flags.enable_edit),
            enable_live: AtomicBool::new(config.flags.enable_live),
            enable_chat: AtomicBool::new(config.flags.enable_chat),
            shared_annotation: AtomicBool::new(config.flags.shared_annotation),
            config_tx,
            events_tx,
            search_index: ArcSwapOption::empty(),
            single_file: single_file.clone(),
            pending_edits: Arc::new(PendingEditStore::new()),
            collaborator_access_code_hash: RwLock::new(config.collaborator_access_code_hash),
            alias: RwLock::new(config.alias),
            stopped: Arc::new(AtomicBool::new(false)),
        });
        self.inner
            .write()
            .unwrap()
            .insert(id.clone(), entry.clone());
        match single_file {
            Some(name) => {
                // Seed scoped assets from the file's current content, then watch
                // for external edits to keep it fresh. When search is enabled,
                // build an index scoped to ONLY this file (no parent WalkDir, no
                // sibling leakage); the single-file watcher refreshes it on edit.
                refresh_allowed_assets(&entry, &name);
                if config.flags.enable_search {
                    spawn_search_indexer(entry.clone());
                }
                spawn_single_file_watcher(config.path, entry.clone(), name);
            }
            None => {
                if config.flags.enable_search {
                    spawn_search_indexer(entry.clone());
                }
                spawn_directory_watcher(config.path, entry.clone());
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
        // Mirror the spawn/clear semantics for both directory and single-file
        // workspaces: turning search on spawns the appropriate indexer, turning
        // it off drops the index so we stop serving stale results and free RAM.
        if flags.enable_search && !was_search && entry.search_index.load().is_none() {
            spawn_search_indexer(entry);
        } else if !flags.enable_search && was_search {
            entry.search_index.store(None);
        }
        self.notify_persist();
        true
    }
    pub fn remove(&self, id: &str) -> bool {
        let removed = self.inner.write().unwrap().remove(id);
        if let Some(entry) = &removed {
            // Existing HTTP lookups stop immediately when the entry leaves the
            // registry. Wake all config/collaboration sockets as well so an
            // already-upgraded connection cannot outlive a detached workspace.
            entry.stopped.store(true, Ordering::Relaxed);
            let _ = entry.config_tx.send(());
            self.notify_persist();
        }
        removed.is_some()
    }
    pub(crate) fn get(&self, id: &str) -> Option<Arc<WorkspaceEntry>> {
        self.inner.read().unwrap().get(id).cloned()
    }
    /// Set (or clear) a workspace's collaborator access-code hash and persist.
    /// Returns false if the id isn't registered.
    pub fn set_collaborator_access_code(&self, id: &str, hash: &str) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id) else {
            return false;
        };
        *entry.collaborator_access_code_hash.write().unwrap() = hash.to_string();
        let _ = entry.config_tx.send(());
        drop(guard);
        self.notify_persist();
        true
    }

    /// Set (or clear, with an empty string) a workspace's alias and persist.
    /// Returns false if the id isn't registered.
    pub fn set_alias(&self, id: &str, alias: &str) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id) else {
            return false;
        };
        *entry.alias.write().unwrap() = alias.to_string();
        drop(guard);
        self.notify_persist();
        true
    }
    pub(crate) fn list(&self) -> Vec<Arc<WorkspaceEntry>> {
        let mut v: Vec<_> = self.inner.read().unwrap().values().cloned().collect();
        // HashMap iteration order is non-deterministic, which leaked into the
        // workspace list (GUI + `GET /api/workspaces`) and `settings.json`
        // (re-written in a different order each save). Sort by serving root,
        // then pinned file name, so the order is stable and path-alphabetical —
        // single-file entries group under their parent dir. (root, single_file)
        // is the workspace identity, so this key is unique and total.
        v.sort_by(|a, b| {
            a.fs.ambient_root()
                .cmp(b.fs.ambient_root())
                .then_with(|| a.single_file.cmp(&b.single_file))
        });
        v
    }
    pub fn info_list(&self) -> Vec<WorkspaceInfo> {
        self.list()
            .into_iter()
            .map(|e| WorkspaceInfo {
                id: e.id.clone(),
                path: e.fs.ambient_root().to_string_lossy().to_string(),
                flags: e.flags(),
                search_ready: e.search_ready(),
                ephemeral: e.is_ephemeral(),
                single_file: e.single_file.clone(),
                collaborator_access_code_hash: e.collaborator_access_code_hash(),
                alias: e.alias(),
            })
            .collect()
    }
}

/// Read the single-file's current content and replace its scoped asset map
/// with the local asset paths it explicitly references. Errors (file gone,
/// unreadable) clear the set — a missing source can't legitimately bless any
/// sibling.
fn refresh_allowed_assets(entry: &WorkspaceEntry, file_name: &str) {
    let root = entry.fs.ambient_root();
    let abs = root.join(file_name);
    let new_set = match std::fs::read_to_string(&abs) {
        Ok(content) => extract_referenced_assets_for_file(&content, &abs, root),
        Err(_) => HashSet::new(),
    };
    entry.fs.replace_assets(new_set);
}

/// Shared scaffold for the notify-based watchers below: spawn a thread that
/// owns the channel and watcher, forward Ok events, and run `on_event` for
/// each one. The thread exits (dropping the watcher) when the watch cannot
/// be established, the channel closes, or `stopped` is set (workspace removed).
fn spawn_watch_thread(
    root: PathBuf,
    mode: RecursiveMode,
    stopped: Arc<AtomicBool>,
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
        // Poll with a timeout rather than a bare `recv()` so the thread wakes
        // periodically to observe `stopped` even when no filesystem events
        // arrive. A removed workspace would otherwise block here forever,
        // leaking the OS thread and the in-RAM search index it pins.
        loop {
            if stopped.load(Ordering::Relaxed) {
                return;
            }
            match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(event) => {
                    if stopped.load(Ordering::Relaxed) {
                        return;
                    }
                    on_event(event);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

/// Watch the parent directory of a single-file workspace and:
///   * filter events down to `{file_name} ∪ scoped assets`
///   * on changes to `file_name`, re-derive the asset allowlist so that newly
///     referenced local assets become accessible (and removed ones stop being)
///   * push a `file_changed` WS message so the open browser tab reloads.
///
/// `notify` cannot reliably watch a single file across platforms, so the
/// minimum viable scope is the parent directory — non-recursive.
fn spawn_single_file_watcher(root: PathBuf, entry: Arc<WorkspaceEntry>, file_name: String) {
    let target = root.join(&file_name);
    let stopped = entry.stopped.clone();
    spawn_watch_thread(
        root.clone(),
        RecursiveMode::NonRecursive,
        stopped,
        move |event: notify::Event| {
            for path in event.paths {
                let Ok(rel) = path.strip_prefix(&root) else {
                    continue;
                };
                let rel_str = rel.to_string_lossy().to_string();
                let touched_pinned = path == target;
                let touched_asset = entry.fs.is_asset(rel);
                if !(touched_pinned || touched_asset) {
                    continue;
                }
                let mut should_broadcast = false;
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        if touched_pinned {
                            refresh_allowed_assets(&entry, &file_name);
                            // Keep the file-scoped search index in sync. No-op
                            // when search is disabled (no index loaded).
                            if let Some(idx) = entry.search_index.load_full() {
                                let _ = idx.update_file(&target);
                            }
                        }
                        should_broadcast = true;
                    }
                    // Don't broadcast for Remove: the file just went away,
                    // reloading would 404 the tab.
                    EventKind::Remove(_) if touched_pinned => {
                        entry.fs.clear_assets();
                        if let Some(idx) = entry.search_index.load_full() {
                            let _ = idx.delete_file(&target);
                        }
                    }
                    _ => {}
                }
                if should_broadcast {
                    let file_payload = serde_json::json!({
                        "type": "file_changed",
                        "workspace_id": entry.id,
                        "path": rel_str,
                    })
                    .to_string();
                    let _ = entry.events_tx.send(WorkspaceEvent::Workspace {
                        payload: file_payload,
                    });
                }
            }
        },
    );
}

fn spawn_search_indexer(entry: Arc<WorkspaceEntry>) {
    std::thread::spawn(move || {
        if let Ok(idx) = SearchIndex::for_workspace(entry.fs.clone()) {
            entry.search_index.store(Some(Arc::new(idx)));
        }
    });
}

fn spawn_directory_watcher(root: PathBuf, entry: Arc<WorkspaceEntry>) {
    let stopped = entry.stopped.clone();
    spawn_watch_thread(
        root.clone(),
        RecursiveMode::Recursive,
        stopped,
        move |event: notify::Event| {
            let event_kind = event.kind;
            for path in event.paths {
                match &event_kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        if let Some(idx) = entry.search_index.load_full() {
                            let _ = idx.update_file(&path);
                        }
                    }
                    EventKind::Remove(_) => {
                        if let Some(idx) = entry.search_index.load_full() {
                            let _ = idx.delete_file(&path);
                        }
                    }
                    _ => continue,
                }
                if let Some(rel_str) = directory_live_reload_path(&root, &path) {
                    let payload = serde_json::json!({
                        "type": "file_changed",
                        "workspace_id": entry.id,
                        "path": rel_str,
                    })
                    .to_string();
                    let _ = entry.events_tx.send(WorkspaceEvent::Workspace { payload });
                }
            }
        },
    );
}

fn directory_live_reload_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    if rel.as_os_str().is_empty()
        || rel.components().any(|component| {
            let name = component.as_os_str().to_string_lossy();
            LIVE_RELOAD_IGNORED_DIRS
                .iter()
                .any(|ignored| name.eq_ignore_ascii_case(ignored))
        })
    {
        return None;
    }
    let ext = rel.extension()?.to_string_lossy().to_ascii_lowercase();
    if !LIVE_RELOAD_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    Some(path_to_forward_slash(rel))
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct ServerLock {
    /// Web TCP port. Kept for building browser/QR URLs; the management plane no
    /// longer rides on it (that moved to the control socket below).
    pub port: u16,
    /// Control-socket identifier the running server bound: a filesystem path on
    /// unix (`~/.markon/control.sock`), a namespaced pipe name on Windows.
    /// Privileged clients (CLI/GUI) connect here for management/admin. Empty when
    /// read from a pre-split lock file — callers fall back to the default socket.
    #[serde(default)]
    pub control_socket: String,
    /// Bind host the daemon was started with (e.g. `0.0.0.0`). Lets a CLI that
    /// registers a workspace into an already-running daemon reproduce the same
    /// reachable/featured URLs. `#[serde(default)]` keeps old lock files (which
    /// predate this field) readable — they deserialize to an empty string,
    /// which callers treat as loopback.
    #[serde(default)]
    pub host: String,
    /// Advertised host active in the owning server process. `None` denotes a
    /// legacy lock file; `Some("")` is the valid automatic-LAN selection.
    #[serde(default)]
    pub advertised_host: Option<String>,
    /// Per-instance ownership nonce. NOT a secret (management no longer rides the
    /// lock — it moved to the control socket) and never used for authentication;
    /// it exists only so [`remove_if_owned`](Self::remove_if_owned) can tell "my
    /// lock" from one a newer server already replaced, keeping cleanup race-safe.
    /// `#[serde(default)]` keeps pre-nonce lock files readable (empty nonce).
    #[serde(default)]
    pub owner: String,
}
impl ServerLock {
    pub(crate) fn path() -> PathBuf {
        dirs::home_dir()
            .expect("HOME directory required")
            .join(".markon")
            .join("server.lock")
    }
    pub(crate) fn write(&self) -> std::io::Result<()> {
        Self::with_write_lock(|| {
            let path = Self::path();
            write_file_user_private(&path, serde_json::to_string(self).unwrap().as_bytes())
        })
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
    fn with_write_lock<T>(operation: impl FnOnce() -> std::io::Result<T>) -> std::io::Result<T> {
        let path = Self::path();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let lock_path = parent.join("server.write.lock");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path)?;
        lock.lock()?;
        let result = operation();
        let unlock_result = lock.unlock();
        match result {
            Ok(value) => {
                unlock_result?;
                Ok(value)
            }
            Err(error) => Err(error),
        }
    }

    /// Remove the discovery file only if it still belongs to this server. A
    /// newer process may have replaced it; unconditional cleanup would then
    /// make the live server undiscoverable. The sidecar lock makes the
    /// compare-and-remove transaction race-free against `write()`.
    pub(crate) fn remove_if_owned(owner: &str) {
        let _ = Self::with_write_lock(|| {
            let owned = Self::read().is_some_and(|lock| lock.owner == owner);
            if owned {
                match std::fs::remove_file(Self::path()) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(())
        });
    }
    pub fn is_alive(&self) -> bool {
        // Prefer the control socket: it is the authoritative "server is up"
        // signal now that management lives there, and a same-user connect proves
        // both liveness and that we may drive it. This must hold on every platform
        // — on Windows the named pipe *is* the management channel, so probe it too
        // rather than inferring liveness solely from a (recyclable) TCP port.
        if !self.control_socket.is_empty()
            && crate::control::transport::probe(&crate::control::ControlSocketName::from_raw(
                self.control_socket.clone(),
            ))
        {
            return true;
        }
        // Fallback: probe the web TCP port (also the only probe on platforms
        // where a cheap synchronous socket connect isn't wired up here).
        let connect_host = if crate::net::host_is_wildcard_v6(&self.host) {
            "::1"
        } else if crate::net::host_is_wildcard_v4(&self.host) {
            "127.0.0.1"
        } else {
            self.host.as_str()
        };
        let Ok(addr) = crate::net::bind_socket_addr(connect_host, self.port) else {
            return false;
        };
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_ok()
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
    fn registry_directory_id_matches_hash_contract() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();
        let salt = "contract-salt";
        let registry = WorkspaceRegistry::new(salt.into());

        let id = registry.add(WorkspaceConfig {
            path: root.clone(),
            flags: WorkspaceFlags::default(),
            single_file: None,
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });

        assert_eq!(id, hash_id(&root, salt));
    }

    #[test]
    fn access_code_hash_is_full_width() {
        // Any non-empty code now stores the full 64-hex digest, regardless of
        // code length — no truncation, so no leaked length and no 4·N cap.
        assert_eq!(hash_access_code("s", "abcd12345678").len(), 64);
        assert_eq!(hash_access_code("s", "x").len(), 64);
        // Empty stays the "gate disabled" sentinel.
        assert_eq!(hash_access_code("s", "").len(), 0);
    }

    #[test]
    fn access_code_matches_current_scheme() {
        let stored = hash_access_code("s", "test1234");
        assert_eq!(stored.len(), 64);
        assert!(access_code_matches("s", "test1234", &stored));
        assert!(!access_code_matches("s", "test1235", &stored));
        // A different-length code can't match either.
        assert!(!access_code_matches("s", "test12345", &stored));
        // Empty stored hash gates nothing.
        assert!(!access_code_matches("s", "anything", ""));
    }

    #[test]
    fn access_code_rejects_legacy_truncated_hash() {
        // Builds before full-digest storage kept only the leading N hex chars
        // (N = code length). Accepting them would retain the prefix-collision
        // vulnerability, so they fail closed until an administrator resets the
        // code locally.
        let full = access_code_digest("s", "test1234");
        let legacy = full[..8].to_string();
        assert!(!access_code_matches("s", "test1234", &legacy));
        assert!(!access_code_matches("s", "wrongone", &legacy));
    }

    #[test]
    fn access_code_matches_rejects_truncation_collision() {
        // The old truncation let ANY string sharing the leading N hex chars
        // unlock. With full-digest storage, only the exact code matches.
        let stored = hash_access_code("s", "test1234");
        // Construct a code whose digest is (astronomically unlikely to be) equal;
        // the point is that partial-prefix matching no longer happens.
        for guess in ["test1235", "TEST1234", "test123", "test12340"] {
            assert!(!access_code_matches("s", guess, &stored));
        }
    }

    #[test]
    fn validate_access_code_enforces_floor() {
        // Empty clears the code and is always allowed.
        assert!(validate_access_code("").is_ok());
        assert!(validate_access_code("   ").is_ok());
        // Below the floor is rejected (trimmed length counts).
        assert!(validate_access_code("short").is_err());
        assert!(validate_access_code(&"x".repeat(MIN_ACCESS_CODE_LEN - 1)).is_err());
        // At/above the floor is accepted.
        assert!(validate_access_code(&"x".repeat(MIN_ACCESS_CODE_LEN)).is_ok());
        assert!(validate_access_code("a-reasonable-code").is_ok());
    }

    #[test]
    fn directory_live_reload_filter_tracks_docs_and_assets_only() {
        let root = Path::new("/repo");

        assert_eq!(
            directory_live_reload_path(root, &root.join("docs").join("a.md")).as_deref(),
            Some("docs/a.md")
        );
        assert_eq!(
            directory_live_reload_path(root, &root.join("assets").join("app.js")).as_deref(),
            Some("assets/app.js")
        );
        assert_eq!(
            directory_live_reload_path(root, &root.join("img").join("hero.PNG")).as_deref(),
            Some("img/hero.PNG")
        );

        assert!(directory_live_reload_path(root, &root.join(".git").join("HEAD")).is_none());
        assert!(
            directory_live_reload_path(root, &root.join("node_modules").join("x.md")).is_none()
        );
        assert!(directory_live_reload_path(root, &root.join("target").join("x.css")).is_none());
        assert!(directory_live_reload_path(root, &root.join("README")).is_none());
        assert!(directory_live_reload_path(root, &root.join("notes.txt")).is_none());
    }

    /// Regression for #32: the workspace list must be deterministically ordered
    /// (by path), not in HashMap iteration order. Scrambled inserts → stable,
    /// path-sorted output, with single-file entries grouped under their dir.
    #[test]
    fn workspace_list_is_deterministically_ordered_by_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let base = tmp.path();
        std::fs::create_dir_all(base.join("alpha")).unwrap();
        std::fs::create_dir_all(base.join("charlie")).unwrap();
        std::fs::write(base.join("alpha").join("a.md"), "# a").unwrap();
        std::fs::write(base.join("alpha").join("z.md"), "# z").unwrap();

        let reg = WorkspaceRegistry::new("salt".into());
        let mk = |path: PathBuf, single: Option<&str>| WorkspaceConfig {
            path,
            flags: WorkspaceFlags::default(),
            single_file: single.map(str::to_string),
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        };
        // Insert in a scrambled order.
        reg.add(mk(base.join("charlie"), None));
        reg.add(mk(base.join("alpha"), Some("z.md")));
        reg.add(mk(base.join("alpha"), None));
        reg.add(mk(base.join("alpha"), Some("a.md")));

        let order: Vec<(PathBuf, Option<String>)> = reg
            .list()
            .iter()
            .map(|e| (e.fs.ambient_root().to_path_buf(), e.single_file.clone()))
            .collect();
        assert_eq!(
            order,
            vec![
                (base.join("alpha"), None),
                (base.join("alpha"), Some("a.md".into())),
                (base.join("alpha"), Some("z.md".into())),
                (base.join("charlie"), None),
            ],
            "list() must be sorted by (root, single_file)"
        );

        // Stable across repeated calls.
        let a: Vec<String> = reg.list().iter().map(|e| e.id.clone()).collect();
        let b: Vec<String> = reg.list().iter().map(|e| e.id.clone()).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn server_lock_optional_fields_default_when_absent() {
        // Pre-split lock files predate `control_socket` (and the older ones the
        // `host` field, plus a now-removed `token`); they must still deserialize,
        // ignoring unknown keys and defaulting the missing ones.
        let old = r#"{"port":6419,"token":"abc"}"#;
        let lock: ServerLock = serde_json::from_str(old).unwrap();
        assert_eq!(lock.port, 6419);
        assert_eq!(lock.control_socket, "");
        assert_eq!(lock.host, "");
        assert_eq!(lock.advertised_host, None);
    }

    #[test]
    fn server_lock_round_trips() {
        let lock = ServerLock {
            port: 6419,
            control_socket: "/home/u/.markon/control.sock".into(),
            host: "0.0.0.0".into(),
            advertised_host: Some("192.168.1.20".into()),
            owner: "owner-nonce".into(),
        };
        let json = serde_json::to_string(&lock).unwrap();
        let back: ServerLock = serde_json::from_str(&json).unwrap();
        assert_eq!(back.host, "0.0.0.0");
        assert_eq!(back.port, 6419);
        assert_eq!(back.control_socket, "/home/u/.markon/control.sock");
        assert_eq!(back.advertised_host.as_deref(), Some("192.168.1.20"));
        assert_eq!(back.owner, "owner-nonce");
    }

    /// Block until the entry's search index is populated (it's built on a
    /// background thread), or fail the test after a generous timeout.
    fn wait_for_index(entry: &Arc<WorkspaceEntry>) -> Arc<SearchIndex> {
        for _ in 0..200 {
            if let Some(idx) = entry.search_index.load_full() {
                return idx;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("search index was not built in time");
    }

    /// SECURITY: a single-file workspace with search enabled must index ONLY
    /// the pinned file. A sibling `.md` carrying a unique term must never be
    /// findable through that workspace's index, proving the parent directory is
    /// not walked.
    #[test]
    fn single_file_workspace_search_no_sibling_leakage() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let dir = temp_dir.path();
        std::fs::write(
            dir.join("pinned.md"),
            "# Pinned\nuniquepinnedtoken is here.",
        )
        .unwrap();
        std::fs::write(
            dir.join("sibling.md"),
            "# Sibling\nuniquesiblingtoken stays private.",
        )
        .unwrap();

        let registry = WorkspaceRegistry::new("test-salt".into());
        let id = registry.add(WorkspaceConfig {
            path: dir.to_path_buf(),
            flags: WorkspaceFlags {
                enable_search: true,
                ..Default::default()
            },
            single_file: Some("pinned.md".into()),
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });

        let entry = registry.get(&id).unwrap();
        assert!(entry.is_ephemeral());
        let idx = wait_for_index(&entry);

        assert_eq!(
            idx.search("uniquesiblingtoken", 10).unwrap().len(),
            0,
            "single-file workspace leaked a sibling through search"
        );
        assert_eq!(
            idx.search("uniquepinnedtoken", 10).unwrap().len(),
            1,
            "pinned file should be searchable"
        );
    }

    /// The search toggle must work for single-file workspaces too: turning it
    /// on spawns the file-scoped indexer, turning it off clears the index.
    #[test]
    fn single_file_workspace_search_toggle_spawns_and_clears() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let dir = temp_dir.path();
        std::fs::write(dir.join("note.md"), "# Note\ntoggletoken here.").unwrap();

        let registry = WorkspaceRegistry::new("test-salt".into());
        // Start with search OFF.
        let id = registry.add(WorkspaceConfig {
            path: dir.to_path_buf(),
            flags: WorkspaceFlags::default(),
            single_file: Some("note.md".into()),
            collaborator_access_code_hash: String::new(),
            ..Default::default()
        });
        let entry = registry.get(&id).unwrap();
        assert!(entry.search_index.load().is_none());

        // Turn search ON → file-scoped index appears.
        registry.update_flags(
            &id,
            WorkspaceFlags {
                enable_search: true,
                ..Default::default()
            },
        );
        let idx = wait_for_index(&entry);
        assert_eq!(idx.search("toggletoken", 10).unwrap().len(), 1);

        // Turn search OFF → index is cleared.
        registry.update_flags(&id, WorkspaceFlags::default());
        assert!(
            entry.search_index.load().is_none(),
            "disabling search must clear the single-file index"
        );
    }
}
