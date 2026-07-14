use lazy_static::lazy_static;
use regex::Regex;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
// Use the syntect that `two-face` was built against (re-exported), so the
// `SyntaxSet` produced by `two_face::syntax::extra_newlines()` matches the
// syntect types we reference here. Cargo unifies both to a single 5.3.0, but
// re-exporting keeps this robust against any future version skew.
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;
use two_face::re_exports::syntect;

#[derive(Debug)]
struct FenceWarning {
    line: usize,
    outer_start: usize,
    backtick_count: usize,
}

/// Lowercase fence-token aliases mapped to a token that `find_syntax_by_token`
/// resolves against two-face's extended set. Only entries where the common
/// fence label differs from the grammar's own name/extension are needed; most
/// languages (rust, python, kotlin, swift, …) resolve directly.
const FENCE_ALIASES: &[(&str, &str)] = &[
    // "Protocol Buffer" grammar: name has a space, extension is `proto`.
    ("protobuf", "proto"),
    ("proto3", "proto"),
    ("proto2", "proto"),
    // F# grammar resolves by `f#` but not by the common `fsharp` label.
    ("fsharp", "f#"),
];

/// Resolve a fence label to a syntax. Tries the alias map first, then
/// `find_syntax_by_token` (matches grammar name and file extension), then
/// `find_syntax_by_name`, falling back to plain text. Matching is
/// case-insensitive via the lowercased token where helpful.
fn resolve_syntax<'a>(ss: &'a SyntaxSet, token: &str) -> &'a SyntaxReference {
    let lower = token.to_ascii_lowercase();
    let aliased = FENCE_ALIASES
        .iter()
        .find(|(k, _)| *k == lower)
        .map(|(_, v)| *v);

    if let Some(target) = aliased {
        if let Some(s) = ss.find_syntax_by_token(target) {
            return s;
        }
    }
    ss.find_syntax_by_token(token)
        .or_else(|| ss.find_syntax_by_token(&lower))
        .or_else(|| ss.find_syntax_by_name(token))
        .unwrap_or_else(|| ss.find_syntax_plain_text())
}

lazy_static! {
    static ref EMOJI_REGEX: Regex = Regex::new(r":([a-zA-Z0-9_+-]+):")
        .expect("Failed to compile EMOJI_REGEX");
    /// two-face's extended syntax set (bat's ~200 Sublime grammars), the
    /// *newlines* variant required by `ClassedHTMLGenerator` (it parses lines
    /// that include their trailing newline).
    static ref SYNTAX_SET: SyntaxSet = two_face::syntax::extra_newlines();
    /// `<img src=…>`, `<source src=…>`, `<video|audio … src=…>` — case-insensitive
    /// tag and attribute, single or double quotes.
    static ref HTML_SRC_REGEX: Regex = Regex::new(
        r#"(?i)<(?:img|source|video|audio|iframe)[^>]*\ssrc\s*=\s*["']([^"']+)["']"#
    ).expect("Failed to compile HTML_SRC_REGEX");
    /// `<link … href=…>` (CSS, manifests, etc.) and HTML `<a href=…>` is **not**
    /// included — anchors are navigation, not assets.
    static ref HTML_LINK_HREF_REGEX: Regex = Regex::new(
        r#"(?i)<link[^>]*\shref\s*=\s*["']([^"']+)["']"#
    ).expect("Failed to compile HTML_LINK_HREF_REGEX");
    /// CSS `url(...)` inside `<style>` blocks or inline `style="…"`.
    static ref CSS_URL_REGEX: Regex = Regex::new(
        r#"url\(\s*['"]?([^'")]+)['"]?\s*\)"#
    ).expect("Failed to compile CSS_URL_REGEX");
    static ref MARKDOWN_IMAGE_REGEX: Regex = Regex::new(
        r#"!\[([^\]\n]*)\]\(([^)\n]+)\)"#
    ).expect("Failed to compile MARKDOWN_IMAGE_REGEX");
    static ref SVG_EVENT_ATTR_REGEX: Regex = Regex::new(r#"(?i)\s+on[a-z0-9_-]+\s*="#)
        .expect("Failed to compile SVG_EVENT_ATTR_REGEX");
    static ref SVG_ROOT_WIDTH_ATTR_REGEX: Regex = Regex::new(r#"(?i)(?:^|[\s<])width\s*="#)
        .expect("Failed to compile SVG_ROOT_WIDTH_ATTR_REGEX");
    static ref SVG_ROOT_HEIGHT_ATTR_REGEX: Regex = Regex::new(r#"(?i)(?:^|[\s<])height\s*="#)
        .expect("Failed to compile SVG_ROOT_HEIGHT_ATTR_REGEX");
    static ref SVG_VIEWBOX_ATTR_REGEX: Regex = Regex::new(r#"(?i)\bviewBox\s*=\s*["']([^"']+)["']"#)
        .expect("Failed to compile SVG_VIEWBOX_ATTR_REGEX");
    static ref DIAGRAM_RENDER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static ref DIAGRAM_REGISTRY: supramark_diagram::DiagramRegistry =
        supramark_diagram::default_registry();
}

/// Returns a set of relative asset paths referenced from a markdown source.
///
/// Used by single-file workspaces to allowlist local images and stylesheets the
/// document needs (so `![](pic.png)` and `![](images/a.png)` still load), while
/// keeping every other sibling file 404. Without a full file context, only
/// same-directory or descendant relative paths are kept; with context,
/// workspace-root paths and absolute filesystem paths are accepted only after
/// they canonicalize inside the single-file workspace root. Absolute URLs
/// (`http://`, `data:`, …), parent-traversing (`../…`), and anchor-only
/// fragments are filtered out.
pub(crate) fn extract_referenced_assets(markdown: &str) -> std::collections::HashSet<String> {
    extract_referenced_assets_with_context(markdown, None)
}

pub(crate) fn extract_referenced_assets_for_file(
    markdown: &str,
    file_path: impl Into<PathBuf>,
    workspace_root: impl Into<PathBuf>,
) -> std::collections::HashSet<String> {
    let asset_context = MarkdownAssetContext::new("", file_path, workspace_root);
    extract_referenced_assets_with_context(markdown, Some(&asset_context))
}

fn extract_referenced_assets_with_context(
    markdown: &str,
    asset_context: Option<&MarkdownAssetContext>,
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut out: HashSet<String> = HashSet::new();

    let normalized = normalize_local_image_destinations(markdown);
    let ast = supramark_markdown::parse(normalized.as_ref());
    collect_supramark_assets(&ast, &mut out, asset_context);
    out
}

fn collect_from_html(html: &str, out: &mut std::collections::HashSet<String>) {
    for caps in HTML_SRC_REGEX.captures_iter(html) {
        if let Some(rel) = sanitize_asset_ref(&caps[1]) {
            out.insert(rel);
        }
    }
    for caps in HTML_LINK_HREF_REGEX.captures_iter(html) {
        if let Some(rel) = sanitize_asset_ref(&caps[1]) {
            out.insert(rel);
        }
    }
    for caps in CSS_URL_REGEX.captures_iter(html) {
        if let Some(rel) = sanitize_asset_ref(&caps[1]) {
            out.insert(rel);
        }
    }
}

/// Accept only relative paths under the current dir. Reject schemes (`http`,
/// `data:`), root-anchored (`/foo`), parent-traversing (`../`), and bare
/// fragments (`#x`). Returns the path with any URL fragment / query stripped.
fn sanitize_asset_ref(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    // Reject anything with a URL scheme.
    if is_remote_or_special_asset_url(trimmed) {
        return None;
    }
    if trimmed.starts_with('/') {
        return None;
    }
    // Strip URL fragment and query, leaving just the path portion.
    let path = trimmed.split(['#', '?']).next().unwrap_or(trimmed);
    if path.is_empty() {
        return None;
    }
    let decoded = urlencoding::decode(path).ok()?;
    let path = decoded.as_ref();
    if path.starts_with('/')
        || path.starts_with('\\')
        || is_windows_absolute_path(path)
        || Path::new(path).is_absolute()
    {
        return None;
    }
    // Reject any segment that escapes upward.
    if path.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return None;
    }
    let stripped = path.strip_prefix("./").unwrap_or(path);
    Some(stripped.to_string())
}

#[derive(Debug, Clone)]
pub(crate) struct MarkdownAssetContext {
    workspace_id: String,
    file_path: PathBuf,
    workspace_root: PathBuf,
}

impl MarkdownAssetContext {
    fn new(
        workspace_id: impl Into<String>,
        file_path: impl Into<PathBuf>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        let file_path = file_path.into();
        let workspace_root = workspace_root.into();
        Self {
            workspace_id: workspace_id.into(),
            file_path: dunce::canonicalize(&file_path).unwrap_or(file_path),
            workspace_root: dunce::canonicalize(&workspace_root).unwrap_or(workspace_root),
        }
    }
}

fn normalize_local_image_destinations(markdown: &str) -> Cow<'_, str> {
    let mut output = String::with_capacity(markdown.len());
    let mut changed = false;
    let mut fence: Option<(char, usize)> = None;

    for line in markdown.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if let Some((marker, len)) = fence {
            output.push_str(line);
            if is_markdown_fence_close(trimmed, marker, len) {
                fence = None;
            }
            continue;
        }

        if is_indented_code_line(line) {
            output.push_str(line);
            continue;
        }

        if let Some(marker) = markdown_fence_marker(trimmed) {
            output.push_str(line);
            fence = Some(marker);
            continue;
        }

        match normalize_line_image_destinations(line) {
            Cow::Borrowed(_) => output.push_str(line),
            Cow::Owned(normalized) => {
                output.push_str(&normalized);
                changed = true;
            }
        }
    }

    if changed {
        Cow::Owned(output)
    } else {
        Cow::Borrowed(markdown)
    }
}

fn normalize_line_image_destinations(line: &str) -> Cow<'_, str> {
    let mut output = String::with_capacity(line.len());
    let mut changed = false;
    let mut cursor = 0;

    while cursor < line.len() {
        let Some(tick_rel) = line[cursor..].find('`') else {
            let segment = &line[cursor..];
            append_normalized_image_segment(segment, &mut output, &mut changed);
            break;
        };
        let tick_start = cursor + tick_rel;
        let segment = &line[cursor..tick_start];
        append_normalized_image_segment(segment, &mut output, &mut changed);

        let tick_count = count_repeated_char(&line[tick_start..], '`');
        let code_start = tick_start + tick_count;
        let needle = "`".repeat(tick_count);
        if let Some(close_rel) = line[code_start..].find(&needle) {
            let code_end = code_start + close_rel + tick_count;
            output.push_str(&line[tick_start..code_end]);
            cursor = code_end;
        } else {
            output.push_str(&line[tick_start..]);
            cursor = line.len();
        }
    }

    if changed {
        Cow::Owned(output)
    } else {
        Cow::Borrowed(line)
    }
}

fn append_normalized_image_segment(segment: &str, output: &mut String, changed: &mut bool) {
    match normalize_image_destinations_in_segment(segment) {
        Cow::Borrowed(_) => output.push_str(segment),
        Cow::Owned(normalized) => {
            output.push_str(&normalized);
            *changed = true;
        }
    }
}

fn normalize_image_destinations_in_segment(segment: &str) -> Cow<'_, str> {
    let replaced = MARKDOWN_IMAGE_REGEX.replace_all(segment, |caps: &regex::Captures| {
        let full = caps.get(0).map_or("", |m| m.as_str());
        let alt = caps.get(1).map_or("", |m| m.as_str());
        let inner = caps.get(2).map_or("", |m| m.as_str());
        match normalize_image_destination_inner(inner) {
            Some(normalized) => format!("![{alt}]({normalized})"),
            None => full.to_string(),
        }
    });
    match replaced {
        Cow::Borrowed(_) => Cow::Borrowed(segment),
        Cow::Owned(normalized) if normalized == segment => Cow::Borrowed(segment),
        Cow::Owned(normalized) => Cow::Owned(normalized),
    }
}

