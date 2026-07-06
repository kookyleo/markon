use serde::Serialize;
use sha2::{Digest, Sha256};

const MAX_BLOCK_RENDER_BYTES: usize = 64 * 1024;
const MAX_TEXT_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownAstEngineInfo {
    pub name: &'static str,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownDocumentSummary {
    pub block_count: usize,
    pub diagnostics: Vec<MarkdownAstDiagnostic>,
    pub blocks: Vec<MarkdownBlockSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownBlockSummary {
    pub index: usize,
    pub kind: String,
    pub label: String,
    pub text: String,
    pub source: String,
    pub html: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MarkdownAstDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone)]
pub(crate) struct MarkdownAstError {
    pub message: String,
}

pub(crate) fn engine_info() -> MarkdownAstEngineInfo {
    engine_info_impl()
}

pub(crate) fn summarize_document<F>(
    markdown: &str,
    render_block: F,
) -> Result<MarkdownDocumentSummary, MarkdownAstError>
where
    F: FnMut(&str) -> String,
{
    summarize_document_impl(markdown, render_block)
}

fn engine_info_impl() -> MarkdownAstEngineInfo {
    MarkdownAstEngineInfo {
        name: "supramark-markdown",
        enabled: true,
        message: Some("Default Markdown AST engine"),
    }
}

fn summarize_document_impl<F>(
    markdown: &str,
    mut render_block: F,
) -> Result<MarkdownDocumentSummary, MarkdownAstError>
where
    F: FnMut(&str) -> String,
{
    use supramark_markdown::SupramarkNode;

    let ast = supramark_markdown::parse(markdown);
    let SupramarkNode::Root {
        children,
        diagnostics,
        ..
    } = &ast
    else {
        return Err(MarkdownAstError {
            message: "Supramark returned a non-root AST".to_string(),
        });
    };

    let blocks = children
        .iter()
        .enumerate()
        .map(|(index, node)| summarize_block(markdown, node, index, &mut render_block))
        .collect::<Vec<_>>();

    Ok(MarkdownDocumentSummary {
        block_count: blocks.len(),
        diagnostics: diagnostics.iter().map(summarize_diagnostic).collect(),
        blocks,
    })
}

fn summarize_block<F>(
    source: &str,
    node: &supramark_markdown::SupramarkNode,
    index: usize,
    render_block: &mut F,
) -> MarkdownBlockSummary
where
    F: FnMut(&str) -> String,
{
    let kind = node_kind(node).to_string();
    let label = node_label(node);
    let text = truncate_chars(&plain_text(node), MAX_TEXT_CHARS);
    let position = node_position(node);
    let source_fragment = position.and_then(|p| source_fragment(source, p));
    let source_markdown = source_fragment
        .map(|fragment| truncate_chars(fragment, MAX_TEXT_CHARS))
        .unwrap_or_else(|| text.clone());
    let html = source_fragment
        .map(|fragment| render_fragment(fragment, render_block))
        .unwrap_or_else(|| fallback_html(&text));
    let (start_line, end_line) = position
        .map(|p| (Some(p.start.line), Some(p.end.line)))
        .unwrap_or((None, None));

    MarkdownBlockSummary {
        index,
        kind,
        label,
        text,
        source: source_markdown,
        html,
        start_line,
        end_line,
        digest: block_digest(node_kind(node), &plain_text(node)),
    }
}

fn summarize_diagnostic(diagnostic: &supramark_markdown::Diagnostic) -> MarkdownAstDiagnostic {
    let (start_line, end_line) = diagnostic
        .position
        .as_ref()
        .map(|p| (Some(p.start.line), Some(p.end.line)))
        .unwrap_or((None, None));
    MarkdownAstDiagnostic {
        code: diagnostic.code.clone(),
        severity: format!("{:?}", diagnostic.severity).to_ascii_lowercase(),
        message: diagnostic.message.clone(),
        start_line,
        end_line,
    }
}

fn node_position(
    node: &supramark_markdown::SupramarkNode,
) -> Option<&supramark_markdown::SourcePosition> {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Root { position, .. }
        | SupramarkNode::Paragraph { position, .. }
        | SupramarkNode::Heading { position, .. }
        | SupramarkNode::Text { position, .. }
        | SupramarkNode::Strong { position, .. }
        | SupramarkNode::Emphasis { position, .. }
        | SupramarkNode::InlineCode { position, .. }
        | SupramarkNode::Link { position, .. }
        | SupramarkNode::Image { position, .. }
        | SupramarkNode::Break { position }
        | SupramarkNode::Delete { position, .. }
        | SupramarkNode::Code { position, .. }
        | SupramarkNode::Diagram { position, .. }
        | SupramarkNode::List { position, .. }
        | SupramarkNode::ListItem { position, .. }
        | SupramarkNode::Blockquote { position, .. }
        | SupramarkNode::ThematicBreak { position }
        | SupramarkNode::Table { position, .. }
        | SupramarkNode::TableRow { position, .. }
        | SupramarkNode::TableCell { position, .. }
        | SupramarkNode::MathBlock { position, .. }
        | SupramarkNode::MathInline { position, .. }
        | SupramarkNode::DefinitionList { position, .. }
        | SupramarkNode::DefinitionItem { position, .. }
        | SupramarkNode::DefinitionTerm { position, .. }
        | SupramarkNode::DefinitionDescription { position, .. }
        | SupramarkNode::FootnoteDefinition { position, .. }
        | SupramarkNode::FootnoteReference { position, .. }
        | SupramarkNode::Container { position, .. }
        | SupramarkNode::Input { position, .. }
        | SupramarkNode::Raw { position, .. }
        | SupramarkNode::Unsupported { position, .. } => position.as_ref(),
    }
}

