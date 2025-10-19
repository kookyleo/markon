# Markon

一个轻量级的 Markdown 渲染工具，使用 Rust 编写，提供 GitHub 风格的样式和 Medium 风格的标注功能。

![Markon Banner](banner.png)

[English](README.md) | 简体中文

## 使用场景

Markon 让你可以便捷地以精美的 HTML 格式阅读、打印和批注 Markdown 文件。无论你是：

- **阅读文档** - 在没有图形界面的服务器上查看 Markdown 文档
- **审阅批注** - 使用高亮和笔记功能标注技术文档
- **打印输出** - 以专业的排版格式打印 Markdown 文件
- **演示展示** - 以 GitHub 风格渲染 Markdown 内容进行展示

只需在任意目录运行 `markon`，即可浏览并渲染 Markdown 文件，享受简洁无干扰的阅读体验。

## 功能特性

### 核心功能
- ✅ **GitHub 样式**: 完整的 GitHub Markdown CSS 样式（深色/浅色主题）
- ✅ **代码高亮**: 基于 Syntect 的语法高亮
- ✅ **GitHub Alerts**: 支持 NOTE、TIP、IMPORTANT、WARNING、CAUTION 五种提示框
- ✅ **Emoji 支持**: Unicode emoji shortcodes（如 `:smile:` → 😄）
- ✅ **Mermaid 图表**: 支持流程图、时序图、饼图等
- ✅ **主题切换**: 支持 light、dark、auto 三种主题模式
- ✅ **表格支持**: GitHub Flavored Markdown (GFM) 表格
- ✅ **任务列表**: 复选框任务列表
- ✅ **打印优化**: 专业的打印样式和多语言字体支持
- ✅ **目录生成**: 自动生成文章目录（TOC）
- ✅ **目录浏览**: 自动列出当前目录的 Markdown 文件
- ✅ **移动端友好**: 响应式设计，支持二维码生成便捷访问
- ✅ **零依赖部署**: 所有资源嵌入到单一二进制文件

### Medium 风格标注功能
- ✅ **文本高亮**: 选中文本后可添加橙色、绿色、黄色高亮
- ✅ **删除线**: 为文本添加删除线标记
- ✅ **笔记功能**: 为高亮文本添加批注笔记
- ✅ **侧边栏显示**: 笔记卡片显示在页面右侧，与高亮文本关联
- ✅ **取消高亮**: 选中已高亮的文本可取消高亮
- ✅ **持久化存储**: 标注数据保存在浏览器本地存储

### 章节已读标记功能
- ✅ **GitHub PR 风格复选框**: 在章节标题旁添加"Viewed"复选框
- ✅ **自动折叠**: 已读章节自动折叠以节省空间
- ✅ **点击展开**: 点击折叠的标题即可展开并取消勾选
- ✅ **状态持久化**: 已读状态按文件保存在 LocalStorage
- ✅ **智能折叠**: 折叠当前章节直到下一个同级或更高级标题

## 安装

### 从 crates.io 安装

```bash
cargo install markon
```

### 从源代码安装

```bash
cargo install --path .
```

### 直接运行（无需安装）

```bash
cargo run -- [OPTIONS] [FILE]
```

## 使用方法

### 基本用法

```bash
# 显示当前目录的 Markdown 文件列表
markon

# 渲染指定的 Markdown 文件
markon README.md

# 指定端口
markon -p 8080 README.md

# 使用深色主题
markon -t dark README.md

# 使用浅色主题
markon -t light README.md

# 自动主题（根据系统设置）
markon -t auto README.md
```

### 命令行参数

```
用法: markon [OPTIONS] [FILE]

参数:
  [FILE]  要渲染的 Markdown 文件

选项:
  -p, --port <PORT>                服务器端口 [默认: 6419]
  -t, --theme <THEME>              主题选择（light, dark, auto）[默认: auto]
      --qr [<BASE_URL>]            生成服务器地址的二维码。可选指定基础 URL（如 http://192.168.1.100:6419）以覆盖默认的本地地址
  -b, --open-browser [<BASE_URL>]  服务启动后自动打开浏览器。可选指定基础 URL（如 http://example.com:8080）以覆盖默认的本地地址
      --shared-annotation          启用共享标注模式。标注数据存储在 SQLite 数据库，多客户端通过 WebSocket 实时同步
      --enable-viewed              启用章节已读标记功能（GitHub PR 风格）
  -h, --help                       显示帮助信息
  -V, --version                    显示版本信息
```

