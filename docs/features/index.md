---
title: 产品能力
description: 以代码中的工作区、阅读审阅、Git、协作、AI 与权限边界为准的 Markon 功能总览。
aside: false
---

# 产品能力

Markon 不是静态站点生成器，也不是把 Markdown 换一套 CSS 的预览器。它围绕一个本地文件或目录建立工作区，把阅读、审阅、修改、Git 对比和多人跟随放在同一条工作流里。

## 工作区底座

| 能力 | 代码中的实际边界 |
|---|---|
| [工作区与文件浏览](/features/workspaces) | 一个 `markond` 管理多个目录或单文件工作区；目录状态可跨重启恢复 |
| [Markdown 渲染](/features/rendering) | Supramark AST、GFM 扩展、KaTeX、服务端图表、受控本地媒体 |
| [Workspace Spotlight](/features/search) | 文件名、H1 文档标题与内容搜索；目录键盘导航；Tantivy + Jieba |
| [Git 浏览与对比](/features/git) | 分支、标签、提交历史、工作区 diff、任意 ref compare、Rendered/Raw 两种视图 |

## 阅读与审阅

| 能力 | 作用 |
|---|---|
| [批注与 Notes](/features/annotations) | 三色高亮、删除线、跨区块锚点、文字 Notes、撤销/重做 |
| [章节进度与折叠](/features/viewed) | H2–H6 Viewed 状态、独立折叠、聚焦标题操作、进度统计 |
| [导出 Notes](/features/export) | 按整页或章节整理为可编辑 Markdown，再复制或下载 |
| [章节打印](/features/print) | 只打印当前标题范围；是否包含折叠正文由设置决定 |
| [源码编辑](/features/edit) | 懒加载 CodeMirror、选区跳源码、实时预览、保存与未保存保护 |

## 协作、AI 与权限

| 能力 | 作用 |
|---|---|
| [Live](/features/live) | Broadcast / Follow 同步活动章节、文字选区与 Viewed 状态 |
| [共享批注](/advanced/shared-annotations) | SQLite 为唯一权威；开启共享后通过 WebSocket 广播同一数据集 |
| [Workspace AI](/features/chat) | 受工作区边界约束的文件工具、引用回链、多线程；Edit 开启时提供审批式修改 |
| [访问与权限](/features/access) | 管理员会话、协作者访问码、功能开关、Host allowlist 与 same-origin 校验 |

## 默认开关

新工作区从全局设置继承默认值。代码默认开启 `Search` 与 `Viewed`，默认关闭 `Edit`、`Live`、`AI Chat` 与 `Shared annotations`。每个工作区之后都能独立调整：

```text
Search · Viewed · Edit · Live · Chat · Shared
```

管理员可在浏览器工作区页、桌面端或 CLI 中修改；协作者只看到当前生效的能力，不能改开关。

## 选择你的起点

- 第一次使用：从[快速上手](/guide/getting-started)开始。
- 需要服务器部署：先读[运行架构](/guide/architecture)与[反向代理](/advanced/reverse-proxy)。
- 关心数据位置和外发边界：读[数据与隐私](/advanced/data-and-privacy)。
- 想确认命令是否仍有效：以[命令行选项](/guide/cli)为准。
