use lazy_static::lazy_static;
use regex::Regex;
use std::borrow::Cow;
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
/// Used by single-file workspaces to allowlist co-located images and stylesheets
/// the document needs (so `![](pic.png)` still loads), while keeping every other
/// sibling file 404. Only same-directory or descendant relative paths are kept;
/// absolute URLs (`http://`, `data:`, …), parent-traversing (`../…`), and
/// anchor-only fragments are filtered out.
pub(crate) fn extract_referenced_assets(markdown: &str) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut out: HashSet<String> = HashSet::new();

    let ast = supramark_markdown::parse(markdown);
    collect_supramark_assets(&ast, &mut out);
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
    if trimmed.contains("://") || trimmed.starts_with("data:") || trimmed.starts_with("mailto:") {
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
    // Reject any segment that escapes upward.
    if path.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return None;
    }
    let stripped = path.strip_prefix("./").unwrap_or(path);
    Some(stripped.to_string())
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

pub(crate) struct MarkdownRenderer;

impl MarkdownRenderer {
    /// `_theme` is accepted for API compatibility but no longer affects
    /// highlighting: code is emitted as CSS classes (see
    /// `highlight_code_to_classed_html`) and coloured by the `--markon-code-*`
    /// design tokens, which switch with the page's `data-theme`.
    pub(crate) fn new(_theme: &str) -> Self {
        Self
    }

    #[cfg(test)]
    pub(crate) fn render(&self, markdown: &str) -> (String, bool, Vec<TocItem>) {
        let output = MarkdownEngine::render(self, markdown);
        (output.html, output.has_mermaid, output.toc)
    }
}

impl MarkdownHtmlRenderer for MarkdownRenderer {
    fn render_html(&self, markdown: &str) -> MarkdownHtmlOutput {
        let ast = supramark_markdown::parse(markdown);
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
        extract_referenced_assets(markdown)
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
                out.push_str("<a href=\"");
                html_escape::encode_double_quoted_attribute_to_string(url, out);
                out.push('"');
                if let Some(title) = title {
                    out.push_str(" title=\"");
                    html_escape::encode_double_quoted_attribute_to_string(title, out);
                    out.push('"');
                }
                out.push('>');
                self.render_nodes(children, out, ctx);
                out.push_str("</a>");
            }
            SupramarkNode::Image {
                url, title, alt, ..
            } => {
                out.push_str("<img src=\"");
                html_escape::encode_double_quoted_attribute_to_string(url, out);
                out.push_str("\" alt=\"");
                html_escape::encode_double_quoted_attribute_to_string(alt, out);
                out.push('"');
                if let Some(title) = title {
                    out.push_str(" title=\"");
                    html_escape::encode_double_quoted_attribute_to_string(title, out);
                    out.push('"');
                }
                out.push_str(" />");
            }
            SupramarkNode::Break { .. } => out.push_str("<br />\n"),
            SupramarkNode::Delete { children, .. } => {
                out.push_str("<del>");
                self.render_nodes(children, out, ctx);
                out.push_str("</del>");
            }
            SupramarkNode::Code { value, lang, .. } => {
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
                    out.push_str(value);
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

fn collect_supramark_assets(
    node: &supramark_markdown::SupramarkNode,
    out: &mut std::collections::HashSet<String>,
) {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Image { url, .. } => {
            if let Some(rel) = sanitize_asset_ref(url) {
                out.insert(rel);
            }
        }
        SupramarkNode::Raw { value, .. } => collect_from_html(value, out),
        _ => {}
    }
    if let Some(children) = supramark_children(node) {
        for child in children {
            collect_supramark_assets(child, out);
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
    use super::extract_referenced_assets;
    use super::MarkdownRenderer;

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
            assert!(output.html.contains("<svg"), "html: {}", output.html);
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
        let output = super::MarkdownEngine::render(&renderer, "```plotly\n{}\n```\n");

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
