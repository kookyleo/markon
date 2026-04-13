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
    pub shared_annotation: bool,
}

// ── Workspace entry (runtime) ───────────────────────────────────────────────

pub struct WorkspaceEntry {
    pub id: String,
    pub root: PathBuf,
    pub enable_search: AtomicBool,
    pub enable_viewed: AtomicBool,
    pub enable_edit: AtomicBool,
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
    pub shared_annotation: bool,
    pub search_ready: bool,
}

// ── Registry ────────────────────────────────────────────────────────────────

pub struct WorkspaceRegistry {
    inner: RwLock<HashMap<String, Arc<WorkspaceEntry>>>,
    pub salt: String,
}

/// Stable workspace ID: hash(path + salt).
/// When salt includes the port (default), the same directory on the same port
/// always produces the same ID — bookmarks and shared links survive restarts.
fn hash_id(path: &std::path::Path, salt: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    salt.hash(&mut h);
    path.hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

/// Generate a hard-to-guess management token from timestamp + pid entropy.
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
            shared_annotation: AtomicBool::new(config.shared_annotation),
            config_tx,
            search_index: search_slot.clone(),
        });

        self.inner
            .write()
            .unwrap()
            .insert(id.clone(), entry.clone());

        if config.enable_search {
            spawn_search_indexer(config.path, search_slot);
        }

        id
    }

    /// Update feature flags for an existing workspace in-place.
    /// If enable_search transitions to true and the index isn't built yet, kick off indexing.
    pub fn update_flags(
        &self,
        id: &str,
        enable_search: bool,
        enable_viewed: bool,
        enable_edit: bool,
        shared_annotation: bool,
    ) -> bool {
        let guard = self.inner.read().unwrap();
        let Some(entry) = guard.get(id) else {
            return false;
        };
        let was_search = entry.enable_search.swap(enable_search, Ordering::Relaxed);
        entry.enable_viewed.store(enable_viewed, Ordering::Relaxed);
        entry.enable_edit.store(enable_edit, Ordering::Relaxed);
        entry
            .shared_annotation
            .store(shared_annotation, Ordering::Relaxed);
        let _ = entry.config_tx.send(());
        // Start indexing if search was just enabled and index not yet built.
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
                shared_annotation: e.shared_annotation.load(Ordering::Relaxed),
                search_ready: e.search_ready(),
            })
            .collect()
    }
}

// ── Search indexer ──────────────────────────────────────────────────────────

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

// ── Per-workspace file watcher ──────────────────────────────────────────────

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

        eprintln!("[search] Watching {:?}", root);

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

// ── Server lock file ────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ServerLock {
    pub port: u16,
    /// Management API token — required in `X-Markon-Token` header for /api/* requests.
    pub token: String,
}

impl ServerLock {
    pub fn path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
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