fn is_indented_code_line(line: &str) -> bool {
    line.starts_with("    ") || line.starts_with('\t')
}

fn markdown_fence_marker(trimmed_line: &str) -> Option<(char, usize)> {
    let marker = trimmed_line.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = count_repeated_char(trimmed_line, marker);
    (len >= 3).then_some((marker, len))
}

fn is_markdown_fence_close(trimmed_line: &str, marker: char, open_len: usize) -> bool {
    let len = count_repeated_char(trimmed_line, marker);
    if len < open_len {
        return false;
    }
    trimmed_line[len..].trim().is_empty()
}

fn count_repeated_char(input: &str, target: char) -> usize {
    input.chars().take_while(|ch| *ch == target).count()
}

fn normalize_image_destination_inner(inner: &str) -> Option<String> {
    let leading_len = inner.len() - inner.trim_start().len();
    let leading = &inner[..leading_len];
    let rest = inner.trim_start();
    if rest.contains('\n') {
        return None;
    }

    // Angle brackets protect destinations containing spaces, but they do not
    // protect Windows backslashes from every Markdown parser. Normalize a
    // wrapped drive/UNC path before parsing just like the unwrapped form below.
    if let Some(wrapped) = rest.strip_prefix('<') {
        let close = wrapped.find('>')?;
        let destination = &wrapped[..close];
        let title = &wrapped[close + 1..];
        if !is_windows_absolute_path(destination) || !is_image_destination_title_tail(title) {
            return None;
        }
        let normalized = normalize_windows_image_path(destination);
        return Some(format!("{leading}<{normalized}>{title}"));
    }

    let has_whitespace = rest.chars().any(char::is_whitespace);
    let dest_end = if has_whitespace {
        image_destination_end(rest)?
    } else {
        rest.len()
    };
    let destination = &rest[..dest_end];
    let title = &rest[dest_end..];
    if destination.contains(['<', '>']) || !is_local_image_destination(destination) {
        return None;
    }
    if !is_image_destination_title_tail(title) {
        return None;
    }

    if is_windows_absolute_path(destination) {
        // Backslashes inside Markdown destinations are escape characters. In
        // particular, a temp directory such as `\.tmp...` loses its separator
        // before the renderer sees it. Normalize drive paths to URL separators;
        // percent-encode UNC paths so their leading `\\` is not mistaken for a
        // protocol-relative URL.
        let normalized = normalize_windows_image_path(destination);
        return Some(format!("{leading}<{normalized}>{title}"));
    }

    if !has_whitespace {
        return None;
    }

    Some(format!("{leading}<{destination}>{title}"))
}

fn normalize_windows_image_path(path: &str) -> String {
    if path.starts_with(r"\\") {
        urlencoding::encode(path).into_owned()
    } else {
        path.replace('\\', "/")
    }
}

fn is_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || path.starts_with(r"\\")
}

fn image_destination_end(input: &str) -> Option<usize> {
    const IMAGE_EXTENSIONS: &[&str] = &[
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tif", ".tiff",
    ];

    let lower = input.to_ascii_lowercase();
    let mut candidates = Vec::new();
    for extension in IMAGE_EXTENSIONS {
        let mut start = 0;
        while let Some(relative_idx) = lower[start..].find(extension) {
            let idx = start + relative_idx;
            let mut end = idx + extension.len();
            if is_image_extension_boundary(input, end) {
                while end < input.len() {
                    let ch = input[end..].chars().next()?;
                    if ch.is_whitespace() {
                        break;
                    }
                    end += ch.len_utf8();
                }
                candidates.push(end);
            }
            start = end;
        }
    }

    candidates.sort_unstable();
    candidates.dedup();
    candidates
        .into_iter()
        .find(|end| is_image_destination_title_tail(&input[*end..]))
}

fn is_image_extension_boundary(input: &str, end: usize) -> bool {
    match input[end..].chars().next() {
        Some(ch) => ch.is_whitespace() || matches!(ch, '?' | '#'),
        None => true,
    }
}

fn is_image_destination_title_tail(tail: &str) -> bool {
    let trimmed = tail.trim_start();
    trimmed.is_empty()
        || trimmed.starts_with('"')
        || trimmed.starts_with('\'')
        || trimmed.starts_with('(')
}

fn is_local_image_destination(destination: &str) -> bool {
    let trimmed = destination.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('#')
        && !trimmed.starts_with("//")
        && !is_remote_or_special_asset_url(trimmed)
}

fn is_remote_or_special_asset_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    trimmed.contains("://")
        || trimmed.starts_with("//")
        || lower.starts_with("data:")
        || lower.starts_with("mailto:")
        || lower.starts_with("blob:")
        || lower.starts_with("javascript:")
}

fn local_asset_route_from_url(raw_url: &str, ctx: &MarkdownAssetContext) -> Option<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("//")
        || is_remote_or_special_asset_url(trimmed)
    {
        return None;
    }

    let path_part = trimmed.split(['#', '?']).next().unwrap_or(trimmed);
    if path_part.is_empty() {
        return None;
    }
    let decoded = urlencoding::decode(path_part).ok()?;
    let decoded = decoded.as_ref();

    let mut candidates = Vec::with_capacity(2);
    let decoded_path = Path::new(decoded);
    if decoded_path.is_absolute() {
        candidates.push(decoded_path.to_path_buf());
    }
    if let Some(root_relative) = decoded.strip_prefix('/') {
        if !root_relative.is_empty() {
            candidates.push(ctx.workspace_root.join(root_relative));
        }
    } else if let (false, Some(parent)) = (decoded_path.is_absolute(), ctx.file_path.parent()) {
        candidates.push(parent.join(decoded_path));
    }

    for candidate in candidates {
        let Ok(canonical) = dunce::canonicalize(&candidate) else {
            continue;
        };
        let Ok(relative) = canonical.strip_prefix(&ctx.workspace_root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        return Some(path_to_route(relative));
    }

    None
}

fn rewrite_local_asset_url(raw_url: &str, ctx: &MarkdownAssetContext) -> Option<String> {
    if ctx.workspace_id.is_empty() {
        return None;
    }
    let route = local_asset_route_from_url(raw_url, ctx)?;
    let encoded_route = encode_route_path(&route);
    let suffix_start = raw_url.find(['#', '?']).unwrap_or(raw_url.len());
    let suffix = &raw_url[suffix_start..];
    Some(format!("/{}/{encoded_route}{suffix}", ctx.workspace_id))
}

