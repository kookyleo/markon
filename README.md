# Markon

Mark it on.
High-performance Markdown review workbench. Open source, free, and fully local.

![Markon Banner](banner.png)

English | [简体中文](README.zh.md)

## Use Cases

Markon makes it easy to read, review, and verify Markdown documents with beautiful GitHub-style rendering. Whether you're:

- **Reading & Review** - Annotate key points, track progress with Section Viewed checkboxes (GitHub PR-style)
- **Remote Servers** - Browse and annotate Markdown files on headless servers via browser (no GUI needed)
- **Team Collaboration** - Shared annotations with real-time sync across devices
- **Printing & Presenting** - Professional formatting and GitHub-style rendering with server-rendered diagrams

Simply run `markon` in any directory to browse and render Markdown files with a clean, distraction-free interface.

## Features

### Core Rendering
- ✅ **GitHub Styling**: Complete GitHub Markdown CSS with dark/light/auto themes
- ✅ **Syntax Highlighting**: Powered by Syntect with 40+ languages
- ✅ **GitHub Alerts**: Support for NOTE, TIP, IMPORTANT, WARNING, CAUTION
- ✅ **Emoji Support**: Unicode emoji shortcodes (e.g., `:smile:` → 😄)
- ✅ **Diagrams**: Server-rendered Mermaid, PlantUML, D2, DOT/Graphviz, Vega-Lite/Vega/chart, ECharts, and Chart.js/chart.js diagrams
- ✅ **GFM Tables**: Full GitHub Flavored Markdown table support
- ✅ **Task Lists**: Interactive checkbox task lists
- ✅ **Print Optimization**: Professional print styles with multilingual font support
- ✅ **Auto TOC**: Auto-generated Table of Contents with smart scrolling
- ✅ **Directory Browsing**: Browse and select Markdown files in current directory
- ✅ **Mobile Friendly**: Responsive design with QR code for easy mobile access
- ✅ **Zero Dependencies**: Single binary with all resources embedded

### Annotation System
- ✅ **Text Highlighting**: Three colors (orange, green, yellow) for different purposes
- ✅ **Strikethrough**: Mark text as deleted or obsolete
- ✅ **Notes**: Attach comments to any highlighted text
- ✅ **Sidebar Cards**: Notes displayed in right sidebar (wide screen) with smart positioning
- ✅ **Popup Notes**: Notes shown as popups (narrow screen) near highlighted text
- ✅ **Click to Edit**: Click highlighted text to view/edit/delete notes
- ✅ **Clear Selection**: Select highlighted text again to remove highlight
- ✅ **Two Storage Modes**:
  - **Local Mode**: Browser LocalStorage (single device)
  - **Shared Mode**: SQLite + WebSocket (real-time multi-device sync)
- ✅ **Undo/Redo**: Full undo/redo support for all annotation operations

### Section Viewed System
- ✅ **GitHub PR-Style Checkboxes**: Mark sections as "Viewed" next to headings (H2-H6)
- ✅ **Auto-Collapse**: Checked sections automatically collapse
- ✅ **Click to Expand**: Toggle collapsed sections without changing viewed state
- ✅ **Batch Operations**: "All Viewed" and "Unviewed" toolbar after H1 heading
- ✅ **Visual Progress**: TOC items turn green when sections are viewed
- ✅ **Smart Folding**: Collapses content until next same/higher-level heading
- ✅ **Two Storage Modes**:
  - **Local Mode**: Browser LocalStorage (per-browser)
  - **Shared Mode**: SQLite + WebSocket (synced across devices)
- ✅ **Independent Toggle**: Expand/collapse without changing viewed status

### Section Print
- ✅ **Individual Print**: "Print" button next to each heading (H2-H6)
- ✅ **Precise Range**: Print only current section content (from heading to next same/higher-level heading)
- ✅ **Clean Output**: Automatically hide interactive elements (checkboxes, buttons) when printing
- ✅ **Preserve Styling**: Maintain GitHub-style professional formatting in print
- ✅ **One-Click Operation**: Click "Print" button to open system print dialog

### Full-Text Search
- ✅ **Tantivy-Powered**: Fast full-text search engine with in-memory indexing
- ✅ **Chinese Support**: Jieba word segmentation for accurate Chinese text search
- ✅ **Multi-Field Search**: Search across file paths, names, titles, and content
- ✅ **Snippet Preview**: Highlighted search results with context excerpts
- ✅ **Auto-Scroll & Highlight**: Jump to exact position with temporary keyword highlighting
- ✅ **Keyboard Navigation**: `↑/↓` to select results, `Enter` to navigate
- ✅ **Auto-Indexing**: File watcher automatically updates index on changes
- ✅ **Portable URLs**: Relative paths for consistent navigation
- ✅ **Clean UI**: Full-screen search with content-width constraint (980px)
- ✅ **Quick Access**: Press `/` to open search, `ESC` to close

