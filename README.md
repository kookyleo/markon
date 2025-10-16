# Markon

A lightweight Markdown renderer with GitHub styling, written in Rust.

markon 是一个轻量级的 Markdown 渲染工具，使用 Rust 编写，提供 GitHub 风格的样式。

## Features 功能特性

- ✅ **GitHub 样式**: 完整的 GitHub Markdown CSS 样式（深色/浅色主题）
- ✅ **代码高亮**: 基于 Syntect 的语法高亮
- ✅ **GitHub Alerts**: 支持 NOTE、TIP、IMPORTANT、WARNING、CAUTION 五种提示框
- ✅ **Emoji 支持**: Unicode emoji shortcodes（如 `:smile:` → 😄）
- ✅ **Mermaid 图表**: 支持流程图、时序图、饼图等
- ✅ **主题切换**: 支持 light、dark、auto 三种主题模式
- ✅ **表格支持**: GitHub Flavored Markdown (GFM) 表格
- ✅ **任务列表**: 复选框任务列表
- ✅ **打印优化**: 专业的打印样式和多语言字体支持
- ✅ **目录浏览**: 自动列出当前目录的 Markdown 文件
- ✅ **零依赖部署**: 所有资源嵌入到单一二进制文件

## Installation 安装

```bash
cargo install --path .
```

或者直接运行：

```bash
cargo run -- [OPTIONS] [FILE]
```

## Usage 使用方法

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
Options:
  [FILE]                    要渲染的 Markdown 文件（可选）
  -p, --port <PORT>         服务器端口 [default: 6419]
  -b, --no-browser          不自动打开浏览器
  -t, --theme <THEME>       主题选择: light, dark, auto [default: auto]
  -h, --help                显示帮助信息
  -V, --version             显示版本信息
```

## Supported Markdown Features 支持的 Markdown 特性

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

本项目移植自 [go-grip](https://github.com/kookyleo/go-grip)，使用 Rust 重新实现。

### 主要区别

| 特性 | go-grip | markon |
|------|---------|---------|
| 语言 | Go | Rust |
| GitHub Alerts | ✅ | ✅ |
| Emoji | 自定义映射 | Unicode (emojis crate) |
| 热重载 | ✅ | ❌ 不支持 |
| 自动打开浏览器 | ✅ | ❌ 不支持 |
| 打印优化 | ✅ | ✅ |

## 技术栈

- **Markdown 解析**: [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)
- **语法高亮**: [syntect](https://github.com/trishume/syntect)
- **HTTP 服务器**: [axum](https://github.com/tokio-rs/axum) + [tokio](https://tokio.rs/)
- **模板引擎**: [tera](https://github.com/Keats/tera)
- **静态资源嵌入**: [rust-embed](https://github.com/pyrossh/rust-embed)
- **Emoji**: [emojis](https://github.com/rosetta-rs/emojis)
- **图表渲染**: [Mermaid.js](https://mermaid.js.org/)

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
│   ├── css/            # GitHub 样式表
│   │   ├── github-markdown-dark.css
│   │   ├── github-markdown-light.css
│   │   └── github-print.css
│   ├── js/             # JavaScript 库
│   │   └── mermaid.min.js
│   └── templates/      # HTML 模板
│       ├── layout.html
│       └── directory.html
├── Cargo.toml
├── README.md
└── MIGRATION_PLAN.md   # 迁移方案文档
```

### 构建

```bash
# Debug 模式
cargo build

# Release 模式
cargo build --release

# 运行测试
cargo test

# 运行示例
cargo run -- TEST.md
```

## License 许可证

Apache License 2.0

## 致谢

- [go-grip](https://github.com/kookyleo/go-grip) - 原始项目
- [GitHub Markdown CSS](https://github.com/sindresorhus/github-markdown-css) - 样式来源
- 所有开源依赖库的贡献者

## 相关链接

- 原项目: https://github.com/kookyleo/go-grip
- GitHub Markdown 样式: https://github.com/sindresorhus/github-markdown-css
- Mermaid 文档: https://mermaid.js.org/
