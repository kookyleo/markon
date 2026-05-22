//! `markon bug | idea | ask` — file a GitHub issue or discussion without
//! leaving the terminal.
//!
//! Hard dependency on the GitHub CLI (`gh`). Rationale: CLI users heavily
//! overlap with `gh` users, and shelling out to `gh` lets us inherit its
//! auth, retry, and error handling instead of reimplementing them.
//!
//! - `bug`  → `gh issue create --label bug` (built-in)
//! - `idea` → `gh api graphql` createDiscussion in the Ideas category
//! - `ask`  → `gh api graphql` createDiscussion in Q&A
//!
//! Body templates and title prefixes come from `markon-core`'s i18n bundle
//! (`tpl.bug`, `tpl.idea`, `tpl.ask`, `tpl.title.bug`, …) so the CLI and the
//! GUI's "Report issue" buttons stay in sync.

use std::process::{Command, Stdio};

const REPO_OWNER: &str = "kookyleo";
const REPO_NAME: &str = "markon";

#[derive(Debug, Clone, Copy)]
pub enum FeedbackKind {
    Bug,
    Idea,
    Ask,
}

impl FeedbackKind {
    fn template_key(self) -> &'static str {
        match self {
            FeedbackKind::Bug => "tpl.bug",
            FeedbackKind::Idea => "tpl.idea",
            FeedbackKind::Ask => "tpl.ask",
        }
    }
    fn title_prefix_key(self) -> &'static str {
        match self {
            FeedbackKind::Bug => "tpl.title.bug",
            FeedbackKind::Idea => "tpl.title.idea",
            FeedbackKind::Ask => "tpl.title.ask",
        }
    }
}

pub fn submit(
    kind: FeedbackKind,
    title: Option<String>,
    body: Option<String>,
    language: &str,
) -> Result<(), String> {
    ensure_gh_ready()?;

    let i18n = markon_core::i18n::get_lang_data(language);
    let template = i18n[kind.template_key()].as_str().unwrap_or("").to_string();
    let title_prefix = i18n[kind.title_prefix_key()]
        .as_str()
        .unwrap_or("")
        .to_string();
    let info = SystemInfo::collect();
    let prefilled_body = render_template(&template, &info);

    let title = resolve_title(title, &title_prefix)?;
    let body = resolve_body(body, &prefilled_body)?;

    match kind {
        FeedbackKind::Bug => submit_bug(&title, &body),
        FeedbackKind::Idea => submit_discussion(&title, &body, "ideas"),
        FeedbackKind::Ask => submit_discussion(&title, &body, "q-a"),
    }
}

