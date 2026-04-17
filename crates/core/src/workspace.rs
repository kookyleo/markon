use crate::search::SearchIndex;
use arc_swap::ArcSwapOption;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
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
    pub shared_annotation: bool,
}

#[derive(Clone)]
pub struct WorkspaceConfig {
    pub path: PathBuf,
    pub flags: WorkspaceFlags,
}

pub struct WorkspaceEntry {
    pub id: String,
    pub root: PathBuf,
    pub enable_search: AtomicBool,
    pub enable_viewed: AtomicBool,
    pub enable_edit: AtomicBool,
    pub enable_live: AtomicBool,
    pub shared_annotation: AtomicBool,
    pub config_tx: broadcast::Sender<()>,
    pub search_index: ArcSwapOption<SearchIndex>,
}

impl WorkspaceEntry {
    pub fn search_ready(&self) -> bool {
        self.enable_search.load(Ordering::Relaxed) && self.search_index.load().is_some()
    }

    pub fn flags(&self) -> WorkspaceFlags {
        WorkspaceFlags {
            enable_search: self.enable_search.load(Ordering::Relaxed),
            enable_viewed: self.enable_viewed.load(Ordering::Relaxed),
            enable_edit: self.enable_edit.load(Ordering::Relaxed),
            enable_live: self.enable_live.load(Ordering::Relaxed),
            shared_annotation: self.shared_annotation.load(Ordering::Relaxed),
        }
    }
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub path: String,
    #[serde(flatten)]
    pub flags: WorkspaceFlags,
    pub search_ready: bool,
}

/// Invoked whenever the registry mutates (add / update_flags / remove).
/// The host (GUI or CLI daemon) wires this to persist workspaces to
/// `~/.markon/settings.json` so CLI-driven and GUI-driven changes are
/// treated identically.
pub type PersistHook = Arc<dyn Fn(&WorkspaceRegistry) + Send + Sync>;

pub struct WorkspaceRegistry {
    inner: RwLock<HashMap<String, Arc<WorkspaceEntry>>>,
    pub salt: String,
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

pub fn generate_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let a = now.as_nanos() as u64;
    let b = std::process::id() as u64;
    let c = now.subsec_nanos() as u64;
    format!(
        "{:016x}{:016x}",
        a.wrapping_mul(6364136223846793005).wrapping_add(b),
        c.wrapping_mul(2862933555777941757).wrapping_add(a)
    )
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
        let id = hash_id(&config.path, &self.salt);
        // Idempotent: same path registered twice just updates flags on the
        // existing entry instead of spawning a second indexer thread.
        if self.inner.read().unwrap().contains_key(&id) {
            self.update_flags(&id, config.flags);
            return id;
        }
        let (config_tx, _) = broadcast::channel(4);
        let entry = Arc::new(WorkspaceEntry {
            id: id.clone(),
            root: config.path.clone(),
            enable_search: AtomicBool::new(config.flags.enable_search),
            enable_viewed: AtomicBool::new(config.flags.enable_viewed),
            enable_edit: AtomicBool::new(config.flags.enable_edit),
            enable_live: AtomicBool::new(config.flags.enable_live),
            shared_annotation: AtomicBool::new(config.flags.shared_annotation),
            config_tx,
            search_index: ArcSwapOption::empty(),
        });
        self.inner
            .write()
            .unwrap()
            .insert(id.clone(), entry.clone());
        if config.flags.enable_search {
            spawn_search_indexer(config.path, entry);
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
    pub fn get(&self, id: &str) -> Option<Arc<WorkspaceEntry>> {
        self.inner.read().unwrap().get(id).cloned()
    }
    pub fn list(&self) -> Vec<Arc<WorkspaceEntry>> {
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
            })
            .collect()
    }
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
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(move |res| {
            if let Ok(e) = res {
                let _ = tx.send(e);
            }
        }) else {
            return;
        };
        let _ = watcher.watch(&root, RecursiveMode::Recursive);
        while let Ok(event) = rx.recv() {
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
        }
    });
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ServerLock {
    pub port: u16,
    pub token: String,
}
impl ServerLock {
    pub fn path() -> PathBuf {
        dirs::home_dir()
            .unwrap()
            .join(".markon")
            .join("server.lock")
    }
    pub fn write(&self) -> std::io::Result<()> {
        let path = Self::path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string(self).unwrap())
    }
    pub fn read() -> Option<Self> {
        let content = std::fs::read_to_string(Self::path()).ok()?;
        serde_json::from_str(&content).ok()
    }
    pub fn remove() {
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
}
