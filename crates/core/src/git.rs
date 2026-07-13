use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use crate::workspace_fs::WorkspaceFs;

#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    pub available: bool,
    pub branch: Option<String>,
    pub commit_short: Option<String>,
    pub dirty: bool,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub renamed: usize,
    pub untracked: usize,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

impl GitStatus {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            branch: None,
            commit_short: None,
            dirty: false,
            added: 0,
            modified: 0,
            deleted: 0,
            renamed: 0,
            untracked: 0,
            ahead: None,
            behind: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitTag {
    pub name: String,
    pub short_hash: String,
    pub relative_time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub relative_time: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitPathCommit {
    pub subject: String,
    pub time: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub patch: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiff {
    pub range: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub patch: String,
    pub files: Vec<GitDiffFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommitResult {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
}

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("not a git repository")]
    NotRepository,
    #[error("invalid git revision")]
    InvalidRevision,
    #[error("nothing to commit")]
    NothingToCommit,
    #[error("git command failed: {0}")]
    Command(String),
    #[error("io error: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

pub fn status(root: &Path) -> GitStatus {
    if git_stdout(root, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return GitStatus::unavailable();
    }

    let branch = git_stdout(root, &["branch", "--show-current"])
        .filter(|s| !s.is_empty())
        .or_else(|| {
            git_stdout(root, &["rev-parse", "--abbrev-ref", "HEAD"])
                .filter(|s| !s.is_empty() && s != "HEAD")
        });
    let commit_short =
        git_stdout(root, &["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty());
    let porcelain = git_stdout(root, &["status", "--porcelain=v1", "--", "."]).unwrap_or_default();

    let mut out = GitStatus {
        available: true,
        branch,
        commit_short,
        dirty: !porcelain.trim().is_empty(),
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        untracked: 0,
        ahead: None,
        behind: None,
    };

    for line in porcelain.lines() {
        let code = line.get(..2).unwrap_or(line);
        if code == "??" {
            out.untracked += 1;
            continue;
        }
        if code.contains('R') || code.contains('C') {
            out.renamed += 1;
        } else if code.contains('A') {
            out.added += 1;
        } else if code.contains('D') {
            out.deleted += 1;
        } else if code.contains('M') {
            out.modified += 1;
        }
    }

    if let Some(counts) = git_stdout(
        root,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        let mut parts = counts.split_whitespace();
        out.behind = parts
            .next()
            .and_then(|s| s.parse().ok())
            .filter(|count| *count > 0);
        out.ahead = parts
            .next()
            .and_then(|s| s.parse().ok())
            .filter(|count| *count > 0);
    }

    out
}

/// Optional filters for [`history_filtered`]. Every field is `None` by default,
/// which reproduces the plain [`history`] behaviour (HEAD, all authors, all time).
#[derive(Debug, Clone, Default)]
pub struct HistoryFilter {
    /// Branch to walk instead of HEAD. Validated against [`branches`] before use;
    /// an unknown branch is ignored and the walk falls back to HEAD.
    pub branch: Option<String>,
    /// `--author=<value>` filter (substring / regex, as git interprets it).
    pub author: Option<String>,
    /// `--since=<value>` filter (any git approxidate, e.g. "1 week ago").
    pub since: Option<String>,
}

pub fn history(root: &Path, limit: usize) -> Result<Vec<GitCommit>> {
    history_filtered(root, limit, &HistoryFilter::default())
}

pub fn history_filtered(
    root: &Path,
    limit: usize,
    filter: &HistoryFilter,
) -> Result<Vec<GitCommit>> {
    ensure_repo(root)?;
    let max_count = format!("--max-count={}", limit.clamp(1, 200));

    // Every value below is passed to `run_git` as its own argument (never joined
    // into a shell string), so author/since text can't inject flags or commands.
    // The branch is additionally whitelisted against the real branch list so it
    // can't smuggle an arbitrary rev / path onto the `git log` command line.
    let mut args: Vec<String> = vec![
        "log".to_string(),
        "--date=iso-strict".to_string(),
        "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%cr%x1f%s".to_string(),
        max_count,
    ];
    if let Some(author) = filter
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        args.push(format!("--author={author}"));
    }
    if let Some(since) = filter
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("--since={since}"));
    }
    // The rev (branch) must sit before the `-- .` pathspec separator. Only accept
    // a branch that actually exists; otherwise leave it out so git walks HEAD.
    if let Some(branch) = filter
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        let known = branches(root).unwrap_or_default();
        if known.iter().any(|candidate| candidate.name == branch) {
            args.push(branch.to_string());
        }
    }
    args.push("--".to_string());
    args.push(".".to_string());

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_git(root, &arg_refs)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(Vec::new());
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_commit_line)
        .collect())
}

/// Distinct commit author names for the workspace path, most-recent first and
/// de-duplicated while preserving order. Empty repositories yield an empty list.
pub fn authors(root: &Path) -> Result<Vec<String>> {
    ensure_repo(root)?;
    let output = run_git(root, &["log", "--format=%an", "--", "."])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(Vec::new());
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }
    let mut seen: Vec<String> = Vec::new();
    for name in String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !seen.iter().any(|existing| existing == name) {
            seen.push(name.to_string());
        }
    }
    Ok(seen)
}

pub fn commit_count(root: &Path) -> Result<usize> {
    ensure_repo(root)?;
    let output = run_git(root, &["rev-list", "--count", "HEAD", "--", "."])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(0);
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or(0))
}

