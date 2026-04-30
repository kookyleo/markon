//! Read-only tools the LLM can invoke. All tools are scoped to the workspace
//! root — paths above the root are rejected before they ever hit the disk.

pub mod glob_search;
pub mod grep;
pub mod list_dir;
pub mod read_file;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Per-request tool scope — currently just the workspace root. Anything
/// extra (cwd, environment) lives here so individual tools stay pure.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub workspace_root: PathBuf,
}

impl ToolContext {
    /// Resolve a relative-to-workspace path, rejecting any traversal that
    /// escapes the root. Returns the absolute path on success.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, ToolError> {
        let candidate = self.workspace_root.join(rel);
        let canon = dunce::canonicalize(&candidate)
            .or_else(|_| Ok::<_, std::io::Error>(candidate.clone()))
            .map_err(|e| ToolError::Io(e.to_string()))?;
        if !canon.starts_with(&self.workspace_root) {
            return Err(ToolError::OutsideWorkspace);
        }
        Ok(canon)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
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
    pub fn to_tool_message(&self) -> String {
        self.to_string()
    }
}

/// JSON-Schema-shaped tool definition exposed to the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn input_schema(&self) -> serde_json::Value;
    async fn run(
        &self,
        ctx: &ToolContext,
        input: serde_json::Value,
    ) -> Result<String, ToolError>;

    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: self.name().to_string(),
            description: self.description().to_string(),
            input_schema: self.input_schema(),
        }
    }
}

pub struct ToolRegistry {
    tools: HashMap<&'static str, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn with_default_tools() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(read_file::ReadFileTool));
        r.register(Arc::new(list_dir::ListDirTool));
        r.register(Arc::new(glob_search::GlobTool));
        r.register(Arc::new(grep::GrepTool));
        r
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools.get(name)
    }

    pub fn schemas(&self) -> Vec<ToolSchema> {
        self.tools.values().map(|t| t.schema()).collect()
    }

    pub async fn dispatch(
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

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::with_default_tools()
    }
}

/// Hard cap a single `read_file` / `grep` result body sent back to the model.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
/// Skip files at or above this size in `read_file` and during `list_dir`
/// content-snippet generation. Configurable per tool via input.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB

/// Detect binary by scanning the first N bytes for NUL.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let scan = bytes.len().min(8192);
    bytes[..scan].contains(&0)
}

/// Render a path with forward slashes regardless of platform — used for
/// stable cross-OS citations and tool output.
pub fn path_to_forward_slash(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Default ignore-rule walker that respects `.gitignore`, `.ignore`, and
/// hidden-file conventions — the same defaults ripgrep uses.
pub fn default_walker(root: &Path) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.standard_filters(true)
        .hidden(true)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true);
    b
}
