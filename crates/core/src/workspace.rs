use crate::search::SearchIndex;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tokio::sync::broadcast;

// ── Workspace config (input) ────────────────────────────────────────────────

pub struct WorkspaceConfig {
    pub path: PathBuf,
    pub enable_search: bool,
    pub enable_viewed: bool,
    pub enable_edit: bool,
    pub enable_live: bool,
    pub shared_annotation: bool,
}

// ── Workspace entry (runtime) ───────────────────────────────────────────────

pub struct WorkspaceEntry {
    pub id: String,
    pub root: PathBuf,
    pub enable_search: AtomicBool,
    pub enable_viewed: AtomicBool,
    pub enable_edit: AtomicBool,
    pub enable_live: AtomicBool,
    pub shared_annotation: AtomicBool,
    /// Broadcast channel: fires `()` each time flags change so WS clients can reload.
    pub config_tx: broadcast::Sender<()>,
    /// Populated asynchronously in a background thread when enable_search is true.
    pub search_index: Arc<Mutex<Option<Arc<SearchIndex>>>>,
}

impl WorkspaceEntry {
    pub fn search_ready(&self) -> bool {
        self.enable_search.load(Ordering::Relaxed) && self.search_index.lock().unwrap().is_some()
    }
}

// ── Serialisable info for the API ───────────────────────────────────────────

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub path: String,
    pub enable_search: bool,
    pub enable_viewed: bool,
    pub enable_edit: bool,
    pub enable_live: bool,
    pub shared_annotation: bool,
    pub search_ready: bool,
}

// ── Registry ────────────────────────────────────────────────────────────────

pub struct WorkspaceRegistry {
    inner: RwLock<HashMap<String, Arc<WorkspaceEntry>>>,
    pub salt: String,
}

pub fn hash_id(path: &std::path::Path, salt: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    salt.hash(&mut h);
    path.hash(&mut h);
    format!("{:08x}", h.finish() as u32)
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
        c.wrapping_mul(2862933555777941757).wrapping_add(a),
    )
}

impl WorkspaceRegistry {
    pub fn new(salt: String) -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            salt,
        }
    }

    pub fn add(&self, config: WorkspaceConfig) -> String {
        let id = hash_id(&config.path, &self.salt);
        let search_slot: Arc<Mutex<Option<Arc<SearchIndex>>>> = Arc::new(Mutex::new(None));
        let (config_tx, _) = broadcast::channel(4);
        let entry = Arc::new(WorkspaceEntry {
            id: id.clone(),
            root: config.path.clone(),
            enable_search: AtomicBool::new(config.enable_search),
            enable_viewed: AtomicBool::new(config.enable_viewed),
            enable_edit: AtomicBool::new(config.enable_edit),
            enable_live: AtomicBool::new(config.enable_live),
            shared_annotation: AtomicBool::new(config.shared_annotation),
            config_tx,
            search_index: search_slot.clone(),
        });
        self.inner.write().unwrap().insert(id.clone(), entry);
        if config.enable_search {
            spawn_search_indexer(config.path, search_slot);
        }
        id
    }

    pub fn update_flags(
        &self,
        id: &str,
        enable_search: bool,
        enable_viewed: bool,
        enable_edit: bool,
        enable_live: bool,
        shared_annotation: bool,
    ) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id) else {
            return false;
        };
        let was_search = entry.enable_search.swap(enable_search, Ordering::Relaxed);
        entry.enable_viewed.store(enable_viewed, Ordering::Relaxed);
        entry.enable_edit.store(enable_edit, Ordering::Relaxed);
        entry.enable_live.store(enable_live, Ordering::Relaxed);
        entry
            .shared_annotation
            .store(shared_annotation, Ordering::Relaxed);
        let _ = entry.config_tx.send(());
        if enable_search && !was_search && entry.search_index.lock().unwrap().is_none() {
            spawn_search_indexer(entry.root.clone(), entry.search_index.clone());
        }
        true
    }

    pub fn remove(&self, id: &str) -> bool {
        self.inner.write().unwrap().remove(id).is_some()
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
                enable_search: e.enable_search.load(Ordering::Relaxed),
                enable_viewed: e.enable_viewed.load(Ordering::Relaxed),
                enable_edit: e.enable_edit.load(Ordering::Relaxed),
                enable_live: e.enable_live.load(Ordering::Relaxed),
                shared_annotation: e.shared_annotation.load(Ordering::Relaxed),
                search_ready: e.search_ready(),
            })
            .collect()
    }
}

fn spawn_search_indexer(root: PathBuf, slot: Arc<Mutex<Option<Arc<SearchIndex>>>>) {
    std::thread::spawn(move || match SearchIndex::new(&root) {
        Ok(idx) => {
            let idx = Arc::new(idx);
            *slot.lock().unwrap() = Some(idx.clone());
            eprintln!("[search] Index ready for {:?}", root);
            start_file_watcher(idx, root);
        }
        Err(e) => eprintln!("[search] Index error for {:?}: {e}", root),
    });
}

fn start_file_watcher(index: Arc<SearchIndex>, root: PathBuf) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[search] Failed to create watcher for {:?}: {e}", root);
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("[search] Failed to watch {:?}: {e}", root);
            return;
        }
        while let Ok(event) = rx.recv() {
            for path in event.paths {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        if let Err(e) = index.update_file(&path) {
                            eprintln!("[search] Error updating index: {e}");
                        }
                    }
                    EventKind::Remove(_) => {
                        if let Err(e) = index.delete_file(&path) {
                            eprintln!("[search] Error removing from index: {e}");
                        }
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
    use std::path::Path;

    #[test]
    fn hash_id_is_deterministic() {
        let path = Path::new("/tmp/test");
        assert_eq!(hash_id(path, "s"), hash_id(path, "s"));
    }

    #[test]
    fn registry_add_and_get() {
        let reg = WorkspaceRegistry::new("salt".into());
        let id = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws1"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            enable_live: false,
            shared_annotation: false,
        });
        assert!(reg.get(&id).is_some());
    }

    #[test]
    fn registry_update_flags() {
        let reg = WorkspaceRegistry::new("salt".into());
        let id = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws_flags"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            enable_live: false,
            shared_annotation: false,
        });
        assert!(reg.update_flags(&id, true, true, true, true, true));
        let entry = reg.get(&id).unwrap();
        assert!(entry.enable_live.load(Ordering::Relaxed));
    }
}
