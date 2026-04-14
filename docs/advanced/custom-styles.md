# 自定义样式

Markon 的阅读页支持通过 CSS 变量做轻量定制，覆盖主色、字体、间距等。

## 在哪里改

**桌面版**：**全局设置 → 页面样式** 面板，支持浅色/深色分开配置。调整会实时保存到
`~/.markon/settings.json`。

<!-- TODO: screenshot: 自定义样式 (/screenshots/web-styles.png) -->

**CLI**：没有单独的命令行参数，但会**自动读取** `~/.markon/settings.json`。同一台机器上，
GUI 和 CLI 的样式/快捷键/语言设置共享一份配置。

如果系统上没有 `~/.markon/settings.json`（比如从未启动过桌面版），CLI 用内置默认值。

## 可定制变量

| Key | 中文 | 作用范围 |
|-----|------|---------|
| `primary` | 主色 | 链接、按钮、TOC 选中、强调元素 |
| `muted` | 次要色 | 工具栏文字、分隔符、辅助信息 |
| `border` | 边框色 | 标题分隔线、面板边框 |
| `subtle` | 背景色 | 浅色区域背景 |
| `ui-font` | 功能区字体 | TOC、工具栏等 UI 元素字体 |
| `ui-font-size` | 功能区字号 | UI 字号 |
| `panel-opacity` | 浮动面板透明度 | TOC、快捷键面板等的透明度 |

## 配置文件格式

`~/.markon/settings.json` 里的 `web_styles` 字段是一个 key → 值的 map。Key 形式有三种：

| Key 后缀 | 含义 |
|---------|------|
| `<key>` | 两种主题共用（除非被同名 `.light`/`.dark` 覆盖） |
| `<key>.light` | 仅浅色主题 |
| `<key>.dark` | 仅深色主题 |

完整示例：

```json
{
  "web_styles": {
    "primary.light": "#0969da",
    "primary.dark":  "#58a6ff",
    "muted":         "#8b949e",
    "ui-font":       "'JetBrains Mono', monospace",
    "ui-font-size":  "0.9rem",
    "panel-opacity": "0.85"
  }
}
```

上例中：
- `primary` 在浅色/深色主题下分别用不同颜色
- `muted` 两种主题共用同一个值
- 字体、字号、透明度不区分主题

## 原理

Markon 把这些键渲染为 CSS 自定义属性（`--markon-*` 前缀），注入到 `:root`。
上面的配置等价于浏览器里生成的：

```css
:root {
  --markon-primary: #0969da;
  --markon-muted: #8b949e;
  --markon-ui-font: 'JetBrains Mono', monospace;
  --markon-ui-font-size: 0.9rem;
  --markon-panel-opacity: 0.85;
}
@media (prefers-color-scheme: dark) {
  :root {
    --markon-primary: #58a6ff;
  }
}
```

## 恢复默认

- **桌面版**：**全局设置 → 页面样式 → 恢复默认** — 一键清空
- **CLI**：编辑 `~/.markon/settings.json`，把 `web_styles` 字段清空为 `{}`，或直接删掉整个字段
