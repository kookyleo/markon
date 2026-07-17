//! Capability-oriented filesystem boundary for a workspace.
//!
//! `WorkspaceFs` is the only component that combines the ambient serving
//! directory with Markon's workspace policy. High-level handlers must ask it
//! for a served/content/editable path or a directory-only capability instead
//! of treating the serving root as authority.

use cap_std::ambient_authority;
use cap_std::fs::Dir;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::fswalk::{default_walker, path_to_forward_slash};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct WorkspaceRelPath(PathBuf);

impl WorkspaceRelPath {
    pub(crate) fn parse(path: impl AsRef<Path>) -> Result<Self, WorkspaceFsError> {
        let path = path.as_ref();
        let mut normalized = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Normal(part) => normalized.push(part),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(WorkspaceFsError::InvalidPath);
                }
            }
        }
        if normalized.as_os_str().is_empty() {
            return Err(WorkspaceFsError::InvalidPath);
        }
        Ok(Self(normalized))
    }

    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn as_route(&self) -> String {
        path_to_forward_slash(&self.0)
    }
}

#[derive(Debug)]
enum WorkspaceScope {
    Directory,
    SingleFile {
        document: ScopedPath,
        assets: RwLock<HashMap<WorkspaceRelPath, WorkspaceRelPath>>,
    },
}

#[derive(Debug)]
struct ScopedPath {
    route: WorkspaceRelPath,
    target: WorkspaceRelPath,
}

#[derive(Debug)]
pub(crate) struct WorkspaceFs {
    /// Stable path supplied by workspace configuration. Used for identity,
    /// persistence, display, and watcher registration.
    ambient_root: PathBuf,
    /// Canonical path paired with `root`. Used for all authorized I/O paths.
    canonical_root: PathBuf,
    root: Option<Arc<Dir>>,
    scope: WorkspaceScope,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkspaceFsError {
    #[error("invalid workspace-relative path")]
    InvalidPath,
    #[error("path is outside this workspace capability")]
    Denied,
    #[error("path not found")]
    NotFound,
    #[error("workspace filesystem unavailable: {0}")]
    Io(String),
}

impl WorkspaceFs {
    pub(crate) fn new(root: PathBuf, single_file: Option<&str>) -> Self {
        let ambient_root = root;
        let canonical_root =
            dunce::canonicalize(&ambient_root).unwrap_or_else(|_| ambient_root.clone());
        let dir = Dir::open_ambient_dir(&canonical_root, ambient_authority())
            .ok()
            .map(Arc::new);
        let scope = match single_file {
            Some(file) => {
                let parsed = WorkspaceRelPath::parse(file)
                    .expect("single-file workspace name must be relative");
                let target = dir
                    .as_deref()
                    .and_then(|dir| dir.canonicalize(parsed.as_path()).ok())
                    .and_then(|path| WorkspaceRelPath::parse(path).ok())
                    .unwrap_or_else(|| parsed.clone());
                WorkspaceScope::SingleFile {
                    document: ScopedPath {
                        route: parsed,
                        target,
                    },
                    assets: RwLock::new(HashMap::new()),
                }
            }
            None => WorkspaceScope::Directory,
        };
        Self {
            ambient_root,
            canonical_root,
            root: dir,
            scope,
        }
    }

    pub(crate) fn is_single_file(&self) -> bool {
        matches!(self.scope, WorkspaceScope::SingleFile { .. })
    }

    /// Ambient path for identity, display, persistence, watchers, and trusted
    /// integrations. It is not an authorization decision.
    pub(crate) fn ambient_root(&self) -> &Path {
        &self.ambient_root
    }

    pub(crate) fn replace_assets(&self, assets: HashSet<String>) {
        let WorkspaceScope::SingleFile {
            assets: current, ..
        } = &self.scope
        else {
            return;
        };
        let scoped = assets
            .into_iter()
            .filter_map(|asset| {
                let route = WorkspaceRelPath::parse(asset).ok()?;
                let target = self.canonicalize_rel(&route).ok()?;
                Some((route, target))
            })
            .collect();
        *current.write().expect("workspace asset lock poisoned") = scoped;
    }