### 高级用法示例

```bash
# 生成二维码以便手机访问（使用本地地址）
markon --qr

# 使用自定义基础 URL 生成二维码（如使用端口转发或公网 IP）
markon --qr http://192.168.1.100:6419

# 启动后自动打开浏览器（打开本地地址）
markon -b

# 使用自定义基础 URL 打开浏览器（适用于反向代理场景）
# 服务监听在 localhost:6419，但通过代理在 example.com 访问
markon -b http://example.com

# 组合选项：二维码 + 自动打开浏览器 + 深色主题
markon --qr -b -t dark README.md

# 完整示例：自定义端口、公网 IP 二维码、自动打开本地浏览器
markon -p 8080 --qr http://203.0.113.1:8080 -b

# 启用共享标注模式，多用户实时协作
markon --shared-annotation README.md

# 启用章节已读标记功能（GitHub PR 风格折叠）
markon --enable-viewed README.md

# 同时启用标注和已读标记功能
markon --shared-annotation --enable-viewed README.md
```

**理解 URL 参数**：

`--qr` 和 `-b` 选项都接受可选的 URL 参数：

**二维码（`--qr` 选项）**：
- 无参数（`--qr`）：为 `http://127.0.0.1:6419`（本地地址）生成二维码
- 带基础 URL（`--qr <BASE_URL>`）：为指定的 URL 生成二维码
- 使用场景：
  - **端口转发**：`--qr http://192.168.1.100:6419`（局域网 IP）
  - **公网访问**：`--qr http://example.com/docs`（公网域名）
  - **移动设备访问**：`--qr http://your-laptop-ip:6419`（同网络手机访问）

**打开浏览器（`-b` 选项）**：
- 无参数（`-b`）：打开 `http://127.0.0.1:6419`（本地地址）
- 带基础 URL（`-b <BASE_URL>`）：打开指定的 URL
- 使用场景：
  - **反向代理**：服务在 `localhost:6419`，代理在 `https://docs.example.com`
  - **SSH 隧道**：远程服务器通过隧道映射到 `http://localhost:8080`
  - **自定义路由**：任何指向运行服务器实例的 URL

### 使用标注功能

1. 在浏览器中打开 Markdown 文件
2. 选中任意文本，会弹出工具栏
3. 选择高亮颜色（橙色/绿色/黄色）、删除线或笔记
4. 笔记会显示在页面右侧
5. 点击高亮文本可查看对应笔记
6. 选中已高亮的文本可取消高亮

#### 两种标注模式

**本地模式（默认）**：
- 标注数据存储在浏览器的 LocalStorage 中
- 仅限单个浏览器使用，不同浏览器或设备间不共享
- 适合个人阅读和批注
- 无需额外配置

**共享模式（`--shared-annotation`）**：
- 标注数据存储在 SQLite 数据库中（默认路径：`~/.markon/annotation.sqlite`）
- 支持多客户端通过 WebSocket 实时同步标注
- 适合多种协作场景：
  - 单人多终端：在手机、平板、电脑等不同设备间同步标注
  - 团队协作：多用户同时查看和编辑同一文档的标注
- 可通过环境变量 `MARKON_SQLITE_PATH` 自定义数据库路径

```bash
# 使用共享标注模式
markon --shared-annotation README.md

# 自定义数据库位置
MARKON_SQLITE_PATH=/path/to/annotations.db markon --shared-annotation README.md
```

两种模式下都可以使用页面底部的"清除本页标注 (模式)"按钮清除当前页面的所有标注。

### 使用章节已读标记功能

章节已读标记功能仿照 GitHub PR 文件审核的"Viewed"功能，帮助您跟踪长文档的阅读进度。

**使用方法**：

1. 使用 `--enable-viewed` 参数启动 markon：
   ```bash
   markon --enable-viewed README.md
   ```

2. 每个章节标题（H2-H6）右侧会显示"Viewed"复选框

