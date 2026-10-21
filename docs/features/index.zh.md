---
title: 产品能力
description: 以代码中的工作区、阅读审阅、Git、协作、AI 与权限边界为准的 Markon 功能总览。
aside: false
---

# 产品能力

Markon 不是静态站点生成器，也不是把 Markdown 换一套 CSS 的预览器。它围绕一个本地文件或目录建立工作区，把阅读、审阅、修改、Git 对比和多人跟随放在同一条工作流里。

## 工作区与查找 / Workspace

| 能力 | 作用 |
|---|---|
| [工作区与文件浏览（Workspace / Files）](/zh/features/workspaces) | 一个服务管理目录与单文件工作区，保留路径和上下文 |
| [统一查找与全文搜索（Spotlight / Search）](/zh/features/search) | 文件名、H1 标题、正文命中和键盘导航；全文结果依赖索引就绪 |

## 阅读与呈现 / Reading

| 能力 | 作用 |
|---|---|
| [Markdown 渲染（Markdown）](/zh/features/rendering) | GFM、KaTeX、图表 Diagrams、媒体 Media、视觉查看器 Viewer 与缩放 Zoom |
| [章节阅读（Outline / Focus / Fold / Resume）](/zh/features/viewed) | 目录导航、章节聚焦、独立折叠与浏览器本地阅读位置记忆 |

## 批注与审阅 / Review

| 能力 | 作用 |
|---|---|
| [批注（Annotate）](/zh/features/annotations) | 高亮 Highlight、删除线 Strike、文字批注 Note，以及导航 Navigate、撤销/重做 Undo / Redo |
| [进度标记（Progress）](/zh/features/viewed) | 使用已读 Read／全部已读 All Read 控件记录章节进度；Markdiff 文件已读状态另保存在浏览器本地 |
| [Git 浏览与差异审阅（Git / Markdiff）](/zh/features/git) | 分支、标签、历史、工作区变更、任意 ref 对比，以及 Rendered / Raw 视图 |

## 源码编辑 / Edit

[源码编辑（Edit）](/zh/features/edit) 按需开启，提供选区跳源码 Edit Here、实时预览 Preview 和保存保护 Save Guard。

## 工作区 AI / Workspace AI

[工作区 AI（Workspace AI）](/zh/features/chat) 使用高级开关 Chat；提供文件引用 Mentions、出处 Citations、多对话 Threads 和审批式修改 Suggestions / Approval，写文件另需 Edit。

## 协作与演示 / Team

| 能力 | 作用 |
|---|---|
| [同步演示（Live）](/zh/features/live) | Present / Follow 同步页面、阅读位置、章节焦点与文字选区；章节进度由 Share 同步 |
| [共享批注与阅读进度（Share）](/zh/advanced/shared-annotations) | 选择共同批注与正文章节进度；关闭后仍可 Personal 审阅；不含 diff 文件进度、折叠或阅读位置记忆 |

## 导出与打印 / Output

| 能力 | 作用 |
|---|---|
| [导出文字批注（Export Notes）](/zh/features/export) | 按整页或章节整理文字批注为 Markdown，复制 Copy 或下载 Download；零计数禁用 |
| [打印（Print）](/zh/features/print) | 打印整页或当前章节，可由浏览器另存 PDF |

## 管理与偏好 / Settings

[访问与权限（Access）](/zh/features/access)、[隐私与数据（Privacy）](/zh/advanced/data-and-privacy)、[主题与排版（Theme / Typography）](/zh/advanced/custom-styles)、[操作与快捷键（Actions / Shortcuts）](/zh/advanced/shortcuts) 另归设置；管理操作继续要求管理员权限。

## 基础能力与高级能力

产品划分以「基础能力随工作区提供，高级能力按需开启」为原则：

| 层级 | 能力 | 开关原则 |
|---|---|---|
| 基础能力 / Essentials | Workspace、Files、Spotlight、Search；Markdown、Viewer、Outline、Fold、Resume；Annotate、Progress、Git、Markdiff；Export Notes、Print；主题、快捷键等设置 | 默认提供，按内容、上下文和权限决定可用状态 |
| 高级能力 / Advanced | Edit、Chat、Live、Share | 由管理员按工作区选择开启，默认关闭 |

高级开关行是 `Edit · Chat · Live · Share`。新工作区继承全局默认值；全新安装的四项默认均为关闭。管理员可在浏览器工作区页、桌面端或 CLI 中逐项调整。Search 与 Progress 不提供开关。

任何通过工作区门禁的浏览器都可使用 Personal 批注、进度标记与文字批注导出。Share 关闭时，非管理员浏览器在同一 SQLite 隔离保存自己的记录；开启后切换共同审阅数据，不自动发布或合并浏览器私有 Personal 数据。Git、Viewer 等入口按仓库和媒体上下文提供；源码写入、管理操作和 AI 调用仍受各自授权条件控制。

## 生效条件与兼容

功能总览介绍完整产品能力；高级开关选择可选工作流；`?` 操作与快捷键（Actions）面板按当前页面实际注册的快捷键列出可执行操作。标题旁的打印、批量折叠等无专用快捷键的操作仍以标题工具栏为入口。

| 能力 | 生效条件 |
|---|---|
| 文件浏览 Files、统一查找 Spotlight、全文搜索 Search | 基础能力；全文结果需要索引就绪 |
| 章节进度 Section Progress | 基础能力；操作当前 Personal / Shared 作用域 |
| 折叠 Fold、打印 Print | 基础能力；按标题与页面内容提供 |
| 批注 Annotate、导出文字批注 Export Notes | 基础能力；操作当前 Personal / Shared 作用域，导出要求范围内有文字批注 |
| 源码编辑 Edit | Edit 开启；新增／删除文件等结构操作还需管理员 |
| AI 对话 Chat | Chat 开启；修改文件还需要 Edit 和审批 |
| 同步演示 Live | Live 开启；不发布 Personal 数据，也不自动开启 Share |
| 共享批注与阅读进度 Share | Share 开启；切换共同批注和章节进度，保留各浏览器 Personal 数据 |

H1 提供整页操作，H2–H6 聚焦时提供章节操作；两处的打印、折叠与导出采用相同生效规则。导出只统计可访问的文字批注，计数为 `0` 时仍显示并禁用。详见[进度标记与折叠（Progress / Fold）](/zh/features/viewed)。

旧配置的工作区字段 `enable_search` / `enable_viewed` 和全局默认字段 `default_search` / `default_viewed` 继续兼容读取，但原来的 `false` 不再禁用基础能力。Workspace id、文档 URL、既有批注与进度数据保持不变。`viewed_state`、`shared_annotation` 等技术名称和既有文档 URL 继续保留。详见 [CLI 兼容说明](/zh/guide/cli#markon-set)。

## 选择你的起点

- 第一次使用：从[快速上手](/zh/guide/getting-started)开始。
- 需要服务器部署：先读[运行架构](/zh/guide/architecture)与[反向代理](/zh/advanced/reverse-proxy)。
- 关心数据位置和外发边界：读[数据与隐私](/zh/advanced/data-and-privacy)。
- 想确认命令是否仍有效：以[命令行选项](/zh/guide/cli)为准。
