use pulldown_cmark::{html, Options, Parser, Event, Tag, CodeBlockKind, CowStr, TagEnd};
use syntect::easy::HighlightLines;
use syntect::highlighting::{ThemeSet, Style};
use syntect::html::{styled_line_to_highlighted_html, IncludeBackground};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

pub fn to_html(markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let ss = SyntaxSet::load_defaults_newlines();
    let ts = ThemeSet::load_defaults();
    let theme = &ts.themes["base16-ocean.dark"];

    let parser = Parser::new_ext(markdown, options);
    let mut new_events = Vec::new();
    let mut in_code_block = false;
    let mut lang = String::new();
    let mut code_buffer = String::new();

    for event in parser {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(fence_lang))) => {
                in_code_block = true;
                lang = fence_lang.to_string();
            }
            Event::Text(text) if in_code_block => {
                code_buffer.push_str(&text);
            }
            Event::End(TagEnd::CodeBlock) => {
                if in_code_block {
                    let syntax = ss.find_syntax_by_extension(&lang)
                                   .unwrap_or_else(|| ss.find_syntax_plain_text());
                    let mut highlighter = HighlightLines::new(syntax, theme);

                    let mut highlighted_html = String::from("<pre><code>");
                    for line in LinesWithEndings::from(&code_buffer) {
                        let ranges: Vec<(Style, &str)> = highlighter.highlight_line(line, &ss).unwrap();
                        let escaped = styled_line_to_highlighted_html(&ranges[..], IncludeBackground::No).unwrap();
                        highlighted_html.push_str(&escaped);
                    }
                    highlighted_html.push_str("</code></pre>");
                    new_events.push(Event::Html(CowStr::from(highlighted_html)));

                    // Reset state
                    in_code_block = false;
                    code_buffer.clear();
                    lang.clear();
                } else {
                    new_events.push(Event::End(TagEnd::CodeBlock));
                }
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
    html_output
}