fn path_to_route(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn encode_route_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// GitHub octicon-alert icon, shared by the WARNING alert title and the
/// fence-warning banner so the two copies can't drift apart.
const OCTICON_ALERT_SVG: &str = r#"<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>"#;

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct TocItem {
    pub level: u8,
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct MarkdownDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub line: Option<usize>,
}

#[derive(Debug, Clone)]
pub(crate) struct MarkdownRenderOutput {
    pub html: String,
    pub has_mermaid: bool,
    pub has_math: bool,
    pub toc: Vec<TocItem>,
    pub referenced_assets: std::collections::HashSet<String>,
    pub diagnostics: Vec<MarkdownDiagnostic>,
}

#[derive(Debug, Clone)]
pub(crate) struct MarkdownHtmlOutput {
    pub html: String,
    pub has_mermaid: bool,
    pub has_math: bool,
    pub toc: Vec<TocItem>,
}

#[derive(Debug, Default)]
struct RenderContext {
    has_mermaid: bool,
    has_math: bool,
    toc: Vec<TocItem>,
    heading_id_counts: std::collections::HashMap<String, u32>,
    open_heading_sections: Vec<u8>,
}

impl RenderContext {
    fn close_heading_sections_at_or_above(&mut self, level: u8, out: &mut String) {
        while let Some(&last_level) = self.open_heading_sections.last() {
            if last_level >= level {
                out.push_str("</div>");
                self.open_heading_sections.pop();
            } else {
                break;
            }
        }
    }

    fn close_all_heading_sections(&mut self, out: &mut String) {
        while self.open_heading_sections.pop().is_some() {
            out.push_str("</div>");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitHubAlertType {
    Note,
    Tip,
    Important,
    Warning,
    Caution,
}

impl GitHubAlertType {
    fn parse_marker(text: &str) -> Option<(Self, &str)> {
        let trimmed = text.trim_start();
        let alert = [
            ("[!NOTE]", Self::Note),
            ("[!TIP]", Self::Tip),
            ("[!IMPORTANT]", Self::Important),
            ("[!WARNING]", Self::Warning),
            ("[!CAUTION]", Self::Caution),
        ]
        .into_iter()
        .find_map(|(marker, alert)| trimmed.strip_prefix(marker).map(|rest| (alert, rest)))?;

        Some((alert.0, alert.1.trim_start()))
    }

    fn class_name(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Tip => "tip",
            Self::Important => "important",
            Self::Warning => "warning",
            Self::Caution => "caution",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Note => "Note",
            Self::Tip => "Tip",
            Self::Important => "Important",
            Self::Warning => "Warning",
            Self::Caution => "Caution",
        }
    }

    fn icon_svg(self) -> &'static str {
        match self {
            Self::Note => {
                r#"<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>"#
            }
            Self::Tip => {
                r#"<svg class="octicon octicon-light-bulb mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>"#
            }
            Self::Important => {
                r#"<svg class="octicon octicon-report mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>"#
            }
            Self::Warning => OCTICON_ALERT_SVG,
            Self::Caution => {
                r#"<svg class="octicon octicon-stop mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>"#
            }
        }
    }
}

pub(crate) trait MarkdownHtmlRenderer {
    fn render_html(&self, markdown: &str) -> MarkdownHtmlOutput;
}

pub(crate) trait MarkdownAssetExtractor {
    fn referenced_assets(&self, markdown: &str) -> std::collections::HashSet<String>;
}

pub(crate) trait MarkdownDiagnostics {
    fn diagnostics(&self, markdown: &str) -> Vec<MarkdownDiagnostic>;
}

pub(crate) trait MarkdownEngine:
    MarkdownHtmlRenderer + MarkdownAssetExtractor + MarkdownDiagnostics
{
    fn render(&self, markdown: &str) -> MarkdownRenderOutput {
        let html = self.render_html(markdown);
        MarkdownRenderOutput {
            html: html.html,
            has_mermaid: html.has_mermaid,
            has_math: html.has_math,
            toc: html.toc,
            referenced_assets: self.referenced_assets(markdown),
            diagnostics: self.diagnostics(markdown),
        }
    }
}

impl<T> MarkdownEngine for T where
    T: MarkdownHtmlRenderer + MarkdownAssetExtractor + MarkdownDiagnostics
{
}

/// Render a code block to class-based HTML (`<span class="mk-…">`) with no
/// inline colors, so the syntax palette is fully driven by the `--markon-code-*`
/// CSS tokens (and therefore theme-switchable + user-overridable). Falls back to
/// escaped plain text if syntect errors on a line.
fn highlight_code_to_classed_html(syntax: &SyntaxReference, ss: &SyntaxSet, code: &str) -> String {
    let mut generator = ClassedHTMLGenerator::new_with_class_style(
        syntax,
        ss,
        ClassStyle::SpacedPrefixed { prefix: "mk-" },
    );
    for line in LinesWithEndings::from(code) {
        if generator
            .parse_html_for_line_which_includes_newline(line)
            .is_err()
        {
            return html_escape::encode_text(code).into_owned();
        }
    }
    generator.finalize()
}

/// Highlight a whole source file to class-based HTML — the same `mk-` classes
/// and `--markon-code-*` design tokens used for fenced code blocks, so a file
/// preview inherits the identical (theme-switchable) palette. `token` is a
/// language hint (typically the file extension, e.g. `"rs"`, or the file name
/// for extension-less files like `"Dockerfile"`); unknown tokens fall back to
/// escaped plain text.
pub(crate) fn highlight_source_file(token: &str, code: &str) -> String {
    let ss: &SyntaxSet = &SYNTAX_SET;
    let syntax = resolve_syntax(ss, token);
    highlight_code_to_classed_html(syntax, ss, code)
}

pub(crate) struct MarkdownRenderer {
    asset_context: Option<MarkdownAssetContext>,
}

impl MarkdownRenderer {
    /// `_theme` is accepted for API compatibility but no longer affects
    /// highlighting: code is emitted as CSS classes (see
    /// `highlight_code_to_classed_html`) and coloured by the `--markon-code-*`
    /// design tokens, which switch with the page's `data-theme`.
    pub(crate) fn new(_theme: &str) -> Self {
        Self {
            asset_context: None,
        }
    }

    pub(crate) fn with_asset_context(
        mut self,
        workspace_id: impl Into<String>,
        file_path: impl Into<PathBuf>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        self.asset_context = Some(MarkdownAssetContext::new(
            workspace_id,
            file_path,
            workspace_root,
        ));
        self
    }

    #[cfg(test)]
    pub(crate) fn render(&self, markdown: &str) -> (String, bool, Vec<TocItem>) {
        let output = MarkdownEngine::render(self, markdown);
        (output.html, output.has_mermaid, output.toc)
    }

    fn rewrite_image_url(&self, url: &str) -> Option<String> {
        rewrite_local_asset_url(url, self.asset_context.as_ref()?)
    }
}

impl MarkdownHtmlRenderer for MarkdownRenderer {
    fn render_html(&self, markdown: &str) -> MarkdownHtmlOutput {
        let normalized = normalize_local_image_destinations(markdown);
        let ast = supramark_markdown::parse(normalized.as_ref());
        let mut html_output = String::new();
        let mut ctx = RenderContext::default();

        match &ast {
            supramark_markdown::SupramarkNode::Root { children, .. } => {
                self.render_nodes(children, &mut html_output, &mut ctx);
            }
            node => self.render_node(node, &mut html_output, &mut ctx),
        }
        ctx.close_all_heading_sections(&mut html_output);

        // Validate code fences and prepend warnings
        let fence_warnings = Self::detect_fence_issues(markdown);
        let warnings_html = Self::build_fence_warnings_html(&fence_warnings);
        let html_output = if warnings_html.is_empty() {
            html_output
        } else {
            format!("{warnings_html}{html_output}")
        };

        MarkdownHtmlOutput {
            html: html_output,
            has_mermaid: ctx.has_mermaid,
            has_math: ctx.has_math,
            toc: ctx.toc,
        }
    }
}

impl MarkdownAssetExtractor for MarkdownRenderer {
    fn referenced_assets(&self, markdown: &str) -> std::collections::HashSet<String> {
        match self.asset_context.as_ref() {
            Some(asset_context) => {
                extract_referenced_assets_with_context(markdown, Some(asset_context))
            }
            None => extract_referenced_assets(markdown),
        }
    }
}

impl MarkdownDiagnostics for MarkdownRenderer {
    fn diagnostics(&self, markdown: &str) -> Vec<MarkdownDiagnostic> {
        let ast = supramark_markdown::parse(markdown);
        let fence_warnings = Self::detect_fence_issues(markdown);
        let mut out = Self::fence_warnings_to_diagnostics(&fence_warnings);
        collect_supramark_diagnostics(&ast, &mut out);
        out
    }
}

impl MarkdownRenderer {
    fn github_alert_type(
        blockquote_children: &[supramark_markdown::SupramarkNode],
    ) -> Option<GitHubAlertType> {
        let paragraph_children = match blockquote_children.first()? {
            supramark_markdown::SupramarkNode::Paragraph { children, .. } => children,
            _ => return None,
        };
        let first_text = match paragraph_children.first()? {
            supramark_markdown::SupramarkNode::Text { value, .. } => value,
            _ => return None,
        };
        GitHubAlertType::parse_marker(first_text).map(|(alert, _)| alert)
    }

    fn render_github_alert(
        &self,
        alert: GitHubAlertType,
        children: &[supramark_markdown::SupramarkNode],
        out: &mut String,
        ctx: &mut RenderContext,
    ) {
        out.push_str("<div class=\"markdown-alert markdown-alert-");
        out.push_str(alert.class_name());
        out.push_str("\">\n");
        self.render_github_alert_title(alert, out);

        let mut consumed_marker = false;
        for child in children {
            if !consumed_marker {
                if let supramark_markdown::SupramarkNode::Paragraph {
                    children: paragraph_children,
                    ..
                } = child
                {
                    self.render_alert_opening_paragraph(paragraph_children, out, ctx);
                    consumed_marker = true;
                    continue;
                }
            }
            self.render_node(child, out, ctx);
        }

        out.push_str("</div>\n");
    }

    fn render_github_alert_title(&self, alert: GitHubAlertType, out: &mut String) {
        out.push_str("<p class=\"markdown-alert-title\">\n");
        out.push_str(alert.icon_svg());
        out.push_str(alert.title());
        out.push_str("\n</p>\n");
    }

    fn render_alert_opening_paragraph(
        &self,
        children: &[supramark_markdown::SupramarkNode],
        out: &mut String,
        ctx: &mut RenderContext,
    ) {
        let remaining = match children.first() {
            Some(supramark_markdown::SupramarkNode::Text { value, .. }) => {
                GitHubAlertType::parse_marker(value).map(|(_, remaining)| remaining)
            }
            _ => None,
        };
        let Some(remaining) = remaining else {
            out.push_str("<p>");
            self.render_nodes(children, out, ctx);
            out.push_str("</p>\n");
            return;
        };

        if remaining.is_empty() && children.len() == 1 {
            return;
        }

        out.push_str("<p>");
        if !remaining.is_empty() {
            self.render_text(out, remaining);
        }
        for child in &children[1..] {
            self.render_node(child, out, ctx);
        }
        out.push_str("</p>\n");
    }

    /// Replace `:shortcode:` emoji. Returns `Cow::Borrowed` (no allocation)
    /// when the text contains no shortcode.
    fn replace_emoji_shortcodes<'h>(&self, text: &'h str) -> Cow<'h, str> {
        EMOJI_REGEX.replace_all(text, |caps: &regex::Captures| {
            let shortcode = &caps[1];

            // Look up emoji using emojis crate
            if let Some(emoji) = emojis::get_by_shortcode(shortcode) {
                emoji.as_str().to_string()
            } else {
                // If not found, keep original text
                caps[0].to_string()
            }
        })
    }

    fn detect_fence_issues(markdown: &str) -> Vec<FenceWarning> {
        let mut warnings = Vec::new();
        let lines: Vec<&str> = markdown.lines().collect();
        let mut i = 0;

        while i < lines.len() {
            let trimmed = lines[i].trim_start();
            let (ch, count) = Self::count_fence_chars(trimmed);

            if count >= 3 {
                let has_info = !trimmed[ch.len_utf8() * count..].trim().is_empty();
                if has_info {
                    let outer_start = i + 1;
                    let outer_count = count;
                    let outer_char = ch;
                    let mut saw_inner_open = false;
                    i += 1;

                    while i < lines.len() {
                        let inner = lines[i].trim_start();
                        let (ic, icount) = Self::count_fence_chars(inner);

                        if ic == outer_char && icount >= outer_count {
                            let inner_has_info = !inner[ic.len_utf8() * icount..].trim().is_empty();
                            if inner_has_info {
                                saw_inner_open = true;
                            } else if saw_inner_open {
                                // This closing fence matches the outer block.
                                // Check if content continues after (suggesting premature close).
                                let mut j = i + 1;
                                while j < lines.len() && lines[j].trim().is_empty() {
                                    j += 1;
                                }
                                if j < lines.len() {
                                    let next = lines[j].trim_start();
                                    if next.starts_with('#') {
                                        warnings.push(FenceWarning {
                                            line: i + 1,
                                            outer_start,
                                            backtick_count: outer_count,
                                        });
                                    }
                                }
                                break;
                            } else {
                                break;
                            }
                        }
                        i += 1;
                    }
                }
            }
            i += 1;
        }

        warnings
    }

    fn count_fence_chars(line: &str) -> (char, usize) {
        let first = match line.chars().next() {
            Some(c @ '`') | Some(c @ '~') => c,
            _ => return (' ', 0),
        };
        let count = line.chars().take_while(|&c| c == first).count();
        (first, count)
    }

    fn build_fence_warnings_html(warnings: &[FenceWarning]) -> String {
        if warnings.is_empty() {
            return String::new();
        }
        let mut html = String::new();
        for w in warnings {
            html.push_str(&format!(
                r#"<div class="markdown-alert markdown-alert-warning">
<p class="markdown-alert-title">
{icon}Markdown Warning
</p>
<p>Line {line}: code fence closed prematurely — the code block starting at line {outer} uses {count} backticks, but an inner fence with the same count closes it early. Use {fix} backticks for the outer fence to fix this. <a href="javascript:void(0)" onclick="openEditorAtLine({line})" style="text-decoration:underline;cursor:pointer">Edit line {line}</a></p>
</div>"#,
                icon = OCTICON_ALERT_SVG,
                line = w.line,
                outer = w.outer_start,
                count = w.backtick_count,
                fix = w.backtick_count + 1,
            ));
        }
        html
    }

    fn fence_warnings_to_diagnostics(warnings: &[FenceWarning]) -> Vec<MarkdownDiagnostic> {
        warnings
            .iter()
            .map(|warning| MarkdownDiagnostic {
                code: "premature_fence_close".to_string(),
                severity: "warning".to_string(),
                message: format!(
                    "Line {}: code fence closed prematurely; use {} backticks for the outer fence.",
                    warning.line,
                    warning.backtick_count + 1
                ),
                line: Some(warning.line),
            })
            .collect()
    }

    fn generate_slug(text: &str) -> String {
        let mapped = text
            .trim()
            .to_lowercase()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c.is_whitespace() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-");

        let mut slug = String::with_capacity(mapped.len());
        let mut last_was_hyphen = false;
        for c in mapped.chars() {
            if c == '-' {
                if !last_was_hyphen {
                    slug.push(c);
                }
                last_was_hyphen = true;
            } else {
                slug.push(c);
                last_was_hyphen = false;
            }
        }
        slug
    }

    fn next_heading_id(ctx: &mut RenderContext, base_id: &str) -> String {
        let count = ctx
            .heading_id_counts
            .entry(base_id.to_string())
            .or_insert(0);
        let id = if *count == 0 {
            base_id.to_string()
        } else {
            format!("{base_id}-{count}")
        };
        *count += 1;
        id
    }
}

pub(crate) fn default_markdown_engine(theme: &str) -> MarkdownRenderer {
    MarkdownRenderer::new(theme)
}

impl MarkdownRenderer {
    fn render_nodes(
        &self,
        nodes: &[supramark_markdown::SupramarkNode],
        out: &mut String,
        ctx: &mut RenderContext,
    ) {
        for node in nodes {
            self.render_node(node, out, ctx);
        }
    }
}

