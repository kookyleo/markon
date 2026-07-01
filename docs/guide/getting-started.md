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
| Linux AppImage (amd64) | `Markon_x.x.x_amd64.AppImage` |
| Linux AppImage (arm64) | `Markon_x.x.x_arm64.AppImage` |

### 2. 使用 Markon

分述两种场景。

#### 场景 A：针对某目录（工作区）文档集的阅览、批注、对话和团队协作

可以视为某个工程项目的 **Markdown 文档 IDE**，这也是 Markon 设计初衷的典型场景。

加入的工作区会常驻在 Markon 的 **工作区** 标签页，后续可以一键打开。有几种启动方式：

- **从 markon 开始**：启动 Markon，在 **工作区** 标签页点左下角 ➕，手选目录。
- **macOS — Finder 工具栏**：把 `/Applications/Markon.app` 拖到 Finder 窗口顶部的工具栏，之后进入任意目录点一下图标，就把当前目录加入并打开。
- **Windows — 右键菜单**：在资源管理器里右键文件夹 → **使用 markon 打开**。

<!-- TODO: screenshot: 添加工作区 (/screenshots/add-workspace.png) -->

#### 场景 B：阅览单个 md 文件

项目级的 IDE 当然也可以 handle 单个文件。

打开单个文件也会创建一个**单文件工作区**：它同样出现在 Markon 的 **工作区** 标签页里（带一个文件图标），和普通工作区一样可以配置。区别在于它是**临时**的 —— 不会在重启 Markon 后保留，全文搜索的范围也只限这一个文件。

- **macOS / Windows**：右键文件 → **打开方式 → Markon**，浏览器直接出结果。
- 如果配置了默认打开方式，双击也同样可以直接启动它。

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

# 添加工作区时设置协作者访问码（远程访客门禁；本机始终免码）
markon --collaborator-access-code guest-secret README.md

# 搜索、编辑、Live、AI 对话等功能在浏览器工作区设置页开启
markon README.md
```

### 3. 局域网访问

```bash
# 绑定所有网络接口，允许局域网访问
markon --host 0.0.0.0 README.md

# 交互式选择网络接口
markon --host

# 通过 --entry 指定外部访问地址，终端会显示 QR 码方便移动端扫码
markon --host 0.0.0.0 --entry https://example.com/
```

![CLI 启动后显示访问链接和 QR 码，移动端扫码即可打开](/screenshots/cli-qr.png)

→ 完整选项见 [命令行选项](/guide/cli)

---

## 下一步

- 了解 [核心功能](/features/search) — 全文搜索、已读追踪、快捷编辑、批注与高亮、章节打印、[实时协作 Live](/features/live)、[与文档对话](/features/chat)
- 配置 [共享批注](/advanced/shared-annotations) 实现多端同步
- 查看 [键盘快捷键](/advanced/shortcuts) 提升效率
