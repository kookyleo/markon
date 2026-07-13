//! Tools the LLM can invoke — read-only by default, plus the approval-gated
//! `edit_file`. All tools are scoped to the workspace root — paths above the
//! root are rejected before they ever hit the disk.

pub(crate) mod edit_file;
pub(crate) mod glob_search;
pub(crate) mod grep;
pub(crate) mod list_dir;
pub(crate) mod read_file;

use crate::chat::edits::PendingEditStore;
use crate::workspace_fs::WorkspaceFs;
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

pub(crate) use crate::fswalk::{default_walker, path_to_forward_slash};

/// Per-request tool scope. Filesystem access is delegated to `WorkspaceFs` so
/// tools cannot accidentally turn a serving directory into broader authority.
#[derive(Clone)]
pub(crate) struct ToolContext {
    workspace_fs: Arc<WorkspaceFs>,
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
    #[cfg(test)]
    pub(crate) fn new(root: impl AsRef<Path>) -> Result<Self, ToolError> {
        let workspace_root = dunce::canonicalize(root.as_ref())
            .map_err(|e| ToolError::Io(format!("workspace root: {e}")))?;
        let workspace_fs = Arc::new(WorkspaceFs::new(workspace_root.clone(), None));
        Ok(Self {
            workspace_fs,
            pending_edits: None,
            event_sink: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_single_file(root: impl AsRef<Path>, file: &str) -> Result<Self, ToolError> {
        let workspace_root = dunce::canonicalize(root.as_ref())
            .map_err(|e| ToolError::Io(format!("workspace root: {e}")))?;
        Self::for_workspace(Arc::new(WorkspaceFs::new(workspace_root, Some(file))))
    }

    pub(crate) fn for_workspace(workspace_fs: Arc<WorkspaceFs>) -> Result<Self, ToolError> {
        if !workspace_fs.ambient_root().is_dir() {
            return Err(ToolError::Io("workspace root is unavailable".to_string()));
        }
        Ok(Self {
            workspace_fs,
            pending_edits: None,
            event_sink: None,
        })
    }

    pub(crate) fn content_files(&self, limit: usize) -> Vec<(String, PathBuf)> {
        self.workspace_fs
            .content_files(limit)
            .into_iter()
            .map(|(rel, abs)| (rel.as_route(), abs))
            .collect()
    }

    pub(crate) fn directory_root(&self) -> Option<&Path> {
        self.workspace_fs.directory_root()
    }

    pub(crate) fn route_for_path(&self, path: &Path) -> Option<String> {
        self.workspace_fs.route_for_path(path)
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

    /// Resolve an existing path through the workspace content capability.
    pub(crate) fn resolve(&self, rel: &str) -> Result<PathBuf, ToolError> {
        self.workspace_fs
            .resolve_content(rel)
            .map_err(|error| match error {
                crate::workspace_fs::WorkspaceFsError::InvalidPath
                | crate::workspace_fs::WorkspaceFsError::Denied => ToolError::OutsideWorkspace,
                crate::workspace_fs::WorkspaceFsError::NotFound => {
                    ToolError::NotFound(rel.to_string())
                }
                crate::workspace_fs::WorkspaceFsError::Io(message) => ToolError::Io(message),
            })
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
        assert_eq!(ctx.route_for_path(&p).as_deref(), Some("ok.md"));
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

    #[tokio::test]
    async fn single_file_scope_is_enforced_across_all_chat_tools() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("opened.md"), "visible marker\n").unwrap();
        fs::write(td.path().join("sibling.md"), "secret marker\n").unwrap();
        let ctx = ToolContext::for_single_file(td.path(), "opened.md").unwrap();
        let tools = ToolRegistry::for_workspace(true);

        let read = tools
            .dispatch(
                &ctx,
                "read_file",
                serde_json::json!({ "path": "opened.md" }),
            )
            .await
            .unwrap();
        assert!(read.contains("visible marker"));
        assert!(matches!(
            tools
                .dispatch(
                    &ctx,
                    "read_file",
                    serde_json::json!({ "path": "sibling.md" })
                )
                .await,
            Err(ToolError::OutsideWorkspace)
        ));

        let listing = tools
            .dispatch(&ctx, "list_dir", serde_json::json!({}))
            .await
            .unwrap();
        assert!(listing.contains("opened.md"), "got: {listing}");
        assert!(!listing.contains("sibling.md"), "got: {listing}");

        let glob = tools
            .dispatch(&ctx, "glob", serde_json::json!({ "pattern": "**/*.md" }))
            .await
            .unwrap();
        assert_eq!(glob, "opened.md");

        let grep = tools
            .dispatch(&ctx, "grep", serde_json::json!({ "pattern": "marker" }))
            .await
            .unwrap();
        assert!(grep.contains("opened.md:1:visible marker"), "got: {grep}");
        assert!(!grep.contains("sibling.md"), "got: {grep}");
        assert!(matches!(
            tools
                .dispatch(
                    &ctx,
                    "grep",
                    serde_json::json!({ "pattern": "secret", "path": "sibling.md" })
                )
                .await,
            Err(ToolError::OutsideWorkspace)
        ));

        assert!(matches!(
            tools
                .dispatch(
                    &ctx,
                    "edit_file",
                    serde_json::json!({
                        "path": "sibling.md",
                        "old_string": "secret",
                        "new_string": "stolen"
                    })
                )
                .await,
            Err(ToolError::OutsideWorkspace)
        ));
        assert_eq!(
            fs::read_to_string(td.path().join("sibling.md")).unwrap(),
            "secret marker\n"
        );
    }
}
