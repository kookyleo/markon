# 快速上手

本指南帮你在 5 分钟内上手 Markon。

## 桌面版

### 1. 下载安装包

从 [GitHub Releases](https://github.com/kookyleo/markon/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `Markon_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Markon_x.x.x_x64.dmg` |
| Windows (x64) | `Markon_x.x.x_x64-setup.exe` |
| Windows (ARM64) | `Markon_x.x.x_arm64-setup.exe` |
| Linux Debian/Ubuntu (amd64) | `Markon_x.x.x_amd64.deb` |
| Linux Debian/Ubuntu (arm64) | `Markon_x.x.x_arm64.deb` |
| Linux AppImage (x86_64) | `Markon_x.x.x_amd64.AppImage` |
| Linux AppImage (aarch64) | `Markon_x.x.x_aarch64.AppImage` |

### 2. 打开 Markdown

Markon 有两种使用场景，按需选择。

#### 场景 A：临时打开一个文件

只是想看一眼某个 `.md` 的渲染效果 —— 不需要加入工作区。

- **macOS / Windows**：右键文件 → **打开方式 → Markon**，浏览器直接出结果。

#### 场景 B：把一个目录加为工作区

适合要长期浏览、搜索、标注一整个项目文档的场景。加入的工作区会常驻在 Markon 的 **工作区** 标签页，下次一键打开。几种方式任选：

- **macOS — Finder 工具栏**：把 `/Applications/Markon.app` 拖到 Finder 窗口顶部的工具栏，之后进入任意目录点一下图标，就把当前目录加入并打开。
- **Windows — 右键菜单**：在资源管理器里右键文件夹 → **使用 markon 打开**。
- **从 markon 开始**：启动 Markon，在 **工作区** 标签页点左下角 ➕，手选目录。

<!-- TODO: screenshot: 添加工作区 (/screenshots/add-workspace.png) -->

### 3. 在浏览器中查看

桌面集成入口（Finder 工具栏 / Windows 右键菜单）会直接把浏览器打开。如果是从 Markon 里手动加的工作区，事后点工作区条目的 ↗ 图标即可。

### 4. 探索功能

在浏览器页面中按下 <kbd>?</kbd> 查看完整快捷键列表，了解所有功能。

---

## CLI 版

### 1. 安装

```bash
cargo install markon
```

### 2. 基础用法

```bash
# 渲染单个文件，自动打开浏览器
markon README.md -b

# 浏览当前目录下所有 Markdown 文件
markon

# 指定端口
markon -p 8080 README.md

# 启用全文搜索（Tantivy 索引）
markon --enable-search

# 启用所有功能
markon --enable-search --enable-viewed --enable-edit README.md
```

### 3. 局域网访问

```bash
# 绑定所有网络接口，允许局域网访问
markon --host 0.0.0.0 README.md

# 交互式选择网络接口
markon --host

# 生成 QR 码方便移动端扫码
markon --host 0.0.0.0 --qr
```

→ 完整选项见 [命令行选项](/guide/cli)

---

## 下一步

- 了解 [核心功能](/features/search) — 全文搜索、已读追踪、在线编辑、标注与高亮、章节打印
- 配置 [共享标注](/advanced/shared-annotations) 实现多端同步
- 查看 [键盘快捷键](/advanced/shortcuts) 提升效率
