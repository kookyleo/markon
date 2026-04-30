//! `read_file` tool — read a UTF-8 text file relative to the workspace root.
//!
//! Input schema:
//!   { path: string, offset?: integer (0-based line), limit?: integer }
//! Behavior:
//!   - resolve via [`ToolContext::resolve`] (rejects traversal)
//!   - error with [`ToolError::NotFound`] / [`ToolError::Binary`] / [`ToolError::TooLarge`]
//!   - return `path:start-end (of total)` header followed by numbered lines so the
//!     model has a stable citation handle.

use super::{looks_binary, Tool, ToolContext, ToolError, MAX_FILE_BYTES, MAX_TOOL_OUTPUT_BYTES};
use async_trait::async_trait;
use serde::Deserialize;
use std::fs::File;
use std::io::Read;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 2000;

#[derive(Debug, Deserialize)]
struct ReadFileInput {
    path: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

pub struct ReadFileTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn description(&self) -> &'static str {
        "Read a text file from the workspace. Returns up to 64 KiB. Use offset+limit \
         (line-based) to page through larger files. Binary or >1 MiB files are refused."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path relative to the workspace root." },
                "offset": { "type": "integer", "minimum": 0, "description": "0-based line to start at." },
                "limit": { "type": "integer", "minimum": 1, "description": "Max lines to return." }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError> {
        let args: ReadFileInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidArgument(e.to_string()))?;

        let offset = args.offset.unwrap_or(0);
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

        let abs = ctx.resolve(&args.path)?;
        let meta = std::fs::metadata(&abs).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ToolError::NotFound(args.path.clone()),
            _ => ToolError::Io(e.to_string()),
        })?;
        if !meta.is_file() {
            return Err(ToolError::InvalidArgument(format!(
                "{} is not a regular file",
                args.path
            )));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(ToolError::TooLarge);
        }

        // Sniff the first 8 KiB for binary content before slurping.
        let mut sniff = [0u8; 8192];
        let n = {
            let mut f = File::open(&abs).map_err(|e| ToolError::Io(e.to_string()))?;
            f.read(&mut sniff)
                .map_err(|e| ToolError::Io(e.to_string()))?
        };
        if looks_binary(&sniff[..n]) {
            return Err(ToolError::Binary);
        }

        let bytes = std::fs::read(&abs).map_err(|e| ToolError::Io(e.to_string()))?;
        let content = String::from_utf8(bytes).map_err(|_| ToolError::Binary)?;

        // Split on '\n'; keep empty trailing element only if the file truly ended
        // with content after the final newline (rare). `split('\n')` gives us
        // [..., "last", ""] when the file ends with '\n'; drop that trailing
        // empty so total_lines reflects the visible line count.
        let mut all: Vec<&str> = content.split('\n').collect();
        if matches!(all.last(), Some(&"")) && content.ends_with('\n') {
            all.pop();
        }
        let total_lines = all.len();

        if offset >= total_lines && total_lines > 0 {
            return Err(ToolError::InvalidArgument(format!(
                "offset {offset} exceeds line count {total_lines}"
            )));
        }
        // Empty file: produce an empty body with a header.
        if total_lines == 0 {
            return Ok(format!(
                "{}:0-0 (of 0)\n",
                rel_path_string(&abs, &ctx.workspace_root)
            ));
        }

        let end = (offset + limit).min(total_lines);
        let slice = &all[offset..end];

        let rel = rel_path_string(&abs, &ctx.workspace_root);
        let mut out = String::new();
        out.push_str(&format!(
            "{}:{}-{} (of {})\n",
            rel,
            offset + 1,
            end,
            total_lines
        ));
        for (i, line) in slice.iter().enumerate() {
            let n = offset + i + 1;
            out.push_str(&format!("{n:>6}\u{2192} {line}\n"));
        }

        Ok(truncate_to_budget(out, total_lines.saturating_sub(end)))
    }
}

/// Render a workspace-relative path with forward slashes. Falls back to the
/// absolute path if the strip fails (shouldn't happen since `resolve` checks
/// containment).
fn rel_path_string(abs: &std::path::Path, root: &std::path::Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    super::path_to_forward_slash(rel)
}

/// Cap output at `MAX_TOOL_OUTPUT_BYTES`, truncating at a line boundary and
/// appending a marker that tells the model how many lines were dropped.
fn truncate_to_budget(s: String, lines_after_slice: usize) -> String {
    if s.len() <= MAX_TOOL_OUTPUT_BYTES {
        return s;
    }
    // Walk back to the last newline before the budget so we don't break inside
    // a numbered line.
    let cut = s[..MAX_TOOL_OUTPUT_BYTES]
        .rfind('\n')
        .unwrap_or(MAX_TOOL_OUTPUT_BYTES);
    // Count remaining lines for the marker (lines we dropped from this output
    // plus lines after the slice).
    let dropped_in_slice = s[cut..].matches('\n').count();
    let mut out = s[..cut].to_string();
    out.push_str(&format!(
        "\n... (truncated, {} more lines)",
        dropped_in_slice + lines_after_slice
    ));
    out
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
    async fn happy_path_reads_full_file() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let tool = ReadFileTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({ "path": "a.txt" }))
            .await
            .unwrap();
        assert!(out.starts_with("a.txt:1-3 (of 3)\n"), "got: {out}");
        assert!(out.contains("     1\u{2192} alpha"));
        assert!(out.contains("     2\u{2192} beta"));
        assert!(out.contains("     3\u{2192} gamma"));
    }

    #[tokio::test]
    async fn offset_and_limit_slice() {
        let td = TempDir::new().unwrap();
        let body = (1..=10)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(td.path().join("b.txt"), body).unwrap();
        let tool = ReadFileTool;
        let out = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "path": "b.txt", "offset": 2, "limit": 3 }),
            )
            .await
            .unwrap();
        assert!(out.starts_with("b.txt:3-5 (of 10)\n"), "got: {out}");
        assert!(out.contains("     3\u{2192} line3"));
        assert!(out.contains("     5\u{2192} line5"));
        assert!(!out.contains("line6"));
    }

    #[tokio::test]
    async fn offset_past_end_errors() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("c.txt"), "only one line\n").unwrap();
        let tool = ReadFileTool;
        let err = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "path": "c.txt", "offset": 50 }),
            )
            .await
            .unwrap_err();
        match err {
            ToolError::InvalidArgument(msg) => {
                assert!(msg.contains("offset 50"));
                assert!(msg.contains("line count 1"));
            }
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_binary_files() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("bin.dat"), [0u8, 1, 2, 3, 0, 9]).unwrap();
        let tool = ReadFileTool;
        let err = tool
            .run(&ctx_for(&td), serde_json::json!({ "path": "bin.dat" }))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Binary));
    }

    #[tokio::test]
    async fn rejects_too_large_files() {
        let td = TempDir::new().unwrap();
        let big = vec![b'a'; (MAX_FILE_BYTES as usize) + 16];
        fs::write(td.path().join("big.txt"), big).unwrap();
        let tool = ReadFileTool;
        let err = tool
            .run(&ctx_for(&td), serde_json::json!({ "path": "big.txt" }))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::TooLarge));
    }
}
