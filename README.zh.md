# Markon

基于 Rust 开发的轻量级 Markdown 渲染器，提供 GitHub 风格样式和类似 Medium 的标注功能。

![Markon Banner](banner.png)

[English](README.md) | 简体中文

## 使用场景

Markon 让您能够以美观的 GitHub 风格阅读、审阅和验证 Markdown 文档。无论您是：

- **阅读与审阅** - 标注要点，使用 Section Viewed 复选框（GitHub PR 风格）跟踪进度
- **远程服务器** - 在无 GUI 的服务器上通过浏览器浏览和标注 Markdown 文件
- **团队协作** - 跨设备实时同步共享标注
- **打印与演示** - 专业排版和 GitHub 风格渲染，支持 Mermaid 图表

只需在任意目录运行 `markon`，即可以简洁、无干扰的界面浏览和渲染 Markdown 文件。

## 功能特性

### 核心渲染
- ✅ **GitHub 样式**：完整的 GitHub Markdown CSS，支持深色/浅色/自动主题
- ✅ **语法高亮**：基于 Syntect，支持 40+ 种编程语言
- ✅ **GitHub Alerts**：支持 NOTE、TIP、IMPORTANT、WARNING、CAUTION
- ✅ **Emoji 支持**：Unicode emoji 短代码（如 `:smile:` → 😄）
- ✅ **Mermaid 图表**：流程图、时序图、饼图等
- ✅ **GFM 表格**：完整的 GitHub Flavored Markdown 表格支持
- ✅ **任务列表**：交互式复选框任务列表
- ✅ **打印优化**：专业打印样式，支持多语言字体
- ✅ **自动目录**：自动生成目录，智能滚动
- ✅ **目录浏览**：浏览并选择当前目录中的 Markdown 文件
- ✅ **移动端友好**：响应式设计，支持 QR 码便捷移动访问
- ✅ **零依赖**：单一二进制文件，所有资源内嵌

### 标注系统
- ✅ **文本高亮**：三种颜色（橙色、绿色、黄色）用于不同目的
- ✅ **删除线**：标记文本为已删除或过时
- ✅ **笔记**：为任何高亮文本添加注释
- ✅ **侧边栏卡片**：笔记显示在右侧边栏（宽屏模式），智能定位
- ✅ **弹出式笔记**：笔记以弹窗形式显示（窄屏模式），靠近高亮文本
- ✅ **点击编辑**：点击高亮文本查看/编辑/删除笔记
- ✅ **清除选择**：再次选择高亮文本可移除高亮
- ✅ **两种存储模式**：
  - **本地模式**：浏览器 LocalStorage（单设备）
  - **共享模式**：SQLite + WebSocket（实时多设备同步）
- ✅ **撤销/重做**：完整支持所有标注操作的撤销/重做

### Section Viewed 系统
- ✅ **GitHub PR 风格复选框**：在标题（H2-H6）旁标记章节为"已查看"
- ✅ **自动折叠**：已勾选的章节自动折叠
- ✅ **点击展开**：切换折叠章节而不改变已查看状态
- ✅ **批量操作**：H1 标题后的"全部已查看"和"全部未查看"工具栏
- ✅ **视觉进度**：TOC 中已查看的章节变为绿色
- ✅ **智能折叠**：折叠内容直到下一个同级或更高级标题
- ✅ **两种存储模式**：
  - **本地模式**：浏览器 LocalStorage（每个浏览器独立）
  - **共享模式**：SQLite + WebSocket（跨设备同步）
- ✅ **独立切换**：展开/折叠不改变已查看状态

### 章节打印
- ✅ **独立打印**：在标题（H2-H6）旁提供"打印"按钮
- ✅ **精确范围**：仅打印当前章节内容（从标题到下一个同级或更高级标题）
- ✅ **清洁输出**：打印时自动隐藏交互元素（复选框、按钮等）
- ✅ **保留样式**：打印保持 GitHub 风格的专业排版
- ✅ **一键操作**：点击"打印"按钮即可调用系统打印对话框

