//! `grep` tool — search file contents in the workspace, ripgrep-style.
//!
//! Input schema:
//!   { pattern: string, path?: string, glob?: string,
//!     case_insensitive?: bool, max_matches?: integer (default 100) }
//! Behavior:
//!   - default starting path = workspace root; if `path` given, scope to that
//!   - optional `glob` filters file paths (e.g. "*.md")
//!   - results formatted as `path:line: <matched line>` so the model can cite
//!   - cap total bytes by [`MAX_TOOL_OUTPUT_BYTES`] and append truncation note.

use super::{default_walker, Tool, ToolContext, ToolError, MAX_TOOL_OUTPUT_BYTES};
use async_trait::async_trait;
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, Sink, SinkMatch};
use serde::Deserialize;

const DEFAULT_MAX_MATCHES: usize = 100;
const HARD_MAX_MATCHES: usize = 1000;

#[derive(Debug, Deserialize)]
struct GrepInput {
    pattern: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    glob: Option<String>,
    #[serde(default)]
    case_insensitive: Option<bool>,
    #[serde(default)]
    max_matches: Option<usize>,
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &'static str {
        "grep"
    }

    fn description(&self) -> &'static str {
        "Search file contents in the workspace using a regex pattern. Returns matching \
         lines as path:line:content. Respects .gitignore. Use this to locate references, \
         find symbols, or verify wording before quoting."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Regex pattern (Rust-style)." },
                "path":    { "type": "string", "description": "Optional sub-path to scope the search." },
                "glob":    { "type": "string", "description": "Optional file-name glob filter, e.g. '*.md'." },
                "case_insensitive": { "type": "boolean" },
                "max_matches": { "type": "integer", "minimum": 1, "maximum": 1000 }
            },
            "required": ["pattern"],
            "additionalProperties": false
        })
    }

    async fn run(&self, ctx: &ToolContext, input: serde_json::Value) -> Result<String, ToolError> {
        let args: GrepInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidArgument(e.to_string()))?;
        if args.pattern.is_empty() {
            return Err(ToolError::InvalidArgument("empty pattern".into()));
        }
        let max_matches = args
            .max_matches
            .unwrap_or(DEFAULT_MAX_MATCHES)
            .clamp(1, HARD_MAX_MATCHES);
        let case_insensitive = args.case_insensitive.unwrap_or(false);

        let start = match args.path.as_deref() {
            Some(p) if !p.is_empty() => ctx.resolve(p)?,
            _ => ctx.workspace_root.clone(),
        };

        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(case_insensitive)
            .build(&args.pattern)
            .map_err(|e| ToolError::InvalidArgument(format!("invalid regex: {e}")))?;

        let glob_set: Option<GlobSet> = match args.glob.as_deref() {
            Some(g) if !g.is_empty() => {
                let glob = Glob::new(g)
                    .map_err(|e| ToolError::InvalidArgument(format!("invalid glob '{g}': {e}")))?;
                let set = GlobSetBuilder::new()
                    .add(glob)
                    .build()
                    .map_err(|e| ToolError::InvalidArgument(e.to_string()))?;
                Some(set)
            }
            _ => None,
        };

        let walker = default_walker(&start).build();
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .multi_line(false)
            .build();

        // Pre-format header now (we don't know match count yet); we'll
        // prepend it when we finalize the body.
        let mut hits: Vec<String> = Vec::new();
        let mut byte_budget_used: usize = 0;
        let mut budget_full = false;

        'walk: for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }
            let path = entry.path();
            // Compute the workspace-relative path used both for glob filter
            // and for output. If the path lives outside the workspace root
            // (shouldn't happen, but be defensive), skip it.
            let rel = match path.strip_prefix(&ctx.workspace_root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            if let Some(set) = &glob_set {
                if !set.is_match(&rel) {
                    continue;
                }
            }
            let rel_str = rel_to_forward(&rel);

            let remaining = max_matches.saturating_sub(hits.len());
            if remaining == 0 {
                break;
            }
            let mut sink = CollectingSink {
                rel: rel_str,
                hits: &mut hits,
                remaining,
                bytes_used: &mut byte_budget_used,
                bytes_budget: MAX_TOOL_OUTPUT_BYTES,
                budget_full: &mut budget_full,
            };
            // search_path opens the file and runs binary detection internally.
            let _ = searcher.search_path(&matcher, path, &mut sink);
            if hits.len() >= max_matches || budget_full {
                break 'walk;
            }
        }

        if hits.is_empty() {
            return Ok("no matches".to_string());
        }

        let mut out = format!(
            "Found {} match(es) for pattern \"{}\"\n",
            hits.len(),
            args.pattern
        );
        for line in &hits {
            // Stop appending if we'd blow past the budget — we already tried
            // to honor it inside the sink, but the header counts too.
            if out.len() + line.len() + 1 > MAX_TOOL_OUTPUT_BYTES {
                out.push_str("\n... (truncated)");
                return Ok(out);
            }
            out.push_str(line);
            out.push('\n');
        }
        if budget_full {
            // Drop the trailing newline before the marker for tidier output.
            if out.ends_with('\n') {
                out.pop();
            }
            out.push_str("\n... (truncated)");
        }
        Ok(out)
    }
}

