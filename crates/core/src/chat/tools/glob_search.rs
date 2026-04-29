//! `glob` tool — match file paths in the workspace by a glob pattern.
//!
//! Input schema:
//!   { pattern: string, limit?: integer (default 200) }
//! Behavior:
//!   - run pattern over ignore-filtered file walk from workspace root
//!   - return at most `limit` matches, one path per line (workspace-relative)
//!   - if more matches exist, append "... (N more matches)".

use super::{default_walker, Tool, ToolContext, ToolError, MAX_TOOL_OUTPUT_BYTES};
use async_trait::async_trait;
use globset::{Glob, GlobSetBuilder};
use serde::Deserialize;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

#[derive(Debug, Deserialize)]
struct GlobInput {
    pattern: String,
    #[serde(default)]
    limit: Option<usize>,
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &'static str {
        "glob"
    }

    fn description(&self) -> &'static str {
        "Find files in the workspace matching a glob pattern (e.g. **/*.rs, docs/**/*.md). \
         Respects .gitignore. Returns workspace-relative paths."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Glob pattern (e.g. **/*.md)." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Max matches to return." }
            },
            "required": ["pattern"],
            "additionalProperties": false
        })
    }

    async fn run(
        &self,
        ctx: &ToolContext,
        input: serde_json::Value,
    ) -> Result<String, ToolError> {
        let args: GlobInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidArgument(e.to_string()))?;
        if args.pattern.is_empty() {
            return Err(ToolError::InvalidArgument("empty glob pattern".into()));
        }
        let limit = args
            .limit
            .unwrap_or(DEFAULT_LIMIT)
            .min(MAX_LIMIT)
            .max(1);

        let glob = Glob::new(&args.pattern).map_err(|e| {
            ToolError::InvalidArgument(format!("invalid glob '{}': {e}", args.pattern))
        })?;
        let set = GlobSetBuilder::new()
            .add(glob)
            .build()
            .map_err(|e| ToolError::InvalidArgument(e.to_string()))?;

        let walker = default_walker(&ctx.workspace_root).build();
        let mut matches: Vec<String> = Vec::new();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            // Only consider regular files; gitignore directory pruning is done
            // by the walker itself.
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let rel = match entry.path().strip_prefix(&ctx.workspace_root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !set.is_match(rel) {
                continue;
            }
            // Forward-slash normalize for stable cross-OS citations.
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            matches.push(rel_str);
        }

        matches.sort();

        if matches.is_empty() {
            return Ok("no matches".to_string());
        }

        let total = matches.len();
        let take = total.min(limit);
        let mut out = String::new();
        for (i, p) in matches.iter().take(take).enumerate() {
            if i > 0 {
                out.push('\n');
            }
            out.push_str(p);
        }
        if total > take {
            out.push_str(&format!("\n... ({} more matches)", total - take));
        }

        Ok(truncate_to_budget(out))
    }
}

fn truncate_to_budget(s: String) -> String {
    if s.len() <= MAX_TOOL_OUTPUT_BYTES {
        return s;
    }
    let cut = s[..MAX_TOOL_OUTPUT_BYTES]
        .rfind('\n')
        .unwrap_or(MAX_TOOL_OUTPUT_BYTES);
    let mut out = s[..cut].to_string();
    out.push_str("\n... (truncated)");
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
    async fn finds_matching_files() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.md"), b"# a").unwrap();
        fs::write(td.path().join("b.rs"), b"fn main(){}").unwrap();
        fs::create_dir(td.path().join("docs")).unwrap();
        fs::write(td.path().join("docs").join("c.md"), b"# c").unwrap();
        let tool = GlobTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({ "pattern": "**/*.md" }))
            .await
            .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines.contains(&"a.md"), "got: {out}");
        assert!(lines.contains(&"docs/c.md"), "got: {out}");
        assert!(!lines.contains(&"b.rs"), "got: {out}");
    }

    #[tokio::test]
    async fn no_matches_returns_sentinel() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.md"), b"# a").unwrap();
        let tool = GlobTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({ "pattern": "**/*.xyz" }))
            .await
            .unwrap();
        assert_eq!(out, "no matches");
    }

    #[tokio::test]
    async fn truncates_when_over_limit() {
        let td = TempDir::new().unwrap();
        for i in 0..25 {
            fs::write(td.path().join(format!("f{i:02}.md")), b"x").unwrap();
        }
        let tool = GlobTool;
        let out = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "pattern": "**/*.md", "limit": 10 }),
            )
            .await
            .unwrap();
        // Sorted lexically, first ten should be f00..f09; last line is the
        // "more" marker.
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "f00.md");
        assert_eq!(lines[9], "f09.md");
        assert!(
            lines.last().unwrap().starts_with("... (15 more matches)"),
            "got: {out}"
        );
    }

    #[tokio::test]
    async fn invalid_pattern_errors() {
        let td = TempDir::new().unwrap();
        let tool = GlobTool;
        let err = tool
            .run(&ctx_for(&td), serde_json::json!({ "pattern": "[" }))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgument(_)));
    }
}
