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

配置文件中的键名：`primary.light` / `primary.dark` 分别设置浅色/深色主题的值；不带后缀表示两种主题共用。

## 浅色 / 深色分离

每个变量都能分别为浅色主题和深色主题设置不同值（在 UI 上有 `.light` / `.dark` 标签）。

## 原理

Markon 把所有可定制属性暴露为 CSS 自定义属性（`--markon-*` 前缀），渲染时在 `:root` 下注入。

例如设置主色：

```css
:root {
  --markon-primary: #007acc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --markon-primary: #4fc3f7;
  }
}
```

## 恢复默认

**全局设置 → 页面样式 → 恢复默认** — 一键清空所有自定义。
