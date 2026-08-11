---
title: 常见问题
description: Markon 安装、后台服务、Workspace、数据、权限、渲染、协作与性能的代码事实答疑。
---

# 常见问题

## 安装与启动

### 为什么 CLI 要装 `markon` 和 `markond`？

`markon` 是本地控制客户端，`markond` 是长期运行的服务。请同时安装：

```bash
cargo install markon markond
```

如果 `PATH` 中找不到 `markond`，CLI 会退回前台服务模式，因此终端不会像正常后台模式那样立即返回。

### macOS 提示无法验证开发者？

当前 macOS 包使用 ad-hoc 签名。首次启动后到 **系统设置 → 隐私与安全性**，在 Markon 被阻止的提示旁选择 **仍要打开 / Open Anyway**。

![macOS Gatekeeper 放行 Markon](/screenshots/macos-gatekeeper.png)

较老 macOS 可在 Finder 的 Applications 中右键 Markon.app → Open。

### Windows SmartScreen 阻止安装？

当前 NSIS 安装器未做商业代码签名。选择 **More info / 更多信息 → Run anyway / 仍要运行**。

![Windows SmartScreen 放行 Markon](/screenshots/windows-smartscreen.png)

### 怎么确认后台服务？

```bash
markon ls
```

交互终端打开 TUI；脚本中可用 `markon ls --format table`。停止服务用：

```bash
markon shutdown
```

## Workspace

### 能同时打开多个文件或目录吗？

可以。一个 `markond` 管理多个 Workspace：

```bash
markon project-a/
markon project-b/
markon README.md
```

目录 Workspace 跨重启恢复；单文件是否自动清理由 `auto_remove_single_file_workspaces` 控制，默认清理。

### 单文件 Workspace 会暴露同目录其它文件吗？

不会。它只开放该 Markdown 与它明确引用、并且仍在父目录内的本地资源。未引用兄弟文件、越界路径与逃逸 symlink 会被拒绝。

### Detach 会删除文件或批注吗？

不会。`markon detach` 只解除 Workspace 注册。历史审阅数据继续留在 SQLite，以便误操作后重新注册恢复；确定不要时再用 `markon cleanup`。

### Workspace URL 为什么要稳定？

workspace id 同时参与 URL 与 Chat 关联。它由持久 salt + 规范化身份路径生成。不要随意更换 `--salt`、删除 settings 中的 salt，或搬动文件后期待沿用旧的路径关联。

## 批注、Viewed 与数据

### 数据保存在哪里？

```text
~/.markon/settings.json
~/.markon/annotation.sqlite
~/.markon/server.lock
~/.markon/logs/markond.log
```

数据库路径可用 `MARKON_SQLITE_PATH` 覆盖。卸载不会自动删除这些文件。

### 批注会降级到 LocalStorage 吗？

不会。当前代码把 SQLite 作为批注与 Viewed 的唯一权威；浏览器不镜像、不迁移、不排队，也不在失败时静默回退。无权限或服务错误时页面保持只读并明确报错。

纯 UI 偏好仍可以存在浏览器里，例如普通折叠、主题面板位置或 diff 展开状态。

### Shared 关闭后数据会搬回个人区吗？

不会。Shared 只改变协作者能否读写同一 SQLite 数据集，以及是否广播变化。关闭不会搬移或删除数据。

### 怎么备份？

停服后复制 settings 与 SQLite：

```bash
markon shutdown
mkdir -p ~/.markon/backup-manual
cp ~/.markon/settings.json ~/.markon/annotation.sqlite ~/.markon/backup-manual/
```

## 权限与远程访问

### 本机浏览器是不是自动管理员？

不是。loopback、LAN 来源和代理头都不授予管理员身份。使用：

```bash
markon admin open
markon admin code
```

### 怎么给协作者加门禁？

```bash
markon docs/ --collaborator-access-code guest-secret
```

明文只用于本次设置，settings 保存加盐 hash。Workspace 专属码覆盖全局码。它只是应用层门禁，不替代 TLS。

### 可以直接暴露到公网吗？

应放在 HTTPS 反向代理后，登记精确 `--entry` / `--trusted-host`，并按需增加网关层认证。不要用 `X-Forwarded-For` 作为身份依据。

→ [反向代理](/zh/advanced/reverse-proxy)

## 编辑、Git 与 AI

### 多人同时编辑会合并吗？

不会。当前没有 OT/CRDT；后保存可能覆盖先保存。用 Git 或协作约定避免竞争。AI edit 会在 Apply 前检查 drift，但普通编辑器不自动 merge。

### Markon 会 `git push` 吗？

不会。它读取本地 branches/tags/history/diff，并允许管理员 checkout 与创建本地 commit；不做 fetch、pull、push、merge 或 rebase。

### AI 会上传整个 Workspace 吗？

不会自动全量上传，但用户消息、选区、`@` 文件、thread 历史和模型工具读取的结果会发给已配置 Provider。只对愿意发送上下文的 Workspace 开启 Chat。

### AI 可以直接修改文件吗？

Chat + Edit 同时开启时，模型可以提出 exact-string edit。每一项都显示 diff 并等待 Apply/Reject；Apply 前检查 drift，应用后可 Undo。它不能创建、移动、删除文件或执行命令。

## 渲染与性能

### 支持哪些扩展？

GFM、脚注、GitHub Alerts、emoji shortcode、语法高亮、KaTeX，以及 Mermaid、PlantUML、D2、DOT/Graphviz、Vega/Vega-Lite、ECharts、Chart.js。

### 图表或图片太大怎么办？

点击视觉查看按钮进入全屏查看器，可缩放、拖动、双指缩放、框选、适应窗口。按 <kbd>?</kbd> 查看当前快捷键。

### 大 Workspace 会把全文复制到内存吗？

搜索索引使用临时 MmapDirectory；全文参与索引但不作为 stored field 再存一份。初次构建按 64 文件一批读取，watcher 更新批量合并。实际占用仍取决于文件量、正文和图表复杂度。

### 能导出 HTML 或 PDF 吗？

没有静态 HTML 导出器。PDF 使用浏览器整页打印或 Markon 章节打印后选择“另存为 PDF”。Notes 可以导出为可编辑 Markdown。

## 定位

### Markon 和 GitHub Markdown 有什么区别？

阅读样式以 GitHub 为基线，但 Markon 增加本地 Workspace、全文搜索、批注/Notes、Viewed、源码编辑、Git Rendered diff、Live、Workspace AI 与自定义主题。

### Markon 是静态站点生成器或 Obsidian 替代品吗？

不是。它不生成发布站点，也没有双链图谱和插件生态；重点是对本地 Markdown/Git Workspace 的阅读与审阅。