pub fn branches(root: &Path) -> Result<Vec<GitBranch>> {
    ensure_repo(root)?;
    // NOTE: ref-filter formats (`branch`/`for-each-ref`/`tag`) do NOT interpret
    // the `%x1f` hex escape that `log --pretty` does — they emit it literally. So
    // the field separator is the real U+001F byte embedded in the format string.
    let output = run_git(root, &["branch", "--format=%(HEAD)\u{1f}%(refname:short)"])?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\x1f')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(GitBranch {
                name: name.to_string(),
                current: head.trim() == "*",
            })
        })
        .collect())
}

pub fn branch_count(root: &Path) -> Result<usize> {
    Ok(branches(root)?.len())
}

/// Read-only, GitHub-style per-branch detail: the branch name, whether it is
/// checked out / the repo default, its relative last-commit time, and how far it
/// sits ahead/behind the default branch. `ahead`/`behind` are `None` for the
/// default branch itself and whenever the comparison can't be computed.
#[derive(Debug, Clone, Serialize)]
pub struct GitBranchDetail {
    pub name: String,
    pub current: bool,
    pub is_default: bool,
    pub updated: String,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

/// Best-effort default branch name. Prefers the remote HEAD symref
/// (`origin/HEAD -> origin/main`, stripped to `main`); falling back to a local
/// `main`, then `master`, then the currently checked-out branch. Returns `None`
/// only when the repository has no branches at all.
fn default_branch(root: &Path) -> Option<String> {
    if let Some(head) = git_stdout(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .filter(|s| !s.is_empty())
    {
        let name = head.strip_prefix("origin/").unwrap_or(&head).trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let known = branches(root).unwrap_or_default();
    if known.iter().any(|b| b.name == "main") {
        return Some("main".to_string());
    }
    if known.iter().any(|b| b.name == "master") {
        return Some("master".to_string());
    }
    known
        .iter()
        .find(|b| b.current)
        .or_else(|| known.first())
        .map(|b| b.name.clone())
}

/// `git rev-list --left-right --count <base>...<head>` → `(behind, ahead)`.
///
/// The left count is commits reachable from `base` but not `head` (how far the
/// branch is *behind* the default); the right count is the reverse (*ahead*).
/// Returns `None` when the range can't be resolved. The range is a single argv
/// element (never a shell string), and branch names come straight from git's own
/// ref list, so no caller input reaches the command line.
fn rev_list_ahead_behind(root: &Path, base: &str, head: &str) -> Option<(usize, usize)> {
    let range = format!("{base}...{head}");
    let output = run_git(root, &["rev-list", "--left-right", "--count", &range]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let behind = parts.next()?.parse().ok()?;
    let ahead = parts.next()?.parse().ok()?;
    Some((behind, ahead))
}

/// Read-only branch listing enriched for the GitHub-style branches page: default
/// flag, relative last-commit time, and ahead/behind vs. the default branch.
/// `branches()` keeps its lean shape for callers that only need names/counts.
pub fn branches_detailed(root: &Path) -> Result<Vec<GitBranchDetail>> {
    ensure_repo(root)?;
    // ref-filter emits `%x1f` literally (see the note in `branches`); the field
    // separator is the real U+001F byte embedded in the format string.
    let output = run_git(
        root,
        &[
            "branch",
            "--format=%(HEAD)\u{1f}%(refname:short)\u{1f}%(committerdate:relative)",
        ],
    )?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    let default = default_branch(root);
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split('\x1f');
        let head = parts.next().unwrap_or_default();
        let name = parts.next().unwrap_or_default().trim();
        if name.is_empty() {
            continue;
        }
        let updated = parts.next().unwrap_or_default().trim().to_string();
        let is_default = default.as_deref() == Some(name);
        let (mut behind, mut ahead) = (None, None);
        if !is_default {
            if let Some(default_name) = default.as_deref() {
                if let Some((b, a)) = rev_list_ahead_behind(root, default_name, name) {
                    behind = Some(b);
                    ahead = Some(a);
                }
            }
        }
        result.push(GitBranchDetail {
            name: name.to_string(),
            current: head.trim() == "*",
            is_default,
            updated,
            ahead,
            behind,
        });
    }
    Ok(result)
}

pub fn tags(root: &Path, limit: usize) -> Result<Vec<GitTag>> {
    ensure_repo(root)?;
    let count = format!("--count={}", limit.clamp(1, 200));
    let output = run_git(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &count,
            // ref-filter emits `%x1f` literally (see note in `branches`); use the
            // real U+001F byte as the field separator instead.
            "--format=%(refname:short)\u{1f}%(objectname:short)\u{1f}%(creatordate:relative)",
            "refs/tags",
        ],
    )?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(GitTag {
                name: name.to_string(),
                short_hash: parts.next().unwrap_or_default().to_string(),
                relative_time: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

pub fn tag_count(root: &Path) -> Result<usize> {
    ensure_repo(root)?;
    let output = run_git(root, &["tag", "--list"])?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count())
}

pub fn checkout_branch(root: &Path, branch: &str) -> Result<GitStatus> {
    ensure_repo(root)?;
    let branch = branch.trim();
    if branch.is_empty()
        || branch.contains('\0')
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains('~')
        || branch.contains('^')
        || branch.contains(':')
        || branch.contains('\\')
        || branch.contains("//")
    {
        return Err(GitError::InvalidRevision);
    }
    let known = branches(root)?;
    if !known.iter().any(|candidate| candidate.name == branch) {
        return Err(GitError::InvalidRevision);
    }
    run_git_success(root, &["switch", branch])?;
    Ok(status(root))
}

pub fn last_commit_for_path(root: &Path, rel_path: &str) -> Result<Option<GitPathCommit>> {
    ensure_repo(root)?;
    if rel_path.trim().is_empty() {
        return Ok(None);
    }
    let output = run_git(
        root,
        &[
            "log",
            "-1",
            "--date=relative",
            "--format=%s%x1f%cr",
            "--",
            rel_path,
        ],
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(None);
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if line.is_empty() {
        return Ok(None);
    }
    let (subject, time) = line.split_once('\x1f').unwrap_or((line.as_str(), ""));
    Ok(Some(GitPathCommit {
        subject: subject.to_string(),
        time: time.to_string(),
    }))
}

pub fn last_commits_for_paths(
    root: &Path,
    rel_paths: &[String],
) -> Result<HashMap<String, GitPathCommit>> {
    ensure_repo(root)?;
    let rel_paths: Vec<&str> = rel_paths
        .iter()
        .map(String::as_str)
        .filter(|path| !path.trim().is_empty())
        .collect();
    if rel_paths.is_empty() {
        return Ok(HashMap::new());
    }

    let mut args = vec![
        "log".to_string(),
        "--date=relative".to_string(),
        "--format=%x1e%s%x1f%cr".to_string(),
        "--name-only".to_string(),
        "--".to_string(),
    ];
    args.extend(rel_paths.iter().map(|path| path.to_string()));
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let output = run_git(root, &arg_refs)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(HashMap::new());
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }

    let mut commits = HashMap::new();
    let text = String::from_utf8_lossy(&output.stdout);
    for record in text
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
    {
        let mut lines = record.lines();
        let Some(header) = lines.next() else {
            continue;
        };
        let (subject, time) = header.split_once('\x1f').unwrap_or((header, ""));
        for changed_path in lines.map(str::trim).filter(|line| !line.is_empty()) {
            for rel_path in rel_paths.iter() {
                if commits.contains_key(*rel_path)
                    || !git_path_matches_entry(changed_path, rel_path)
                {
                    continue;
                }
                commits.insert(
                    (*rel_path).to_string(),
                    GitPathCommit {
                        subject: subject.to_string(),
                        time: time.to_string(),
                    },
                );
            }
        }
        if commits.len() >= rel_paths.len() {
            break;
        }
    }

    Ok(commits)
}

pub(crate) fn working_diff(workspace_fs: &WorkspaceFs) -> Result<GitDiff> {
    let root = workspace_fs
        .directory_root()
        .ok_or_else(|| GitError::Io("directory workspace required".to_string()))?;
    ensure_repo(root)?;
    let mut patch = if has_head(root) {
        git_stdout_required(
            root,
            &["diff", "--no-ext-diff", "--find-renames", "HEAD", "--", "."],
        )?
    } else {
        String::new()
    };
    append_untracked_file_patches(workspace_fs, &mut patch, None);
    let files = parse_diff_files(&patch);
    Ok(GitDiff {
        range: "HEAD..worktree".to_string(),
        title: "Working tree diff".to_string(),
        subtitle: Some("Current workspace changes against HEAD".to_string()),
        patch,
        files,
    })
}

pub(crate) fn compare_diff(
    workspace_fs: &WorkspaceFs,
    base: &str,
    compare: &str,
) -> Result<GitDiff> {
    compare_diff_with_pathspec(workspace_fs, base, compare, None)
}

fn compare_diff_with_pathspec(
    workspace_fs: &WorkspaceFs,
    base: &str,
    compare: &str,
    pathspec: Option<&str>,
) -> Result<GitDiff> {
    let root = workspace_fs
        .directory_root()
        .ok_or_else(|| GitError::Io("directory workspace required".to_string()))?;
    ensure_repo(root)?;
    let base = validate_compare_ref(root, base, false)?;
    let compare = validate_compare_ref(root, compare, true)?;
    let pathspec = pathspec.unwrap_or(".");
    let mut patch = if compare == "worktree" && base == "HEAD" && !has_head(root) {
        String::new()
    } else if compare == "worktree" {
        git_stdout_required(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--find-renames",
                &base,
                "--",
                pathspec,
            ],
        )?
    } else {
        git_stdout_required(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--find-renames",
                &base,
                &compare,
                "--",
                pathspec,
            ],
        )?
    };
    if compare == "worktree" {
        let untracked_filter = (pathspec != ".").then_some(pathspec);
        append_untracked_file_patches(workspace_fs, &mut patch, untracked_filter);
    }
    let range = format!("{base}..{compare}");
    let files = parse_diff_files(&patch);
    Ok(GitDiff {
        title: format!("Compare {base} and {compare}"),
        subtitle: Some(format!("Changes from {base} to {compare}")),
        range,
        patch,
        files,
    })
}

/// A single markdown file change, carrying blob object ids instead of patch
/// text. The rendered (AST) diff only needs which markdown files changed, their
/// status, and the blob to read each side from — never the unified patch. This
/// lets the rendered path skip generating the full textual diff and skip the
/// per-file `git show` subprocess (blobs are batch-read via `read_blobs`).
#[derive(Debug, Clone)]
pub struct MarkdownDiffEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    /// Blob oid of the old side (base). `None` when the file was added.
    pub old_blob: Option<String>,
    /// Blob oid of the new side (compare). `None` means "read from the worktree"
    /// (worktree compares) or the file was deleted.
    pub new_blob: Option<String>,
    /// Added / deleted line counts (from `git diff --numstat`), for the diffstat.
    pub additions: usize,
    pub deletions: usize,
}

pub struct MarkdownDiffListing {
    pub range: String,
    pub title: String,
    pub entries: Vec<MarkdownDiffEntry>,
}

/// Enumerate the markdown files changed between `base` and `compare` using
/// `git diff --raw` (no patch generation) plus untracked markdown for worktree
/// compares. Cheap: one `git diff --raw` and, for worktree, one `ls-files`.
pub(crate) fn markdown_diff_listing(
    workspace_fs: &WorkspaceFs,
    base: &str,
    compare: &str,
) -> Result<MarkdownDiffListing> {
    let root = workspace_fs
        .directory_root()
        .ok_or_else(|| GitError::Io("directory workspace required".to_string()))?;
    ensure_repo(root)?;
    let base = validate_compare_ref(root, base, false)?;
    let compare = validate_compare_ref(root, compare, true)?;
    let worktree = compare == "worktree";
    let head_missing = base == "HEAD" && !has_head(root);

    let mut entries = Vec::new();
    if !head_missing {
        // `--no-abbrev` forces full 40/64-hex blob oids so they match what
        // `git cat-file --batch` echoes (its default --raw output is abbreviated).
        // `--relative` makes every emitted path relative to `root` (the workspace,
        // via `git -C root`) instead of the repo worktree root, so it shares one
        // base with the untracked `ls-files --others` paths below. Callers can then
        // join onto the workspace root and reach the same on-disk file (and the
        // same annotation key) the normal file view uses, even when the workspace
        // is a subdirectory of the repo. When the workspace *is* the repo root the
        // prefix is empty, so the output is byte-identical to the unrelative form.
        let args: Vec<&str> = if worktree {
            vec![
                "diff",
                "--no-ext-diff",
                "--find-renames",
                "--relative",
                "--raw",
                "--no-abbrev",
                "-z",
                &base,
                "--",
                ".",
            ]
        } else {
            vec![
                "diff",
                "--no-ext-diff",
                "--find-renames",
                "--relative",
                "--raw",
                "--no-abbrev",
                "-z",
                &base,
                &compare,
                "--",
                ".",
            ]
        };
        let out = run_git(root, &args)?;
        if !out.status.success() {
            return Err(GitError::Command(command_error(&out)));
        }
        entries.extend(parse_raw_diff_entries(&out.stdout, worktree));
    }

    if worktree {
        if let Some(list) = git_stdout_nul(
            root,
            &[
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                ".",
            ],
        ) {
            for rel in list {
                if is_markdown_git_path(&rel) {
                    let additions = workspace_fs
                        .read_content_to_string(&rel)
                        .map(|c| c.lines().count())
                        .unwrap_or(0);
                    entries.push(MarkdownDiffEntry {
                        path: rel,
                        old_path: None,
                        status: "added".to_string(),
                        old_blob: None,
                        new_blob: None,
                        additions,
                        deletions: 0,
                    });
                }
            }
        }
    }

    entries.retain(|e| {
        is_markdown_git_path(&e.path) || e.old_path.as_deref().is_some_and(is_markdown_git_path)
    });

    // Fill per-file diffstat counts (untracked entries already carry a line count).
    if !head_missing {
        let stats = markdown_numstat_map(root, &base, &compare, worktree);
        for entry in &mut entries {
            if let Some(&(adds, dels)) = stats.get(&entry.path) {
                entry.additions = adds;
                entry.deletions = dels;
            }
        }
    }

    Ok(MarkdownDiffListing {
        // Matches the prior compare-based rendered path ("Compare HEAD and
        // worktree"), distinct from the raw view's "Working tree diff".
        title: format!("Compare {base} and {compare}"),
        range: format!("{base}..{compare}"),
        entries,
    })
}

fn blob_or_none(sha: &str) -> Option<String> {
    if sha.is_empty() || sha.bytes().all(|b| b == b'0') {
        None
    } else {
        Some(sha.to_string())
    }
}

/// Parse `git diff --raw -z` output. Each record is
/// `:<om> <nm> <osha> <nsha> <STATUS>\0<path>\0` (rename/copy append a second
/// `<path>\0`). `worktree` forces the new side to "read from disk" since the
/// worktree has no blob oid yet (its `nsha` is all zeros).
fn parse_raw_diff_entries(raw: &[u8], worktree: bool) -> Vec<MarkdownDiffEntry> {
    let text = String::from_utf8_lossy(raw);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut out = Vec::new();
    while let Some(meta) = tokens.next() {
        let Some(meta) = meta.strip_prefix(':') else {
            continue;
        };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let old_sha = fields[2];
        let new_sha = fields[3];
        let letter = fields[4].chars().next().unwrap_or('M');
        let (old_path, path) = if letter == 'R' || letter == 'C' {
            let from = tokens.next().unwrap_or("").to_string();
            let to = tokens.next().unwrap_or("").to_string();
            (Some(from), to)
        } else {
            (None, tokens.next().unwrap_or("").to_string())
        };
        let status = match letter {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            _ => "modified",
        }
        .to_string();
        out.push(MarkdownDiffEntry {
            path,
            old_path,
            status,
            old_blob: blob_or_none(old_sha),
            new_blob: if worktree {
                None
            } else {
                blob_or_none(new_sha)
            },
            additions: 0,
            deletions: 0,
        });
    }
    out
}

/// Map of path -> (added, deleted) line counts from `git diff --numstat`, used
/// to render the per-file diffstat. One cheap git call; renames are normalised
/// to their destination path.
fn markdown_numstat_map(
    root: &Path,
    base: &str,
    compare: &str,
    worktree: bool,
) -> HashMap<String, (usize, usize)> {
    // `--relative` keeps the numstat path keys on the same workspace-relative base
    // as the `--raw` listing entries, so the per-file diffstat lookup matches.
    let args: Vec<&str> = if worktree {
        vec![
            "-c",
            "core.quotepath=false",
            "diff",
            "--no-ext-diff",
            "--find-renames",
            "--relative",
            "--numstat",
            base,
            "--",
            ".",
        ]
    } else {
        vec![
            "-c",
            "core.quotepath=false",
            "diff",
            "--no-ext-diff",
            "--find-renames",
            "--relative",
            "--numstat",
            base,
            compare,
            "--",
            ".",
        ]
    };
    let mut map = HashMap::new();
    let Ok(out) = run_git(root, &args) else {
        return map;
    };
    if !out.status.success() {
        return map;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let adds = parts
            .next()
            .unwrap_or("0")
            .trim()
            .parse::<usize>()
            .unwrap_or(0);
        let dels = parts
            .next()
            .unwrap_or("0")
            .trim()
            .parse::<usize>()
            .unwrap_or(0);
        if let Some(path_field) = parts.next() {
            map.insert(numstat_dest_path(path_field), (adds, dels));
        }
    }
    map
}

/// Resolve the destination path from a numstat path field, which for renames is
/// `old => new` or `prefix/{old => new}/suffix`.
fn numstat_dest_path(field: &str) -> String {
    if let (Some(open), Some(close)) = (field.find('{'), field.find('}')) {
        if close > open {
            if let Some(arrow) = field[open..close].find(" => ") {
                let new_mid = &field[open + arrow + 4..close];
                return format!("{}{}{}", &field[..open], new_mid, &field[close + 1..]);
            }
        }
    }
    if let Some(idx) = field.find(" => ") {
        return field[idx + 4..].to_string();
    }
    field.to_string()
}

/// Batch-read blob contents by oid via a single `git cat-file --batch` process,
/// replacing N separate `git show` spawns. Returns oid -> bytes; missing oids
/// are simply absent from the map.
pub fn read_blobs(root: &Path, oids: &[String]) -> Result<HashMap<String, Vec<u8>>> {
    let mut map = HashMap::new();
    if oids.is_empty() {
        return Ok(map);
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| GitError::Io(e.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| GitError::Io("cat-file: no stdin".to_string()))?;
    let mut buf = String::with_capacity(oids.len() * 41);
    for oid in oids {
        buf.push_str(oid);
        buf.push('\n');
    }
    // The output can be far larger than the OS pipe buffer, so git may block on
    // stdout (and stop reading stdin) before we finish writing. Drain stdout on
    // this thread while a helper thread feeds stdin, then closes it via drop.
    let writer = std::thread::spawn(move || {
        if let Err(e) = stdin.write_all(buf.as_bytes()) {
            // git may exit early (e.g. all oids reported before we finish),
            // closing its read end; a broken pipe here is expected and benign.
            if e.kind() != std::io::ErrorKind::BrokenPipe {
                return Err(GitError::Io(e.to_string()));
            }
        }
        Ok(())
    });
    let out = child
        .wait_with_output()
        .map_err(|e| GitError::Io(e.to_string()))?;
    // Surface a genuine (non-broken-pipe) write failure; a panicked writer
    // thread is treated as an I/O error.
    writer
        .join()
        .map_err(|_| GitError::Io("cat-file: writer thread panicked".to_string()))??;
    parse_cat_file_batch(&out.stdout, &mut map);
    Ok(map)
}

fn parse_cat_file_batch(stdout: &[u8], map: &mut HashMap<String, Vec<u8>>) {
    let mut i = 0;
    while i < stdout.len() {
        let Some(nl_rel) = stdout[i..].iter().position(|&b| b == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&stdout[i..i + nl_rel]).into_owned();
        i += nl_rel + 1;
        let mut parts = header.split(' ');
        let oid = parts.next().unwrap_or("").to_string();
        let kind = parts.next().unwrap_or("");
        if kind == "missing" || oid.is_empty() {
            continue;
        }
        let Some(size) = parts.next().and_then(|s| s.trim().parse::<usize>().ok()) else {
            break;
        };
        if i + size > stdout.len() {
            break;
        }
        map.insert(oid, stdout[i..i + size].to_vec());
        i += size + 1; // content + trailing newline
    }
}

fn git_stdout_nul(root: &Path, args: &[&str]) -> Option<Vec<String>> {
    let out = run_git(root, args).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
    )
}

pub fn diff_has_markdown_changes(root: &Path, base: &str, compare: &str) -> Result<bool> {
    ensure_repo(root)?;
    let base = validate_compare_ref(root, base, false)?;
    let compare = validate_compare_ref(root, compare, true)?;
    if compare == "worktree" && base == "HEAD" && !has_head(root) {
        return Ok(has_untracked_markdown_changes(root));
    }
    let output = if compare == "worktree" {
        run_git(
            root,
            &["diff", "--no-ext-diff", "--name-only", &base, "--", "."],
        )?
    } else {
        run_git(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--name-only",
                &base,
                &compare,
                "--",
                ".",
            ],
        )?
    };
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    if String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(is_markdown_git_path)
    {
        return Ok(true);
    }
    if compare == "worktree" {
        return Ok(has_untracked_markdown_changes(root));
    }
    Ok(false)
}