    /// Returns true if a TCP connection to 127.0.0.1:port succeeds quickly.
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
        let a = hash_id(path, "salt1");
        let b = hash_id(path, "salt1");
        assert_eq!(a, b);
    }

    #[test]
    fn hash_id_length_is_8_hex() {
        let id = hash_id(Path::new("/some/path"), "s");
        assert_eq!(id.len(), 8);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_id_differs_by_salt() {
        let path = Path::new("/tmp/test");
        let a = hash_id(path, "salt1");
        let b = hash_id(path, "salt2");
        assert_ne!(a, b);
    }

    #[test]
    fn hash_id_differs_by_path() {
        let a = hash_id(Path::new("/a"), "salt");
        let b = hash_id(Path::new("/b"), "salt");
        assert_ne!(a, b);
    }

    #[test]
    fn generate_token_length_and_hex() {
        let token = generate_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_token_uniqueness() {
        let a = generate_token();
        // Tiny sleep to ensure different timestamp
        std::thread::sleep(std::time::Duration::from_millis(1));
        let b = generate_token();
        assert_ne!(a, b);
    }

    #[test]
    fn search_ready_false_when_search_disabled() {
        let (tx, _) = broadcast::channel(1);
        let entry = WorkspaceEntry {
            id: "test".into(),
            root: PathBuf::from("/tmp"),
            enable_search: AtomicBool::new(false),
            enable_viewed: AtomicBool::new(false),
            enable_edit: AtomicBool::new(false),
            shared_annotation: AtomicBool::new(false),
            config_tx: tx,
            search_index: Arc::new(Mutex::new(None)),
        };
        assert!(!entry.search_ready());
    }

    #[test]
    fn search_ready_false_when_index_not_built() {
        let (tx, _) = broadcast::channel(1);
        let entry = WorkspaceEntry {
            id: "test".into(),
            root: PathBuf::from("/tmp"),
            enable_search: AtomicBool::new(true),
            enable_viewed: AtomicBool::new(false),
            enable_edit: AtomicBool::new(false),
            shared_annotation: AtomicBool::new(false),
            config_tx: tx,
            search_index: Arc::new(Mutex::new(None)),
        };
        assert!(!entry.search_ready());
    }

    #[test]
    fn search_ready_true_when_enabled_and_index_present() {
        let (tx, _) = broadcast::channel(1);
        let idx = crate::search::SearchIndex::new(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
        let entry = WorkspaceEntry {
            id: "test".into(),
            root: PathBuf::from("/tmp"),
            enable_search: AtomicBool::new(true),
            enable_viewed: AtomicBool::new(false),
            enable_edit: AtomicBool::new(false),
            shared_annotation: AtomicBool::new(false),
            config_tx: tx,
            search_index: Arc::new(Mutex::new(Some(Arc::new(idx)))),
        };
        assert!(entry.search_ready());
    }

    #[test]
    fn registry_add_and_get() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        let id = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws1"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        assert!(!id.is_empty());
        assert!(reg.get(&id).is_some());
        assert_eq!(reg.get(&id).unwrap().id, id);
    }

    #[test]
    fn registry_add_idempotent_id() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        let id1 = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws1"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        let id2 = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws1"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        assert_eq!(id1, id2);
    }

    #[test]
    fn registry_remove() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        let id = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws_rm"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        assert!(reg.remove(&id));
        assert!(!reg.remove(&id));
        assert!(reg.get(&id).is_none());
    }

    #[test]
    fn registry_list() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/a"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/b"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        assert_eq!(reg.list().len(), 2);
    }

    #[test]
    fn registry_update_flags() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        let id = reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/ws_flags"),
            enable_search: false,
            enable_viewed: false,
            enable_edit: false,
            shared_annotation: false,
        });
        // Unknown ID returns false
        assert!(!reg.update_flags("nonexistent", true, true, true, true));
        // Known ID returns true
        assert!(reg.update_flags(&id, false, true, true, false));
        let entry = reg.get(&id).unwrap();
        assert!(!entry.enable_search.load(Ordering::Relaxed));
        assert!(entry.enable_viewed.load(Ordering::Relaxed));
        assert!(entry.enable_edit.load(Ordering::Relaxed));
        assert!(!entry.shared_annotation.load(Ordering::Relaxed));
    }

    #[test]
    fn registry_info_list() {
        let reg = WorkspaceRegistry::new("test-salt".into());
        reg.add(WorkspaceConfig {
            path: PathBuf::from("/tmp/info"),
            enable_search: false,
            enable_viewed: true,
            enable_edit: false,
            shared_annotation: false,
        });
        let infos = reg.info_list();
        assert_eq!(infos.len(), 1);
        assert!(infos[0].enable_viewed);
        assert!(!infos[0].enable_search);
        assert!(!infos[0].search_ready);
    }

    #[test]
    fn server_lock_serde_roundtrip() {
        let lock = ServerLock {
            port: 8080,
            token: "abc123".into(),
        };
        let json = serde_json::to_string(&lock).unwrap();
        let parsed: ServerLock = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.port, 8080);
        assert_eq!(parsed.token, "abc123");
    }
}
