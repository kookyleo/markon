# 主题与自定义样式

Markon 使用一套共享主题控制桌面设置面板、Markdown 阅读页、浮动面板和源码编辑器：

- **跟随系统**：根据操作系统外观自动使用浅色或深色。
- **Light**：固定使用浅色。
- **Dark**：固定使用深色。

语言是独立的全局设置，同时作用于桌面端、托盘、阅读页和编辑器。

## 在哪里改

打开桌面版的 **全局设置 → 外观**：

1. 在 **Theme** 中选择跟随系统、Light 或 Dark。
2. 在下方调整颜色、字体、字号和面板透明度。
3. 每一项右侧的撤销按钮只恢复该项；底部按钮清除全部自定义值。

CLI 没有另一套样式参数，会读取同一份 `~/.markon/settings.json`。

## 可自定义项

| Key | 中文 | 作用范围 |
|-----|------|---------|
| `primary` | 主色 | 链接、按钮、TOC 选中、强调元素 |
| `muted` | 次要色 | 次级文字、分隔符、辅助信息 |
| `border` | 边框色 | 标题分隔线、面板边框 |
| `subtle` | 区块背景 | 代码块、卡片等区块底色 |
| `canvas` | 画布色 | 页面和编辑区画布 |
| `text` | 正文色 | 正文和编辑器文字 |
| `ui-font` | 功能区字体 | TOC、工具栏、面板和编辑器 UI |
| `ui-font-size` | 功能区字号 | UI 字号 |
| `panel-opacity` | 面板透明度 | TOC、Note、确认对话框、聊天面板等浮层 |

颜色分别保存浅色和深色覆盖值；字体、字号和透明度由两种外观共享。弹出层、悬停态和强调边框等
细分 token 由这些值和 Markon 默认 token 派生，不重复暴露。

## 配置文件格式

`theme` 只接受 `auto`、`light` 或 `dark`。`web_styles` 保存用户修改过的 token：

```json
{
  "theme": "auto",
  "language": "auto",
  "web_styles": {
    "primary.light": "#76520e",
    "primary.dark": "#d4a24c",
    "canvas.light": "#fffaf0",
    "canvas.dark": "#17130d",
    "ui-font": "Charter, serif",
    "ui-font-size": "0.90rem",
    "panel-opacity": "0.92"
  }
}
```

服务把这些值转换为共享的 `--markon-*` CSS token。页面在首屏绘制前设置 `data-theme`，避免
主题闪烁；阅读页、浮动面板和源码编辑器消费同一组 token。