### Keyboard Shortcuts
- ✅ **Undo/Redo**: `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y`
- ✅ **Navigation**: `j/k` (next/prev heading), `Ctrl/Cmd+j/k` (next/prev annotation)
- ✅ **Smart Scroll**: `Space` (smooth 1/3 page scroll, `ESC` to stop)
- ✅ **TOC Control**: `Ctrl/Cmd+\` (toggle/focus TOC)
- ✅ **Section Control**: `o` (collapse/expand current section)
- ✅ **Viewed Control**: `v` (toggle current section viewed state)
- ✅ **Search**: `/` (open full-text search)
- ✅ **Help Panel**: `?` (show all shortcuts)
- ✅ **Close/Cancel**: `ESC` (close popups, clear selection, cancel focus)
- ✅ **Platform Detection**: Auto-detects Mac vs Windows/Linux for modifier keys

### UI/UX Enhancements
- ✅ **Smart Popover**: Selection toolbar with auto-positioning (above/below)
- ✅ **Modal System**: Unified modal manager for notes and confirmations
- ✅ **Selection Overlay**: Visual selection highlight persists during note input
- ✅ **Focus Management**: Click outside markdown area clears section focus
- ✅ **Responsive Layout**: Adapts to wide screen (1400px+) and narrow screen modes
- ✅ **Note Positioning**: Smart positioning avoiding scrollbars and screen edges
- ✅ **Prevent Scroll**: Modal/popover focus doesn't trigger auto-scroll

### Developer Features
- ✅ **Modular Architecture**: Clean separation (managers, navigators, components, services)
- ✅ **Configuration System**: Centralized config with frozen constants
- ✅ **Logger Utility**: Structured logging for debugging
- ✅ **WebSocket Manager**: Auto-reconnect with exponential backoff
- ✅ **Storage Abstraction**: Strategy pattern for local vs shared storage
- ✅ **Event System**: Pub/sub for WebSocket and annotation changes

## Installation

### From crates.io

```bash
cargo install markon
```

### From source

```bash
cargo install --path crates/cli
```

### From GitHub Releases

Download a precompiled binary from [Releases](https://github.com/kookyleo/markon/releases).

### Run directly without installing

```bash
cargo run -- [OPTIONS] [FILE]
```

## Usage

**Quick Start**: `markon [FILE]` - Render a Markdown file or browse current directory.

Markon CLI runs in **background daemon** mode by default. The first launch starts the server, moves it to the background, and releases the terminal; subsequent runs automatically append new workspaces to the already-running server and open them.

### Workspace Management

```bash
# List active workspaces
markon ls

# Detach a workspace (accepts index or ID)
markon detach 1

# Shut down the background server
markon shutdown
```

### Command Line Options

```
Usage: markon [OPTIONS] [FILE]

Arguments:
  [FILE]  Markdown file to render (omit to browse current directory)

Options:
  -p, --port <PORT>                Server port [default: 6419]
      --host [<IP>]                Bind address for LAN access [default: 127.0.0.1]
                                   - (omit): localhost only
                                   - --host: interactive selection
                                   - --host 0.0.0.0: all interfaces
                                   - --host <IP>: specific IP address
      --entry [<BASE_URL>]         External access prefix; generates a QR code (alias: --qr)
  -b, --open-browser [<BASE_URL>]  Auto-open browser (optional: custom URL)
      --collaborator-access-code <CODE>
                                   Set or clear this workspace's collaborator access code
                                   (remote-visitor gate; loopback is always allowed)
      --print-collapsed-content    Include collapsed (viewed) sections when printing
      --salt <SALT>                Salt for hashing access codes / identity
  -h, --help                       Print help
  -V, --version                    Print version
```

### Common Examples

```bash
# Browse markdown files in current directory
markon

# Render specific file
markon README.md

# Custom port
markon -p 8080 README.md

# LAN access - bind to all interfaces
markon --host 0.0.0.0 README.md

# LAN access - interactive selection
markon --host README.md

# LAN access - specific IP address
markon --host 192.168.1.100 README.md