    pub(crate) fn is_asset(&self, rel: impl AsRef<Path>) -> bool {
        let Ok(lexical) = WorkspaceRelPath::parse(rel) else {
            return false;
        };
        match &self.scope {
            WorkspaceScope::SingleFile { assets, .. } => assets
                .read()
                .expect("workspace asset lock poisoned")
                .contains_key(&lexical),
            WorkspaceScope::Directory => false,
        }
    }

    pub(crate) fn clear_assets(&self) {
        if let WorkspaceScope::SingleFile { assets, .. } = &self.scope {
            assets
                .write()
                .expect("workspace asset lock poisoned")
                .clear();
        }
    }

    pub(crate) fn resolve_served(
        &self,
        rel: impl AsRef<Path>,
    ) -> Result<PathBuf, WorkspaceFsError> {
        let route = WorkspaceRelPath::parse(rel)?;
        match &self.scope {
            WorkspaceScope::Directory => {
                let target = self.canonicalize_rel(&route)?;
                Ok(self.absolute(&target))
            }
            WorkspaceScope::SingleFile { document, assets } => {
                if route == document.route {
                    return self.resolve_scoped(&route, &document.target);
                }
                let assets = assets.read().expect("workspace asset lock poisoned");
                let target = assets.get(&route).ok_or(WorkspaceFsError::Denied)?;
                self.resolve_scoped(&route, target)
            }
        }
    }

    /// Content authority is intentionally narrower than serving authority:
    /// assets may be rendered by the browser but are not automatically exposed
    /// to Chat tools or inline mentions.
    pub(crate) fn resolve_content(
        &self,
        rel: impl AsRef<Path>,
    ) -> Result<PathBuf, WorkspaceFsError> {
        let route = WorkspaceRelPath::parse(rel)?;
        let target = self.content_target(&route)?;
        Ok(self.absolute(&target))
    }

    /// Read through the capability handle after applying the same content
    /// policy as [`Self::resolve_content`]. This keeps bulk/high-level features
    /// from re-opening an authorized ambient path and reintroducing a symlink
    /// race between validation and I/O.
    pub(crate) fn read_content(&self, rel: impl AsRef<Path>) -> Result<Vec<u8>, WorkspaceFsError> {
        let route = WorkspaceRelPath::parse(rel)?;
        let target = self.content_target(&route)?;
        self.root_dir()?
            .read(target.as_path())
            .map_err(map_io_error)
    }

    pub(crate) fn read_content_to_string(
        &self,
        rel: impl AsRef<Path>,
    ) -> Result<String, WorkspaceFsError> {
        let route = WorkspaceRelPath::parse(rel)?;
        let target = self.content_target(&route)?;
        self.root_dir()?
            .read_to_string(target.as_path())
            .map_err(map_io_error)
    }

    /// Resolve either a workspace-relative route or an absolute path supplied
    /// by a higher-level protocol, then enforce this workspace's content
    /// capability. The returned path is canonical and safe to use as a stable
    /// persistence key.
    pub(crate) fn resolve_content_input(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, WorkspaceFsError> {
        let path = path.as_ref();
        if !path.is_absolute() {
            return self.resolve_content(path);
        }
        let canonical_input = dunce::canonicalize(path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => WorkspaceFsError::NotFound,
            std::io::ErrorKind::PermissionDenied => WorkspaceFsError::Denied,
            _ => WorkspaceFsError::Io(error.to_string()),
        })?;
        let route = self
            .route_for_path(&canonical_input)
            .ok_or(WorkspaceFsError::Denied)?;
        self.resolve_content(route)
    }

