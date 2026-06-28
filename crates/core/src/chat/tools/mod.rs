//! Tools the LLM can invoke — read-only by default, plus the approval-gated
//! `edit_file`. All tools are scoped to the workspace root — paths above the
//! root are rejected before they ever hit the disk.

pub(crate) mod edit_file;
pub(crate) mod glob_search;
pub(crate) mod grep;
pub(crate) mod list_dir;
pub(crate) mod read_file;

use crate::chat::edits::PendingEditStore;
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

pub(crate) use crate::fswalk::{default_walker, path_to_forward_slash};

/// Per-request tool scope — currently just the workspace root. Anything
/// extra (cwd, environment) lives here so individual tools stay pure.
///
/// `workspace_root` must be canonicalized at construction so the sandbox
/// check in `resolve()` can rely on lexical prefix comparison being
/// semantically meaningful. Use `ToolContext::new()` instead of building the
/// struct literally — the literal constructor is kept `pub` only for tests
/// that pass an already-canonicalized temp dir.
#[derive(Clone)]
pub(crate) struct ToolContext {
    pub workspace_root: PathBuf,
    /// Pending-edit queue, shared with the workspace's HTTP routes so the
    /// `edit_file` tool can stash a proposal and await the user's decision.
    /// `None` in unit-test contexts that don't need it.
    pub pending_edits: Option<Arc<PendingEditStore>>,
    /// Channel the agent loop uses to fan agent events out to SSE. Tools that
    /// need to surface mid-run UI hooks (currently just `edit_file`) push
    /// directly to this. `None` in unit tests.
    pub event_sink: Option<mpsc::Sender<crate::chat::agent::AgentEvent>>,
}

impl ToolContext {
    /// Canonicalize `root` and wrap it in a `ToolContext`. Returns an error
    /// when the root cannot be canonicalized (e.g. doesn't exist).
    pub(crate) fn new(root: impl AsRef<Path>) -> Result<Self, ToolError> {
        let workspace_root = dunce::canonicalize(root.as_ref())
            .map_err(|e| ToolError::Io(format!("workspace root: {e}")))?;
        Ok(Self {
            workspace_root,
            pending_edits: None,
            event_sink: None,
        })
    }

    /// Builder that attaches the shared pending-edit store and event sink
    /// the `edit_file` tool needs. The agent loop calls this once per run.
    pub(crate) fn with_chat_state(
        mut self,
        pending_edits: Arc<PendingEditStore>,
        event_sink: mpsc::Sender<crate::chat::agent::AgentEvent>,
    ) -> Self {
        self.pending_edits = Some(pending_edits);
        self.event_sink = Some(event_sink);
        self
    }

    /// Resolve a relative-to-workspace path, rejecting any traversal that
    /// escapes the root. Returns the absolute path on success.
    ///
    /// Defense-in-depth strategy:
    /// 1. Reject `..`, absolute paths, and Windows path prefixes lexically —
    ///    no syscall needed, eliminates the obvious attempts up front.
    /// 2. Canonicalize the candidate (must exist). This collapses any
    ///    symlinks inside `workspace_root` that point outside, so the next
    ///    check can catch them.
    /// 3. `starts_with` against the canonical root — only paths that resolve
    ///    inside the sandbox are returned.
    ///
    /// We intentionally do NOT fall back to the un-canonicalized candidate
    /// on `canonicalize()` failure: that fallback silently broke step 3 for
    /// any path whose last component didn't exist (`..` traversal to a
    /// non-existent file then read), since `PathBuf::starts_with` is a
    /// lexical component-prefix match and does not normalize `..`.
    pub(crate) fn resolve(&self, rel: &str) -> Result<PathBuf, ToolError> {
        let rel_path = Path::new(rel);
        for comp in rel_path.components() {
            match comp {
                Component::ParentDir => return Err(ToolError::OutsideWorkspace),
                Component::RootDir | Component::Prefix(_) => {
                    return Err(ToolError::OutsideWorkspace);
                }
                Component::CurDir | Component::Normal(_) => {}
            }
        }
        let candidate = self.workspace_root.join(rel_path);
        let canon = dunce::canonicalize(&candidate).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ToolError::NotFound(rel.to_string()),
            _ => ToolError::Io(e.to_string()),
        })?;
        if !canon.starts_with(&self.workspace_root) {
            return Err(ToolError::OutsideWorkspace);
        }
        Ok(canon)
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ToolError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("path escapes workspace root")]
    OutsideWorkspace,
    #[error("file too large")]
    TooLarge,
    #[error("binary or non-utf8 file")]
    Binary,
    #[error("io error: {0}")]
    Io(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl ToolError {
    /// Render the error as a string the LLM gets back as `tool_result` content
    /// when `is_error: true`. Keep these short and actionable.
    pub(crate) fn to_tool_message(&self) -> String {
        self.to_string()
    }
}

/// JSON-Schema-shaped tool definition exposed to the LLM.
#[derive(Debug, Clone)]
pub(crate) struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[async_trait]
pub(crate) trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn input_schema(&self) -> serde_json::Value;
    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError>;

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.name().to_string(),
            description: self.description().to_string(),
            input_schema: self.input_schema(),
        }
    }
}