3. **勾选复选框**标记章节为已读：
   - 该章节自动折叠
   - 内容被隐藏，直到下一个同级或更高级标题
   - 标题显示"(click to expand)"提示

4. **点击折叠的标题**展开章节：
   - 章节内容重新显示
   - "Viewed"复选框自动取消勾选

**功能特性**：

- ✅ **状态持久化**：已读状态按文件保存在浏览器 LocalStorage
- ✅ **智能折叠**：只折叠当前章节，不影响其他分支的子章节
- ✅ **视觉反馈**：折叠的章节略微变暗并显示展开提示
- ✅ **键盘友好**：支持标准复选框键盘导航

**使用场景**：

- **长篇文档**：折叠已读章节，专注于未读内容
- **代码审查**：类似 GitHub PR 文件审核的工作流
- **学习材料**：跟踪教程的学习进度
- **技术规范**：隐藏已完成的章节，聚焦当前工作内容

**工作流示例**：

```bash
# 阅读长篇 API 文档
markon --enable-viewed API_DOCS.md

# 1. 阅读完"身份认证"章节 → 勾选"Viewed"
# 2. 阅读完"API 端点"章节 → 勾选"Viewed"
# 3. 正在处理"限流规则"章节 → 保持未勾选
# 4. 稍后返回 → 之前已读的章节仍然是折叠状态
# 5. 需要参考"身份认证" → 点击标题临时展开
```

## 重要说明

### 系统路径前缀

Markon 使用 `/_/` 作为所有系统资源（CSS、JavaScript、WebSocket、favicon）的保留路径前缀，确保系统文件与用户内容完全分离：

- **保留路径**：`/_/`（仅此特定前缀）
- **这意味着什么**：请勿在工作目录根目录创建名为 `_`（单下划线）的目录
- **您可以做什么**：
  - ✅ 创建 `_build/`、`__pycache__/`、`_test/`、`_cache/` 等目录（与 `_` 不同）
  - ✅ 创建 `ws/`、`static/`、`css/`、`js/` 等目录（不会冲突！）
  - ✅ 使用任何不以 `_/` 开头的文件或目录名

**示例**：
```bash
# ❌ 这会与系统路径冲突
mkdir _              # 不要创建单下划线目录
markon               # 系统使用 /_/css/*、/_/js/* 等

# ✅ 以下都可以正常使用
mkdir _build         # URL: /_build/* (不是 /_/*)
mkdir __pycache__    # URL: /__pycache__/* (不是 /_/*)
mkdir ws             # URL: /ws/* (与 /_/ws 不同！)
mkdir static         # URL: /static/* (不是 /_/*)
```

**使用反向代理时**：请确保配置代理转发 `/_/` 路径。详细的 Nginx、Caddy、Apache、Traefik 配置示例请参考 [REVERSE_PROXY.zh.md](REVERSE_PROXY.zh.md) ([English](REVERSE_PROXY.md))。

## 支持的 Markdown 特性

- **标题** (H1-H6)
- **粗体/斜体/删除线**
- **列表** (有序/无序)
- **任务列表** (- [ ] / - [x])
- **表格**
- **代码块** (支持语法高亮)
- **引用块**
- **链接和图片**
- **分隔线**
- **脚注**
- **Emoji** (:emoji_name:)
- **Mermaid 图表**
- **GitHub Alerts** ([!NOTE], [!TIP], etc.)

## Mermaid 图表示例

markon 支持 Mermaid 图表渲染，只需使用 \`\`\`mermaid 代码块：

\`\`\`markdown
\`\`\`mermaid
graph TD
    A[开始] --> B{判断}
    B -->|是| C[操作1]
    B -->|否| D[操作2]
\`\`\`
\`\`\`

支持的图表类型：
- 流程图 (graph/flowchart)
- 时序图 (sequenceDiagram)
- 饼图 (pie)
- 甘特图 (gantt)
- 类图 (classDiagram)
- 状态图 (stateDiagram)
- 等等...

## Emoji 支持

使用标准的 emoji shortcodes：

```markdown
:smile: :heart: :rocket: :tada: :sparkles:
```

渲染结果：😄 ❤️ 🚀 🎉 ✨

## GitHub Alerts 示例

使用特殊的 blockquote 语法创建提示框：

```markdown
> [!NOTE]
> 这是一条提示信息。