    pub(crate) fn resolve_editable_input(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, WorkspaceFsError> {
        self.resolve_content_input(path)
    }

    pub(crate) fn route_for_path(&self, path: &Path) -> Option<String> {
        // Callers may hand us a lexical path produced by a directory walk. A
        // symlink under the workspace can still target an ambient file outside
        // it, so containment must be checked after resolution, not just with a
        // lexical `strip_prefix`.
        let canonical = dunce::canonicalize(path).ok()?;
        let rel = canonical.strip_prefix(&self.canonical_root).ok()?;
        let target = WorkspaceRelPath::parse(rel).ok()?;
        match &self.scope {
            WorkspaceScope::SingleFile { document, .. } if target == document.target => {
                Some(document.route.as_route())
            }
            WorkspaceScope::SingleFile { .. } => None,
            WorkspaceScope::Directory => Some(target.as_route()),
        }
    }

    pub(crate) fn directory_root(&self) -> Option<&Path> {
        matches!(self.scope, WorkspaceScope::Directory).then_some(self.canonical_root.as_path())
    }

    pub(crate) fn content_files(&self, limit: usize) -> Vec<(WorkspaceRelPath, PathBuf)> {
        match &self.scope {
            WorkspaceScope::SingleFile { document, .. } => self
                .resolve_scoped(&document.route, &document.target)
                .ok()
                .filter(|abs| abs.is_file())
                .map(|abs| (document.route.clone(), abs))
                .into_iter()
                .collect(),
            WorkspaceScope::Directory => self.walk_authorized(limit, |_| true),
        }
    }

    /// Convert a watcher-supplied path into a lexical workspace route without
    /// requiring the target to still exist. This is deliberately separate from
    /// [`Self::route_for_path`], which canonicalizes and therefore cannot
    /// represent a path after a remove/rename event.
    pub(crate) fn lexical_route(&self, path: &Path) -> Option<WorkspaceRelPath> {
        let rel = if path.is_absolute() {
            path.strip_prefix(&self.ambient_root)
                .or_else(|_| path.strip_prefix(&self.canonical_root))
                .ok()?
        } else {
            path
        };
        WorkspaceRelPath::parse(rel).ok()
    }

    /// Resolve only the requested routes that are currently visible under the
    /// same standard ignore rules as [`Self::content_files`].
    ///
    /// Directory workspaces start at the workspace root so ignored/hidden
    /// parent directories are evaluated exactly like the initial full walk.
    /// A filter prunes every branch that is not an ancestor of a candidate, so
    /// an incremental save does not rescan unrelated workspace subtrees.
    pub(crate) fn content_files_for_routes(
        &self,
        routes: &BTreeSet<WorkspaceRelPath>,
    ) -> Vec<(WorkspaceRelPath, PathBuf)> {
        match &self.scope {
            WorkspaceScope::SingleFile { document, .. } => {
                if !routes.contains(&document.route) {
                    return Vec::new();
                }
                self.resolve_scoped(&document.route, &document.target)
                    .ok()
                    .filter(|abs| abs.is_file())
                    .map(|abs| (document.route.clone(), abs))
                    .into_iter()
                    .collect()
            }
            WorkspaceScope::Directory => {
                let candidates: BTreeSet<PathBuf> = routes
                    .iter()
                    .map(|route| self.canonical_root.join(route.as_path()))
                    .filter(|path| path.is_file())
                    .collect();
                if candidates.is_empty() {
                    return Vec::new();
                }

                let root = self.canonical_root.clone();
                let mut relevant_paths = BTreeSet::new();
                for candidate in &candidates {
                    for ancestor in candidate.ancestors() {
                        if !ancestor.starts_with(&root) {
                            break;
                        }
                        relevant_paths.insert(ancestor.to_path_buf());
                        if ancestor == root {
                            break;
                        }
                    }
                }
                let mut walker = default_walker(&root);
                walker.filter_entry(move |entry| relevant_paths.contains(entry.path()));
                walker
                    .build()
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().is_file())
                    .filter(|entry| candidates.contains(entry.path()))
                    .filter_map(|entry| {
                        let rel = entry.path().strip_prefix(&self.canonical_root).ok()?;
                        let route = WorkspaceRelPath::parse(rel).ok()?;
                        let target = self.canonicalize_rel(&route).ok()?;
                        let absolute = self.absolute(&target);
                        absolute.is_file().then_some((route, absolute))
                    })
                    .collect()
            }
        }
    }