/// Like [`diff_has_markdown_changes`] but skips `ensure_repo` + ref validation.
/// For hot loops (e.g. the compare dropdown) where both refs already come from a
/// trusted enumeration, this is a single `git diff --name-only` instead of ~4
/// subprocesses. A bad ref just errors, which callers treat as "has changes".
pub fn diff_has_markdown_changes_unchecked(root: &Path, base: &str, compare: &str) -> Result<bool> {
    let output = if compare == "worktree" {
        run_git(
            root,
            &["diff", "--no-ext-diff", "--name-only", base, "--", "."],
        )?
    } else {
        run_git(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--name-only",
                base,
                compare,
                "--",
                ".",
            ],
        )?
    };
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    if String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(is_markdown_git_path)
    {
        return Ok(true);
    }
    if compare == "worktree" {
        return Ok(has_untracked_markdown_changes(root));
    }
    Ok(false)
}

fn has_untracked_markdown_changes(root: &Path) -> bool {
    let untracked = git_stdout(
        root,
        &["ls-files", "--others", "--exclude-standard", "--", "."],
    )
    .unwrap_or_default();
    untracked.lines().any(is_markdown_git_path)
}

pub fn commit_diff(root: &Path, rev: &str) -> Result<GitDiff> {
    ensure_repo(root)?;
    if !valid_hex_rev(rev) {
        return Err(GitError::InvalidRevision);
    }
    let patch = git_stdout_required(
        root,
        &[
            "show",
            "--format=",
            "--no-ext-diff",
            "--find-renames",
            "--patch",
            rev,
            "--",
            ".",
        ],
    )?;
    let meta = git_stdout(
        root,
        &[
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%h%x1f%s%x1f%an%x1f%ad",
            rev,
        ],
    );
    let (title, subtitle) = meta
        .as_deref()
        .and_then(|line| {
            let parts: Vec<&str> = line.split('\x1f').collect();
            (parts.len() == 4).then(|| {
                (
                    format!("{} {}", parts[0], parts[1]),
                    Some(format!("{} · {}", parts[2], parts[3])),
                )
            })
        })
        .unwrap_or_else(|| (rev.to_string(), None));
    let files = parse_diff_files(&patch);
    Ok(GitDiff {
        range: rev.to_string(),
        title,
        subtitle,
        patch,
        files,
    })
}

