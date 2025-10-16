use lazy_static::lazy_static;
use pulldown_cmark::{html, CodeBlockKind, CowStr, Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::html::{styled_line_to_highlighted_html, IncludeBackground};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

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
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TocItem {
    pub level: u8,
    pub id: String,
    pub text: String,
}

pub struct MarkdownRenderer {
    theme: String,
}

impl MarkdownRenderer {
    pub fn new(theme: &str) -> Self {
        Self {
            theme: theme.to_string(),
        }
    }

    pub fn render(&self, markdown: &str) -> (String, bool, Vec<TocItem>) {
        let mut options = Options::empty();
        options.insert(Options::ENABLE_TABLES);
        options.insert(Options::ENABLE_FOOTNOTES);
        options.insert(Options::ENABLE_STRIKETHROUGH);
        options.insert(Options::ENABLE_TASKLISTS);
        options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

        let ss = SyntaxSet::load_defaults_newlines();
        let ts = ThemeSet::load_defaults();

        // 根据主题选择代码高亮样式
        let theme_name = match self.theme.as_str() {
            "light" => "InspiredGitHub",
            "dark" => "base16-ocean.dark",
            _ => "base16-ocean.dark", // auto 默认深色
        };
        let theme = &ts.themes[theme_name];

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
                        // 检查是否是 Mermaid 图表
                        if code_lang.to_lowercase() == "mermaid" {
                            has_mermaid = true;
                            let mermaid_html = format!(
                                "<pre class=\"mermaid\">{}</pre>",
                                html_escape::encode_text(&code_buffer)
                            );
                            new_events.push(Event::Html(CowStr::from(mermaid_html)));
                        } else {
                            // 普通代码块，进行语法高亮
                            let syntax = ss
                                .find_syntax_by_extension(&code_lang)
                                .unwrap_or_else(|| ss.find_syntax_plain_text());
                            let mut highlighter = HighlightLines::new(syntax, theme);

                            let mut highlighted_html = String::from("<pre><code>");
                            for line in LinesWithEndings::from(&code_buffer) {
                                match highlighter.highlight_line(line, &ss) {
                                    Ok(ranges) => {
                                        match styled_line_to_highlighted_html(
                                            &ranges[..],
                                            IncludeBackground::No,
                                        ) {
                                            Ok(escaped) => highlighted_html.push_str(&escaped),
                                            Err(_) => highlighted_html
                                                .push_str(&html_escape::encode_text(line)),
                                        }
                                    }
                                    Err(_) => {
                                        highlighted_html.push_str(&html_escape::encode_text(line))
                                    }
                                }
                            }
                            highlighted_html.push_str("</code></pre>");
                            new_events.push(Event::Html(CowStr::from(highlighted_html)));
                        }

                        // 重置状态
                        in_code_block = false;
                        code_buffer.clear();
                        code_lang.clear();
                    } else {
                        new_events.push(Event::End(TagEnd::CodeBlock));
                    }
                }
                Event::Text(text) if !in_code_block => {
                    // 替换 emoji shortcodes
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

        // 处理 GitHub Alerts
        let html_output = self.process_github_alerts(&html_output);

        // 为标题添加 ID 属性并提取目录
        let (html_output, toc) = self.add_heading_ids_and_extract_toc(&html_output);

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

                    // 组合内容
                    let content = if remaining.trim().is_empty() {
                        first_line.to_string()
                    } else {
                        format!("{first_line}{remaining}")
                    };

                    // 生成对应的 alert HTML
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

                // 使用 emojis crate 查找 emoji
                if let Some(emoji) = emojis::get_by_shortcode(shortcode) {
                    emoji.as_str().to_string()
                } else {
                    // 如果找不到，保留原始文本
                    caps[0].to_string()
                }
            })
            .to_string()
    }

    fn add_heading_ids_and_extract_toc(&self, html: &str) -> (String, Vec<TocItem>) {
        let mut toc = Vec::new();

        let result = HEADING_REGEX
            .replace_all(html, |caps: &regex::Captures| {
                if let (Some(tag), Some(content)) = (caps.get(1), caps.get(2)) {
                    let tag = tag.as_str();
                    let content = content.as_str();
                    let id = self.generate_slug(content);

                    // Extract heading level (h1 -> 1, h2 -> 2, etc.)
                    let level = tag.chars().nth(1).and_then(|c| c.to_digit(10)).unwrap_or(1) as u8;

                    // Remove HTML tags from content for TOC
                    let text = HTML_TAG_REGEX.replace_all(content, "").to_string();

                    toc.push(TocItem {
                        level,
                        id: id.clone(),
                        text,
                    });

                    format!("<{tag} id=\"{id}\">{content}</{tag}>")
                } else {
                    caps[0].to_string()
                }
            })
            .to_string();

        (result, toc)
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