### 全文搜索
- ✅ **Tantivy 引擎**：快速全文搜索引擎，支持内存索引
- ✅ **中文支持**：Jieba 分词，精确匹配中文文本
- ✅ **多字段搜索**：搜索文件路径、名称、标题和内容
- ✅ **代码片段预览**：高亮显示搜索结果和上下文摘录
- ✅ **自动滚动与高亮**：跳转到精确位置，临时高亮关键词
- ✅ **键盘导航**：`↑/↓` 选择结果，`Enter` 跳转
- ✅ **自动索引**：文件监视器自动更新索引
- ✅ **便携 URL**：相对路径确保导航一致性
- ✅ **简洁 UI**：全屏搜索，内容宽度限制 980px
- ✅ **快速访问**：按 `/` 打开搜索，`ESC` 关闭

### 键盘快捷键
- ✅ **撤销/重做**：`Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`、`Ctrl/Cmd+Y`
- ✅ **导航**：`j/k`（下一个/上一个标题）、`Ctrl/Cmd+j/k`（下一个/上一个标注）
- ✅ **智能滚动**：`Space`（平滑滚动 1/3 页，`ESC` 停止）
- ✅ **TOC 控制**：`Ctrl/Cmd+\`（切换/聚焦 TOC）
- ✅ **章节控制**：`o`（折叠/展开当前章节）
- ✅ **已查看控制**：`v`（切换当前章节已查看状态）
- ✅ **搜索**：`/`（打开全文搜索）
- ✅ **帮助面板**：`?`（显示所有快捷键）
- ✅ **关闭/取消**：`ESC`（关闭弹窗、清除选择、取消聚焦）
- ✅ **平台检测**：自动检测 Mac vs Windows/Linux 的修饰键

### UI/UX 增强
- ✅ **智能弹出框**：选择工具栏自动定位（上方/下方）
- ✅ **模态系统**：统一的模态管理器，用于笔记和确认对话框
- ✅ **选择覆盖层**：笔记输入时视觉选择高亮保持
- ✅ **焦点管理**：点击 markdown 区域外清除章节焦点
- ✅ **响应式布局**：适应宽屏（1400px+）和窄屏模式
- ✅ **笔记定位**：智能定位，避开滚动条和屏幕边缘
- ✅ **防止滚动**：模态/弹出框聚焦不触发自动滚动

### 开发者特性
- ✅ **模块化架构**：清晰分离（managers、navigators、components、services）
- ✅ **配置系统**：集中式配置，冻结常量
- ✅ **日志工具**：结构化日志用于调试
- ✅ **WebSocket 管理器**：自动重连，指数退避
- ✅ **存储抽象**：本地 vs 共享存储的策略模式
- ✅ **事件系统**：WebSocket 和标注变更的发布/订阅

## 安装

### 从 crates.io 安装

```bash
cargo install markon
```

### 从源码安装

```bash
cargo install --path .
```

### 从 GitHub Releases 安装

从 [Releases](https://github.com/kookyleo/markon/releases) 下载预编译二进制文件。

## 使用方法

### 基本用法

```bash
# 渲染单个文件
markon README.md

# 目录浏览模式
markon

# 自定义端口
markon -p 8080

# 指定绑定地址
markon -l 0.0.0.0

# 自动打开浏览器
markon -b README.md
```

### 命令行选项

| 选项 | 说明 | 示例 |
|------|------|------|
| `<FILE>` | 要渲染的 Markdown 文件 | `markon README.md` |
| `-p, --port <PORT>` | HTTP 服务器端口（默认：6419） | `markon -p 8080` |
| `-l, --listen <ADDR>` | 绑定地址（默认：127.0.0.1） | `markon -l 0.0.0.0` |
| `-b, --browser [URL]` | 启动后自动打开浏览器 | `markon -b` |
| `--qr [URL]` | 生成 QR 码用于移动访问 | `markon --qr` |
| `--theme <THEME>` | 颜色主题：light/dark/auto | `markon --theme dark` |
| `--shared-annotation` | 启用共享标注（SQLite + WebSocket） | `markon --shared-annotation` |
| `--enable-viewed` | 启用 Section Viewed 功能 | `markon --enable-viewed` |
| `--enable-search` | 启用全文搜索（Tantivy） | `markon --enable-search` |

### 常用示例

```bash
# 带 QR 码的目录浏览
markon --qr

# 自定义 QR 码 URL（反向代理）
markon --qr http://192.168.1.100:6419

# 自动打开浏览器，使用自定义 URL（反向代理）
markon -b http://docs.example.com

