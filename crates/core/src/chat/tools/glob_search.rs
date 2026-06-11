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
use globset::Glob;
use serde::Deserialize;

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

#[derive(Debug, Deserialize)]
struct GlobInput {
    pattern: String,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) struct GlobTool;

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

    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError> {
        let args: GlobInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidArgument(e.to_string()))?;
        if args.pattern.is_empty() {
            return Err(ToolError::InvalidArgument("empty glob pattern".into()));
        }
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

        let matcher = Glob::new(&args.pattern)
            .map_err(|e| {
                ToolError::InvalidArgument(format!("invalid glob '{}': {e}", args.pattern))
            })?
            .compile_matcher();

        let walker = default_walker(&ctx.workspace_root).build();
        let mut matches: Vec<String> = Vec::new();
        // Cumulative byte budget. The previous implementation collected
        // every match, formatted them all into one String, then truncated.
        // For pathological workspaces (hundred-thousand files with long
        // names) that intermediate Vec could blow past `MAX_TOOL_OUTPUT_BYTES`
        // many times over before truncation kicked in. We now stop walking
        // the moment the next path would push us over budget — both the
        // Vec and the final String stay bounded.
        let mut bytes_used: usize = 0;
        let mut over_budget = false;

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
            if !matcher.is_match(rel) {
                continue;
            }
            // Forward-slash normalize for stable cross-OS citations.
            let line = super::path_to_forward_slash(rel);
            // +1 for the newline that joins this line to the previous one.
            let line_cost = line.len() + 1;
            if bytes_used + line_cost > MAX_TOOL_OUTPUT_BYTES {
                over_budget = true;
                break;
            }
            bytes_used += line_cost;
            matches.push(line);
        }

        matches.sort();

        if matches.is_empty() {
            // If we stopped immediately because the very first match would
            // already exceed the budget, surface it explicitly rather than
            // pretending there are zero matches.
            if over_budget {
                return Ok("(no matches fit within the output budget)".to_string());
            }
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
        } else if over_budget {
            out.push_str("\n... (truncated by output budget)");
        }

        // truncate_to_budget remains as defense-in-depth: the early break
        // above bounds the input, but a future refactor that forgets the
        // break should not be allowed to overflow the tool result.
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
        ToolContext::new(td.path()).unwrap()
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
    async fn early_break_on_output_budget() {
        // Build a workspace where the matched lines collectively exceed
        // MAX_TOOL_OUTPUT_BYTES (64 KiB). Each filename is ~96 chars, so
        // ~700 files would already overflow without the early break.
        let td = TempDir::new().unwrap();
        let stuffer = "a".repeat(80);
        for i in 0..1500 {
            fs::write(td.path().join(format!("{stuffer}-{i:06}.md")), b"x").unwrap();
        }
        let tool = GlobTool;
        let out = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "pattern": "**/*.md", "limit": 5000 }),
            )
            .await
            .unwrap();
        // Output must stay within the byte cap even though the request
        // limit (5000) is well above the file count.
        assert!(
            out.len() <= MAX_TOOL_OUTPUT_BYTES,
            "output {} bytes exceeded budget {}",
            out.len(),
            MAX_TOOL_OUTPUT_BYTES
        );
        // The marker tells the caller we stopped before exhausting matches.
        assert!(
            out.contains("(truncated") || out.contains("more matches"),
            "expected a truncation marker, got tail: ...{}",
            &out[out.len().saturating_sub(60)..]
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
