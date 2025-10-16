# Markon

一个轻量级的 Markdown 渲染工具，使用 Rust 编写，提供 GitHub 风格的样式和 Medium 风格的标注功能。

[English](README.md) | 简体中文

## 使用场景

Markon 让你可以便捷地以精美的 HTML 格式阅读、打印和批注 Markdown 文件。无论你是：

- **阅读文档** - 在没有图形界面的服务器上查看 Markdown 文档
- **审阅批注** - 使用高亮和笔记功能标注技术文档
- **打印输出** - 以专业的排版格式打印 Markdown 文件
- **演示展示** - 以 GitHub 风格渲染 Markdown 内容进行展示
- **协作分享** - 分享带有批注的文档视图进行协作

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
- ✅ **零依赖部署**: 所有资源嵌入到单一二进制文件

### Medium 风格标注功能
- ✅ **文本高亮**: 选中文本后可添加橙色、绿色、黄色高亮
- ✅ **删除线**: 为文本添加删除线标记
- ✅ **笔记功能**: 为高亮文本添加批注笔记
- ✅ **侧边栏显示**: 笔记卡片显示在页面右侧，与高亮文本关联
- ✅ **取消高亮**: 选中已高亮的文本可取消高亮
- ✅ **持久化存储**: 标注数据保存在浏览器本地存储

## 安装

从源代码安装：

```bash
cargo install --path .
```

或者直接运行：

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
选项:
  [FILE]                    要渲染的 Markdown 文件（可选）
  -p, --port <PORT>         服务器端口 [默认: 6419]
  -b, --no-browser          不自动打开浏览器
  -t, --theme <THEME>       主题选择: light, dark, auto [默认: auto]
  -h, --help                显示帮助信息
  -V, --version             显示版本信息
```

### 使用标注功能

1. 在浏览器中打开 Markdown 文件
2. 选中任意文本，会弹出工具栏
3. 选择高亮颜色（橙色/绿色/黄色）、删除线或笔记
4. 笔记会显示在页面右侧
5. 点击高亮文本可查看对应笔记
6. 选中已高亮的文本可取消高亮

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
| 自动打开浏览器 | ✅ | ❌ |
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