    pub(crate) fn served_files(&self, limit: usize) -> Vec<(WorkspaceRelPath, PathBuf)> {
        match &self.scope {
            WorkspaceScope::Directory => self.walk_authorized(limit, |_| true),
            WorkspaceScope::SingleFile { document, assets } => {
                let mut paths = BTreeMap::new();
                paths.insert(document.route.clone(), document.target.clone());
                paths.extend(
                    assets
                        .read()
                        .expect("workspace asset lock poisoned")
                        .clone(),
                );
                paths
                    .into_iter()
                    .filter_map(|(route, target)| {
                        let abs = self.resolve_scoped(&route, &target).ok()?;
                        abs.is_file().then_some((route, abs))
                    })
                    .take(limit)
                    .collect()
            }
        }
    }

    fn walk_authorized(
        &self,
        limit: usize,
        allow: impl Fn(&WorkspaceRelPath) -> bool,
    ) -> Vec<(WorkspaceRelPath, PathBuf)> {
        default_walker(&self.canonical_root)
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| {
                let rel = entry.path().strip_prefix(&self.canonical_root).ok()?;
                let route = WorkspaceRelPath::parse(rel).ok()?;
                if !allow(&route) {
                    return None;
                }
                // `ignore::DirEntry::path().is_file()` follows symlinks. Always
                // re-resolve through the capability before returning an ambient
                // path, otherwise bulk consumers (grep/glob/file listings) could
                // read a symlink target outside the workspace even though the
                // point resolver correctly rejects it.
                let target = self.canonicalize_rel(&route).ok()?;
                let absolute = self.absolute(&target);
                absolute.is_file().then_some((route, absolute))
            })
            .take(limit)
            .collect()
    }

    fn canonicalize_rel(
        &self,
        rel: &WorkspaceRelPath,
    ) -> Result<WorkspaceRelPath, WorkspaceFsError> {
        let root = self.root_dir()?;
        let canonical = root.canonicalize(rel.as_path()).map_err(map_io_error)?;
        WorkspaceRelPath::parse(canonical)
    }

    fn root_dir(&self) -> Result<&Dir, WorkspaceFsError> {
        self.root
            .as_deref()
            .ok_or_else(|| WorkspaceFsError::Io("workspace root is not open".to_string()))
    }

    fn content_target(
        &self,
        route: &WorkspaceRelPath,
    ) -> Result<WorkspaceRelPath, WorkspaceFsError> {
        match &self.scope {
            WorkspaceScope::Directory => self.canonicalize_rel(route),
            WorkspaceScope::SingleFile { document, .. } if route == &document.route => {
                self.scoped_target(route, &document.target)
            }
            WorkspaceScope::SingleFile { .. } => Err(WorkspaceFsError::Denied),
        }
    }

    fn resolve_scoped(
        &self,
        route: &WorkspaceRelPath,
        expected_target: &WorkspaceRelPath,
    ) -> Result<PathBuf, WorkspaceFsError> {
        let current_target = self.scoped_target(route, expected_target)?;
        Ok(self.absolute(&current_target))
    }

    fn scoped_target(
        &self,
        route: &WorkspaceRelPath,
        expected_target: &WorkspaceRelPath,
    ) -> Result<WorkspaceRelPath, WorkspaceFsError> {
        let current_target = self.canonicalize_rel(route)?;
        if &current_target != expected_target {
            return Err(WorkspaceFsError::Denied);
        }
        Ok(current_target)
    }