/// Ensure `gh` is installed and authenticated. Both checks are needed: a
/// PATH miss prints a useful install hint; an auth miss tells the user the
/// one command that fixes it.
fn ensure_gh_ready() -> Result<(), String> {
    let which = Command::new("gh")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if !matches!(which, Ok(s) if s.success()) {
        return Err("`gh` (GitHub CLI) not found on PATH.\n\
             Install: https://github.com/cli/cli#installation"
            .to_string());
    }
    let auth = Command::new("gh")
        .args(["auth", "status"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if !matches!(auth, Ok(s) if s.success()) {
        return Err("`gh` is installed but not authenticated.\n\
             Run `gh auth login` and try again."
            .to_string());
    }
    Ok(())
}

struct SystemInfo {
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
}

impl SystemInfo {
    fn collect() -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

/// Resolve `{app_version} {os} {os_version} {arch} {ua}` placeholders in the
/// i18n template. We don't ship an os_version probe in the CLI, so that
/// field collapses to empty; ditto `ua` (browser concept, not relevant here).
fn render_template(template: &str, info: &SystemInfo) -> String {
    template
        .replace("{app_version}", info.app_version)
        .replace("{os}", info.os)
        .replace("{os_version}", "")
        .replace("{arch}", info.arch)
        .replace("{ua}", "(cli)")
}

fn resolve_title(arg: Option<String>, prefix: &str) -> Result<String, String> {
    let raw = match arg {
        Some(t) if !t.trim().is_empty() => t,
        _ => dialoguer::Input::<String>::new()
            .with_prompt("Title")
            .interact_text()
            .map_err(|e| format!("could not read title: {e}"))?,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("title must not be empty".to_string());
    }
    // Prepend the prefix unless the user already typed it.
    if !prefix.is_empty() && !trimmed.starts_with(prefix.trim()) {
        Ok(format!("{prefix}{trimmed}"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn resolve_body(arg: Option<String>, prefilled: &str) -> Result<String, String> {
    if let Some(b) = arg {
        return Ok(b);
    }
    let edited = dialoguer::Editor::new()
        .extension(".md")
        .edit(prefilled)
        .map_err(|e| format!("could not open $EDITOR: {e}"))?;
    let body = edited.unwrap_or_default();
    if body.trim().is_empty() {
        return Err("body must not be empty".to_string());
    }
    Ok(body)
}

fn submit_bug(title: &str, body: &str) -> Result<(), String> {
    let repo = format!("{REPO_OWNER}/{REPO_NAME}");
    let output = Command::new("gh")
        .args([
            "issue", "create", "--repo", &repo, "--label", "bug", "--title", title, "--body", body,
        ])
        .output()
        .map_err(|e| format!("failed to invoke gh: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "gh issue create failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("Created: {url}");
    Ok(())
}

/// Discussions don't have a built-in `gh discussion create` in gh 2.x, so
/// drive the GraphQL `createDiscussion` mutation directly. Two API calls:
/// one to resolve the repo + category node IDs, one for the mutation
/// itself.
fn submit_discussion(title: &str, body: &str, category_slug: &str) -> Result<(), String> {
    let lookup_query = format!(
        r#"query {{ repository(owner:"{REPO_OWNER}", name:"{REPO_NAME}") {{ id discussionCategories(first:20) {{ nodes {{ id slug }} }} }} }}"#
    );
    let lookup = run_graphql(&lookup_query, &[])?;
    let repo_id = lookup["data"]["repository"]["id"]
        .as_str()
        .ok_or("graphql response missing repository.id")?
        .to_string();
    let category_id = lookup["data"]["repository"]["discussionCategories"]["nodes"]
        .as_array()
        .ok_or("graphql response missing discussionCategories.nodes")?
        .iter()
        .find(|n| n["slug"] == category_slug)
        .ok_or_else(|| {
            format!(
                "discussion category slug '{category_slug}' not found on {REPO_OWNER}/{REPO_NAME}"
            )
        })?["id"]
        .as_str()
        .ok_or("graphql response missing category.id")?
        .to_string();

    let mutation = "mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){\
        createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){\
            discussion{url}\
        }\
    }";
    let result = run_graphql(
        mutation,
        &[
            ("repo", &repo_id),
            ("cat", &category_id),
            ("title", title),
            ("body", body),
        ],
    )?;
    let url = result["data"]["createDiscussion"]["discussion"]["url"]
        .as_str()
        .ok_or("graphql response missing discussion.url")?
        .to_string();
    println!("Created: {url}");
    Ok(())
}

fn run_graphql(query: &str, vars: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("gh");
    cmd.args(["api", "graphql", "-f", &format!("query={query}")]);
    for (k, v) in vars {
        cmd.args(["-f", &format!("{k}={v}")]);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to invoke gh: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "gh api graphql failed:\n{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid gh response (not JSON): {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_renders_known_placeholders() {
        let info = SystemInfo {
            app_version: "1.2.3",
            os: "macos",
            arch: "aarch64",
        };
        let rendered = render_template(
            "Markon v{app_version} on {os} {os_version} ({arch}) [{ua}]",
            &info,
        );
        assert_eq!(rendered, "Markon v1.2.3 on macos  (aarch64) [(cli)]");
    }

    #[test]
    fn title_prefix_is_prepended_when_missing() {
        let title = resolve_title(Some("crash on save".into()), "[Bug] ").unwrap();
        assert_eq!(title, "[Bug] crash on save");
    }

    #[test]
    fn title_prefix_is_not_doubled_when_user_already_typed_it() {
        let title = resolve_title(Some("[Bug] crash on save".into()), "[Bug] ").unwrap();
        assert_eq!(title, "[Bug] crash on save");
    }

    #[test]
    fn template_leaves_unknown_placeholders_alone() {
        let info = SystemInfo {
            app_version: "0.1.0",
            os: "linux",
            arch: "x86_64",
        };
        // `{markdown}` is not a known placeholder — should pass through.
        let rendered = render_template("Code: `{markdown}` on {os}", &info);
        assert_eq!(rendered, "Code: `{markdown}` on linux");
    }
}