fn node_kind(node: &supramark_markdown::SupramarkNode) -> &'static str {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Root { .. } => "root",
        SupramarkNode::Paragraph { .. } => "paragraph",
        SupramarkNode::Heading { .. } => "heading",
        SupramarkNode::Text { .. } => "text",
        SupramarkNode::Strong { .. } => "strong",
        SupramarkNode::Emphasis { .. } => "emphasis",
        SupramarkNode::InlineCode { .. } => "inline_code",
        SupramarkNode::Link { .. } => "link",
        SupramarkNode::Image { .. } => "image",
        SupramarkNode::Break { .. } => "break",
        SupramarkNode::Delete { .. } => "delete",
        SupramarkNode::Code { .. } => "code",
        SupramarkNode::Diagram { .. } => "diagram",
        SupramarkNode::List { .. } => "list",
        SupramarkNode::ListItem { .. } => "list_item",
        SupramarkNode::Blockquote { .. } => "blockquote",
        SupramarkNode::ThematicBreak { .. } => "thematic_break",
        SupramarkNode::Table { .. } => "table",
        SupramarkNode::TableRow { .. } => "table_row",
        SupramarkNode::TableCell { .. } => "table_cell",
        SupramarkNode::MathBlock { .. } => "math_block",
        SupramarkNode::MathInline { .. } => "math_inline",
        SupramarkNode::DefinitionList { .. } => "definition_list",
        SupramarkNode::DefinitionItem { .. } => "definition_item",
        SupramarkNode::DefinitionTerm { .. } => "definition_term",
        SupramarkNode::DefinitionDescription { .. } => "definition_description",
        SupramarkNode::FootnoteDefinition { .. } => "footnote_definition",
        SupramarkNode::FootnoteReference { .. } => "footnote_reference",
        SupramarkNode::Container { .. } => "container",
        SupramarkNode::Input { .. } => "input",
        SupramarkNode::Raw { .. } => "raw",
        SupramarkNode::Unsupported { .. } => "unsupported",
    }
}

fn node_label(node: &supramark_markdown::SupramarkNode) -> String {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Heading { depth, .. } => format!("H{depth}"),
        SupramarkNode::Code { lang, .. } => lang.clone().unwrap_or_else(|| "code".to_string()),
        SupramarkNode::Diagram { engine, .. } => engine.clone(),
        SupramarkNode::List {
            ordered, children, ..
        } => {
            let marker = if *ordered { "ordered" } else { "bullet" };
            format!("{marker} list, {} items", children.len())
        }
        SupramarkNode::Table { children, .. } => format!("{} rows", children.len()),
        SupramarkNode::MathBlock { .. } => "math".to_string(),
        SupramarkNode::FootnoteDefinition { label, .. } => format!("footnote {label}"),
        SupramarkNode::Container { name, .. } | SupramarkNode::Input { name, .. } => name.clone(),
        SupramarkNode::Raw { format, .. } => format.clone(),
        SupramarkNode::Unsupported { syntax, .. } => syntax.clone(),
        _ => node_kind(node).replace('_', " "),
    }
}

fn children_of(
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

fn plain_text(node: &supramark_markdown::SupramarkNode) -> String {
    let mut out = String::new();
    collect_plain_text(node, &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_plain_text(node: &supramark_markdown::SupramarkNode, out: &mut String) {
    use supramark_markdown::SupramarkNode;
    match node {
        SupramarkNode::Text { value, .. }
        | SupramarkNode::InlineCode { value, .. }
        | SupramarkNode::Code { value, .. }
        | SupramarkNode::MathBlock { value, .. }
        | SupramarkNode::MathInline { value, .. }
        | SupramarkNode::Raw { value, .. } => push_text(out, value),
        SupramarkNode::Diagram { code, .. } => push_text(out, code),
        SupramarkNode::Image { alt, .. } => push_text(out, alt),
        SupramarkNode::Link { url, children, .. } => {
            for child in children {
                collect_plain_text(child, out);
            }
            if out.is_empty() {
                push_text(out, url);
            }
        }
        SupramarkNode::FootnoteReference { label, .. } => push_text(out, label),
        SupramarkNode::Container {
            value, children, ..
        }
        | SupramarkNode::Input {
            value, children, ..
        } => {
            if let Some(value) = value {
                push_text(out, value);
            }
            for child in children {
                collect_plain_text(child, out);
            }
        }
        SupramarkNode::Unsupported {
            value, children, ..
        } => {
            if let Some(value) = value {
                push_text(out, value);
            }
            for child in children {
                collect_plain_text(child, out);
            }
        }
        SupramarkNode::Break { .. } => out.push('\n'),
        _ => {
            if let Some(children) = children_of(node) {
                for child in children {
                    collect_plain_text(child, out);
                }
            }
        }
    }
}

fn push_text(out: &mut String, value: &str) {
    if !out.is_empty() {
        out.push(' ');
    }
    out.push_str(value);
}

fn source_fragment<'a>(
    source: &'a str,
    position: &supramark_markdown::SourcePosition,
) -> Option<&'a str> {
    source.get(position.start.byte_offset..position.end.byte_offset)
}

fn render_fragment<F>(fragment: &str, render_block: &mut F) -> String
where
    F: FnMut(&str) -> String,
{
    if fragment.len() <= MAX_BLOCK_RENDER_BYTES {
        render_block(fragment)
    } else {
        fallback_html(&truncate_chars(fragment, MAX_TEXT_CHARS))
    }
}

fn fallback_html(text: &str) -> String {
    format!("<pre><code>{}</code></pre>", html_escape::encode_text(text))
}

fn block_digest(kind: &str, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(kind.as_bytes());
    h.update(b"\0");
    h.update(text.as_bytes());
    h.finalize()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}