    fn absolute(&self, rel: &WorkspaceRelPath) -> PathBuf {
        self.canonical_root.join(rel.as_path())
    }
}

fn map_io_error(error: std::io::Error) -> WorkspaceFsError {
    match error.kind() {
        std::io::ErrorKind::NotFound => WorkspaceFsError::NotFound,
        std::io::ErrorKind::PermissionDenied => WorkspaceFsError::Denied,
        _ => WorkspaceFsError::Io(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_file_capabilities_are_distinct() {
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("note.md"), "![x](image.svg)").unwrap();
        std::fs::write(temp.path().join("image.svg"), "<svg/>").unwrap();
        std::fs::write(temp.path().join("secret.md"), "secret").unwrap();
        let fs = WorkspaceFs::new(temp.path().to_path_buf(), Some("note.md"));
        fs.replace_assets(HashSet::from(["image.svg".to_string()]));

        assert!(fs.resolve_served("note.md").is_ok());
        assert!(fs.resolve_served("image.svg").is_ok());
        assert!(matches!(
            fs.resolve_served("secret.md"),
            Err(WorkspaceFsError::Denied)
        ));
        assert!(fs.resolve_content("note.md").is_ok());
        assert!(matches!(
            fs.resolve_content("image.svg"),
            Err(WorkspaceFsError::Denied)
        ));
        assert!(fs.directory_root().is_none());
    }

    #[test]
    fn capability_dir_rejects_parent_and_outside_symlink() {
        let temp = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("note.md"), "ok").unwrap();
        std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), temp.path().join("escape")).unwrap();
        let fs = WorkspaceFs::new(temp.path().to_path_buf(), None);

        assert!(matches!(
            fs.resolve_content("../secret.md"),
            Err(WorkspaceFsError::InvalidPath)
        ));
        #[cfg(unix)]
        assert!(fs.resolve_content("escape/secret.md").is_err());
    }

    #[test]
    fn bulk_enumeration_rejects_outside_file_symlink() {
        let temp = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("inside.md"), "inside").unwrap();
        let secret = outside.path().join("secret.md");
        std::fs::write(&secret, "secret").unwrap();
        let link = temp.path().join("linked-secret.md");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&secret, &link).is_err() {
            // Windows requires Developer Mode or elevated symlink privilege.
            return;
        }

        let fs = WorkspaceFs::new(temp.path().to_path_buf(), None);
        let content_routes: Vec<_> = fs
            .content_files(10)
            .into_iter()
            .map(|(rel, _)| rel.as_route())
            .collect();
        let served_routes: Vec<_> = fs
            .served_files(10)
            .into_iter()
            .map(|(rel, _)| rel.as_route())
            .collect();

        assert_eq!(content_routes, ["inside.md"]);
        assert_eq!(served_routes, ["inside.md"]);
        assert!(fs.route_for_path(&link).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn scoped_symlink_keeps_public_route_and_rejects_target_swap() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new().unwrap();
        std::fs::write(temp.path().join("target-a.md"), "a").unwrap();
        std::fs::write(temp.path().join("target-b.md"), "b").unwrap();
        symlink("target-a.md", temp.path().join("opened.md")).unwrap();
        let fs = WorkspaceFs::new(temp.path().to_path_buf(), Some("opened.md"));

        let files = fs.content_files(10);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0.as_route(), "opened.md");
        assert_eq!(fs.route_for_path(&files[0].1).as_deref(), Some("opened.md"));
        assert_eq!(fs.resolve_content_input(&files[0].1).unwrap(), files[0].1);
        assert!(matches!(
            fs.resolve_content("target-a.md"),
            Err(WorkspaceFsError::Denied)
        ));

        std::fs::remove_file(temp.path().join("opened.md")).unwrap();
        symlink("target-b.md", temp.path().join("opened.md")).unwrap();
        assert!(matches!(
            fs.resolve_content("opened.md"),
            Err(WorkspaceFsError::Denied)
        ));
    }
}