/// Per-commit info needed to build git-history diff links.
#[derive(Debug, Clone, Default)]
pub struct CommitDiffInfo {
    /// First-parent hash, or `None` for a root commit (compare against the
    /// empty tree).
    pub parent: Option<String>,
    /// Whether the commit touches any Markdown (`.md`) path — checking both
    /// sides of a rename, mirroring the per-file markdown filter.
    pub has_markdown: bool,
}

/// Resolve [`CommitDiffInfo`] for many commits in a single `git log` pass.
///
/// The history page needs, per commit, (a) whether it changed any Markdown file
/// (to decide if a diff link is offered) and (b) its parent hash (the diff
/// base). Done naively that is one `git show --patch` plus one `rev-parse` per
/// commit — hundreds of git subprocesses for a full page. `--no-walk=unsorted`
/// lists exactly the given commits (no ancestry walk) with their parents and a
/// name-status file list, all at once.
pub fn commit_diff_index(root: &Path, hashes: &[&str]) -> Result<HashMap<String, CommitDiffInfo>> {
    ensure_repo(root)?;
    // Only feed trusted full hashes (they come from our own history walk); this
    // also guarantees none can be mistaken for a flag on the command line.
    let revs: Vec<&str> = hashes
        .iter()
        .copied()
        .filter(|h| valid_hex_rev(h))
        .collect();
    if revs.is_empty() {
        return Ok(HashMap::new());
    }
    // Header lines are prefixed with U+001F so they can't be confused with a
    // name-status line (which starts with a status letter).
    let mut args: Vec<&str> = vec![
        "log",
        "--no-walk=unsorted",
        "--no-ext-diff",
        "--find-renames",
        "--name-status",
        "--format=\x1f%H\x1f%P",
    ];
    args.extend(revs.iter().copied());
    args.push("--");
    args.push(".");

    let output = run_git(root, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") {
            return Ok(HashMap::new());
        }
        return Err(GitError::Command(stderr.trim().to_string()));
    }

    let mut map: HashMap<String, CommitDiffInfo> = HashMap::new();
    let mut current: Option<String> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(header) = line.strip_prefix('\x1f') {
            let mut parts = header.split('\x1f');
            let hash = match parts.next() {
                Some(h) if !h.is_empty() => h.to_string(),
                _ => continue,
            };
            let parent = parts
                .next()
                .and_then(|parents| parents.split_whitespace().next())
                .map(str::to_string);
            map.insert(
                hash.clone(),
                CommitDiffInfo {
                    parent,
                    has_markdown: false,
                },
            );
            current = Some(hash);
        } else if !line.is_empty() {
            // Name-status entry: `STATUS\tpath[\told\tnew]`. Any path field on
            // either side of a rename that ends in `.md` marks the commit.
            if let Some(hash) = current.as_deref() {
                if let Some(info) = map.get_mut(hash) {
                    if !info.has_markdown && line.split('\t').skip(1).any(is_markdown_git_path) {
                        info.has_markdown = true;
                    }
                }
            }
        }
    }
    Ok(map)
}

