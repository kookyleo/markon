# 快速上手

本指南帮你在 5 分钟内上手 Markon。

## 桌面版

### 1. 下载安装包

从 [GitHub Releases](https://github.com/kookyleo/markon/releases/latest) 下载对应平台的安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `Markon_x.x.x_aarch64.dmg` |
| Windows | `Markon_x.x.x_x64-setup.exe` |
| Linux (Debian/Ubuntu) | `Markon_x.x.x_amd64.deb` |
| Linux (通用) | `Markon_x.x.x_amd64.AppImage` |

### 2. 添加工作区

启动 Markon 后，在 **工作区** 标签页点击左下角 ➕ 按钮，选择任意包含 Markdown 文件的目录。

<!-- TODO: screenshot: 添加工作区 (/screenshots/add-workspace.png) -->

### 3. 在浏览器中查看

点击工作区条目的 ↗ 图标，Markon 会在默认浏览器中打开渲染好的页面。

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
