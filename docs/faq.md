# 常见问题

## 安装 / 启动

### macOS 提示"无法验证开发者"怎么办？

Markon 使用 ad-hoc 签名（免费签名方式）。首次启动时：

1. 双击 `Markon.app`，会弹出"无法打开 'Markon'…" 对话框 — 点 **关闭**
2. 前往 **系统设置 → 隐私与安全性**，滚动到底部
3. 在 "已阻止打开 'Markon'" 一行点 **仍要打开**，再次确认即可

![macOS Gatekeeper：在系统设置点 Open Anyway，确认放行 Markon](/screenshots/macos-gatekeeper.png)

之后启动就不会再提示。

::: details 较老版本 macOS（Monterey 及更早）

如果系统设置中没有 "Open Anyway" 按钮，请在 Finder 的 Applications 目录中 **右键**（或 Control+点击）Markon.app → 选择 **Open**，弹出确认框后再点 **Open** 即可。

![macOS 较老版本：右键打开放行 Markon](/screenshots/macos-gatekeeper-legacy.png)

:::

### Windows 提示"Windows 已保护你的电脑"？

NSIS 安装包未做代码签名，会触发 SmartScreen：

1. 在弹窗中点左下角 **更多信息**
2. 展开后点 **仍要运行**

![Windows SmartScreen：点 More info 展开后选择 Run anyway](/screenshots/windows-smartscreen.png)

### `cargo install markon` 编译失败？

确保 Rust 版本 ≥ 1.80：

```bash
rustup update stable
```

如果是 Linux，可能需要装 pkg-config：

```bash
sudo apt install pkg-config libssl-dev  # Debian/Ubuntu
```

## 功能

### 标注保存在哪？

- **默认（本地模式）**：浏览器 LocalStorage，每个浏览器独立
- **共享模式（`--shared-annotation`）**：SQLite 数据库
  - macOS/Linux：`~/.markon/annotation.sqlite`
  - Windows：`%USERPROFILE%\.markon\annotation.sqlite`
  - 自定义：`MARKON_SQLITE_PATH=/path/to/db`

### 怎么让其他设备也能访问？

服务器启动时加 `--host 0.0.0.0`：

```bash
markon --host 0.0.0.0 README.md
```

然后从其他设备访问 `http://{IP}:{PORT}`（默认为 6419 端口）。如果希望在终端显示二维码以便手机扫描，可以使用 `--entry`（或 `--qr`）指定**访问地址前缀**（包含协议、IP 和端口）：

```bash
# 示例：如果你有一个域名或反向代理指向此地址，则可以：
markon --host 0.0.0.0 --entry {YOUR_URL}
```

![Markon CLI：使用 --entry 指定外部入口并显示二维码](/screenshots/cli-qr.png)

Markon 会自动在该前缀后追加当前工作区的路径，生成完整的访问二维码。

### 能同时打开多个文件/目录吗？

- **桌面版**：可以。**工作区** 标签页支持添加任意多个工作区，每个对应一个目录。
- **CLI**：支持。
  - **追加**：若已有 Markon 服务正在运行，再次运行 `markon <目录>` 会自动将该目录作为新工作区追加。
### 如何停止 Markon 服务？

由于 CLI 默认开启驻留模式，当你不再需要服务时，可以运行以下命令优雅关闭：

```bash
markon shutdown
```

这会确保所有标注数据安全保存并清理运行锁。

### 能修改默认端口吗？

- **桌面版**：**全局设置 → 监听 → 端口**
- **CLI**：`markon -p 8080`

## 渲染

### 支持哪些 Markdown 扩展？

- GitHub Flavored Markdown（表格、任务列表、删除线等）
- GitHub Alerts（`[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`）
- Emoji 短代码（`:smile:` → 😄）
- Mermaid 代码块（自动渲染为图表）
- 40+ 语言的语法高亮（Syntect）

### Mermaid 图表不显示？

检查代码块是否用 ` ```mermaid ` 开头。如果还不行，看浏览器 Console 是否有 JS 错误（某些语法 Mermaid 版本不同可能报错）。

### 深色模式下图片太亮？

在浏览器页面里切到深色主题时，图片不会自动变暗。如需可在 **全局设置 → 页面样式** 中调整。

## 同步 / 协作

### 共享模式支持用户权限管理吗？

不支持。Markon 设计为"所有连接客户端平等"，适合小团队 wiki 或读书会场景，不适合需要权限控制的正式文档系统。

### 能和 Obsidian / VS Code 共享标注数据吗？

不能。Markon 的标注格式是自己的（基于 XPath 定位），无法与其他工具互通。

### 多人同时编辑会冲突吗？

会。编辑模式没有冲突检测，后保存的会覆盖先保存的。建议：

- 读写分离：一人编辑其他人看
- 或者用 Git 管理源文件，Markon 只做阅读展示

## 性能

### 大型工作区（几千个 md 文件）会卡吗？

- **启动**：首次索引 1000 个文件约 1-2 秒
- **搜索**：Tantivy 引擎毫秒级响应
- **渲染**：单文件渲染在 Rust 里极快，瓶颈通常在浏览器端的 Mermaid/MathJax

建议大型工作区开启 `--enable-search`，用搜索代替目录浏览。

### 内存占用大吗？

- 空闲：5-20 MB
- 索引 1000 个文件：+10-50 MB
- 打开文件阅读：+5-10 MB（主要是浏览器端）

## 其他

### 能打印 PDF 吗？

打印对话框选择 "另存为 PDF" 即可。Markon 的 [章节打印](/features/print) 只导出选定章节，适合做 PDF 切片。

### 能导出成 HTML 吗？

没有内置导出功能，但你可以用 `wget` 抓取：

```bash
wget --recursive --no-parent --convert-links http://127.0.0.1:6419/
```

### 为什么叫 Markon？

**Mark-on** — "Turn your markdown **on**"。像 Markdown 的"开关"，启动它让文档活起来。

### 和 GitHub 渲染有何不同？

Markon 复用了 `github-markdown-css` 作为基础样式，核心渲染非常接近 GitHub。增量部分：

- 实时批注、已读追踪、编辑器（GitHub 没有）
- 全文搜索（GitHub 只能搜索代码）
- 自定义样式/主题（GitHub 固定）
- 本地优先（GitHub 需要上传）