pub(crate) struct ToolRegistry {
    tools: HashMap<&'static str, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub(crate) fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Read-only tool set — what every chat session gets unconditionally.
    pub(crate) fn with_default_tools() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(read_file::ReadFileTool));
        r.register(Arc::new(list_dir::ListDirTool));
        r.register(Arc::new(glob_search::GlobTool));
        r.register(Arc::new(grep::GrepTool));
        r
    }

    /// Registry shaped for a particular workspace. Adds the `edit_file` tool
    /// when `enable_edit` is on — same cross-flag gate the GUI uses to decide
    /// whether the editor surface is available.
    pub(crate) fn for_workspace(enable_edit: bool) -> Self {
        let mut r = Self::with_default_tools();
        if enable_edit {
            r.register(Arc::new(edit_file::EditFileTool));
        }
        r
    }

    pub(crate) fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name(), tool);
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    pub(crate) fn schemas(&self) -> Vec<ToolSchema> {
        self.tools.values().map(|t| t.schema()).collect()
    }

    pub(crate) async fn dispatch(
        &self,
        ctx: &ToolContext,
        name: &str,
        input: serde_json::Value,
    ) -> Result<String, ToolError> {
        let tool = self
            .get(name)
            .ok_or_else(|| ToolError::NotFound(format!("tool '{name}' is unknown")))?;
        tool.run(ctx, input).await
    }
}

/// Hard cap a single `read_file` / `grep` result body sent back to the model.
pub(crate) const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
/// Refuse files above this size in `read_file` / `edit_file`.
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Detect binary by scanning the first N bytes for NUL.
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    let scan = bytes.len().min(8192);
    bytes[..scan].contains(&0)
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn ctx() -> (TempDir, ToolContext) {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("ok.md"), b"hi").unwrap();
        let ctx = ToolContext::new(td.path()).unwrap();
        (td, ctx)
    }

    #[test]
    fn accepts_normal_relative_path() {
        let (_td, ctx) = ctx();
        let p = ctx.resolve("ok.md").unwrap();
        assert!(p.ends_with("ok.md"));
        assert!(p.starts_with(&ctx.workspace_root));
    }

    #[test]
    fn accepts_curdir_component() {
        let (_td, ctx) = ctx();
        ctx.resolve("./ok.md").unwrap();
    }

    #[test]
    fn rejects_parent_traversal_even_when_target_missing() {
        // Regression: the pre-fix `or_else` fallback let
        // `workspace_root.join("../etc/passwd")` slip past the lexical
        // `starts_with` check whenever canonicalize failed (typically because
        // the last component did not exist).
        let (_td, ctx) = ctx();
        let err = ctx.resolve("../etc/passwd").unwrap_err();
        assert!(matches!(err, ToolError::OutsideWorkspace), "got {err:?}");
    }

    #[test]
    fn rejects_parent_traversal_with_existing_outside_target() {
        let (_td, ctx) = ctx();
        // /tmp exists; without the lexical check, an attacker could read it.
        let err = ctx.resolve("../").unwrap_err();
        assert!(matches!(err, ToolError::OutsideWorkspace), "got {err:?}");
    }

    #[test]
    fn rejects_absolute_path() {
        let (_td, ctx) = ctx();
        #[cfg(unix)]
        let abs = "/etc/passwd";
        #[cfg(windows)]
        let abs = "C:\\Windows\\System32\\drivers\\etc\\hosts";
        let err = ctx.resolve(abs).unwrap_err();
        assert!(matches!(err, ToolError::OutsideWorkspace), "got {err:?}");
    }

    #[test]
    fn missing_file_returns_not_found() {
        let (_td, ctx) = ctx();
        let err = ctx.resolve("does-not-exist.md").unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)), "got {err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escaping_workspace() {
        use std::os::unix::fs::symlink;
        let td = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), b"nope").unwrap();
        symlink(outside.path(), td.path().join("escape")).unwrap();
        let ctx = ToolContext::new(td.path()).unwrap();
        // Following the symlink would canonicalize to a path outside the
        // workspace; the post-canonicalize starts_with check must catch it.
        let err = ctx.resolve("escape/secret.txt").unwrap_err();
        assert!(matches!(err, ToolError::OutsideWorkspace), "got {err:?}");
    }
}
