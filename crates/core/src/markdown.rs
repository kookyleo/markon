use lazy_static::lazy_static;
use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::{SyntaxDefinition, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

#[derive(Debug)]
struct FenceWarning {
    line: usize,
    outer_start: usize,
    backtick_count: usize,
}

/// Bundled Protocol Buffers (proto2 + proto3) syntax definition. The default
/// syntect set ships no protobuf grammar, so ```protobuf / ```proto fences would
/// otherwise render as plain text. Embedded at compile time and folded into the
/// set at startup.
const PROTOBUF_SYNTAX: &str = include_str!("syntaxes/Protocol Buffer.sublime-syntax");

/// Build the syntax set used for highlighting: the syntect defaults plus the
/// bundled Protocol Buffers grammar. On a parse failure of the (trusted) bundled
/// grammar we fall back to the plain defaults rather than panicking the server.
fn build_syntax_set() -> SyntaxSet {
    let defaults = SyntaxSet::load_defaults_newlines();
    match SyntaxDefinition::load_from_str(PROTOBUF_SYNTAX, true, Some("Protocol Buffer")) {
        Ok(def) => {
            let mut builder = defaults.into_builder();
            builder.add(def);
            builder.build()
        }
        Err(e) => {
            eprintln!("warning: failed to parse bundled Protocol Buffer syntax: {e}");
            SyntaxSet::load_defaults_newlines()
        }
    }
}

lazy_static! {
    static ref EMOJI_REGEX: Regex = Regex::new(r":([a-zA-Z0-9_+-]+):")
        .expect("Failed to compile EMOJI_REGEX");
    static ref ALERT_REGEX: Regex = Regex::new(
        r"(?s)<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*?)</p>(.*?)</blockquote>"
    ).expect("Failed to compile ALERT_REGEX");
    static ref HEADING_REGEX: Regex = Regex::new(r"<(h[1-6])>(.*?)</h[1-6]>")
        .expect("Failed to compile HEADING_REGEX");
    static ref HTML_TAG_REGEX: Regex = Regex::new(r"<[^>]+>")
        .expect("Failed to compile HTML_TAG_REGEX");
    static ref MULTI_HYPHEN_REGEX: Regex = Regex::new(r"-+")
        .expect("Failed to compile MULTI_HYPHEN_REGEX");
    static ref SYNTAX_SET: SyntaxSet = build_syntax_set();
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

    // Markdown image syntax (`![](url)`) via pulldown for accurate semantics.
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(markdown, options);
    for event in parser {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => {
                if let Some(rel) = sanitize_asset_ref(&dest_url) {
                    out.insert(rel);
                }
            }
            Event::Html(s) | Event::InlineHtml(s) => {
                collect_from_html(&s, &mut out);
            }
            _ => {}
        }
    }
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

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct TocItem {
    pub level: u8,
    pub id: String,
    pub text: String,
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

    pub(crate) fn render(&self, markdown: &str) -> (String, bool, Vec<TocItem>) {
        let mut options = Options::empty();
        options.insert(Options::ENABLE_TABLES);
        options.insert(Options::ENABLE_FOOTNOTES);
        options.insert(Options::ENABLE_STRIKETHROUGH);
        options.insert(Options::ENABLE_TASKLISTS);
        options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

        let ss: &SyntaxSet = &SYNTAX_SET;

        let parser = Parser::new_ext(markdown, options);
        let mut new_events = Vec::new();
        let mut in_code_block = false;
        let mut code_lang = String::new();
        let mut code_buffer = String::new();
        let mut has_mermaid = false;

        for event in parser {
            match event {
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(fence_lang))) => {
                    in_code_block = true;
                    code_lang = fence_lang.to_string();
                }
                Event::Text(text) if in_code_block => {
                    code_buffer.push_str(&text);
                }
                Event::End(TagEnd::CodeBlock) => {
                    if in_code_block {
                        // Check if this is a Mermaid diagram
                        if code_lang.to_lowercase() == "mermaid" {
                            has_mermaid = true;
                            let mermaid_html = format!(
                                "<pre class=\"mermaid\">{}</pre>",
                                html_escape::encode_text(&code_buffer)
                            );
                            new_events.push(Event::Html(CowStr::from(mermaid_html)));
                        } else {
                            // Regular code block: emit class-based spans (no
                            // inline colors) so the palette lives in CSS tokens.
                            // `by_token` matches the fence label against both the
                            // language name (`rust`, `python`) and file extension
                            // (`rs`, `py`); `by_extension` alone misses name-only
                            // fences and silently fell back to plain text.
                            let syntax = ss
                                .find_syntax_by_token(&code_lang)
                                .unwrap_or_else(|| ss.find_syntax_plain_text());
                            let inner = highlight_code_to_classed_html(syntax, ss, &code_buffer);
                            let highlighted_html =
                                format!("<pre><code class=\"mk-code\">{inner}</code></pre>");
                            new_events.push(Event::Html(CowStr::from(highlighted_html)));
                        }

                        // Reset state
                        in_code_block = false;
                        code_buffer.clear();
                        code_lang.clear();
                    } else {
                        new_events.push(Event::End(TagEnd::CodeBlock));
                    }
                }
                Event::Text(text) if !in_code_block => {
                    // Replace emoji shortcodes
                    let processed_text = self.replace_emoji_shortcodes(&text);
                    new_events.push(Event::Text(CowStr::from(processed_text)));
                }
                e => {
                    if !in_code_block {
                        new_events.push(e);
                    }
                }
            }
        }

        let mut html_output = String::new();
        html::push_html(&mut html_output, new_events.into_iter());

        // Process GitHub Alerts
        let html_output = self.process_github_alerts(&html_output);

        // Add heading IDs and extract table of contents
        let (html_output, toc) = self.add_heading_ids_and_extract_toc(&html_output);

        // Validate code fences and prepend warnings
        let fence_warnings = Self::detect_fence_issues(markdown);
        let warnings_html = Self::build_fence_warnings_html(&fence_warnings);
        let html_output = if warnings_html.is_empty() {
            html_output
        } else {
            format!("{warnings_html}{html_output}")
        };

        (html_output, has_mermaid, toc)
    }

    fn process_github_alerts(&self, html: &str) -> String {
        ALERT_REGEX
            .replace_all(html, |caps: &regex::Captures| {
                if let (Some(alert_type), Some(first_line), Some(remaining)) =
                    (caps.get(1), caps.get(2), caps.get(3))
                {
                    let alert_type = alert_type.as_str();
                    let first_line = first_line.as_str();
                    let remaining = remaining.as_str();

                    // Combine content
                    let content = if remaining.trim().is_empty() {
                        first_line.to_string()
                    } else {
                        format!("{first_line}{remaining}")
                    };

                    // Generate corresponding alert HTML
                    self.generate_alert_html(alert_type, &content)
                } else {
                    caps[0].to_string()
                }
            })
            .to_string()
    }

    fn generate_alert_html(&self, alert_type: &str, content: &str) -> String {
        let (icon_svg, title) = match alert_type {
            "NOTE" => (
                r#"<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>"#,
                "Note",
            ),
            "TIP" => (
                r#"<svg class="octicon octicon-light-bulb mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>"#,
                "Tip",
            ),
            "IMPORTANT" => (
                r#"<svg class="octicon octicon-report mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>"#,
                "Important",
            ),
            "WARNING" => (
                r#"<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>"#,
                "Warning",
            ),
            "CAUTION" => (
                r#"<svg class="octicon octicon-stop mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>"#,
                "Caution",
            ),
            _ => ("", "Note"),
        };

        let alert_class = alert_type.to_lowercase();

        format!(
            r#"<div class="markdown-alert markdown-alert-{alert_class}">
<p class="markdown-alert-title">
{icon_svg}{title}
</p>
{content}
</div>"#
        )
    }

    fn replace_emoji_shortcodes(&self, text: &str) -> String {
        EMOJI_REGEX
            .replace_all(text, |caps: &regex::Captures| {
                let shortcode = &caps[1];

                // Look up emoji using emojis crate
                if let Some(emoji) = emojis::get_by_shortcode(shortcode) {
                    emoji.as_str().to_string()
                } else {
                    // If not found, keep original text
                    caps[0].to_string()
                }
            })
            .to_string()
    }

    fn add_heading_ids_and_extract_toc(&self, html: &str) -> (String, Vec<TocItem>) {
        let mut toc = Vec::new();
        let mut headings = Vec::new();
        let mut id_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();

        // First pass: collect all headings with their positions
        for caps in HEADING_REGEX.captures_iter(html) {
            if let (Some(tag), Some(content), Some(m)) = (caps.get(1), caps.get(2), caps.get(0)) {
                let tag = tag.as_str();
                let content = content.as_str();
                let level = tag.chars().nth(1).and_then(|c| c.to_digit(10)).unwrap_or(1) as u8;
                let base_id = self.generate_slug(content);
                // Deduplicate: append -1, -2, etc. for repeated headings
                let count = id_counts.entry(base_id.clone()).or_insert(0);
                let id = if *count == 0 {
                    base_id.clone()
                } else {
                    format!("{}-{}", base_id, count)
                };
                *count += 1;
                let text = HTML_TAG_REGEX.replace_all(content, "").to_string();

                toc.push(TocItem {
                    level,
                    id: id.clone(),
                    text,
                });

                headings.push((
                    m.start(),
                    m.end(),
                    level,
                    tag.to_string(),
                    id,
                    content.to_string(),
                ));
            }
        }

        // Second pass: build new HTML with section containers
        let mut result = String::new();
        let mut last_pos = 0;
        let mut open_sections: Vec<u8> = Vec::new();

        for (start, end, level, tag, id, content) in &headings {
            // Add content before this heading
            result.push_str(&html[last_pos..*start]);

            // Close sections that are same or higher level
            while let Some(&last_level) = open_sections.last() {
                if last_level >= *level {
                    result.push_str("</div>");
                    open_sections.pop();
                } else {
                    break;
                }
            }

            // Open new section
            result.push_str(&format!(
                "<div class=\"heading-section\" data-level=\"{level}\">"
            ));
            open_sections.push(*level);

            // Add the heading with ID
            result.push_str(&format!("<{tag} id=\"{id}\">{content}</{tag}>"));

            last_pos = *end;
        }

        // Add remaining content
        result.push_str(&html[last_pos..]);

        // Close all remaining sections
        for _ in open_sections {
            result.push_str("</div>");
        }

        (result, toc)
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
<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>Markdown Warning
</p>
<p>Line {line}: code fence closed prematurely — the code block starting at line {outer} uses {count} backticks, but an inner fence with the same count closes it early. Use {fix} backticks for the outer fence to fix this. <a href="javascript:void(0)" onclick="openEditorAtLine({line})" style="text-decoration:underline;cursor:pointer">Edit line {line}</a></p>
</div>"#,
                line = w.line,
                outer = w.outer_start,
                count = w.backtick_count,
                fix = w.backtick_count + 1,
            ));
        }
        html
    }

    fn generate_slug(&self, text: &str) -> String {
        // Remove HTML tags
        let text = HTML_TAG_REGEX.replace_all(text, "");

        // Convert to lowercase and replace spaces/special chars with hyphens
        let slug = text
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

        // Remove consecutive hyphens
        MULTI_HYPHEN_REGEX.replace_all(&slug, "-").to_string()
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
        // the bundled grammar matched (otherwise it would be plain text).
        assert!(
            html.contains("mk-keyword"),
            "fence `{fence_lang}` missing mk-keyword span: {html}"
        );
        assert!(
            html.contains("mk-storage"),
            "fence `{fence_lang}` missing mk-storage span (scalar types): {html}"
        );
        assert!(
            html.contains("mk-comment"),
            "fence `{fence_lang}` missing mk-comment span: {html}"
        );
        // No inline colors — palette is CSS/token driven.
        assert!(
            !html.contains("style=\"color"),
            "fence `{fence_lang}` unexpected inline color: {html}"
        );
    }

    #[test]
    fn protobuf_fence_is_highlighted() {
        assert_proto_highlighted("protobuf");
    }

    #[test]
    fn proto_fence_is_highlighted() {
        assert_proto_highlighted("proto");
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
}