impl MarkdownRenderer {
    fn render_node(
        &self,
        node: &supramark_markdown::SupramarkNode,
        out: &mut String,
        ctx: &mut RenderContext,
    ) {
        use supramark_markdown::SupramarkNode;
        match node {
            SupramarkNode::Root { children, .. } => self.render_nodes(children, out, ctx),
            SupramarkNode::Paragraph { children, .. } => {
                out.push_str("<p>");
                self.render_nodes(children, out, ctx);
                out.push_str("</p>\n");
            }
            SupramarkNode::Heading {
                depth, children, ..
            } => {
                let depth = (*depth).clamp(1, 6);
                let heading_text = heading_plain_text(children);
                let id = Self::next_heading_id(ctx, &Self::generate_slug(&heading_text));

                ctx.close_heading_sections_at_or_above(depth, out);
                out.push_str(&format!(
                    "<div class=\"heading-section\" data-level=\"{depth}\">"
                ));
                ctx.open_heading_sections.push(depth);

                ctx.toc.push(TocItem {
                    level: depth,
                    id: id.clone(),
                    text: heading_text,
                });

                out.push_str(&format!("<h{depth} id=\""));
                html_escape::encode_double_quoted_attribute_to_string(&id, out);
                out.push_str("\">");
                self.render_nodes(children, out, ctx);
                out.push_str(&format!("</h{depth}>\n"));
            }
            SupramarkNode::Text { value, .. } => self.render_text(out, value),
            SupramarkNode::Strong { children, .. } => {
                out.push_str("<strong>");
                self.render_nodes(children, out, ctx);
                out.push_str("</strong>");
            }
            SupramarkNode::Emphasis { children, .. } => {
                out.push_str("<em>");
                self.render_nodes(children, out, ctx);
                out.push_str("</em>");
            }
            SupramarkNode::InlineCode { value, .. } => {
                out.push_str("<code>");
                html_escape::encode_text_to_string(value, out);
                out.push_str("</code>");
            }
            SupramarkNode::Link {
                url,
                title,
                children,
                ..
            } => {
                // Drop the href for unsafe schemes (javascript:, data:, …) so a
                // `[text](javascript:…)` link renders as inert text, not a click
                // that executes script.
                if url_scheme_is_safe(url, false) {
                    out.push_str("<a href=\"");
                    html_escape::encode_double_quoted_attribute_to_string(url, out);
                    out.push('"');
                    if let Some(title) = title {
                        out.push_str(" title=\"");
                        html_escape::encode_double_quoted_attribute_to_string(title, out);
                        out.push('"');
                    }
                    out.push('>');
                } else {
                    out.push_str("<a>");
                }
                self.render_nodes(children, out, ctx);
                out.push_str("</a>");
            }
            SupramarkNode::Image {
                url, title, alt, ..
            } => {
                let rewritten_url = self.rewrite_image_url(url);
                let src = rewritten_url.as_deref().unwrap_or(url);
                // Images may carry `data:image/…`; any other non-safe scheme is
                // dropped, leaving the alt text.
                if url_scheme_is_safe(src, true) {
                    out.push_str("<img src=\"");
                    html_escape::encode_double_quoted_attribute_to_string(src, out);
                    out.push_str("\" alt=\"");
                    html_escape::encode_double_quoted_attribute_to_string(alt, out);
                    out.push('"');
                    if let Some(title) = title {
                        out.push_str(" title=\"");
                        html_escape::encode_double_quoted_attribute_to_string(title, out);
                        out.push('"');
                    }
                    out.push_str(" />");
                } else {
                    out.push_str("<img alt=\"");
                    html_escape::encode_double_quoted_attribute_to_string(alt, out);
                    out.push_str("\" />");
                }
            }
            SupramarkNode::Break { .. } => out.push_str("<br />\n"),
            SupramarkNode::Delete { children, .. } => {
                out.push_str("<del>");
                self.render_nodes(children, out, ctx);
                out.push_str("</del>");
            }
            SupramarkNode::Code { value, lang, .. } => {
                if let Some(engine) = code_fence_diagram_engine(lang.as_deref()) {
                    self.render_diagram(engine, value, out);
                    return;
                }

                let syntax = resolve_syntax(&SYNTAX_SET, lang.as_deref().unwrap_or(""));
                let inner = highlight_code_to_classed_html(syntax, &SYNTAX_SET, value);
                out.push_str("<pre><code class=\"mk-code\">");
                out.push_str(&inner);
                out.push_str("</code></pre>");
            }
            SupramarkNode::Diagram { engine, code, .. } => {
                self.render_diagram(engine, code, out);
            }
            SupramarkNode::List {
                ordered,
                start,
                children,
                ..
            } => {
                if *ordered {
                    out.push_str("<ol");
                    if let Some(start) = start {
                        out.push_str(&format!(" start=\"{start}\""));
                    }
                    out.push_str(">\n");
                    self.render_nodes(children, out, ctx);
                    out.push_str("</ol>\n");
                } else {
                    out.push_str("<ul>\n");
                    self.render_nodes(children, out, ctx);
                    out.push_str("</ul>\n");
                }
            }
            SupramarkNode::ListItem {
                checked, children, ..
            } => {
                out.push_str("<li>");
                if let Some(checked) = checked {
                    let checked_attr = if *checked { " checked" } else { "" };
                    out.push_str(&format!(
                        "<input disabled=\"\" type=\"checkbox\"{checked_attr} /> "
                    ));
                }
                self.render_nodes(children, out, ctx);
                out.push_str("</li>\n");
            }
            SupramarkNode::Blockquote { children, .. } => {
                if let Some(alert) = Self::github_alert_type(children) {
                    self.render_github_alert(alert, children, out, ctx);
                } else {
                    out.push_str("<blockquote>\n");
                    self.render_nodes(children, out, ctx);
                    out.push_str("</blockquote>\n");
                }
            }
            SupramarkNode::ThematicBreak { .. } => out.push_str("<hr />\n"),
            SupramarkNode::Table { children, .. } => self.render_table(children, out, ctx),
            SupramarkNode::TableRow { children, .. } => {
                out.push_str("<tr>");
                self.render_nodes(children, out, ctx);
                out.push_str("</tr>\n");
            }
            SupramarkNode::TableCell {
                align,
                header,
                children,
                ..
            } => {
                let tag = if *header { "th" } else { "td" };
                out.push_str(&format!("<{tag}"));
                if let Some(align) = align {
                    let value = match align {
                        supramark_markdown::TableAlign::Left => "left",
                        supramark_markdown::TableAlign::Right => "right",
                        supramark_markdown::TableAlign::Center => "center",
                    };
                    out.push_str(" style=\"text-align: ");
                    out.push_str(value);
                    out.push('"');
                }
                out.push('>');
                self.render_nodes(children, out, ctx);
                out.push_str(&format!("</{tag}>"));
            }
            SupramarkNode::MathBlock { value, .. } => {
                ctx.has_math = true;
                out.push_str("<div class=\"math math-block\" data-math-display=\"true\">");
                html_escape::encode_text_to_string(value, out);
                out.push_str("</div>");
            }
            SupramarkNode::MathInline { value, .. } => {
                ctx.has_math = true;
                out.push_str("<span class=\"math math-inline\" data-math-display=\"false\">");
                html_escape::encode_text_to_string(value, out);
                out.push_str("</span>");
            }
            SupramarkNode::DefinitionList { children, .. } => {
                out.push_str("<dl>\n");
                self.render_nodes(children, out, ctx);
                out.push_str("</dl>\n");
            }
            SupramarkNode::DefinitionItem { children, .. } => {
                self.render_nodes(children, out, ctx);
            }
            SupramarkNode::DefinitionTerm { children, .. } => {
                out.push_str("<dt>");
                self.render_nodes(children, out, ctx);
                out.push_str("</dt>\n");
            }
            SupramarkNode::DefinitionDescription { children, .. } => {
                out.push_str("<dd>");
                self.render_nodes(children, out, ctx);
                out.push_str("</dd>\n");
            }
            SupramarkNode::FootnoteDefinition {
                index,
                identifier,
                children,
                ..
            } => {
                out.push_str(&format!(
                    "<div class=\"footnote-definition\" id=\"{}\"><sup class=\"footnote-definition-label\">{}</sup>",
                    footnote_id(identifier),
                    index
                ));
                self.render_nodes(children, out, ctx);
                out.push_str("</div>\n");
            }
            SupramarkNode::FootnoteReference {
                index, identifier, ..
            } => {
                out.push_str(&format!(
                    "<sup class=\"footnote-reference\"><a href=\"#{}\">{}</a></sup>",
                    footnote_id(identifier),
                    index
                ));
            }
            SupramarkNode::Container {
                name,
                children,
                value,
                ..
            }
            | SupramarkNode::Input {
                name,
                children,
                value,
                ..
            } => {
                if children.is_empty() {
                    if let Some(value) = value {
                        self.render_source_fallback(
                            "Unsupported Supramark extension",
                            name,
                            None,
                            value,
                            out,
                        );
                    }
                } else {
                    self.render_nodes(children, out, ctx);
                }
            }
            SupramarkNode::Raw {
                format,
                value,
                block,
                ..
            } => {
                if format.eq_ignore_ascii_case("html") {
                    out.push_str(&sanitize_raw_html_fragment(value));
                    if *block {
                        out.push('\n');
                    }
                } else {
                    out.push_str("<pre><code>");
                    html_escape::encode_text_to_string(value, out);
                    out.push_str("</code></pre>");
                }
            }
            SupramarkNode::Unsupported {
                value, children, ..
            } => {
                if let Some(value) = value {
                    out.push_str("<pre><code>");
                    html_escape::encode_text_to_string(value, out);
                    out.push_str("</code></pre>");
                }
                self.render_nodes(children, out, ctx);
            }
        }
    }

    fn render_table(
        &self,
        rows: &[supramark_markdown::SupramarkNode],
        out: &mut String,
        ctx: &mut RenderContext,
    ) {
        out.push_str("<table>");
        let header_rows = rows
            .iter()
            .take_while(|row| table_row_is_header(row))
            .collect::<Vec<_>>();
        if !header_rows.is_empty() {
            out.push_str("<thead>");
            for row in &header_rows {
                self.render_node(row, out, ctx);
            }
            out.push_str("</thead>");
        }
        let body_rows = rows.iter().skip(header_rows.len()).collect::<Vec<_>>();
        if !body_rows.is_empty() {
            out.push_str("<tbody>\n");
            for row in body_rows {
                self.render_node(row, out, ctx);
            }
            out.push_str("</tbody>");
        }
        out.push_str("</table>\n");
    }

    fn render_source_fallback(
        &self,
        label: &str,
        name: &str,
        lang: Option<&str>,
        source: &str,
        out: &mut String,
    ) {
        self.render_source_fallback_with_message(label, name, lang, source, None, out);
    }

    fn render_source_fallback_with_message(
        &self,
        label: &str,
        name: &str,
        lang: Option<&str>,
        source: &str,
        message: Option<&str>,
        out: &mut String,
    ) {
        out.push_str("<div class=\"markon-source-fallback\" data-fallback-kind=\"");
        html_escape::encode_double_quoted_attribute_to_string(label, out);
        out.push_str("\" data-fallback-name=\"");
        html_escape::encode_double_quoted_attribute_to_string(name, out);
        out.push_str("\"><div class=\"markon-source-fallback-label\">");
        html_escape::encode_text_to_string(label, out);
        out.push_str(": <code>");
        html_escape::encode_text_to_string(name, out);
        out.push_str("</code>.");
        if let Some(message) = message {
            out.push_str(" <span class=\"markon-source-fallback-message\">");
            html_escape::encode_text_to_string(message, out);
            out.push_str("</span>.");
        }
        out.push_str(" Showing source.</div>");

        let syntax = resolve_syntax(&SYNTAX_SET, lang.unwrap_or(name));
        let inner = highlight_code_to_classed_html(syntax, &SYNTAX_SET, source);
        out.push_str("<pre><code class=\"mk-code\">");
        out.push_str(&inner);
        out.push_str("</code></pre></div>");
    }

