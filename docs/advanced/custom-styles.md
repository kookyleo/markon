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

颜色 token（每项分浅/深两组）：

| Key | 中文 | 作用范围 |
|-----|------|---------|
| `primary` | 主色 | 链接、按钮、TOC 选中、强调元素 |
| `muted` | 次要色 | 次级文字、分隔符、辅助信息 |
| `border` | 边框色 | 标题分隔线、面板边框 |
| `subtle` | 区块背景 | 代码块、卡片等区块底色 |
| `canvas` | 画布色 | 页面整体底色 |
| `text` | 正文色 | 正文文字颜色 |

排版与透明度（不分主题）：

| Key | 中文 | 作用范围 |
|-----|------|---------|
| `ui-font` | 功能区字体 | TOC、工具栏等 UI 元素字体 |
| `ui-font-size` | 功能区字号 | UI 字号 |
| `panel-opacity` | 浮动面板透明度 | TOC、note 弹窗、确认对话框、聊天面板等浮层 |

::: info 内部派生 token
另有 5 个 token（`text-muted` / `elevated` / `elevated-2` / `overlay` / `border-strong`）用于 sphere 图标、用户气泡、弹出层等内部场景，由 Markon 直接维护浅/深默认值，不在面板暴露，也不读 `web_styles`。
:::

## 配置文件格式

`~/.markon/settings.json` 里的 `web_styles` 字段是一个 key → 值的 map：

- **颜色 token**（`primary` / `muted` / `border` / `subtle` / `canvas` / `text`）按主题分别配置，key 加 `.light` / `.dark` 后缀。
- **排版与透明度**（`ui-font` / `ui-font-size` / `panel-opacity`）不分主题，直接用裸 key。

完整示例：

```json
{
  "web_styles": {
    "primary.light": "#0969da",
    "primary.dark":  "#58a6ff",
    "canvas.light":  "#fdfdfc",
    "ui-font":       "'JetBrains Mono', monospace",
    "ui-font-size":  "0.9rem",
    "panel-opacity": "0.85"
  }
}
```

上例中：
- `primary` 浅色/深色分别配色
- `canvas.light` 单独覆写浅色画布底（深色不覆写则保留默认 `#0d1117`）
- 字体、字号、透明度不区分主题

## 原理

Markon 把这些键渲染为 CSS 自定义属性（`--markon-*` 前缀），按主题拆到不同选择器：浅色进 `:root`，深色覆写进 `html[data-theme="dark"]`。配置等价于：

```css
:root {
  --markon-primary: #0969da;
  --markon-canvas: #fdfdfc;
  --markon-ui-font: 'JetBrains Mono', monospace;
  --markon-ui-font-size: 0.9rem;
  --markon-panel-opacity: 0.85;
}
html[data-theme="dark"] {
  --markon-primary: #58a6ff;
}
```

非颜色键只在 `:root` 出现一次（不需要按主题切）。Markon 在页面加载时根据系统/用户偏好把 `data-theme` 解析为 `light` 或 `dark`，避免 `@media (prefers-color-scheme)` 与显式主题切换之间的冲突。

## 恢复默认

- **桌面版**：**全局设置 → 页面样式 → 恢复默认** — 一键清空
- **CLI**：编辑 `~/.markon/settings.json`，把 `web_styles` 字段清空为 `{}`，或直接删掉整个字段