> [!TIP]
> 这是一条技巧提示。

> [!IMPORTANT]
> 这是一条重要信息。

> [!WARNING]
> 这是一条警告信息。

> [!CAUTION]
> 这是一条严重警告。
```

支持的类型：
- **NOTE** (蓝色) - 一般性提示信息
- **TIP** (绿色) - 有用的技巧或建议
- **IMPORTANT** (紫色) - 关键信息
- **WARNING** (黄色) - 需要注意的警告
- **CAUTION** (红色) - 危险或严重警告

## 项目来源

本项目移植自 [go-grip](https://github.com/kookyleo/go-grip)，使用 Rust 重新实现，并添加了 Medium 风格的标注功能。

### 与 go-grip 的主要区别

| 特性 | go-grip | markon |
|------|---------|---------|
| 语言 | Go | Rust |
| GitHub Alerts | ✅ | ✅ |
| Emoji | 自定义映射 | Unicode (emojis crate) |
| Medium 标注 | ❌ | ✅ |
| 热重载 | ✅ | ❌ |
| 自动打开浏览器 | ✅ | ✅ |
| 二维码生成 | ❌ | ✅ |
| 打印优化 | ✅ | ✅ |

## 技术栈

### 后端
- **Markdown 解析**: [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)
- **语法高亮**: [syntect](https://github.com/trishume/syntect)
- **HTTP 服务器**: [axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs/)
- **模板引擎**: [tera](https://github.com/Keats/tera)
- **静态资源嵌入**: [rust-embed](https://github.com/pyrossh/rust-embed)
- **Emoji**: [emojis](https://github.com/rosetta-rs/emojis)

### 前端
- **图表渲染**: [Mermaid.js](https://mermaid.js.org/)
- **样式**: [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css)
- **标注功能**: 原生 JavaScript + LocalStorage

## 开发

### 项目结构

```
markon/
├── src/
│   ├── main.rs         # 程序入口
│   ├── server.rs       # HTTP 服务器
│   ├── markdown.rs     # Markdown 渲染器
│   └── assets.rs       # 静态资源管理
├── assets/
│   ├── css/            # 样式表
│   │   ├── github-markdown-dark.css
│   │   ├── github-markdown-light.css
│   │   ├── github-print.css
│   │   └── editor.css  # 标注功能样式
│   ├── js/             # JavaScript
│   │   ├── mermaid.min.js
│   │   └── editor.js   # 标注功能逻辑
│   └── templates/      # HTML 模板
│       ├── layout.html
│       └── directory.html
├── Cargo.toml
├── README.md
└── README.zh.md
```

### 构建

```bash
# Debug 模式
cargo build

# Release 模式
cargo build --release

# 运行测试
cargo test

# 代码检查
cargo clippy

# JavaScript Lint
npx eslint assets/js/editor.js
```

## 贡献

我们欢迎所有形式的贡献！无论是报告 bug、提出新功能建议，还是提交代码改进。

### 如何贡献

1. **报告问题**：在 [GitHub Issues](https://github.com/kookyleo/markon/issues) 中提交 bug 报告或功能请求
2. **提交 PR**：
   - Fork 本项目
   - 创建特性分支（`git checkout -b feature/amazing-feature`）
   - 提交更改（`git commit -m 'Add some amazing feature'`）
   - 推送到分支（`git push origin feature/amazing-feature`）
   - 开启 Pull Request

### 代码规范

提交 PR 前请确保：
- ✅ 运行 `cargo test` 确保所有测试通过
- ✅ 运行 `cargo clippy` 确保代码符合 Rust 最佳实践
- ✅ 运行 `cargo fmt` 格式化代码
- ✅ 对 JavaScript 代码运行 `npx eslint assets/js/editor.js`

## License

Apache License 2.0

## 致谢

- [go-grip](https://github.com/kookyleo/go-grip) - 原始项目
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css) - 样式来源
- [Medium](https://medium.com) - 标注功能灵感来源
- 所有开源依赖库的贡献者

## 相关链接

- 原项目: https://github.com/kookyleo/go-grip
- GitHub Markdown 样式: https://github.com/sindresorhus/github-markdown-css
- Mermaid 文档: https://mermaid.js.org/