pub fn parent_commit(root: &Path, rev: &str) -> Result<Option<String>> {
    ensure_repo(root)?;
    if !valid_hex_rev(rev) {
        return Err(GitError::InvalidRevision);
    }
    Ok(git_stdout(root, &["rev-parse", &format!("{rev}^")]).filter(|s| !s.is_empty()))
}

pub fn commit_workspace(root: &Path, message: &str) -> Result<GitCommitResult> {
    ensure_repo(root)?;
    let subject = message.trim();
    if subject.is_empty() {
        return Err(GitError::Command("commit message is required".to_string()));
    }
    let current = status(root);
    if !current.dirty {
        return Err(GitError::NothingToCommit);
    }
    run_git_success(root, &["add", "-A", "--", "."])?;
    let output = run_git(root, &["commit", "-m", subject, "--", "."])?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    let hash = git_stdout_required(root, &["rev-parse", "HEAD"])?;
    let short_hash = git_stdout_required(root, &["rev-parse", "--short", "HEAD"])?;
    Ok(GitCommitResult {
        hash,
        short_hash,
        subject: subject.to_string(),
    })
}

fn ensure_repo(root: &Path) -> Result<()> {
    match git_stdout(root, &["rev-parse", "--is-inside-work-tree"]).as_deref() {
        Some("true") => Ok(()),
        _ => Err(GitError::NotRepository),
    }
}