# LAN access + QR code for easy mobile access
markon --host 0.0.0.0 --qr http://192.168.1.100:6419 README.md

# Auto-open browser with custom URL (reverse proxy)
markon -b http://docs.example.com

# Set a per-workspace collaborator access code (remote-visitor gate) while adding a workspace
markon --collaborator-access-code guest-secret README.md

# Workspace features are controlled in the browser workspace settings
markon --qr -b README.md
```

### Features Guide

**LAN Access** (`--host`):
- Default: Server binds to `127.0.0.1` (localhost only, secure)
- `--host`: Interactive selection of available network interfaces with arrow keys
- `--host 0.0.0.0`: Bind to all interfaces (accessible from LAN)
- `--host <IP>`: Bind to specific IP address
- Combine with `--qr` for easy mobile/team access

**Annotations**:
- Select text → Choose highlight/strikethrough/note from toolbar
- Local mode: Stored in browser LocalStorage
- Shared mode: enable **Shared notes** from workspace settings for SQLite + WebSocket sync
- Custom DB path: set `MARKON_SQLITE_PATH=/path/to/db` before starting Markon

**Section Viewed**:
- Check box next to heading → Section collapses
- Click "(click to expand)" → Temporarily view collapsed section
- Uncheck box → Section expands permanently
- Batch toolbar (after H1): "All Viewed" / "Unviewed" buttons
- Storage: LocalStorage (default) or SQLite when **Shared notes** is enabled

**Full-Text Search**:
- Press `/` to open search modal
- Type keywords to search across all markdown files
- Use `↑/↓` arrow keys to navigate results, `Enter` to jump
- Results show file path, title, and highlighted snippets
- Click result or press `Enter` to navigate with auto-scroll and keyword highlighting
- Chinese text automatically tokenized with Jieba for accurate matching

**Markdown Editing**:
- Press `e` to open editor with line numbers and syntax highlighting
- Select text → Click "Edit" in toolbar → Auto-jump to source with text selected
- `Ctrl/Cmd+S`: Save changes (asterisk * in title shows unsaved changes)
- `ESC`: Close editor and return to view mode
- Security: Only `.md` files within the start directory can be edited
- Theme: Auto-follows light/dark mode with GitHub-style syntax highlighting

**Live Collaboration**:
- Three-state sphere on the page: Off / Broadcast / Follow
- Broadcaster shares section focus, text selection, and viewed-checks; followers smooth-scroll to match
- XPath-based anchoring works across screen sizes (4K presenter ↔ phone follower)
- Each client picks one of 8 colors for identity; the broadcaster's color rings the sphere and triggers the focus pulse
- Press `l` to swap leader/follower (jumps in even from off); `Shift+L` toggles between off and the previous active state

**AI Chat**:
- Embedded read-only assistant that reads files in the workspace via `read_file` / `list_dir` / `glob` / `grep` — no write or execute
- Press `c` to open in the default surface (in-page panel or popout window); `Shift+C` opens in the opposite surface for one-shot inversion
- Threads are workspace-scoped and persisted in `~/.markon/annotation.sqlite` (override via `MARKON_SQLITE_PATH`)
- `@` in the input picks any text file from the workspace; selecting text in the page and clicking "聊聊" sends it as a citation pill
- Provider is Anthropic or OpenAI; API key is stored locally in `~/.markon/settings.json` (plain text — see [Reverse-proxy notes](REVERSE_PROXY.md) before exposing the server)

**Keyboard Shortcuts** (press `?` to see all):
- `/`: Open search (requires Search enabled for the workspace)
- `e`: Edit current file (requires Edit enabled for the workspace)
- `l` / `Shift+L`: Toggle Live broadcast/follow / off (requires Live enabled for the workspace)
- `c` / `Shift+C`: Open AI chat in default / opposite surface (requires AI Chat enabled for the workspace)
- `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`: Undo/Redo annotations
- `j` / `k`: Next/Previous heading
- `Ctrl/Cmd+\`: Toggle TOC
- `v`: Toggle current section viewed (requires Viewed tracking enabled for the workspace)
- `ESC`: Close popups/Clear selection

## Important Notes

### System Path Prefix

Markon uses `/_/` as a reserved path prefix for all system resources (CSS, JavaScript, WebSocket, favicon). This ensures complete separation between system files and your content:

- **Reserved path**: `/_/` (only this specific prefix)
- **What this means**: Do NOT create a directory named `_` (single underscore) in your working directory root
- **What you CAN do**:
  - ✅ Create directories like `_build/`, `__pycache__/`, `_test/`, `_cache/` (different from `_`)
  - ✅ Create directories like `ws/`, `static/`, `css/`, `js/` (no conflict!)
  - ✅ Use any file or directory names that don't start with exactly `_/`

**Examples**:
```bash
# ❌ This will conflict with system paths
mkdir _              # Don't create a single-underscore directory
markon               # System uses /_/css/*, /_/js/*, etc.

