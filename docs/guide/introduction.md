# 简介

**Markon** 是一款基于 Rust 开发的轻量级 Markdown 阅览器。最初是为无 GUI 的 Server 场景而生 —— 在远程机器上把一整个目录的 `.md` 变成可读、可审阅、可检索的"阅读工作台"，侧重良好的阅读和审校体验。后来又逐步长出了章节打印、多终端同步标注、在线编辑等功能，以及跨平台桌面版本。

## 为什么是 Markon？

市面上 Markdown 渲染器不少，但往往只做渲染。Markon 的定位是"**Markdown 的阅读工作台**"——除了漂亮的渲染，还希望在你阅读、审阅、标注、协作的全流程里都帮得上忙。

### 它适合谁？

- **📖 阅读与审阅** — 给要点做高亮、添加便条，用 Section Viewed 跟踪阅读进度（GitHub PR Review 风格）
- **🖥️ 远程服务器** — 在无 GUI 的服务器上用浏览器浏览、标注、编辑 Markdown 文件
- **👥 团队协作** — 跨设备/跨用户实时同步标注，团队 wiki 场景
- **🖨️ 打印与演示** — GitHub 风格的专业排版，支持 Mermaid 图表，按章节打印

### 它不是什么？

- **不是文档生成器** — 没有 MkDocs / Hugo 的那种主题/导航/扩展系统
- **不是笔记应用** — 没有 Obsidian 那样的双链、图谱、插件
- **不是 IDE** — 编辑器是辅助功能，重点还是阅读体验

## 两种使用方式

### 桌面应用（GUI）

基于 Tauri 2 的原生桌面应用，系统托盘常驻，支持 macOS / Windows / Linux。

- 一键打开任意目录作为工作区
- 图形化管理多个工作区，每个工作区独立配置
- macOS 可拖入 Finder 工具栏，Windows 右键菜单集成
- 自动更新（可切换 Stable / RC 通道）

→ 从 [GitHub Releases](https://github.com/kookyleo/markon/releases) 下载

### 命令行（CLI）

轻量级命令行版，适合服务器环境或喜欢终端的用户。

```bash
cargo install markon
markon README.md       # 渲染单个文件
markon                 # 浏览当前目录
```

→ 查看 [命令行选项](/guide/cli)

## 架构概览

```
┌──────────────────────────────────┐
│  Markon GUI (Tauri 2)            │
│  crates/gui                      │
└─────────────┬────────────────────┘
              │
              ▼
┌──────────────────────────────────┐
│  Markon Core (library)           │   ← crates/core
│  - HTTP server (axum)            │
│  - Markdown renderer             │
│  - Full-text search (Tantivy)    │
│  - Annotation persistence        │
└──────────────────────────────────┘
              ▲
              │
┌─────────────┴────────────────────┐
│  Markon CLI                      │   ← crates/cli
│  - 轻量命令行入口                 │
└──────────────────────────────────┘
```

- **`markon-core`** — 所有核心能力作为独立 lib 发布到 crates.io
- **`markon`** — CLI 入口，薄封装
- **`markon-gui`** — Tauri 桌面端，通过 GitHub Release 分发（不上 crates.io）
