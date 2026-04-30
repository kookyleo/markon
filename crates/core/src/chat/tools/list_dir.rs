//! `list_dir` tool — list immediate children of a directory inside the workspace.
//!
//! Input schema:
//!   { path?: string }      (default = workspace root)
//! Behavior:
//!   - one-level only
//!   - skip entries that ignore-rules would exclude (.gitignore etc.)
//!   - mark dirs with trailing `/`, mark files with size suffix
//!   - return as a newline-separated list so the model can grep it later.

use super::{default_walker, Tool, ToolContext, ToolError, MAX_TOOL_OUTPUT_BYTES};
use async_trait::async_trait;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ListDirInput {
    #[serde(default)]
    path: Option<String>,
}

pub struct ListDirTool;

#[async_trait]
impl Tool for ListDirTool {
    fn name(&self) -> &'static str {
        "list_dir"
    }

    fn description(&self) -> &'static str {
        "List immediate entries of a directory in the workspace, respecting .gitignore. \
         Default is the workspace root. Directories end with '/'."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path relative to workspace root. Default = root." }
            },
            "additionalProperties": false
        })
    }

    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError> {
        let args: ListDirInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidArgument(e.to_string()))?;

        let rel_arg = args.path.as_deref().unwrap_or("");
        let abs = if rel_arg.is_empty() {
            ctx.workspace_root.clone()
        } else {
            ctx.resolve(rel_arg)?
        };
        let meta = std::fs::metadata(&abs).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ToolError::NotFound(rel_arg.to_string()),
            _ => ToolError::Io(e.to_string()),
        })?;
        if !meta.is_dir() {
            return Err(ToolError::InvalidArgument(format!(
                "{} is not a directory",
                rel_arg
            )));
        }

        // Walk only depth==1 children; default_walker rooted at `abs` already
        // applies gitignore semantics (it consults parent .gitignore files via
        // `parents(true)`).
        let walker = default_walker(&abs).max_depth(Some(1)).build();
        let mut dirs: Vec<(String, ())> = Vec::new();
        let mut files: Vec<(String, u64)> = Vec::new();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue, // ignore I/O errors on individual entries
            };
            // Depth 0 is the start dir itself — skip.
            if entry.depth() == 0 {
                continue;
            }
            let path = entry.path();
            let name = match path.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => continue,
            };
            let ft = entry.file_type();
            let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                dirs.push((name, ()));
            } else {
                let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                files.push((name, len));
            }
        }

        dirs.sort_by(|a, b| a.0.cmp(&b.0));
        files.sort_by(|a, b| a.0.cmp(&b.0));

        let rel_header = if rel_arg.is_empty() {
            ".".to_string()
        } else {
            normalize_rel(rel_arg)
        };
        let mut out = format!(
            "Listing {}/ ({} dirs, {} files)\n",
            rel_header,
            dirs.len(),
            files.len()
        );

        let total = dirs.len() + files.len();
        let mut emitted: usize = 0;
        let mut all_lines: Vec<String> = Vec::with_capacity(total);
        for (name, _) in &dirs {
            all_lines.push(format!("{name}/"));
        }
        for (name, size) in &files {
            all_lines.push(format!("{name}  ({})", human_size(*size)));
        }

        for line in &all_lines {
            // Reserve room for a possible truncation marker.
            let projected = out.len() + line.len() + 1;
            if projected > MAX_TOOL_OUTPUT_BYTES {
                let remaining = total - emitted;
                out.push_str(&format!("... ({remaining} more)\n"));
                return Ok(out);
            }
            out.push_str(line);
            out.push('\n');
            emitted += 1;
        }

        Ok(out)
    }
}

/// Best-effort relative-path normalization for the header line — replaces
/// platform separators with `/` so output is stable across OSes.
fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_end_matches('/').to_string()
}

/// Human-readable byte size, using 1024-based units.
fn human_size(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;
    if bytes < KIB {
        format!("{bytes} B")
    } else if bytes < MIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else if bytes < GIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::tools::ToolContext;
    use std::fs;
    use tempfile::TempDir;

    fn ctx_for(td: &TempDir) -> ToolContext {
        ToolContext {
            workspace_root: dunce::canonicalize(td.path()).unwrap(),
        }
    }

    #[tokio::test]
    async fn lists_dirs_then_files_with_sizes() {
        let td = TempDir::new().unwrap();
        fs::create_dir(td.path().join("zsub")).unwrap();
        fs::create_dir(td.path().join("asub")).unwrap();
        fs::write(td.path().join("readme.md"), b"hello").unwrap();
        fs::write(td.path().join("data.bin"), vec![0u8; 2048]).unwrap();

        let tool = ListDirTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({}))
            .await
            .unwrap();

        // Header
        assert!(
            out.starts_with("Listing ./ (2 dirs, 2 files)\n"),
            "got: {out}"
        );
        // Order: dirs sorted, then files sorted.
        let body = out.lines().skip(1).collect::<Vec<_>>();
        assert_eq!(body[0], "asub/");
        assert_eq!(body[1], "zsub/");
        assert_eq!(body[2], "data.bin  (2.0 KiB)");
        assert_eq!(body[3], "readme.md  (5 B)");
    }

    #[tokio::test]
    async fn respects_gitignore() {
        let td = TempDir::new().unwrap();
        // Make this look like a git workspace so gitignore is consulted.
        fs::create_dir(td.path().join(".git")).unwrap();
        fs::write(td.path().join(".gitignore"), "secret.txt\nbuild/\n").unwrap();
        fs::write(td.path().join("keep.txt"), b"keep").unwrap();
        fs::write(td.path().join("secret.txt"), b"nope").unwrap();
        fs::create_dir(td.path().join("build")).unwrap();
        fs::write(td.path().join("build").join("artifact"), b"x").unwrap();

        let tool = ListDirTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({}))
            .await
            .unwrap();
        assert!(out.contains("keep.txt"));
        assert!(!out.contains("secret.txt"), "should be gitignored: {out}");
        assert!(!out.contains("build/"), "should be gitignored: {out}");
    }

    #[tokio::test]
    async fn errors_when_path_is_a_file() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.txt"), b"hi").unwrap();
        let tool = ListDirTool;
        let err = tool
            .run(&ctx_for(&td), serde_json::json!({ "path": "a.txt" }))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgument(_)));
    }
}
