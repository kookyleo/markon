# Markon

Mark it on.

本地优先的 Markdown 阅览、审校与协作工作台。Markon 可以把一个文件或仓库变成可搜索的浏览器工作区，提供 GitHub 风格渲染、批注、章节进度、编辑、Git 差异查看，以及可选的 AI 助手。

![Markon Banner](banner.png)

[English](README.md) | 简体中文 | [在线文档](https://kookyleo.github.io/markon/) | [最新版本](https://github.com/kookyleo/markon/releases/latest)

## Markon 是什么

Markon 面向的是 Markdown 的深度阅读与审校，而不只是预览。它适合这些场景：

- 阅读长篇设计文档，用高亮、便条和章节进度完成审阅；
- 在本机或无 GUI 的服务器上浏览、检索 Markdown；
- 对比工作区改动或不同 Git 提交中的渲染结果；
- 演示文档时，让其它设备跟随当前章节；
- 不离开浏览器就快速编辑正文；
- 让 AI 助手检索工作区文件，并提出可审核、可撤销的修改建议。

Markon 提供 macOS、Windows、Linux 的 Tauri 桌面应用，也提供适合终端和服务器环境的独立 CLI。

## 功能概览

| 领域 | 当前能力 |
| --- | --- |
| 渲染 | GitHub 风格亮色/暗色主题、GFM 表格与任务列表、脚注、Alerts、Emoji shortcode、语法高亮、数学公式和服务端图表渲染 |
| 审校 | 文本高亮、删除线、便条、撤销/重做、章节 Viewed 状态、独立折叠、焦点章节操作、整页/章节便条导出、章节/整页打印 |
| 导航 | 多工作区目录浏览、树形展开、自动 TOC、同时搜索文件与内容的 Workspace Spotlight、中文分词与键盘导航 |
| 编辑 | 浏览器内 Markdown 编辑器、从渲染选区定位源码、保存后刷新、文件实时监听与工作区路径边界保护 |
| 协作 | 本地/共享批注、SQLite + WebSocket 同步，以及同步章节焦点、选区和 Viewed 状态的 Live 主控/跟随模式 |
| AI 对话 | Anthropic 或 OpenAI 兼容 Provider、工作区文件工具与引用、多会话、页内/独立窗口，以及 Edit 开启后的人工确认编辑 |
| Git | 分支/标签/ref 浏览、近期历史、工作区与提交 diff、Markdown 原始/渲染对比、本机 checkout 与 commit |
| 桌面端 | 托盘常驻、多工作区管理、独立功能开关、文件关联、自定义样式与快捷键、Stable/RC 更新通道 |

渲染、搜索、批注和持久化都在本机完成。AI 对话是可选功能，会把它读取的上下文发送给你配置的 Provider；详见[数据与隐私](#数据与隐私)。

## 安装

### 桌面应用

从 [GitHub Releases](https://github.com/kookyleo/markon/releases/latest) 下载对应平台安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS | Apple Silicon 与 Intel `.dmg` |
| Windows | x64 与 ARM64 NSIS 安装程序 |
| Linux | x64 与 ARM64 `.deb`、`.AppImage` |

macOS 可使用仓库内的 Homebrew tap：

```bash
brew tap kookyleo/markon https://github.com/kookyleo/markon
brew install --cask markon
```

Windows 可使用仓库内的 Scoop bucket：

```powershell
scoop bucket add kookyleo https://github.com/kookyleo/markon
scoop install kookyleo/markon
```

macOS 应用使用 ad-hoc 签名，Windows 安装程序尚未代码签名，因此首次启动可能遇到 Gatekeeper 或 SmartScreen。具体放行步骤见[安装指南](docs/guide/installation.md)。

### CLI

通过 Cargo 安装已发布的 CLI：

```bash
cargo install markon
```

或从源码安装：

```bash
git clone https://github.com/kookyleo/markon.git
cd markon
cargo install --path crates/cli
```

## 快速开始

### 桌面端

1. 启动 Markon，在「工作区」标签页添加一个目录。
2. 在浏览器中打开该工作区。
3. 按工作区开启搜索、Viewed、编辑、Live、AI 对话或共享批注。
4. 在文档中按 `?` 查看当前页面可用的快捷键。

也可以直接用 Markon 打开 `.md`/`.markdown` 文件。单文件工作区是临时的，只搜索该文件，也只开放该文件和它明确引用且位于父目录边界内的本地资源。

### CLI

```bash
# 打开单个文件。传入路径时会自动尝试打开浏览器。
markon README.md

# 浏览当前目录，并显式打开浏览器。
markon -b

# 将目录作为另一个工作区打开。
markon docs/

# 查看和管理后台服务。
markon ls
markon set 1 edit on
markon detach 1
markon shutdown
```

CLI 使用「单个后台服务 + 多个工作区」模型。第一次调用会启动 daemon，后续调用会在同一个服务中注册或更新其它工作区。

## CLI 速查

```text
markon [OPTIONS] [FILE]
markon <COMMAND>
```

### 主要选项

| 选项 | 说明 |
| --- | --- |
| `[FILE]` | Markdown 文件或目录；默认使用当前目录 |
| `-p, --port <PORT>` | 服务端口，默认 `6419` |
| `--host [IP]` | 绑定地址；不传值时打开网卡选择器，`0.0.0.0` 表示所有接口 |
| `--entry, --qr [URL_PREFIX]` | 公共 URL 前缀和二维码目标；不传值时使用首选可访问地址 |
| `-b, --open-browser [BASE_URL]` | 打开浏览器；可选 BASE_URL 用于反向代理场景 |
| `--collaborator-access-code <CODE>` | 设置或清除该工作区的远程协作者门禁码 |
| `--print-collapsed-content` | 打印时包含折叠章节的正文 |
| `--salt <SALT>` | 高级选项：覆盖 workspace ID 的生成 salt |

### 子命令

| 命令 | 用途 |
| --- | --- |
| `markon ls [--format cards\|table]` | 列出活跃工作区和功能状态 |
| `markon detach <ID\|序号>` | 从运行中的服务移除工作区 |
| `markon set <ID\|序号> <FEATURE> <on\|off>` | 开关 `search`、`viewed`、`edit`、`live`、`chat` 或 `shared` |
| `markon shutdown` | 关闭后台服务 |
| `markon bug` | 通过已登录的 `gh` 起草并打开 GitHub Bug |
| `markon idea` | 通过 `gh` 创建 GitHub Discussion 功能建议 |
| `markon ask` | 通过 `gh` 创建 GitHub Discussions 问题 |

### 网络示例

```bash
# 局域网访问，并按首选局域网地址生成二维码。
markon docs/ --host 0.0.0.0 --entry

# 显式绑定一个网卡地址。
markon --host 192.168.1.5 docs/

# 声明 HTTPS 反向代理对外提供的公共地址。
markon --entry https://docs.example.com docs/

# 给该工作区的远程访客设置门禁，本机访问仍然免码。
markon --collaborator-access-code guest-secret docs/
```

完整说明见 [CLI 指南](docs/guide/cli.md)和 [反向代理指南](REVERSE_PROXY.zh.md)。

## 工作区模型

Markon 用一个服务承载任意数量的工作区根目录：

- 目录工作区会持久化到 `~/.markon/settings.json`，重启后自动恢复。
- 单文件工作区是临时的，不会开放无关的兄弟文件。
- 每个工作区都有可选别名、协作者门禁码和独立功能开关。
- 新工作区继承桌面端「通用设置」里的全局默认值。
- 默认开启搜索和 Viewed；编辑、Live、AI 对话、共享批注默认按需开启。

### 功能开关

| 功能 | 效果 |
| --- | --- |
| 搜索 | 构建 Tantivy/Jieba 索引，并启用 Workspace Spotlight（`/` 或 `g`） |
| Viewed | 为 H2-H6 增加阅读进度和折叠；章节操作只在标题获得焦点时出现 |
| 编辑 | 启用 Markdown 编辑器，并允许 AI 对话提出需要人工确认的文件修改 |
| Live | 启用通过 WebSocket 同步阅读位置的主控/跟随模式 |
| AI 对话 | 使用已配置 Provider 开启工作区感知的多会话对话 |
| 共享批注 | 将批注与 Viewed 状态从浏览器存储迁移到 SQLite，并通过 WebSocket 同步 |

对于 Git 仓库，工作区页面还会提供分支、标签、历史、工作区改动，以及 Markdown 原始/渲染 diff。Checkout、commit、创建文件等结构性操作仅允许本机管理员执行。

## 访问权限

Markon 不使用账号系统，而是按网络来源区分权限：

- **本机 loopback 是管理员。** 桌面应用和 `127.0.0.1` 浏览器页面可管理工作区、修改功能与别名、编辑文件，以及执行 Git/文件操作，且无需访问码。
- **远程访问是协作者。** 只能使用该工作区已开启的能力，不能执行结构性/管理操作。
- **协作者码只约束远程访问。** 工作区自己的码覆盖全局码；本机始终绕过门禁。

协作者码是应用层访问控制，不提供传输加密。对公网开放时必须使用 HTTPS 和反向代理。部署前请阅读[访问权限](docs/features/access.md)和[反向代理](REVERSE_PROXY.zh.md)。

## 数据与隐私

| 数据 | 默认位置或行为 |
| --- | --- |
| 设置、工作区列表、Provider 配置 | `~/.markon/settings.json` |
| 共享批注、共享 Viewed 状态、AI 对话会话 | `~/.markon/annotation.sqlite` |
| 本地批注与本地 Viewed 状态 | 浏览器 LocalStorage |
| 自定义 SQLite 路径 | `MARKON_SQLITE_PATH=/path/to/annotation.sqlite` |
| 工作区访问码 | 以加盐 hash 持久化，不保存明文 |
| AI Provider Key | 明文保存在本机 `settings.json`，应按敏感文件保护 |

Markdown 渲染、搜索和批注不会把工作区内容上传到云端。AI 对话会把选区、`@` 引用以及工具读取的上下文发送给配置的 Anthropic 或 OpenAI 兼容端点。它的文件工具被限制在工作区内，会拒绝二进制/超大文件，也不能执行命令。开启编辑后，每次写入都必须由用户明确 Apply/Reject，已经应用的修改可以在对话中撤销。

卸载 Markon 不会自动删除 `~/.markon`。

## Markdown 支持

Markon 使用 Supramark 解析 Markdown 和渲染图表。目前覆盖：

- CommonMark/GFM 标题、强调、链接、图片、Raw HTML、列表、表格、任务列表、引用和代码围栏；
- 脚注、GitHub Alerts、Emoji shortcode、语法高亮与 KaTeX 数学公式；
- Mermaid、PlantUML、D2、DOT/Graphviz、Vega/Vega-Lite、ECharts、Chart.js；
- 工作区边界内被明确引用的本地图片、样式表、视频和音频；
- 自动生成的章节结构与可导航 TOC。

[示例工作区](example/)包含可直接运行的渲染与端到端测试素材。

## 键盘快捷键

快捷键可以在桌面端设置中自定义。当前页面的权威列表以按 `?` 打开的面板为准。

| 按键 | 操作 |
| --- | --- |
| `?` / `t` | 快捷键帮助 / 主题面板 |
| `/` 或 `g` | 打开 Workspace Spotlight |
| `j` / `k` | 下一个 / 上一个标题 |
| `Ctrl/Cmd+j` / `Ctrl/Cmd+k` | 下一个 / 上一个批注 |
| `Ctrl/Cmd+\` | 打开或聚焦 TOC |
| `o` / `v` | 折叠当前章节 / 切换 Viewed |
| `x` | 导出当前页面的便条 |
| `e` | 编辑当前 Markdown 文件 |
| `l` / `Shift+L` | 切换 Live 激活模式 / 开关 Live |
| `c` / `Shift+C` | 以默认 / 另一种界面打开 AI 对话 |
| `m`、`n`、`p` | diff 页切换模式 / 下一处 / 上一处改动 |
| `Ctrl/Cmd+z` / `Ctrl/Cmd+Shift+z` | 撤销 / 重做批注 |
| `Esc` | 关闭当前浮层，或清除焦点/选区 |

## 开发

浏览器端资源以 TypeScript bundle 的形式嵌入 `markon-core`。全新 checkout 需要先构建前端，再编译 Rust：

```bash
npm install
npm run build
cargo build
```

提交前运行统一质量门禁：

```bash
scripts/quality-gate.sh
```

它会执行 Rust 格式检查、严格 Clippy、Rust 测试、TypeScript 类型检查/ESLint 和 Vitest。常用的独立命令包括：

```bash
npm run typecheck
npm test
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

桌面端开发和 macOS 打包：

```bash
scripts/dev-gui.sh
scripts/build-dmg.sh
```

### 仓库结构

| 路径 | 职责 |
| --- | --- |
| `crates/core` | HTTP 服务、渲染、搜索、持久化、Git、Chat 与浏览器资源 |
| `crates/cli` | CLI 与后台服务生命周期 |
| `crates/gui` | Tauri 2 桌面壳与设置界面 |
| `crates/xtask` | 构建期维护工具 |
| `docs` | VitePress 文档 |
| `example` | 渲染与端到端测试素材 |

架构与持久化兼容约束见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 贡献

欢迎提交 Issue 和 Pull Request。请保持改动范围清晰，按风险补充测试，并在开 PR 前运行 `scripts/quality-gate.sh`。

- [Issues](https://github.com/kookyleo/markon/issues)
- [Discussions](https://github.com/kookyleo/markon/discussions)
- [发布流程](RELEASE.zh.md)

## 许可证

版权所有 © 2025-至今 kookyleo。基于 [Apache License 2.0](LICENSE) 开源发布。

依据 Apache-2.0 第 4 条，再分发或衍生作品必须保留 [`NOTICE`](NOTICE)、原始版权信息，并显著标注修改过的文件。

`Markon` 名称及标识为作者所有。Apache-2.0 不授予将这些名称或标识用于衍生产品命名或宣传的权利。

## 致谢

- [go-grip](https://github.com/kookyleo/go-grip)：最初的渲染灵感
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css)：阅读样式基线
- [Supramark](https://github.com/kookyleo/supramark)：Markdown 与图表渲染
- 所有贡献者
