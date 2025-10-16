# Markon

A lightweight Markdown renderer with GitHub styling and Medium-like annotation features, written in Rust.

English | [简体中文](README.zh.md)

## Use Cases

Markon makes it easy to read, print, and annotate Markdown files in beautiful HTML format. Whether you're:

- **Reading documentation** on remote servers without a GUI
- **Reviewing and annotating** technical documents with highlights and notes
- **Printing** Markdown files with professional formatting
- **Presenting** Markdown content with GitHub-style rendering
- **Collaborating** by sharing annotated views of documentation

Simply run `markon` in any directory to browse and render Markdown files with a clean, distraction-free interface.

## Features

### Core Features
- ✅ **GitHub Styling**: Complete GitHub Markdown CSS (dark/light themes)
- ✅ **Syntax Highlighting**: Powered by Syntect
- ✅ **GitHub Alerts**: Support for NOTE, TIP, IMPORTANT, WARNING, CAUTION
- ✅ **Emoji Support**: Unicode emoji shortcodes (e.g., `:smile:` → 😄)
- ✅ **Mermaid Diagrams**: Flowcharts, sequence diagrams, pie charts, etc.
- ✅ **Theme Switching**: Light, dark, and auto themes
- ✅ **Table Support**: GitHub Flavored Markdown (GFM) tables
- ✅ **Task Lists**: Checkbox task lists
- ✅ **Print Optimization**: Professional print styles with multilingual font support
- ✅ **Table of Contents**: Auto-generated TOC
- ✅ **Directory Browsing**: Auto-list Markdown files in current directory
- ✅ **Zero Dependencies**: All resources embedded in a single binary

### Medium-Style Annotation Features
- ✅ **Text Highlighting**: Add orange, green, or yellow highlights to selected text
- ✅ **Strikethrough**: Mark text with strikethrough
- ✅ **Notes**: Add annotation notes to highlighted text
- ✅ **Sidebar Display**: Note cards displayed on the right side, linked to highlights
- ✅ **Unhighlight**: Remove highlights from selected text
- ✅ **Persistent Storage**: Annotation data saved in browser local storage

## Installation

### From crates.io

```bash
cargo install markon
```

### From source

```bash
cargo install --path .
```

### Run directly without installing

```bash
cargo run -- [OPTIONS] [FILE]
```

## Usage

### Basic Usage

```bash
# Display list of Markdown files in current directory
markon

# Render a specific Markdown file
markon README.md

# Specify port
markon -p 8080 README.md

# Use dark theme
markon -t dark README.md

# Use light theme
markon -t light README.md

# Auto theme (based on system settings)
markon -t auto README.md
```

### Command Line Options

```
Options:
  [FILE]                    Markdown file to render (optional)
  -p, --port <PORT>         Server port [default: 6419]
  -b, --no-browser          Don't automatically open browser
  -t, --theme <THEME>       Theme: light, dark, auto [default: auto]
  -h, --help                Show help information
  -V, --version             Show version information
```

### Using Annotation Features

1. Open a Markdown file in your browser
2. Select any text to see the toolbar
3. Choose highlight color (orange/green/yellow), strikethrough, or note
4. Notes will appear on the right side of the page
5. Click highlighted text to view associated notes
6. Select highlighted text again to unhighlight

## Supported Markdown Features

- **Headings** (H1-H6)
- **Bold/Italic/Strikethrough**
- **Lists** (ordered/unordered)
- **Task Lists** (- [ ] / - [x])
- **Tables**
- **Code Blocks** (with syntax highlighting)
- **Block Quotes**
- **Links and Images**
- **Horizontal Rules**
- **Footnotes**
- **Emoji** (:emoji_name:)
- **Mermaid Diagrams**
- **GitHub Alerts** ([!NOTE], [!TIP], etc.)

## Mermaid Diagram Example

Markon supports Mermaid diagram rendering using \`\`\`mermaid code blocks:

\`\`\`markdown
\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
\`\`\`
\`\`\`

Supported diagram types:
- Flowcharts (graph/flowchart)
- Sequence Diagrams (sequenceDiagram)
- Pie Charts (pie)
- Gantt Charts (gantt)
- Class Diagrams (classDiagram)
- State Diagrams (stateDiagram)
- And more...

## Emoji Support

Use standard emoji shortcodes:

```markdown
:smile: :heart: :rocket: :tada: :sparkles:
```

Result: 😄 ❤️ 🚀 🎉 ✨

## GitHub Alerts Example

Create alert boxes using special blockquote syntax:

```markdown
> [!NOTE]
> This is a note.

> [!TIP]
> This is a helpful tip.

> [!IMPORTANT]
> This is important information.

> [!WARNING]
> This is a warning.

> [!CAUTION]
> This is a serious warning.
```

Supported types:
- **NOTE** (blue) - General information
- **TIP** (green) - Helpful tips or suggestions
- **IMPORTANT** (purple) - Key information
- **WARNING** (yellow) - Important warnings
- **CAUTION** (red) - Dangerous or critical warnings

## Project Origin

This project is a Rust port of [go-grip](https://github.com/kookyleo/go-grip) with added Medium-style annotation features.

### Key Differences from go-grip

| Feature | go-grip | markon |
|---------|---------|--------|
| Language | Go | Rust |
| GitHub Alerts | ✅ | ✅ |
| Emoji | Custom mapping | Unicode (emojis crate) |
| Medium Annotations | ❌ | ✅ |
| Hot Reload | ✅ | ❌ |
| Auto Browser Open | ✅ | ❌ |
| Print Optimization | ✅ | ✅ |

## Tech Stack

### Backend
- **Markdown Parsing**: [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)
- **Syntax Highlighting**: [syntect](https://github.com/trishume/syntect)
- **HTTP Server**: [axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs/)
- **Template Engine**: [tera](https://github.com/Keats/tera)
- **Static Asset Embedding**: [rust-embed](https://github.com/pyrossh/rust-embed)
- **Emoji**: [emojis](https://github.com/rosetta-rs/emojis)

### Frontend
- **Diagram Rendering**: [Mermaid.js](https://mermaid.js.org/)
- **Styling**: [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css)
- **Annotations**: Vanilla JavaScript + LocalStorage

## Development

### Project Structure

```
markon/
├── src/
│   ├── main.rs         # Entry point
│   ├── server.rs       # HTTP server
│   ├── markdown.rs     # Markdown renderer
│   └── assets.rs       # Static asset management
├── assets/
│   ├── css/            # Stylesheets
│   │   ├── github-markdown-dark.css
│   │   ├── github-markdown-light.css
│   │   ├── github-print.css
│   │   └── editor.css  # Annotation styles
│   ├── js/             # JavaScript
│   │   ├── mermaid.min.js
│   │   └── editor.js   # Annotation logic
│   └── templates/      # HTML templates
│       ├── layout.html
│       └── directory.html
├── Cargo.toml
├── README.md
└── README.zh.md
```

### Build

```bash
# Debug mode
cargo build

# Release mode
cargo build --release

# Run tests
cargo test

# Lint
cargo clippy

# JavaScript lint
npx eslint assets/js/editor.js
```

## License

Apache License 2.0

## Acknowledgments

- [go-grip](https://github.com/kookyleo/go-grip) - Original project
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css) - Styling source
- [Medium](https://medium.com) - Annotation feature inspiration
- All open-source contributors

## Links

- Original project: https://github.com/kookyleo/go-grip
- GitHub Markdown CSS: https://github.com/sindresorhus/github-markdown-css
- Mermaid documentation: https://mermaid.js.org/
