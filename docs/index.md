---
layout: home

hero:
  name: Markon
  text: Turn your markdown on.
  tagline: 轻量级的 Markdown 阅览与审校工作台。开源、免费，完全本地。
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: Markon
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/getting-started
    - theme: alt
      text: 查看功能
      link: /features/search
    - theme: alt
      text: GitHub
      link: https://github.com/kookyleo/markon

features:
  - icon: 📖
    title: GitHub 风格渲染
    details: 原生 GitHub Markdown 样式，支持 GFM 表格、任务列表、GitHub Alerts、Mermaid 图表、语法高亮（40+ 语言）
  - icon: 🔍
    title: 全文搜索
    details: 基于 Tantivy 构建索引，支持中日英分词。浏览器中按 <kbd>/</kbd> 实时搜索所有 Markdown 内容
  - icon: 👁
    title: 已读追踪
    details: 受 GitHub PR Review 启发，按段落级别标记阅读进度，自动折叠已读章节，再次打开时恢复上次位置
  - icon: ✏️
    title: 在线编辑
    details: 按 <kbd>e</kbd> 直接在浏览器编辑 Markdown 源文件，语法高亮 + 实时预览，<kbd>Ctrl+S</kbd> 保存
  - icon: 🏷️
    title: 深度标注与审校
    details: Medium 风格三色高亮、删除线、便条笔记，支持以侧边栏卡片或弹窗形式呈现
  - icon: 🛰️
    title: 实时协作 (Live)
    details: 以颜色为身份，在主控/被控之间实时同步聚焦章节、文字选区与已读勾选；被控端以对方代表色呼吸灯提示焦点切换
  - icon: 🔄
    title: 多端同步
    details: 自动同步批注与已读状态。适用于个人多设备阅读或团队协同审阅，支持私有化部署
  - icon: 🖨️
    title: 章节打印
    details: 标题旁的打印按钮，仅打印当前章节内容，保持 GitHub 风格排版
  - icon: 🖥️
    title: 桌面集成
    details: macOS 拖入 Finder 工具栏一键打开，Windows 右键菜单集成，系统托盘常驻
  - icon: 📱
    title: 移动端友好
    details: 响应式设计，生成 QR 码方便扫码移动端查看
---

## 即刻开始

<DownloadButton />

或通过 [Cargo](https://crates.io/crates/markon) 安装命令行版本：

```bash
cargo install markon
markon README.md
```

## 运行截图

<!-- TODO: screenshot: Markon 主界面 (/screenshot.png) -->