    fn render_diagram(&self, engine: &str, code: &str, out: &mut String) {
        let engine_id = engine.trim().to_ascii_lowercase();
        let result = {
            let _guard = DIAGRAM_RENDER_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            DIAGRAM_REGISTRY.render(engine_id.as_str(), code)
        };
        let Some(result) = result else {
            self.render_source_fallback(
                "Unsupported diagram engine",
                engine,
                Some(engine),
                code,
                out,
            );
            return;
        };

        let output = match result {
            Ok(output) => output,
            Err(err) => {
                self.render_source_fallback_with_message(
                    "Diagram render failed",
                    engine,
                    Some(engine),
                    code,
                    Some(&err.to_string()),
                    out,
                );
                return;
            }
        };

        if output.mime != "image/svg+xml" {
            self.render_source_fallback_with_message(
                "Diagram render failed",
                engine,
                Some(engine),
                code,
                Some("renderer returned a non-SVG output"),
                out,
            );
            return;
        }

        let svg = match String::from_utf8(output.bytes) {
            Ok(svg) => svg,
            Err(err) => {
                self.render_source_fallback_with_message(
                    "Diagram render failed",
                    engine,
                    Some(engine),
                    code,
                    Some(&format!("renderer returned invalid UTF-8: {err}")),
                    out,
                );
                return;
            }
        };

        let Some(svg) = normalize_rendered_svg(&svg) else {
            self.render_source_fallback_with_message(
                "Diagram render failed",
                engine,
                Some(engine),
                code,
                Some("renderer returned unsafe or invalid SVG"),
                out,
            );
            return;
        };

        let class_suffix = diagram_engine_class_suffix(engine);
        out.push_str("<div class=\"markon-diagram markon-diagram-");
        html_escape::encode_double_quoted_attribute_to_string(&class_suffix, out);
        out.push_str("\" data-diagram-engine=\"");
        html_escape::encode_double_quoted_attribute_to_string(engine, out);
        out.push_str("\"><div class=\"markon-diagram-canvas\">");
        out.push_str(&svg);
        out.push_str("</div></div>");
    }

    fn render_text(&self, out: &mut String, text: &str) {
        let text = self.replace_emoji_shortcodes(text);
        html_escape::encode_text_to_string(&text, out);
    }
}

fn normalize_rendered_svg(raw: &str) -> Option<String> {
    let start = raw.find("<svg")?;
    let end = raw.rfind("</svg>")? + "</svg>".len();
    if start >= end {
        return None;
    }
    let mut svg = raw[start..end].to_string();
    strip_xml_processing_instructions(&mut svg);
    ensure_root_svg_dimensions(&mut svg);

    let lower = svg.to_ascii_lowercase();
    if lower.contains("<script") || lower.contains("javascript:") {
        return None;
    }
    if SVG_EVENT_ATTR_REGEX.is_match(&svg) {
        return None;
    }

    Some(svg)
}

fn ensure_root_svg_dimensions(svg: &mut String) {
    let Some(tag_end) = svg.find('>') else {
        return;
    };
    let root_tag = &svg[..tag_end];
    let has_width = SVG_ROOT_WIDTH_ATTR_REGEX.is_match(root_tag);
    let has_height = SVG_ROOT_HEIGHT_ATTR_REGEX.is_match(root_tag);
    if has_width && has_height {
        return;
    }

    let Some((viewbox_width, viewbox_height)) = root_svg_viewbox_size(root_tag) else {
        return;
    };

    let mut attrs = String::new();
    if !has_width {
        attrs.push_str(" width=\"");
        attrs.push_str(&viewbox_width);
        attrs.push('"');
    }
    if !has_height {
        attrs.push_str(" height=\"");
        attrs.push_str(&viewbox_height);
        attrs.push('"');
    }
    svg.insert_str(tag_end, &attrs);
}

fn root_svg_viewbox_size(root_tag: &str) -> Option<(String, String)> {
    let value = SVG_VIEWBOX_ATTR_REGEX.captures(root_tag)?.get(1)?.as_str();
    let parts = value
        .split(|ch: char| ch == ',' || ch.is_ascii_whitespace())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() != 4 {
        return None;
    }

    let width = parts[2].parse::<f64>().ok()?;
    let height = parts[3].parse::<f64>().ok()?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return None;
    }

    Some((parts[2].to_owned(), parts[3].to_owned()))
}

fn strip_xml_processing_instructions(svg: &mut String) {
    while let Some(start) = svg.find("<?") {
        let Some(relative_end) = svg[start + 2..].find("?>") else {
            break;
        };
        let end = start + 2 + relative_end + 2;
        svg.replace_range(start..end, "");
    }
}

fn diagram_engine_class_suffix(engine: &str) -> String {
    let mut out = String::with_capacity(engine.len());
    let mut last_was_dash = false;
    for ch in engine.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn code_fence_diagram_engine(lang: Option<&str>) -> Option<&'static str> {
    let token = lang?
        .trim()
        .split(char::is_whitespace)
        .find(|part| !part.is_empty())?
        .to_ascii_lowercase();

    match token.as_str() {
        "mermaid" | "mmd" => Some("mermaid"),
        "plantuml" | "puml" => Some("plantuml"),
        "d2" => Some("d2"),
        "dot" => Some("dot"),
        "graphviz" => Some("graphviz"),
        "vega-lite" | "vegalite" => Some("vega-lite"),
        "vega" => Some("vega"),
        "echarts" => Some("echarts"),
        "chart" => Some("chart"),
        "chartjs" => Some("chartjs"),
        "chart.js" => Some("chart.js"),
        "plotly" => Some("plotly"),
        _ => None,
    }
}

fn heading_plain_text(nodes: &[supramark_markdown::SupramarkNode]) -> String {
    let mut out = String::new();
    for node in nodes {
        collect_heading_plain_text(node, &mut out);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_heading_plain_text(node: &supramark_markdown::SupramarkNode, out: &mut String) {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Text { value, .. }
        | SupramarkNode::InlineCode { value, .. }
        | SupramarkNode::Code { value, .. }
        | SupramarkNode::MathBlock { value, .. }
        | SupramarkNode::MathInline { value, .. } => push_heading_text(out, value),
        SupramarkNode::Raw { format, value, .. } => {
            if format.eq_ignore_ascii_case("html") {
                push_heading_text(out, &strip_html_tags(value));
            } else {
                push_heading_text(out, value);
            }
        }
        SupramarkNode::Diagram { code, .. } => push_heading_text(out, code),
        SupramarkNode::Image { alt, .. } => push_heading_text(out, alt),
        SupramarkNode::Link { url, children, .. } => {
            let before = out.len();
            for child in children {
                collect_heading_plain_text(child, out);
            }
            if out.len() == before {
                push_heading_text(out, url);
            }
        }
        SupramarkNode::FootnoteReference { label, .. } => push_heading_text(out, label),
        SupramarkNode::Container {
            value, children, ..
        }
        | SupramarkNode::Input {
            value, children, ..
        } => {
            if let Some(value) = value {
                push_heading_text(out, value);
            }
            for child in children {
                collect_heading_plain_text(child, out);
            }
        }
        SupramarkNode::Unsupported {
            value, children, ..
        } => {
            if let Some(value) = value {
                push_heading_text(out, value);
            }
            for child in children {
                collect_heading_plain_text(child, out);
            }
        }
        SupramarkNode::Break { .. } => out.push('\n'),
        _ => {
            if let Some(children) = supramark_children(node) {
                for child in children {
                    collect_heading_plain_text(child, out);
                }
            }
        }
    }
}

fn push_heading_text(out: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push(' ');
    }
    out.push_str(value);
}

fn strip_html_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for c in value.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Tags that may survive from *author-written raw HTML* (the `raw-html` feature
/// passes inline HTML through the AST as `Raw{format:"html"}` fragments). This
/// is a deliberately small GitHub-flavored formatting/structure set; anything
/// outside it is escaped to inert text. It does NOT need to list markon's own
/// generated markup (octicon SVGs, syntect spans, diagram/math containers,
/// heading anchors …) because that markup never passes through this scrubber —
/// only untrusted raw fragments do — so there is no risk of silently dropping
/// first-party markup.
const RAW_HTML_ALLOWED_TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
];

/// Attributes whose value carries a URL and must pass [`url_scheme_is_safe`].
const RAW_HTML_URL_ATTRS: &[&str] = &[
    "href",
    "src",
    "xlink:href",
    "action",
    "formaction",
    "poster",
    "background",
    "srcset",
    "ping",
    "data",
];

/// Sanitize one author-written raw HTML fragment WITHOUT rebalancing tags.
///
/// The markdown parser hands raw HTML through split into open/close fragments
/// (`<details>` and `</details>` arrive as separate `Raw` nodes with rendered
/// markdown in between), so a tree-rebuilding sanitizer (ammonia/html5ever)
/// would prematurely close `<details>`/`<div>` wrappers and drop the stray
/// closing tags — breaking legitimate GitHub-style inline HTML. Instead we scan
/// tag-by-tag and rewrite in place, fail-closed: a tag we can't parse cleanly,
/// or whose name isn't in [`RAW_HTML_ALLOWED_TAGS`], is escaped to visible text
/// rather than emitted. On allowed tags we strip event-handler (`on*`) and
/// `style`/`srcdoc` attributes and drop URL attributes with an unsafe scheme.
fn sanitize_raw_html_fragment(frag: &str) -> String {
    let bytes = frag.as_bytes();
    let mut out = String::with_capacity(frag.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some((end, rendered)) = sanitize_html_tag(frag, i) {
                out.push_str(&rendered);
                i = end;
            } else {
                // Not a well-formed tag → the '<' is literal text.
                out.push_str("&lt;");
                i += 1;
            }
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b'<' {
            i += 1;
        }
        out.push_str(&frag[start..i]);
    }
    out
}

fn escape_html_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    html_escape::encode_text_to_string(s, &mut out);
    out
}

/// Parse a single tag starting at `start` (`frag[start] == '<'`). Returns the
/// index just past the tag and the sanitized replacement, or `None` when the
/// bytes aren't a well-formed tag (the caller then escapes the lone `<`).
fn sanitize_html_tag(frag: &str, start: usize) -> Option<(usize, String)> {
    let bytes = frag.as_bytes();
    let rest = &frag[start..];

    // Comments: drop entirely (fail closed on an unterminated one).
    if rest.starts_with("<!--") {
        return match rest.find("-->") {
            Some(pos) => Some((start + pos + 3, String::new())),
            None => Some((frag.len(), String::new())),
        };
    }
    // Doctype / CDATA / processing instructions: not expected inside a fragment.
    if rest.starts_with("<!") || rest.starts_with("<?") {
        return None;
    }

    let mut i = start + 1;
    let closing = i < bytes.len() && bytes[i] == b'/';
    if closing {
        i += 1;
    }

    // Tag name: must start with a letter.
    let name_start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
        i += 1;
    }
    if i == name_start || !bytes[name_start].is_ascii_alphabetic() {
        return None;
    }
    let name = frag[name_start..i].to_ascii_lowercase();
    let allowed = RAW_HTML_ALLOWED_TAGS.contains(&name.as_str());

    if closing {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'>' {
            return None;
        }
        let end = i + 1;
        return Some((
            end,
            if allowed {
                format!("</{name}>")
            } else {
                escape_html_text(&frag[start..end])
            },
        ));
    }

    // Opening / self-closing tag: parse attributes, honoring quoted values so a
    // '>' inside a value doesn't end the tag early.
    let mut attrs: Vec<(String, Option<String>)> = Vec::new();
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None; // no closing '>'
        }
        match bytes[i] {
            b'>' => {
                i += 1;
                break;
            }
            b'/' => {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                if i < bytes.len() && bytes[i] == b'>' {
                    i += 1;
                    break;
                }
                return None;
            }
            _ => {
                let an_start = i;
                while i < bytes.len() {
                    let b = bytes[i];
                    if b.is_ascii_whitespace() || b == b'=' || b == b'>' || b == b'/' {
                        break;
                    }
                    i += 1;
                }
                if i == an_start {
                    return None;
                }
                let aname = frag[an_start..i].to_ascii_lowercase();
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                let mut aval: Option<String> = None;
                if i < bytes.len() && bytes[i] == b'=' {
                    i += 1;
                    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    if i >= bytes.len() {
                        return None;
                    }
                    let quote = bytes[i];
                    if quote == b'"' || quote == b'\'' {
                        i += 1;
                        let v_start = i;
                        while i < bytes.len() && bytes[i] != quote {
                            i += 1;
                        }
                        if i >= bytes.len() {
                            return None; // unterminated quote
                        }
                        aval = Some(frag[v_start..i].to_string());
                        i += 1;
                    } else {
                        let v_start = i;
                        while i < bytes.len() {
                            let b = bytes[i];
                            if b.is_ascii_whitespace() || b == b'>' {
                                break;
                            }
                            i += 1;
                        }
                        aval = Some(frag[v_start..i].to_string());
                    }
                }
                attrs.push((aname, aval));
            }
        }
    }
    let end = i;

    if !allowed {
        return Some((end, escape_html_text(&frag[start..end])));
    }

    let allow_data_image = name == "img";
    let mut out = String::with_capacity(end - start);
    out.push('<');
    out.push_str(&name);
    for (aname, aval) in attrs {
        // Event handlers, inline CSS, and iframe srcdoc are dropped outright.
        if aname.starts_with("on") || aname == "style" || aname == "srcdoc" {
            continue;
        }
        if RAW_HTML_URL_ATTRS.contains(&aname.as_str()) {
            if let Some(v) = &aval {
                if !url_scheme_is_safe(v, allow_data_image) {
                    continue;
                }
            }
        }
        out.push(' ');
        out.push_str(&aname);
        if let Some(v) = aval {
            out.push_str("=\"");
            html_escape::encode_double_quoted_attribute_to_string(&v, &mut out);
            out.push('"');
        }
    }
    out.push('>');
    Some((end, out))
}