fn has_head(root: &Path) -> bool {
    git_stdout(root, &["rev-parse", "--verify", "HEAD"]).is_some()
}

fn valid_hex_rev(rev: &str) -> bool {
    (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_compare_ref(root: &Path, value: &str, allow_worktree: bool) -> Result<String> {
    let value = value.trim();
    if allow_worktree && value == "worktree" {
        return Ok(value.to_string());
    }
    if value == "HEAD" {
        return Ok(value.to_string());
    }
    if valid_hex_rev(value) && git_stdout(root, &["rev-parse", "--verify", value]).is_some() {
        return Ok(value.to_string());
    }

    let known = branches(root)
        .unwrap_or_default()
        .into_iter()
        .map(|branch| branch.name)
        .chain(
            tags(root, 500)
                .unwrap_or_default()
                .into_iter()
                .map(|tag| tag.name),
        );
    for candidate in known {
        if candidate == value && !candidate.starts_with('-') {
            return Ok(value.to_string());
        }
    }

    Err(GitError::InvalidRevision)
}

fn append_untracked_file_patches(
    workspace_fs: &WorkspaceFs,
    patch: &mut String,
    path_filter: Option<&str>,
) {
    let Some(root) = workspace_fs.directory_root() else {
        return;
    };
    let untracked = git_stdout(
        root,
        &["ls-files", "--others", "--exclude-standard", "--", "."],
    )
    .unwrap_or_default();
    for rel in untracked.lines().filter(|line| !line.trim().is_empty()) {
        if path_filter.is_some_and(|filter| !git_path_matches_entry(rel, filter)) {
            continue;
        }
        if !patch.is_empty() && !patch.ends_with('\n') {
            patch.push('\n');
        }
        patch.push_str(&untracked_file_patch(workspace_fs, rel));
    }
}

fn git_path_matches_entry(changed_path: &str, entry_path: &str) -> bool {
    changed_path == entry_path
        || changed_path
            .strip_prefix(entry_path)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn is_markdown_git_path(path: &str) -> bool {
    Path::new(path.trim())
        .extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("md"))
}

fn parse_commit_line(line: &str) -> Option<GitCommit> {
    let mut parts = line.split('\x1f');
    Some(GitCommit {
        hash: parts.next()?.to_string(),
        short_hash: parts.next()?.to_string(),
        author: parts.next()?.to_string(),
        date: parts.next()?.to_string(),
        relative_time: parts.next().unwrap_or_default().to_string(),
        subject: parts.next().unwrap_or_default().to_string(),
    })
}

fn parse_diff_files(patch: &str) -> Vec<GitDiffFile> {
    let mut files = Vec::new();
    let mut current: Option<GitDiffFile> = None;

    for line in patch.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some((old_path, new_path)) = parse_diff_git_line(trimmed) {
            if let Some(file) = current.take() {
                files.push(file);
            }
            let path = if new_path == "/dev/null" {
                old_path.trim_start_matches("a/").to_string()
            } else {
                new_path.trim_start_matches("b/").to_string()
            };
            current = Some(GitDiffFile {
                path,
                old_path: None,
                status: "modified".to_string(),
                additions: 0,
                deletions: 0,
                patch: String::new(),
            });
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        if trimmed == "new file mode 100644" || trimmed.starts_with("new file mode ") {
            file.status = "added".to_string();
        } else if trimmed == "deleted file mode 100644" || trimmed.starts_with("deleted file mode ")
        {
            file.status = "deleted".to_string();
        } else if let Some(old) = trimmed.strip_prefix("rename from ") {
            file.status = "renamed".to_string();
            file.old_path = Some(old.to_string());
        } else if let Some(new_path) = trimmed.strip_prefix("rename to ") {
            file.path = new_path.to_string();
        }
        if trimmed.starts_with('+') && !trimmed.starts_with("+++") {
            file.additions += 1;
        } else if trimmed.starts_with('-') && !trimmed.starts_with("---") {
            file.deletions += 1;
        }
        file.patch.push_str(line);
    }
    if let Some(file) = current {
        files.push(file);
    }
    files
}

fn parse_diff_git_line(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("diff --git ")?;
    let (old_path, new_path) = rest.split_once(' ')?;
    Some((old_path, new_path))
}

fn untracked_file_patch(workspace_fs: &WorkspaceFs, rel: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{rel} b/{rel}\n"));
    out.push_str("new file mode 100644\n");
    out.push_str("--- /dev/null\n");
    out.push_str(&format!("+++ b/{rel}\n"));

    let bytes = match workspace_fs.read_content(rel) {
        Ok(bytes) => bytes,
        Err(e) => {
            out.push_str(&format!(
                "Binary files /dev/null and b/{rel} differ ({e})\n"
            ));
            return out;
        }
    };
    if bytes.contains(&0) {
        out.push_str(&format!("Binary files /dev/null and b/{rel} differ\n"));
        return out;
    }
    let text = String::from_utf8_lossy(&bytes);
    let line_count = text.lines().count().max(1);
    out.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));
    for line in text.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !text.ends_with('\n') && !text.is_empty() {
        out.push_str("\\ No newline at end of file\n");
    }
    out
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(root, args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_stdout_required(root: &Path, args: &[&str]) -> Result<String> {
    let output = run_git(root, args)?;
    if !output.status.success() {
        return Err(GitError::Command(command_error(&output)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_success(root: &Path, args: &[&str]) -> Result<()> {
    let output = run_git(root, args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(GitError::Command(command_error(&output)))
    }
}

fn run_git(root: &Path, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| GitError::Io(e.to_string()))
}

fn command_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_diff_files_and_counts_lines() {
        let patch =
            "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1,2 @@\n-old\n+new\n+next\n";
        let files = parse_diff_files(patch);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.md");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 1);
    }

    #[test]
    fn git_path_match_treats_directories_as_prefixes() {
        assert!(git_path_matches_entry("docs/readme.md", "docs"));
        assert!(git_path_matches_entry("docs", "docs"));
        assert!(git_path_matches_entry("README.md", "README.md"));
        assert!(!git_path_matches_entry("docs-old/readme.md", "docs"));
        assert!(!git_path_matches_entry("README.zh.md", "README.md"));
    }

    #[test]
    fn rejects_non_hex_revisions() {
        assert!(valid_hex_rev("abc123"));
        assert!(!valid_hex_rev("--help"));
        assert!(!valid_hex_rev("HEAD"));
    }

    #[test]
    fn parses_raw_diff_entries_with_blobs() {
        let z = "0000000000000000000000000000000000000000";
        let osha = "1111111111111111111111111111111111111111";
        let nsha = "2222222222222222222222222222222222222222";
        // modified (committed both sides), added (worktree), renamed
        let raw = format!(
            ":100644 100644 {osha} {nsha} M\0docs/a.md\0\
             :000000 100644 {z} {z} A\0docs/new.md\0\
             :100644 100644 {osha} {nsha} R100\0docs/old.md\0docs/renamed.md\0"
        );
        // commit-vs-commit (worktree=false): new side keeps its blob
        let entries = parse_raw_diff_entries(raw.as_bytes(), false);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "docs/a.md");
        assert_eq!(entries[0].status, "modified");
        assert_eq!(entries[0].old_blob.as_deref(), Some(osha));
        assert_eq!(entries[0].new_blob.as_deref(), Some(nsha));
        assert_eq!(entries[1].status, "added");
        assert_eq!(entries[1].old_blob, None);
        assert_eq!(entries[2].status, "renamed");
        assert_eq!(entries[2].old_path.as_deref(), Some("docs/old.md"));
        assert_eq!(entries[2].path, "docs/renamed.md");

        // worktree compare: new side has no blob -> read from disk
        let wt = parse_raw_diff_entries(raw.as_bytes(), true);
        assert_eq!(wt[0].new_blob, None);
        assert_eq!(wt[0].old_blob.as_deref(), Some(osha));
    }

    #[test]
    fn parses_cat_file_batch_output() {
        let oid_a = "1111111111111111111111111111111111111111";
        let oid_b = "2222222222222222222222222222222222222222";
        let mut stream = Vec::new();
        stream.extend_from_slice(format!("{oid_a} blob 5\n").as_bytes());
        stream.extend_from_slice(b"hello\n");
        stream.extend_from_slice(format!("{oid_b} missing\n").as_bytes());
        let oid_c = "3333333333333333333333333333333333333333";
        stream.extend_from_slice(format!("{oid_c} blob 3\n").as_bytes());
        stream.extend_from_slice(b"abc\n");

        let mut map = HashMap::new();
        parse_cat_file_batch(&stream, &mut map);
        assert_eq!(map.get(oid_a).map(|v| v.as_slice()), Some(&b"hello"[..]));
        assert_eq!(map.get(oid_b), None); // missing
        assert_eq!(map.get(oid_c).map(|v| v.as_slice()), Some(&b"abc"[..]));
    }
}