# ✅ All of these are perfectly fine
mkdir _build         # URL: /_build/* (not /_/*)
mkdir __pycache__    # URL: /__pycache__/* (not /_/*)
mkdir ws             # URL: /ws/* (not /_/ws - different!)
mkdir static         # URL: /static/* (not /_/*)
```

**When using reverse proxy**: Make sure to configure your proxy to forward the `/_/` path. See [REVERSE_PROXY.md](REVERSE_PROXY.md) ([中文版](REVERSE_PROXY.zh.md)) for detailed configuration examples for Nginx, Caddy, Apache, and Traefik.

### Shared Annotation Mode

When **Shared notes** is enabled:

**Database location**:
- Linux/macOS: `~/.markon/annotation.sqlite`
- Windows: `%USERPROFILE%\.markon\annotation.sqlite`
- Custom: set the `MARKON_SQLITE_PATH` environment variable

**Sync mechanism**:
- Annotations and viewed state sync in real time over WebSocket
- Auto-reconnect with exponential backoff
- Broadcast to all connected clients

**Multi-device usage**:
1. Start on the server: `markon --host 0.0.0.0 README.md`
2. Enable **Shared notes** from the browser workspace settings
3. Open on any device: `http://server-ip:6419`
4. All annotations sync across devices in real time

### Permissions & Access Codes

Markon splits permissions by **where you connect from**, with no accounts or roles:

- **Loopback (`127.0.0.1`) = full admin, no code.** The desktop GUI and any local browser tab on `127.0.0.1` count as loopback and get every capability — toggling workspace features, editing aliases, adding/removing workspaces, `git commit` / `checkout`, and creating/deleting files — all without any code.
- **Remote (LAN / other machines) = collaborator.** What a remote visitor can do is decided by that workspace's **feature flags**: `edit` on → edit and save body text; `chat` on → use the AI assistant; `annotation` (shared) on → annotate; and so on. Remote visitors can never perform admin/structural actions.

A **collaborator access code** gates remote visitors. When a scope has one, remote visitors must unlock at a browser gate first; **loopback is always allowed through**. It is two-level with nearest-scope override:

- **Server-level (global) collaborator code**: set in **General** settings; it gates every workspace that does not define its own.
- **Per-workspace collaborator code**: set via the collaborator lock icon on each workspace card, or pass `--collaborator-access-code` when adding a workspace from the CLI. A workspace's own code **overrides** the global one.

From loopback you can also manage workspaces via the CLI (`markon set <id|index> <feature> <on|off>`, `markon ls`, `markon detach`, `markon shutdown`).

This is **app-layer access control**, not transport security. Codes travel over whatever connection you expose, so put Markon behind HTTPS / a reverse proxy for any real exposure. See [REVERSE_PROXY.md](REVERSE_PROXY.md).

### Single-File Workspaces

Opening a single `.md` file — via Finder's **Open With** or `markon path/to/file.md` — creates a **single-file workspace**:

- It appears in the GUI workspace list with a file icon and can use the same feature flags and collaborator-code controls as any other workspace.
- It is **transient**: single-file workspaces are not persisted across server restarts.
- Its full-text search is **scoped to that one file**.

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
- **Diagrams** (Mermaid, PlantUML, D2, DOT/Graphviz, Vega-Lite/Vega/chart, ECharts, Chart.js/chart.js)
- **GitHub Alerts** ([!NOTE], [!TIP], etc.)

## Diagram Example