# 启用共享标注（多设备同步）
markon --shared-annotation README.md

# 启用 viewed 功能（跟踪阅读进度）
markon --enable-viewed README.md

# 启用全文搜索
markon --enable-search

# 全功能：QR + 浏览器 + 共享 + viewed + 搜索
markon --qr -b --shared-annotation --enable-viewed --enable-search README.md
```

### 功能指南

**标注**：
- 选择文本 → 从工具栏选择高亮/删除线/笔记
- 本地模式：存储在浏览器 LocalStorage
- 共享模式（`--shared-annotation`）：SQLite 数据库，通过 WebSocket 实时同步
- 自定义数据库路径：`MARKON_SQLITE_PATH=/path/to/db markon --shared-annotation`

**Section Viewed**（`--enable-viewed`）：
- 标题旁的复选框 → 章节折叠
- 点击"(点击展开)" → 临时查看折叠的章节
- 取消勾选 → 章节永久展开
- 批量工具栏（H1 后）："全部已查看" / "全部未查看"按钮
- 存储：LocalStorage（默认）或 SQLite（配合 `--shared-annotation`）

**全文搜索**（`--enable-search`）：
- 按 `/` 打开搜索模态框
- 输入关键词搜索所有 markdown 文件
- 使用 `↑/↓` 箭头键导航结果，`Enter` 跳转
- 结果显示文件路径、标题和高亮的代码片段
- 点击结果或按 `Enter` 跳转，支持自动滚动和关键词高亮
- 中文文本自动使用 Jieba 分词，精确匹配

**键盘快捷键**（按 `?` 查看全部）：
- `/`：打开搜索（需要 `--enable-search`）
- `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`：撤销/重做标注
- `j` / `k`：下一个/上一个标题
- `Ctrl/Cmd+\`：切换 TOC
- `v`：切换当前章节已查看状态（需要 `--enable-viewed`）
- `ESC`：关闭弹窗/清除选择

## 重要说明

### 系统路径前缀

Markon 使用 `/_/` 作为所有系统资源（CSS、JavaScript、WebSocket、favicon）的保留路径前缀。这确保系统文件与您的内容完全分离：

- **保留路径**：`/_/`（仅此特定前缀）
- **注意事项**：不要在工作目录根目录创建名为 `_`（单下划线）的目录
- **允许操作**：
  - ✅ 创建 `_build/`、`__pycache__/`、`_test/`、`_cache/` 等目录（与 `_` 不同）
  - ✅ 创建 `ws/`、`static/`、`css/`、`js/` 等目录（无冲突！）
  - ✅ 使用任何不以 `_/` 开头的文件或目录名

**为什么？** Markon 将 `/_/` 映射到系统资源。浏览器会将 `/ws` 和 `/_/ws` 视为不同路径，因此只有精确的 `_/` 前缀是保留的。

### 共享标注模式

启用 `--shared-annotation` 时：

**数据库位置**：
- Linux/macOS：`~/.local/share/markon/annotations.db`
- Windows：`%APPDATA%\markon\annotations.db`
- 自定义：设置 `MARKON_SQLITE_PATH` 环境变量

**同步机制**：
- 通过 WebSocket 实时同步标注和 viewed 状态
- 自动重连，指数退避
- 广播到所有连接的客户端

**多设备用法**：
1. 在服务器启动：`markon --shared-annotation -l 0.0.0.0 README.md`
2. 在任何设备打开：`http://server-ip:6419`
3. 所有标注在设备间实时同步

### 反向代理

通过反向代理暴露 Markon 时，使用 `--browser` 和 `--qr` 指定公共 URL：

```bash
# Nginx 监听 docs.example.com
markon -b http://docs.example.com --qr http://docs.example.com
```

参见 [反向代理配置指南](REVERSE_PROXY.zh.md) 了解详细设置。

## GitHub Alerts

支持 GitHub 风格的提示块：

```markdown
> [!NOTE]
> 高亮需要注意的信息。

> [!TIP]
> 可选信息，帮助用户更成功。

> [!IMPORTANT]
> 用户成功所需的关键信息。

> [!WARNING]
> 由于潜在风险需要用户立即注意的关键内容。

> [!CAUTION]
> 操作的负面潜在后果。
```