/// Whether a URL is safe to place in an `href`/`src`-style attribute — i.e. it
/// can't drive script execution or navigation to a scripting scheme. Relative
/// URLs, anchors and protocol-relative URLs are safe; among absolute URLs only
/// a small scheme allowlist passes (`data:` only for images). HTML entities are
/// decoded and whitespace/control characters removed first, so obfuscations
/// like `jav&#x61;script:` or `java\tscript:` can't slip through.
fn url_scheme_is_safe(raw: &str, allow_data_image: bool) -> bool {
    let decoded = html_escape::decode_html_entities(raw);
    let mut cleaned = String::with_capacity(decoded.len());
    for c in decoded.chars() {
        if (c as u32) > 0x20 {
            cleaned.push(c.to_ascii_lowercase());
        }
    }
    // A scheme is `[alpha][alnum+.-]* ':'` occurring before any `/ ? #`.
    let mut scheme = String::new();
    let mut has_colon = false;
    for c in cleaned.chars() {
        match c {
            ':' => {
                has_colon = true;
                break;
            }
            '/' | '?' | '#' => break,
            _ => scheme.push(c),
        }
    }
    if !has_colon {
        return true; // relative / anchor / protocol-relative
    }
    // If it isn't a grammatically valid scheme, the ':' is just data (e.g. a
    // time like "12:30"), which is likewise safe.
    if !scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return true;
    }
    match scheme.as_str() {
        "http" | "https" | "mailto" | "tel" | "ftp" => true,
        "data" => allow_data_image && cleaned.starts_with("data:image/"),
        _ => false,
    }
}

fn collect_supramark_assets(
    node: &supramark_markdown::SupramarkNode,
    out: &mut std::collections::HashSet<String>,
    asset_context: Option<&MarkdownAssetContext>,
) {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Image { url, .. } => {
            if let Some(rel) = asset_context.and_then(|ctx| local_asset_route_from_url(url, ctx)) {
                out.insert(rel);
            } else if let Some(rel) = sanitize_asset_ref(url) {
                out.insert(rel);
            }
        }
        SupramarkNode::Raw { value, .. } => collect_from_html(value, out),
        _ => {}
    }
    if let Some(children) = supramark_children(node) {
        for child in children {
            collect_supramark_assets(child, out, asset_context);
        }
    }
}

fn collect_supramark_diagnostics(
    node: &supramark_markdown::SupramarkNode,
    out: &mut Vec<MarkdownDiagnostic>,
) {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Root { diagnostics, .. } => {
            for diagnostic in diagnostics {
                out.push(MarkdownDiagnostic {
                    code: diagnostic.code.clone(),
                    severity: format!("{:?}", diagnostic.severity).to_ascii_lowercase(),
                    message: diagnostic.message.clone(),
                    line: diagnostic
                        .position
                        .as_ref()
                        .map(|position| position.start.line as usize),
                });
            }
            return;
        }
        SupramarkNode::Unsupported { diagnostics, .. } => {
            for diagnostic in diagnostics {
                out.push(MarkdownDiagnostic {
                    code: diagnostic.code.clone(),
                    severity: format!("{:?}", diagnostic.severity).to_ascii_lowercase(),
                    message: diagnostic.message.clone(),
                    line: diagnostic
                        .position
                        .as_ref()
                        .map(|position| position.start.line as usize),
                });
            }
        }
        _ => {}
    }
    if let Some(children) = supramark_children(node) {
        for child in children {
            collect_supramark_diagnostics(child, out);
        }
    }
}

fn table_row_is_header(node: &supramark_markdown::SupramarkNode) -> bool {
    match node {
        supramark_markdown::SupramarkNode::TableRow { children, .. } => {
            children.iter().any(|cell| {
                matches!(
                    cell,
                    supramark_markdown::SupramarkNode::TableCell { header: true, .. }
                )
            })
        }
        _ => false,
    }
}

fn footnote_id(label: &str) -> String {
    format!("fn-{}", html_escape::encode_double_quoted_attribute(label))
}

fn supramark_children(
    node: &supramark_markdown::SupramarkNode,
) -> Option<&[supramark_markdown::SupramarkNode]> {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Root { children, .. }
        | SupramarkNode::Paragraph { children, .. }
        | SupramarkNode::Heading { children, .. }
        | SupramarkNode::Strong { children, .. }
        | SupramarkNode::Emphasis { children, .. }
        | SupramarkNode::Delete { children, .. }
        | SupramarkNode::List { children, .. }
        | SupramarkNode::ListItem { children, .. }
        | SupramarkNode::Blockquote { children, .. }
        | SupramarkNode::Table { children, .. }
        | SupramarkNode::TableRow { children, .. }
        | SupramarkNode::TableCell { children, .. }
        | SupramarkNode::DefinitionList { children, .. }
        | SupramarkNode::DefinitionItem { children, .. }
        | SupramarkNode::DefinitionTerm { children, .. }
        | SupramarkNode::DefinitionDescription { children, .. }
        | SupramarkNode::FootnoteDefinition { children, .. }
        | SupramarkNode::Container { children, .. }
        | SupramarkNode::Input { children, .. }
        | SupramarkNode::Unsupported { children, .. } => Some(children),
        _ => None,
    }
}

#[cfg(test)]
mod assets_tests {
    use super::MarkdownRenderer;
    use super::{
        extract_referenced_assets, normalize_local_image_destinations, sanitize_asset_ref,
        sanitize_raw_html_fragment, url_scheme_is_safe,
    };
    use crate::markdown::MarkdownEngine;

    fn assert_set(actual: std::collections::HashSet<String>, expected: &[&str]) {
        let want: std::collections::HashSet<String> =
            expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(actual, want, "asset set mismatch");
    }

    #[test]
    fn markdown_image_syntax() {
        let s = "![alt](pic.png) and ![](folder/img.jpg)";
        assert_set(extract_referenced_assets(s), &["pic.png", "folder/img.jpg"]);
    }

    #[test]
    fn html_img_video_audio() {
        let s = r#"<img src="a.png"> <video src='b.mp4'/> <audio src="c.ogg"></audio>"#;
        assert_set(extract_referenced_assets(s), &["a.png", "b.mp4", "c.ogg"]);
    }

    #[test]
    fn link_stylesheet() {
        let s = r#"<link rel="stylesheet" href="style.css">"#;
        assert_set(extract_referenced_assets(s), &["style.css"]);
    }

    #[test]
    fn css_url_in_style_block() {
        let s = "<style>body { background: url('bg.jpg'); }</style>";
        assert_set(extract_referenced_assets(s), &["bg.jpg"]);
    }