Markon supports server-side diagram rendering with Supramark. Mermaid diagrams use \`\`\`mermaid code blocks:

\`\`\`markdown
\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
\`\`\`
\`\`\`

Supported engines include:
- Mermaid (flowcharts, sequence diagrams, pie charts, Gantt charts, class diagrams, state diagrams, and more)
- PlantUML
- D2
- DOT/Graphviz (`dot`, `graphviz`)
- Vega-Lite (`vega-lite`, `vega`, `chart`)
- ECharts
- Chart.js (`chartjs`, `chart.js`)

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

## Tech Stack

### Backend
- **Markdown Parsing**: Supramark (`supramark-markdown`)
- **Diagram Rendering**: Supramark (`supramark-diagram`)
- **Syntax Highlighting**: [syntect](https://github.com/trishume/syntect)
- **HTTP Server**: [axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs/)
- **Template Engine**: [tera](https://github.com/Keats/tera)
- **Static Asset Embedding**: [rust-embed](https://github.com/pyrossh/rust-embed)
- **Emoji**: [emojis](https://github.com/rosetta-rs/emojis)
- **Full-Text Search**: [tantivy](https://github.com/quickwit-oss/tantivy) + [tantivy-jieba](https://github.com/baoyachi/tantivy-jieba)

### Frontend
- **Styling**: [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css)
- **Architecture**: ES6 modules, OOP design, Strategy pattern

## FAQ

<details>
<summary><strong>How do I access from another device?</strong></summary>

On the server, bind all interfaces with `--host 0.0.0.0`:

```bash
markon --host 0.0.0.0 README.md
```

Then open `http://{IP}:6419` from any device. Use `--entry` to generate a QR code for mobile access.
</details>

<details>
<summary><strong>Where are annotations stored?</strong></summary>

**Local mode** (default): browser LocalStorage (per-browser)

**Shared mode**: SQLite database when **Shared notes** is enabled for the workspace
- Linux/macOS: `~/.markon/annotation.sqlite`
- Windows: `%USERPROFILE%\.markon\annotation.sqlite`
- Custom: set `MARKON_SQLITE_PATH=/path/to/db` before starting Markon
</details>

<details>
<summary><strong>How do I run behind an Nginx/Apache reverse proxy?</strong></summary>

Nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:6419;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

Then use:
```bash
markon -b http://yourdomain.com --entry http://yourdomain.com
```

See the [reverse proxy guide](REVERSE_PROXY.md) for detailed configuration.
</details>

<details>
<summary><strong>Can I render multiple files at once?</strong></summary>

A single file-render workspace shows one file at a time, but you can open multiple workspaces at once, and directory-browse mode lets you switch between files quickly:

```bash
markon  # browse all .md files in the current directory
```
</details>

<details>
<summary><strong>How do I change the port?</strong></summary>

```bash
markon -p 8080 README.md
```
</details>

<details>
<summary><strong>Which themes are supported?</strong></summary>

Three theme modes:
- Light
- Dark
- Follow system / page default

Use the browser page theme switcher for rendered pages and the GUI appearance settings for the desktop panel.
</details>

## Development

### Build

```bash
# Development build
cargo build

# Release build
cargo build --release

# Run tests
cargo test
npm test

# JavaScript lint
npx eslint 'crates/core/assets/js/**/*.js'

# Run
./target/debug/markon README.md
```

## Contributing

Contributions are welcome! Whether it's bug reports, feature requests, or code improvements.

### How to Contribute

1. **Report Issues**: Submit bugs or feature requests via [GitHub Issues](https://github.com/kookyleo/markon/issues)
2. **Submit PRs**:
   - Fork the repository
   - Create a feature branch (`git checkout -b feature/your-feature`)
   - Commit changes (`git commit -m 'Add your feature'`)
   - Push to branch (`git push origin feature/your-feature`)
   - Open a Pull Request

### Before Submitting PR

- Run `cargo test` and `npm test` - Ensure all tests pass
- Run `cargo clippy` - Check code quality
- Run `cargo fmt` - Format code
- Run `npx eslint 'crates/core/assets/js/**/*.js'` - Lint JavaScript code
- Test the changes manually

## License

Copyright 2025-present kookyleo. Released under the [Apache License 2.0](LICENSE).

Per Apache-2.0 §4, redistributions and derivative works **must** preserve the
[`NOTICE`](NOTICE) file, the original copyright headers, and clearly mark
modified files. See the LICENSE for the authoritative terms.

### Name & marks

`"Markon"` is a trademark of the author. Per Apache-2.0 §6, this license does
**not** grant rights to use the `"Markon"` name, logo, or related marks to
name, brand, or promote derivative works or products. Forks and derivatives
should pick a distinct name.

## Acknowledgments

- [go-grip](https://github.com/kookyleo/go-grip) - Initial inspiration for Markdown rendering
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css) - Styling source
- [Medium](https://medium.com) - Annotation feature inspiration
- All open-source contributors

## Links

- GitHub Markdown CSS: https://github.com/sindresorhus/github-markdown-css
- Mermaid syntax documentation: https://mermaid.js.org/
- go-grip: https://github.com/kookyleo/go-grip