颜色主题：
- **NOTE**（蓝色）- 高亮信息
- **TIP**（绿色）- 可选提示
- **IMPORTANT**（紫色）- 关键信息
- **WARNING**（黄色）- 重要警告
- **CAUTION**（红色）- 危险或严重警告

## 技术栈

### 后端
- **Markdown 解析**：[pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)
- **语法高亮**：[syntect](https://github.com/trishume/syntect)
- **HTTP 服务器**：[axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs/)
- **模板引擎**：[tera](https://github.com/Keats/tera)
- **静态资源嵌入**：[rust-embed](https://github.com/pyrossh/rust-embed)
- **Emoji**：[emojis](https://github.com/rosetta-rs/emojis)
- **全文搜索**：[tantivy](https://github.com/quickwit-oss/tantivy) + [tantivy-jieba](https://github.com/baoyachi/tantivy-jieba)

### 前端
- **图表渲染**：[Mermaid.js](https://mermaid.js.org/)
- **样式**：[GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css)
- **架构**：ES6 模块，面向对象设计，策略模式

## 常见问题

<details>
<summary><strong>如何从其他设备访问？</strong></summary>

在服务器上使用 `-l 0.0.0.0` 绑定所有接口：

```bash
markon -l 0.0.0.0 README.md
```

然后从任何设备打开 `http://server-ip:6419`。使用 `--qr` 生成移动访问 QR 码。
</details>

<details>
<summary><strong>标注存储在哪里？</strong></summary>

**本地模式**（默认）：浏览器 LocalStorage（每个浏览器独立）

**共享模式**（`--shared-annotation`）：SQLite 数据库
- Linux/macOS：`~/.local/share/markon/annotations.db`
- Windows：`%APPDATA%\markon\annotations.db`
- 自定义：`MARKON_SQLITE_PATH=/path/to/db markon --shared-annotation`
</details>

<details>
<summary><strong>如何使用 Nginx/Apache 反向代理？</strong></summary>

Nginx 示例：

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

然后使用：
```bash
markon -b http://yourdomain.com --qr http://yourdomain.com
```

参见 [反向代理指南](REVERSE_PROXY.zh.md) 了解详细配置。
</details>

<details>
<summary><strong>可以同时渲染多个文件吗？</strong></summary>

不支持。Markon 一次渲染一个文件，但提供目录浏览模式快速切换：

```bash
markon  # 在当前目录浏览所有 .md 文件
```
</details>

<details>
<summary><strong>如何更改端口？</strong></summary>

```bash
markon -p 8080 README.md
```
</details>

<details>
<summary><strong>支持哪些主题？</strong></summary>

三种主题模式：
- `--theme light`：强制浅色主题
- `--theme dark`：强制深色主题
- `--theme auto`（默认）：跟随系统设置
</details>

## 开发

### 构建

```bash
# 开发构建
cargo build

# 发布构建
cargo build --release

# 运行测试
cargo test

# JavaScript lint
npx eslint assets/js/**/*.js

# 运行
./target/debug/markon README.md
```

## 贡献

欢迎贡献！无论是 bug 报告、功能请求还是代码改进。

### 如何贡献

1. **报告问题**：通过 [GitHub Issues](https://github.com/kookyleo/markon/issues) 提交 bug 或功能请求
2. **提交 PR**：
   - Fork 仓库
   - 创建功能分支（`git checkout -b feature/your-feature`）
   - 提交更改（`git commit -m 'Add your feature'`）
   - 推送分支（`git push origin feature/your-feature`）
   - 创建 Pull Request

### 提交 PR 前

- 运行 `cargo test` - 确保所有测试通过
- 运行 `cargo clippy` - 检查代码质量
- 运行 `cargo fmt` - 格式化代码
- 运行 `npx eslint assets/js/**/*.js` - 检查 JavaScript 代码
- 手动测试更改

## 许可证

Apache License 2.0

## 致谢

- [go-grip](https://github.com/kookyleo/go-grip) - Markdown 渲染的最初启发
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css) - 样式来源
- [Medium](https://medium.com) - 标注功能灵感
- 所有开源贡献者

## 链接

- GitHub Markdown CSS: https://github.com/sindresorhus/github-markdown-css
- Mermaid 文档: https://mermaid.js.org/
- go-grip: https://github.com/kookyleo/go-grip