    #[test]
    fn rejects_external_and_traversal() {
        let s = r#"
![](https://example.com/a.png)
![](data:image/png;base64,xx)
![](/absolute/path.png)
![](../parent.png)
![](#anchor)
![](valid.png)
"#;
        assert_set(extract_referenced_assets(s), &["valid.png"]);
    }

    #[test]
    fn strips_query_and_fragment() {
        let s = "![](pic.png?v=2#frag)";
        assert_set(extract_referenced_assets(s), &["pic.png"]);
    }

    #[test]
    fn dot_slash_normalized() {
        let s = "![](./pic.png)";
        assert_set(extract_referenced_assets(s), &["pic.png"]);
    }

    #[test]
    fn percent_encoded_relative_asset_is_allowlisted_decoded() {
        let s = "![](pic%20with%20space.png)";
        assert_set(extract_referenced_assets(s), &["pic with space.png"]);
    }

    #[test]
    fn raw_local_image_path_with_spaces_renders_as_image() {
        let md = "![alt](pic with space.png)";
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        assert!(
            html.contains(r#"<img src="pic%20with%20space.png" alt="alt" />"#),
            "html: {html}"
        );
    }

    #[test]
    fn raw_local_image_path_with_spaces_preserves_title() {
        let md = r#"![alt](pic with space.png "title.png")"#;
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        assert!(
            html.contains(r#"<img src="pic%20with%20space.png" alt="alt" title="title.png" />"#),
            "html: {html}"
        );
    }

    #[test]
    fn raw_local_svg_path_with_spaces_renders_as_image() {
        let md = "![vector](icon art.svg)";
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        assert!(
            html.contains(r#"<img src="icon%20art.svg" alt="vector" />"#),
            "html: {html}"
        );
    }

    fn render_html_only(md: &str) -> String {
        MarkdownRenderer::new("light").render(md).0
    }

    #[test]
    fn raw_html_strips_event_handlers() {
        let html = render_html_only("<img src=x onerror=\"alert(1)\">");
        assert!(!html.contains("onerror"), "html: {html}");
        assert!(html.contains(r#"<img src="x">"#), "html: {html}");
    }

    #[test]
    fn raw_html_escapes_disallowed_tags() {
        let html = render_html_only("<script>alert(1)</script>");
        assert!(!html.contains("<script"), "html: {html}");
        assert!(html.contains("&lt;script&gt;"), "html: {html}");

        let iframe = render_html_only("<iframe src=\"http://evil\"></iframe>");
        assert!(!iframe.contains("<iframe"), "html: {iframe}");
    }

    #[test]
    fn raw_html_preserves_split_inline_html() {
        // The parser hands `<details>` and `</details>` as separate fragments;
        // the non-rebalancing scrubber must keep both so the widget still works.
        let html = render_html_only("<details>\n<summary>more</summary>\n\nbody\n\n</details>");
        assert!(html.contains("<details>"), "html: {html}");
        assert!(html.contains("<summary>"), "html: {html}");
        assert!(html.contains("</details>"), "html: {html}");
        assert!(render_html_only("press <kbd>Ctrl</kbd>").contains("<kbd>"));
    }

    #[test]
    fn raw_html_link_javascript_scheme_dropped() {
        let html = render_html_only("<a href=\"javascript:alert(1)\">click</a>");
        assert!(!html.contains("javascript:"), "html: {html}");
        // The tag survives (inert), just without the dangerous href.
        assert!(
            html.contains("<a>") || html.contains("<a >"),
            "html: {html}"
        );
    }

    #[test]
    fn markdown_link_and_image_scheme_whitelist() {
        // A javascript: link must never become a clickable href. (supramark
        // itself refuses to parse it as a link; the Link-node check is the
        // backstop if that ever changes.)
        let link = render_html_only("[click](javascript:alert(1))");
        assert!(!link.contains("href=\"javascript:"), "html: {link}");

        // data:image is allowed for images (embedded images are common).
        let img = render_html_only("![x](data:image/png;base64,iVBORw0KGgo=)");
        assert!(img.contains("src=\"data:image/png"), "html: {img}");

        // A data: URL must never surface as an <a href> or non-image <img src>.
        let bad = render_html_only("[x](data:text/html,<b>hi</b>)");
        assert!(!bad.contains("href=\"data:"), "html: {bad}");
    }

    #[test]
    fn url_scheme_is_safe_allows_benign_and_blocks_dangerous() {
        for ok in [
            "http://a",
            "https://a/b?c#d",
            "mailto:a@b",
            "tel:+1",
            "/rel/path",
            "relative",
            "#anchor",
            "//protocol-relative/x",
            "12:30",
        ] {
            assert!(url_scheme_is_safe(ok, false), "should allow: {ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "  javascript:alert(1)",
            "java\tscript:alert(1)",
            "jav&#x61;script:alert(1)",
            "vbscript:msgbox(1)",
            "data:text/html,<script>",
            "data:image/png,x", // data blocked when images aren't allowed
        ] {
            assert!(!url_scheme_is_safe(bad, false), "should block: {bad}");
        }
        // data:image only when the image context opts in.
        assert!(url_scheme_is_safe("data:image/png;base64,AAAA", true));
        assert!(!url_scheme_is_safe("data:text/html,x", true));
    }

    #[test]
    fn sanitize_fragment_unit_cases() {
        assert_eq!(sanitize_raw_html_fragment("<details>"), "<details>");
        assert_eq!(sanitize_raw_html_fragment("</details>"), "</details>");
        assert_eq!(sanitize_raw_html_fragment("<kbd>"), "<kbd>");
        assert_eq!(sanitize_raw_html_fragment("<script>"), "&lt;script&gt;");
        assert_eq!(sanitize_raw_html_fragment("<!-- secret -->"), "");
        assert_eq!(
            sanitize_raw_html_fragment("<img src=x onerror=alert(1)>"),
            r#"<img src="x">"#
        );
        assert_eq!(
            sanitize_raw_html_fragment("<a href=\"javascript:x\">"),
            "<a>"
        );
        // A lone '<' that isn't a tag is escaped, not passed through.
        assert_eq!(sanitize_raw_html_fragment("a < b"), "a &lt; b");
    }

    #[test]
    fn windows_absolute_image_path_normalizes_markdown_escapes() {
        let normalized = normalize_local_image_destinations(
            r"![drive](C:\Users\leo\.tmp\pic.png) ![wrapped](<C:\Users\leo\.tmp\pic.png>) ![unc](\\server\share\pic.png)",
        );
        assert!(
            normalized.contains(r"![drive](<C:/Users/leo/.tmp/pic.png>)"),
            "normalized: {normalized}"
        );
        assert!(
            normalized.contains(r"![wrapped](<C:/Users/leo/.tmp/pic.png>)"),
            "normalized: {normalized}"
        );
        assert!(
            normalized.contains(r"![unc](<%5C%5Cserver%5Cshare%5Cpic.png>)"),
            "normalized: {normalized}"
        );
    }

    #[test]
    fn windows_absolute_asset_refs_never_fall_back_to_relative() {
        assert!(sanitize_asset_ref(r"C:\Users\leo\secret.png").is_none());
        assert!(sanitize_asset_ref("C:/Users/leo/secret.png").is_none());
        assert!(sanitize_asset_ref(r"%5C%5Cserver%5Cshare%5Csecret.png").is_none());
    }

    #[test]
    fn raw_local_image_path_normalization_skips_inline_code() {
        let md = "`![alt](pic with space.png)`";
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        assert!(!html.contains("<img"), "html: {html}");
        assert!(html.contains("pic with space.png"), "html: {html}");
    }

    #[test]
    fn raw_local_image_path_normalization_skips_fenced_code() {
        let md = "```\n![alt](pic with space.png)\n```\n";
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        assert!(!html.contains("<img"), "html: {html}");
        assert!(html.contains("pic with space.png"), "html: {html}");
    }

    #[test]
    fn workspace_absolute_image_path_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let image = root.join("assets/pic with space.png");
        std::fs::write(&image, b"png").unwrap();
        let doc = root.join("note.md");
        std::fs::write(&doc, "# note").unwrap();

        let renderer = MarkdownRenderer::new("light").with_asset_context("wsid", &doc, &root);
        let md = format!("![alt](<{}>)", image.to_string_lossy());
        let output = MarkdownEngine::render(&renderer, &md);

        assert!(
            output
                .html
                .contains(r#"<img src="/wsid/assets/pic%20with%20space.png" alt="alt" />"#),
            "html: {}",
            output.html
        );
        assert!(output
            .referenced_assets
            .contains("assets/pic with space.png"));
    }

    #[test]
    fn workspace_root_absolute_image_path_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/pic.png"), b"png").unwrap();
        let doc = root.join("note.md");
        std::fs::write(&doc, "# note").unwrap();

        let renderer = MarkdownRenderer::new("light").with_asset_context("wsid", &doc, &root);
        let output = MarkdownEngine::render(&renderer, "![alt](/assets/pic.png)");

        assert!(
            output
                .html
                .contains(r#"<img src="/wsid/assets/pic.png" alt="alt" />"#),
            "html: {}",
            output.html
        );
        assert!(output.referenced_assets.contains("assets/pic.png"));
    }

    #[test]
    fn workspace_external_absolute_image_path_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), b"png").unwrap();
        let doc = root.join("note.md");
        std::fs::write(&doc, "# note").unwrap();

        let renderer = MarkdownRenderer::new("light").with_asset_context("wsid", &doc, &root);
        let md = format!("![alt]({})", outside.path().to_string_lossy());
        let output = MarkdownEngine::render(&renderer, &md);

        assert!(
            !output.html.contains(r#"src="/wsid/"#),
            "html: {}",
            output.html
        );
        assert!(output.referenced_assets.is_empty());
    }

    #[test]
    fn anchor_href_is_not_an_asset() {
        // href on <a> is navigation, not an asset to allowlist.
        let s = r#"<a href="other.md">x</a>"#;
        assert_set(extract_referenced_assets(s), &[]);
    }

    #[test]
    fn code_blocks_emit_css_classes_not_inline_colors() {
        let md = "```rust\nfn main() { let x = 1; }\n```\n";
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(md);
        // Class-based output, namespaced with the `mk-` prefix.
        assert!(
            html.contains("<pre><code class=\"mk-code\">"),
            "html: {html}"
        );
        assert!(
            html.contains("mk-keyword") || html.contains("mk-storage"),
            "html: {html}"
        );
        // No inline colors — the palette is entirely CSS/token driven.
        assert!(
            !html.contains("style=\"color"),
            "unexpected inline color: {html}"
        );
    }

    fn assert_proto_highlighted(fence_lang: &str) {
        let md = format!(
            "```{fence_lang}\n\
             // a leading comment\n\
             syntax = \"proto3\";\n\
             message Person {{\n\
             \x20 string name = 1;\n\
             \x20 int32 id = 2;\n\
             \x20 repeated string emails = 3;\n\
             }}\n\
             ```\n"
        );
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(&md);
        // Must be a highlighted code block, not a single plain <code> dump.
        assert!(
            html.contains("<pre><code class=\"mk-code\">"),
            "fence `{fence_lang}` not rendered as a code block: {html}"
        );
        // Proto keywords/types/comments must be wrapped in mk-* spans, proving
        // two-face's "Protocol Buffer" grammar matched (otherwise plain text).
        assert!(
            html.contains("mk-comment"),
            "fence `{fence_lang}` missing mk-comment span: {html}"
        );
        assert!(
            html.contains("mk-keyword") || html.contains("mk-storage"),
            "fence `{fence_lang}` missing mk-keyword/mk-storage span: {html}"
        );
        // No inline colors — palette is CSS/token driven.
        assert!(
            !html.contains("style=\"color"),
            "fence `{fence_lang}` unexpected inline color: {html}"
        );
    }

    fn first_svg_tag(html: &str) -> &str {
        let start = html.find("<svg").expect("first svg start");
        let end = html[start..].find('>').expect("first svg end");
        &html[start..start + end + 1]
    }

    #[test]
    fn protobuf_fence_is_highlighted() {
        assert_proto_highlighted("protobuf");
    }

    #[test]
    fn proto_fence_is_highlighted() {
        assert_proto_highlighted("proto");
    }

    /// Render a fenced block in `lang` and assert it became a class-based,
    /// highlighted code block (not a plain dump and not inline-coloured). At
    /// least one of the supplied highlight classes must be present.
    fn assert_lang_highlighted(lang: &str, code: &str, expect_classes: &[&str]) {
        let md = format!("```{lang}\n{code}\n```\n");
        let (html, _has_mermaid, _toc) = MarkdownRenderer::new("light").render(&md);
        assert!(
            html.contains("<pre><code class=\"mk-code\">"),
            "fence `{lang}` not rendered as a code block: {html}"
        );
        assert!(
            expect_classes.iter().any(|c| html.contains(c)),
            "fence `{lang}` missing any of {expect_classes:?}: {html}"
        );
        assert!(
            !html.contains("style=\"color"),
            "fence `{lang}` unexpected inline color: {html}"
        );
    }

    #[test]
    fn typescript_fence_is_highlighted() {
        assert_lang_highlighted(
            "typescript",
            "// c\nconst x: string = \"hi\";\nfunction f() {}",
            &["mk-keyword", "mk-storage", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn tsx_fence_is_highlighted() {
        assert_lang_highlighted(
            "tsx",
            "// c\nconst App = () => <div className=\"a\">hi</div>;",
            &["mk-keyword", "mk-storage", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn kotlin_fence_is_highlighted() {
        assert_lang_highlighted(
            "kotlin",
            "// c\nfun main() { val s = \"hi\" }",
            &["mk-keyword", "mk-storage", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn swift_fence_is_highlighted() {
        assert_lang_highlighted(
            "swift",
            "// c\nlet s = \"hi\"\nfunc f() {}",
            &["mk-keyword", "mk-storage", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn toml_fence_is_highlighted() {
        assert_lang_highlighted(
            "toml",
            "# c\nname = \"markon\"\n[deps]",
            &["mk-string", "mk-comment", "mk-keyword"],
        );
    }

    #[test]
    fn dockerfile_fence_is_highlighted() {
        assert_lang_highlighted(
            "dockerfile",
            "# c\nFROM rust:1 AS build\nRUN echo hi",
            &["mk-keyword", "mk-comment"],
        );
    }

    #[test]
    fn graphql_fence_is_highlighted() {
        assert_lang_highlighted(
            "graphql",
            "# c\ntype Query { name: String }",
            &["mk-keyword", "mk-comment", "mk-support"],
        );
    }

    #[test]
    fn powershell_fence_is_highlighted() {
        assert_lang_highlighted(
            "powershell",
            "# c\n$x = \"hi\"\nWrite-Host $x",
            &["mk-keyword", "mk-string", "mk-comment", "mk-variable"],
        );
    }

    #[test]
    fn elixir_fence_is_highlighted() {
        assert_lang_highlighted(
            "elixir",
            "# c\ndef hello do\n  \"world\"\nend",
            &["mk-keyword", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn zig_fence_is_highlighted() {
        assert_lang_highlighted(
            "zig",
            "// c\nconst std = @import(\"std\");\npub fn main() void {}",
            &["mk-keyword", "mk-storage", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn fsharp_fence_resolves_via_alias() {
        // `fsharp` is not a native token; the alias map maps it to `f#`.
        assert_lang_highlighted(
            "fsharp",
            "// c\nlet x = \"hi\"\nlet add a b = a + b",
            &["mk-keyword", "mk-string", "mk-comment"],
        );
    }

    #[test]
    fn code_highlight_is_theme_independent() {
        // `new()` ignores the theme now; light and dark render identical markup
        // (colours come from CSS tokens that switch via data-theme).
        let md = "```js\nconst a = 'hi';\n```\n";
        let light = MarkdownRenderer::new("light").render(md).0;
        let dark = MarkdownRenderer::new("dark").render(md).0;
        assert_eq!(light, dark);
    }

    #[test]
    fn supramark_renderer_preserves_markon_render_contract() {
        let md = "# Title\n\n![Alt](pic.png)\n\n```mermaid\ngraph TD\nA-->B\n```\n";
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(&renderer, md);

        assert!(
            output.html.contains("class=\"heading-section\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("<h1 id=\"title\">Title</h1>"),
            "html: {}",
            output.html
        );
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-mermaid\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-diagram-engine=\"mermaid\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        assert!(
            !output.has_mermaid,
            "Mermaid is rendered server-side and should not request client JS"
        );
        assert_eq!(output.toc.len(), 1);
        assert_eq!(output.toc[0].text, "Title");
        assert!(output.referenced_assets.contains("pic.png"));
        assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    }

    #[test]
    fn supramark_renderer_marks_math_for_katex() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            "Inline $E = mc^2$.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n",
        );

        assert!(output.has_math, "html: {}", output.html);
        assert!(
            output
                .html
                .contains("class=\"math math-inline\" data-math-display=\"false\""),
            "html: {}",
            output.html
        );
        assert!(
            output
                .html
                .contains("class=\"math math-block\" data-math-display=\"true\""),
            "html: {}",
            output.html
        );
        assert!(
            !output.html.contains("<pre><code class=\"math"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_plantuml_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            "```plantuml\n@startuml\nactor User\nUser -> Markon: open workspace\n@enduml\n```\n",
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-plantuml\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        let svg_tag = first_svg_tag(&output.html);
        assert!(svg_tag.contains("width=\""), "svg tag: {svg_tag}");
        assert!(svg_tag.contains("height=\""), "svg tag: {svg_tag}");
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_d2_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            "```d2\nworkspace: Workspace\nmarkdown: Markdown files\nworkspace -> markdown\n```\n",
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-d2\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        let svg_tag = first_svg_tag(&output.html);
        assert!(svg_tag.contains("width=\""), "svg tag: {svg_tag}");
        assert!(svg_tag.contains("height=\""), "svg tag: {svg_tag}");
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_dot_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            "```dot\ndigraph Workspace {\n  Readme -> Diagrams;\n}\n```\n",
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-dot\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_vega_lite_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            r#"```vega-lite
{
  "data": {"values": [{"area": "Rendering", "score": 35}, {"area": "Search", "score": 20}]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "area", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```
"#,
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-vega-lite\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-diagram-engine=\"vega-lite\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_echarts_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            r#"```echarts
{
  "xAxis": {"type": "category", "data": ["Render", "Search", "Edit"]},
  "yAxis": {"type": "value"},
  "series": [{"type": "line", "data": [35, 20, 25]}]
}
```
"#,
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-echarts\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-diagram-engine=\"echarts\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_chartjs_diagram() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            r#"```chartjs
{
  "type": "doughnut",
  "data": {
    "labels": ["Markdown", "Workspace", "Review"],
    "datasets": [{"data": [40, 35, 25]}]
  }
}
```
"#,
        );

        assert!(!output.has_mermaid);
        assert!(
            output
                .html
                .contains("class=\"markon-diagram markon-diagram-chartjs\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-diagram-engine=\"chartjs\""),
            "html: {}",
            output.html
        );
        assert!(output.html.contains("<svg"), "html: {}", output.html);
        assert!(
            !output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_renders_diagram_aliases() {
        let renderer = MarkdownRenderer::new("light");
        let cases = [
            (
                "graphviz",
                "```graphviz\ndigraph Alias { A -> B; }\n```\n".to_string(),
            ),
            (
                "dot",
                "```dot\ndigraph Alias { A -> B; }\n```\n".to_string(),
            ),
        ];

        for (engine, source) in cases {
            let output = super::MarkdownEngine::render(&renderer, &source);
            assert!(!output.has_mermaid);
            assert!(
                output
                    .html
                    .contains(&format!("data-diagram-engine=\"{engine}\"")),
                "engine {engine} html: {}",
                output.html
            );
            assert!(output.html.contains("<svg"), "html: {}", output.html);
            assert!(
                !output.html.contains("Unsupported diagram engine"),
                "engine {engine} html: {}",
                output.html
            );
        }
    }

    #[test]
    fn supramark_renderer_renders_chart_aliases() {
        let renderer = MarkdownRenderer::new("light");
        let cases = [
            (
                "vega",
                r#"```vega
{
  "data": {"values": [{"stage": "Draft", "score": 12}, {"stage": "Review", "score": 28}]},
  "mark": "line",
  "encoding": {
    "x": {"field": "stage", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```
"#
                .to_string(),
            ),
            (
                "chart",
                r#"```chart
{
  "data": {"values": [{"item": "A", "score": 8}, {"item": "B", "score": 14}]},
  "mark": "point",
  "encoding": {
    "x": {"field": "item", "type": "nominal"},
    "y": {"field": "score", "type": "quantitative"}
  }
}
```
"#
                .to_string(),
            ),
            (
                "chartjs",
                r#"```chartjs
{
  "type": "line",
  "data": {
    "labels": ["Draft", "Review"],
    "datasets": [{"label": "Readiness", "data": [72, 91]}]
  }
}
```
"#
                .to_string(),
            ),
            (
                "chart.js",
                r#"```chart.js
{
  "type": "line",
  "data": {
    "labels": ["Draft", "Review"],
    "datasets": [{"label": "Readiness", "data": [72, 91]}]
  }
}
```
"#
                .to_string(),
            ),
        ];

        for (engine, source) in cases {
            let output = super::MarkdownEngine::render(&renderer, &source);
            assert!(!output.has_mermaid);
            assert!(
                output
                    .html
                    .contains(&format!("data-diagram-engine=\"{engine}\"")),
                "engine {engine} html: {}",
                output.html
            );
            assert!(
                output.html.contains("<svg"),
                "engine {engine} html: {}",
                output.html
            );
            assert!(
                !output.html.contains("Unsupported diagram engine"),
                "engine {engine} html: {}",
                output.html
            );
        }
    }

    #[test]
    fn supramark_renderer_labels_unsupported_diagram_fallback() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(&renderer, "```echarts\n{}\n```\n");

        assert!(!output.has_mermaid);
        assert!(
            output.html.contains("class=\"markon-source-fallback\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("Diagram render failed"),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-fallback-name=\"echarts\""),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_labels_unsupported_diagram_code_fence() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(
            &renderer,
            "```plotly\n{\"data\":[{\"type\":\"bar\",\"x\":[\"A\"],\"y\":[1]}]}\n```\n",
        );

        assert!(!output.has_mermaid);
        assert!(
            output.html.contains("class=\"markon-source-fallback\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("Unsupported diagram engine"),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-fallback-name=\"plotly\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("Showing source"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_keeps_plain_code_fences_as_code() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(&renderer, "```json\n{\"ok\":true}\n```\n");

        assert!(!output.has_mermaid);
        assert!(output.html.contains("<pre><code"), "html: {}", output.html);
        assert!(
            !output.html.contains("markon-source-fallback"),
            "html: {}",
            output.html
        );
        assert!(
            !output.html.contains("data-diagram-engine"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_labels_opaque_extension_fallback() {
        let renderer = MarkdownRenderer::new("light");
        let output =
            super::MarkdownEngine::render(&renderer, ":::map\ncenter: [37.7749, -122.4194]\n:::\n");

        assert!(
            output.html.contains("Unsupported Supramark extension"),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("data-fallback-name=\"map\""),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_reports_parser_diagnostics_once() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(&renderer, ":::map\ncenter: [0, 0]\n");
        let diagnostics = output
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "unclosed_extension_block")
            .collect::<Vec<_>>();

        assert_eq!(diagnostics.len(), 1, "{:?}", output.diagnostics);
        assert_eq!(diagnostics[0].severity, "error");
        assert_eq!(diagnostics[0].line, Some(1));
    }

    #[test]
    fn supramark_renderer_preserves_raw_html_shape() {
        let renderer = MarkdownRenderer::new("light");

        let inline = super::MarkdownEngine::render(&renderer, "text <span>x</span> y\n");
        assert!(
            inline.html.contains("<p>text <span>x</span> y</p>"),
            "html: {}",
            inline.html
        );

        let block = super::MarkdownEngine::render(&renderer, "<div>\n  <p>x</p>\n</div>\n");
        assert!(
            block.html.contains("<div>\n  <p>x</p>\n</div>"),
            "html: {}",
            block.html
        );
    }

    #[test]
    fn supramark_renderer_uses_normalized_footnote_identifier() {
        let renderer = MarkdownRenderer::new("light");
        let output =
            super::MarkdownEngine::render(&renderer, "Text[^My Note].\n\n[^my  note]: Body.");

        assert!(
            output.html.contains("<a href=\"#fn-my note\">1</a></sup>"),
            "html: {}",
            output.html
        );
        assert!(
            output
                .html
                .contains("<div class=\"footnote-definition\" id=\"fn-my note\">"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn supramark_renderer_builds_heading_sections_and_toc_from_ast() {
        let renderer = MarkdownRenderer::new("light");
        let output = super::MarkdownEngine::render(&renderer, "# Same\n\n## Same\n\n# Same\n");

        assert!(
            output.html.contains("<h1 id=\"same\">Same</h1>"),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("<h2 id=\"same-1\">Same</h2>"),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("<h1 id=\"same-2\">Same</h1>"),
            "html: {}",
            output.html
        );
        assert_eq!(
            output
                .toc
                .iter()
                .map(|item| (item.level, item.id.as_str(), item.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1, "same", "Same"),
                (2, "same-1", "Same"),
                (1, "same-2", "Same")
            ]
        );
    }

    #[test]
    fn supramark_renderer_builds_github_alerts_from_ast() {
        let renderer = MarkdownRenderer::new("light");
        let output =
            super::MarkdownEngine::render(&renderer, "> [!WARNING]\n> **Careful**\n\n> Plain\n");

        assert!(
            output
                .html
                .contains("class=\"markdown-alert markdown-alert-warning\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("class=\"markdown-alert-title\""),
            "html: {}",
            output.html
        );
        assert!(
            output.html.contains("<strong>Careful</strong>"),
            "html: {}",
            output.html
        );
        assert!(
            !output.html.contains("<blockquote>\n<p>[!WARNING]"),
            "html: {}",
            output.html
        );
        assert!(
            output
                .html
                .contains("<blockquote>\n<p>Plain</p>\n</blockquote>"),
            "html: {}",
            output.html
        );
    }

    #[test]
    fn default_engine_is_supramark() {
        let renderer = super::default_markdown_engine("light");
        let output = super::MarkdownEngine::render(&renderer, ":::map\ncenter: [0, 0]\n");

        assert!(
            output
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unclosed_extension_block"),
            "{:?}",
            output.diagnostics
        );
    }
}
