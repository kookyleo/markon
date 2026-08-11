---
title: 快速上手
description: 用桌面版或 CLI 在 5 分钟内建立第一个 Markon Workspace，并了解管理员会话与功能开关。
---

# 快速上手

本指南用最短路径建立一个目录工作区。若只想打开单个 Markdown 文件，直接把文件交给 Markon 即可。

## 桌面版

### 1. 安装

<DownloadButton />

安装包覆盖 macOS Apple Silicon / Intel、Windows x64 / ARM64，以及 Linux amd64 / arm64。首次启动的系统安全提示见[安装说明](/zh/guide/installation)。

### 2. 添加目录

启动 Markon，在 **Workspaces** 页点击左下角 `+`，选择包含 Markdown 的目录。

也可以从系统文件管理器进入：

- **macOS**：把 Markon.app 拖入 Finder 工具栏，在目标目录点图标；
- **Windows**：在目录或 Markdown 文件的右键菜单中使用 Markon 打开。

目录工作区会写入 `~/.markon/settings.json`，以后服务重启会恢复。

### 3. 打开浏览器工作区

点击工作区卡片的打开按钮。你会看到：

- 可展开的文件树；
- Workspace 路径、别名和 id；
- Search、Viewed、Edit、Live、Chat、Shared 六个开关；
- Git 仓库的分支、历史与工作区改动；
- 搜索入口与当前版本。

桌面端打开的浏览器会引导建立管理员会话，因此可以修改功能、增删文件、checkout 或 commit。单纯访问 URL 的浏览器不会因为来自本机就自动成为管理员。

### 4. 选一条工作流

**阅读与搜索**

1. 开启 Search。
2. 打开 Markdown。
3. 按 <kbd>/</kbd> 或 <kbd>g</kbd> 搜索文件和正文。
4. 按 <kbd>?</kbd> 查看当前页面实际可用的快捷键。

**审阅长文档**

1. 开启 Viewed。
2. 选中文字，建立高亮、删除线或 Note。
3. 聚焦 H2–H6，用 <kbd>v</kbd> 标记 Viewed、<kbd>o</kbd> 独立折叠。
4. 用标题操作导出当前章节 Notes 或打印章节。

**审阅 Git 改动**

1. 回到工作区根页。
2. 打开 **Working diff** 或某个 commit。
3. 在 Rendered / Raw 间切换；Raw 还可选 Split / Unified。
4. 用 Viewed 逐个处理文件，用 <kbd>j</kbd>/<kbd>k</kbd> 聚焦变更。

## CLI / 服务器

### 1. 安装两个二进制

```bash
cargo install markon markond
```

`markon` 是本地控制客户端，`markond` 是后台服务。两者都应位于 `PATH`；如果找不到 `markond`，CLI 会退回前台服务模式。

### 2. 打开文件或目录

```bash
markon README.md  # 路径参数默认尝试打开浏览器
markon docs/      # 目录工作区
markon -b         # 当前目录，并明确打开浏览器
```

第一次运行启动后台服务，后续调用把路径追加到同一服务。

### 3. 管理工作区

```bash
markon ls
markon set 1 edit on
markon set 1 shared on
markon detach 1
markon shutdown
```

交互式终端中的裸 `markon ls` 会打开 TUI；管道或重定向时输出静态 cards。也可用 `--format cards|table` 明确选择。

### 4. SSH 与管理员会话

无桌面服务器上：

```bash
markon admin code
```

在浏览器的管理员引导页输入一次性配对码。管理浏览器会话与普通协作者严格分开。

### 5. 局域网或反向代理

```bash
# 局域网
markon docs/ --host 0.0.0.0 --entry http://192.168.1.20:6419

# HTTPS 反向代理
markon docs/ --host 127.0.0.1 \
  --entry https://docs.example.com \
  --trusted-host https://docs.example.com
```

`--entry` 既用于展示/二维码地址，也登记对应 Host/origin。公网部署仍须由反向代理提供 TLS，详见[反向代理](/zh/advanced/reverse-proxy)。

## 单文件工作区

```bash
markon path/to/README.md
```

单文件工作区：

- 搜索范围只有该文件；
- 只开放正文与它明确引用、且仍在父目录内的本地资源；
- 默认在下一次服务启动时自动移除；
- 可在桌面全局设置关闭自动移除。

## 下一步

- [产品能力总览](/zh/features/)
- [运行架构](/zh/guide/architecture)
- [访问与权限](/zh/features/access)
- [数据与隐私](/zh/advanced/data-and-privacy)
- [命令行完整参考](/zh/guide/cli)
