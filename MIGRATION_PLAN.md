# Markon 迁移方案

从 [go-grip](https://github.com/kookyleo/go-grip) 到 markon 的功能迁移计划

## 项目概述

**目标**: 将 go-grip 的所有核心功能移植到 Rust 实现的 markon 项目

**当前状态**: ✅ 基础 Markdown 渲染已完成，需要补充样式和扩展功能

## 迁移优先级

### 第一阶段：核心样式和布局 (P0 - 必须)
- [ ] GitHub Markdown 样式表（深色/浅色主题）
- [ ] 打印优化样式
- [ ] HTML 布局模板
- [ ] 静态资源管理（使用 `rust-embed`）

### 第二阶段：扩展功能 (P1 - 重要)
- [ ] GitHub Alerts（NOTE、WARNING、CAUTION、IMPORTANT、TIP）
- [ ] Emoji 支持（Unicode + 图片）
- [ ] 任务列表渲染优化
- [ ] 主题切换功能

### 第三阶段：高级功能 (P2 - 增强)
- [ ] Mermaid 图表支持
- [ ] 热重载功能
- [ ] 代码高亮主题改进
- [ ] 多语言字体优化

### 第四阶段：开发体验 (P3 - 可选)
- [ ] 文件监控和自动刷新
- [ ] 自动打开浏览器
- [ ] 更多命令行参数

---

## 详细实施计划

## 阶段 1: 核心样式和布局

### 1.1 目录结构设计

```
markon/
├── src/
│   ├── main.rs
│   ├── server.rs
│   ├── markdown.rs
│   ├── assets.rs          # 新增：静态资源管理
│   └── theme.rs           # 新增：主题管理
├── assets/                # 新增：静态资源目录
│   ├── css/
│   │   ├── github-markdown-dark.css
│   │   ├── github-markdown-light.css
│   │   └── github-print.css
│   ├── js/
│   │   └── mermaid.min.js
│   ├── templates/
│   │   ├── layout.html
│   │   └── alerts/
│   │       ├── note.html
│   │       ├── warning.html
│   │       ├── caution.html
│   │       ├── important.html
│   │       └── tip.html
│   └── emojis/            # 自定义 emoji 图片
├── Cargo.toml
└── README.md
```

### 1.2 依赖添加

需要在 `Cargo.toml` 中添加：

```toml
[dependencies]
# 现有依赖...
rust-embed = "8.5"          # 嵌入静态资源
tera = "1.20"               # 模板引擎（类似 Go template）
mime_guess = "2.0"          # MIME 类型检测
```

### 1.3 静态资源嵌入

创建 `src/assets.rs`:

```rust
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/css/"]
pub struct CssAssets;

#[derive(RustEmbed)]
#[folder = "assets/js/"]
pub struct JsAssets;

#[derive(RustEmbed)]
#[folder = "assets/templates/"]
pub struct Templates;

#[derive(RustEmbed)]
#[folder = "assets/emojis/"]
pub struct Emojis;
```

### 1.4 CSS 样式迁移

**任务**:
1. 从 go-grip 复制以下 CSS 文件：
   - `github-markdown-dark.css`
   - `github-markdown-light.css`
   - `github-print.css`

2. 调整 CSS 中的路径引用（emoji 图片等）

3. 在 `server.rs` 中添加 CSS 文件服务路由：
   ```rust
   .route("/static/css/:filename", get(serve_css))
   ```

### 1.5 HTML 模板改造

**当前问题**: 直接在代码中拼接 HTML 字符串

**改进方案**: 使用 Tera 模板引擎

**layout.html 模板结构**:
```html
<!DOCTYPE html>
<html lang="zh-CN" dir="auto">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ title }}</title>
    <link rel="stylesheet" href="/static/css/github-markdown-{{ theme }}.css">
    <link rel="stylesheet" href="/static/css/github-print.css" media="print">
    <style>
        .markdown-body {
            box-sizing: border-box;
            min-width: 200px;
            max-width: 980px;
            margin: 0 auto;
            padding: 45px;
        }
    </style>
</head>
<body>
    <div class="markdown-body">
        {% if show_back_link %}
        <div style="margin-bottom: 20px;">
            <a href="/">← 返回文件列表</a>
        </div>
        {% endif %}
        {{ content | safe }}
    </div>
    {% if enable_mermaid %}
    <script src="/static/js/mermaid.min.js"></script>
    <script>
        mermaid.initialize({
            startOnLoad: true,
            theme: '{{ theme }}' === 'dark' ? 'dark' : 'default'
        });
    </script>
    {% endif %}
</body>
</html>
```

---

## 阶段 2: 扩展功能

### 2.1 GitHub Alerts 实现

**原理**: 检测块引用中的特殊标记并转换为 HTML

**实现位置**: `src/markdown.rs`

**步骤**:
1. 在 Markdown 解析过程中检测 blockquote 内容
2. 匹配 `[!NOTE]`、`[!WARNING]` 等标记
3. 使用对应的 HTML 模板替换

**示例代码**:
```rust
fn process_github_alerts(html: &str) -> String {
    let alert_types = vec![
        ("NOTE", "note"),
        ("WARNING", "warning"),
        ("CAUTION", "caution"),
        ("IMPORTANT", "important"),
        ("TIP", "tip"),
    ];

    let mut result = html.to_string();
    for (marker, class) in alert_types {
        // 使用正则表达式匹配和替换
        // <blockquote>\n<p>[!NOTE]...
    }
    result
}
```

**Alert HTML 模板** (`assets/templates/alerts/note.html`):
```html
<div class="markdown-alert markdown-alert-note">
    <p class="markdown-alert-title">
        <svg><!-- SVG 图标 --></svg>
        Note
    </p>
    <p>{{ content }}</p>
</div>
```

### 2.2 Emoji 支持

**方案 A: 简单方案（推荐）**
- 使用 `emojis` crate 提供 Unicode emoji
- 不支持自定义图片 emoji（如 :octocat:）
- 实现简单，体积小

```toml
[dependencies]
emojis = "0.6"
```

```rust
fn replace_emoji_shortcodes(text: &str) -> String {
    let mut result = String::new();
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if c == ':' {
            // 提取 :emoji_name:
            // 查找并替换
        } else {
            result.push(c);
        }
    }
    result
}
```

**方案 B: 完整方案**
- 从 go-grip 复制 emoji_map（手动转换为 Rust 的 HashMap）
- 支持自定义图片 emoji
- 需要维护 emoji 图片资源

### 2.3 主题切换

**实现方式**:
1. 添加命令行参数 `--theme <light|dark|auto>`
2. 在模板中动态加载对应的 CSS 文件
3. 如果是 `auto` 模式，使用 CSS 媒体查询：

```html
<link rel="stylesheet" href="/static/css/github-markdown-light.css"
      media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="/static/css/github-markdown-dark.css"
      media="(prefers-color-scheme: dark)">
```

**命令行参数扩展** (`src/main.rs`):
```rust
#[arg(short = 't', long, default_value = "auto")]
theme: String,  // light, dark, auto
```

---

## 阶段 3: 高级功能

### 3.1 Mermaid 图表支持

**实现步骤**:
1. 下载 `mermaid.min.js` 到 `assets/js/`
2. 在 Markdown 解析时检测 mermaid 代码块
3. 将代码块包裹在 `<pre class="mermaid">` 中
4. 在页面中加载 mermaid.js

**修改 `src/markdown.rs`**:
```rust
// 在 Event::Start(Tag::CodeBlock) 处理中
if fence_lang == "mermaid" {
    // 不做语法高亮，直接输出 <pre class="mermaid">
    return format!("<pre class=\"mermaid\">{}</pre>", code_content);
}
```

### 3.2 热重载功能

**方案**: 使用 WebSocket + 文件监控

**依赖**:
```toml
[dependencies]
notify = "6.1"              # 文件系统监控
tokio-tungstenite = "0.21"  # WebSocket 支持
```

**实现概要**:
1. 监控当前目录的 `.md` 文件变化
2. 文件修改时，通过 WebSocket 通知所有连接的客户端
3. 客户端收到通知后自动刷新页面

**HTML 中添加**:
```html
<script>
const ws = new WebSocket('ws://localhost:{{ port }}/ws');
ws.onmessage = () => window.location.reload();
</script>
```

### 3.3 代码高亮主题改进

**当前**: 使用 syntect 的 `base16-ocean.dark` 主题

**改进**:
1. 根据页面主题选择代码高亮主题：
   - 深色主题 → `base16-ocean.dark` 或 `Monokai`
   - 浅色主题 → `InspiredGitHub`

2. 修改 `src/markdown.rs`:
```rust
pub fn to_html(markdown: &str, theme: &str) -> String {
    let theme_name = match theme {
        "light" => "InspiredGitHub",
        "dark" => "base16-ocean.dark",
        _ => "base16-ocean.dark", // 默认
    };
    let theme = &ts.themes[theme_name];
    // ...
}
```

---

## 阶段 4: 开发体验优化

### 4.1 自动打开浏览器

**依赖**:
```toml
[dependencies]
open = "5.0"  # 跨平台打开浏览器
```

**实现**:
```rust
if !cli.no_browser {
    let url = format!("http://{}:{}", "localhost", cli.port);
    let _ = open::that(&url);
}
```

### 4.2 更多命令行参数

参考 go-grip 的参数列表：

```rust
#[derive(Parser, Debug)]
struct Cli {
    /// Markdown 文件路径
    file: Option<String>,

    /// 服务器端口
    #[arg(short, long, default_value_t = 6419)]
    port: u16,

    /// 不自动打开浏览器
    #[arg(short = 'b', long)]
    no_browser: bool,

    /// 主题选择 (light, dark, auto)
    #[arg(short = 't', long, default_value = "auto")]
    theme: String,

    /// 禁用热重载
    #[arg(long)]
    no_reload: bool,

    /// 服务器主机地址
    #[arg(long, default_value = "localhost")]
    host: String,
}
```

---

## 技术选型对比

| 功能 | go-grip 实现 | markon 实现建议 | 备注 |
|------|--------------|----------------|------|
| Markdown 解析 | gomarkdown | pulldown-cmark | ✅ 已实现 |
| 语法高亮 | Chroma | syntect | ✅ 已实现 |
| 静态资源嵌入 | go:embed | rust-embed | 需添加 |
| 模板引擎 | html/template | tera | 需添加 |
| HTTP 服务器 | net/http | axum + tokio | ✅ 已实现 |
| 热重载 | aarol/reload | notify + WebSocket | 需实现 |
| Emoji | 自定义映射表 | emojis crate | 推荐简化方案 |
| 文件监控 | fsnotify | notify | 需添加 |

---

## 实施时间线估算

| 阶段 | 预计工作量 | 关键任务 |
|------|-----------|---------|
| 阶段 1 | 2-3 天 | CSS 迁移、模板系统、静态资源 |
| 阶段 2 | 2-3 天 | Alerts、Emoji、主题切换 |
| 阶段 3 | 2-3 天 | Mermaid、热重载、高亮优化 |
| 阶段 4 | 1 天 | 开发体验优化 |
| **总计** | **7-10 天** | 完整功能迁移 |

---

## 立即开始的步骤

### 第一步：创建目录结构
```bash
mkdir -p assets/{css,js,templates/alerts,emojis}
```

### 第二步：下载 CSS 文件
从 go-grip 仓库下载：
- `defaults/static/css/github-markdown-dark.css`
- `defaults/static/css/github-markdown-light.css`
- `defaults/static/css/github-print.css`

### 第三步：更新依赖
```bash
cargo add rust-embed tera
```

### 第四步：创建基础模板
创建 `assets/templates/layout.html`

### 第五步：修改代码以使用模板
重构 `src/server.rs` 中的 HTML 生成逻辑

---

## 测试计划

### 功能测试清单
- [ ] 基础 Markdown 渲染
- [ ] 表格渲染
- [ ] 代码块高亮（多种语言）
- [ ] GitHub Alerts（5 种类型）
- [ ] Emoji 显示（Unicode）
- [ ] 任务列表
- [ ] Mermaid 图表
- [ ] 深色主题
- [ ] 浅色主题
- [ ] 自动主题切换
- [ ] 打印样式（A4、边距、分页）
- [ ] 热重载
- [ ] 目录列表
- [ ] 文件链接跳转

### 兼容性测试
- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari
- [ ] Linux
- [ ] macOS
- [ ] Windows

---

## 参考资源

- **go-grip 源码**: https://github.com/kookyleo/go-grip
- **GitHub Markdown CSS**: https://github.com/sindresorhus/github-markdown-css
- **Mermaid 文档**: https://mermaid.js.org/
- **pulldown-cmark**: https://docs.rs/pulldown-cmark/
- **syntect**: https://docs.rs/syntect/
- **tera**: https://docs.rs/tera/

---

## 许可证说明

- go-grip: MIT License
- markon: Apache 2.0 License
- GitHub Markdown CSS: MIT License
- Mermaid: MIT License

迁移过程中需注意保留原作者的版权声明。
