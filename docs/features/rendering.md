---
title: Markdown 渲染
description: Markon 的 Supramark AST、GFM 扩展、数学、图表、本地媒体、安全过滤与视觉缩放能力。
---

# Markdown 渲染

Markon 使用 Supramark 解析 Markdown AST，再由服务端生成 HTML。阅读页沿用 GitHub 风格的浅色/深色基线，并叠加工作区能力。

<div class="feature-illustration">
  <img src="/illustrations/01-rendering.svg" alt="Markon Markdown 渲染示意" />
</div>

## 文本与结构

- CommonMark 标题、段落、强调、引用、链接、图片、列表与 fenced code；
- GFM 表格、任务列表与删除线；
- GitHub Alerts：Note、Tip、Important、Warning、Caution；
- 脚注；
- emoji shortcode；
- 语法高亮；
- 行内与块级 KaTeX 数学；
- 从 H1–H6 生成章节结构与可导航目录。

解析过程还记录源码位置，用于渲染选区跳转到编辑器的对应位置。

## 图表引擎

代码围栏支持下列引擎与别名：

| 类别 | fence |
|---|---|
| Mermaid | `mermaid`、`mmd` |
| PlantUML | `plantuml`、`puml` |
| D2 | `d2` |
| Graphviz | `dot`、`graphviz` |
| Vega | `vega`、`vega-lite`、`vegalite` |
| ECharts | `echarts` |
| Chart.js | `chart`、`chartjs`、`chart.js` |

图表由 Supramark 的服务端能力渲染。引擎不可用或语法错误时，页面显示带原因的源码 fallback，不会静默消失。

## 图片、SVG 与图表全屏查看

阅读页会为图表、图片和独立 SVG 增加视觉查看器。打开后可：

- 滚轮或按钮缩放；
- 拖动画布；
- 双指缩放；
- 框选放大；
- 适应窗口或重置；
- 使用 <kbd>+</kbd> / <kbd>-</kbd>、<kbd>0</kbd>、<kbd>f</kbd>、<kbd>z</kbd>、<kbd>Esc</kbd>。

Mermaid SVG 会在打开前校正 viewBox，避免内容因生成器边界过小被裁掉。Alerts 等界面装饰 SVG 不会误进入查看器。

## 本地资源

Markdown 图片和受允许的原始 HTML `img`、`video`、`audio` 可以引用工作区内资源。路径会：

1. 解析 Markdown 转义；
2. 规范化；
3. 校验工作区 capability；
4. 拒绝越界、危险 scheme 与不允许的 HTML 属性。

单文件工作区只开放正文明确引用的资源。目录工作区也不能借助 `..` 或 symlink 读出根目录。

## 原始 HTML 与链接安全

Markon 保留常用展示标签，但过滤 `script`、事件处理属性和 `javascript:` 等危险 URL。浏览器端写接口另有 same-origin、workspace capability 或管理员会话校验；HTML 过滤不是唯一防线。

## 主题与打印

主题可以跟随系统、固定浅色或深色。颜色、字体、UI 字号和浮层透明度从统一 token 派生，桌面设置与阅读页共用。打印使用独立样式，章节折叠正文是否展开由 `print_collapsed_content` 决定。

→ 主题细节见[自定义样式](/advanced/custom-styles)，范围打印见[章节打印](/features/print)。