use super::path_to_forward_slash as rel_to_forward;

/// A `Sink` that stashes formatted `rel:line:text` strings into a shared
/// vector. Stops searching the current file once we've collected enough or
/// the byte budget is full.
struct CollectingSink<'a> {
    rel: String,
    hits: &'a mut Vec<String>,
    remaining: usize,
    bytes_used: &'a mut usize,
    bytes_budget: usize,
    budget_full: &'a mut bool,
}

impl<'a> Sink for CollectingSink<'a> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, std::io::Error> {
        if self.remaining == 0 {
            return Ok(false);
        }
        let line_no = mat.line_number().unwrap_or(0);
        // `mat.bytes()` may span multiple lines if multi_line is on, but we
        // explicitly disabled it. Trim a single trailing newline.
        let raw = mat.bytes();
        let text = trim_trailing_newline(raw);
        let line_text = String::from_utf8_lossy(text);
        let line = format!("{}:{}:{}", self.rel, line_no, line_text);
        let cost = line.len() + 1; // newline
        if *self.bytes_used + cost > self.bytes_budget {
            *self.budget_full = true;
            return Ok(false);
        }
        *self.bytes_used += cost;
        self.hits.push(line);
        self.remaining = self.remaining.saturating_sub(1);
        Ok(self.remaining > 0)
    }
}

fn trim_trailing_newline(b: &[u8]) -> &[u8] {
    let mut end = b.len();
    if end > 0 && b[end - 1] == b'\n' {
        end -= 1;
        if end > 0 && b[end - 1] == b'\r' {
            end -= 1;
        }
    }
    &b[..end]
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
    async fn finds_matches_with_line_numbers() {
        let td = TempDir::new().unwrap();
        fs::write(
            td.path().join("a.md"),
            "alpha line\nTODO fix me\nbeta line\nTODO again\n",
        )
        .unwrap();
        let tool = GrepTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({ "pattern": "TODO" }))
            .await
            .unwrap();
        assert!(out.starts_with("Found 2 match(es)"), "got: {out}");
        assert!(out.contains("a.md:2:TODO fix me"), "got: {out}");
        assert!(out.contains("a.md:4:TODO again"), "got: {out}");
    }

    #[tokio::test]
    async fn glob_filters_files() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("notes.md"), "hello world\n").unwrap();
        fs::write(td.path().join("code.rs"), "// hello world\n").unwrap();
        let tool = GrepTool;
        let out = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "pattern": "hello", "glob": "*.md" }),
            )
            .await
            .unwrap();
        assert!(out.contains("notes.md:1:hello world"), "got: {out}");
        assert!(
            !out.contains("code.rs"),
            "rs file should be filtered: {out}"
        );
    }

    #[tokio::test]
    async fn case_insensitive_search() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.md"), "Hello\nhello\nHELLO\n").unwrap();
        let tool = GrepTool;
        let out = tool
            .run(
                &ctx_for(&td),
                serde_json::json!({ "pattern": "hello", "case_insensitive": true }),
            )
            .await
            .unwrap();
        // All three lines should match.
        assert!(out.contains("a.md:1:Hello"), "got: {out}");
        assert!(out.contains("a.md:2:hello"), "got: {out}");
        assert!(out.contains("a.md:3:HELLO"), "got: {out}");
    }

    #[tokio::test]
    async fn no_matches_returns_sentinel() {
        let td = TempDir::new().unwrap();
        fs::write(td.path().join("a.md"), "nothing here\n").unwrap();
        let tool = GrepTool;
        let out = tool
            .run(&ctx_for(&td), serde_json::json!({ "pattern": "absent" }))
            .await
            .unwrap();
        assert_eq!(out, "no matches");
    }
}
