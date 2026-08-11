---
title: 产品定位
description: Markon 是什么、适合哪些工作流，以及它与 Markdown 预览器、静态站点生成器和 IDE 的区别。
---

# 产品定位

<div class="feature-illustration">
  <img src="/illustrations/01-rendering.svg" alt="Markon 阅读与审阅工作台" />
</div>

**让人与 Agent 在文档中达成共识。**

设计通常都不是一次写就，而是在审阅、修订与再审阅中逐步收敛完成。Markon 是人与 Agent 共同打磨 Spec 的 Markdown IDE：阅读当前方案，批注反馈或直接修改，再审阅下一版的变化，如此往复，直到达成共识。

Markon 本地优先。它把一个本地文件、目录或 Git 仓库转成浏览器工作区，内容仍由你自己的机器或服务器保存。

## 解决什么问题

Markdown 经常不只是“看一眼预览”：

- 一份长设计文档需要高亮、Notes、章节进度与局部打印；
- 一个仓库需要跨文件搜索、查看历史，并按渲染结果审阅 diff；
- 无 GUI 服务器上的文档需要从本机浏览器安全访问；
- 评审会希望所有参与者跟随主讲人所在章节；
- 修改一个 typo 时，不想离开阅读上下文；
- AI 回答必须从当前工作区取证，并能跳回原文件位置。

Markon 把这些动作收进同一个 Workspace，而不是要求你在预览器、浏览器搜索、Git 客户端、聊天工具和编辑器之间来回切换。

## 核心模型

```text
local file / directory / Git repository
                    │
                    ▼
            Markon Workspace
   browse · render · search · review
      edit · diff · live · chat
```

每个工作区有独立的 `Search`、`Viewed`、`Edit`、`Live`、`Chat`、`Shared` 开关。管理员决定开放哪些能力，协作者只能使用已开启的部分。

## 两种入口，一套服务

### 桌面应用

Tauri 2 桌面端面向日常使用：

- 管理多个目录或单文件工作区；
- 配置全局默认功能、主题、语言、快捷键、数据库与 AI Provider；
- 系统托盘常驻；
- macOS Finder 工具栏和 Windows 文件关联/右键入口；
- Stable / RC 更新通道。

### CLI

`markon` 面向终端、SSH 和无桌面服务器：

```bash
cargo install markon markond
markon README.md
markon docs/
```

桌面端与 CLI 都连接同一个 `markond` 后台服务，不会各自维护一份工作区状态。详情见[运行架构](/zh/guide/architecture)。

## 它是什么

- **阅读工作台**：GitHub 风格正文、目录、视觉缩放、快捷键与主题。
- **审阅工作台**：批注、Notes、Viewed、折叠、导出与章节打印。
- **Git-aware 工作区**：branches、tags、history、working/commit/compare diff。
- **本地协作面**：共享审阅状态与 Live 跟随，数据仍落在运行 Markon 的机器。
- **受约束的 Workspace AI**：文件调查、引用回链，以及用户逐项批准的修改。

## 它不是什么

- **不是静态站点生成器**：没有 MkDocs / Hugo 的发布主题与站点构建模型。
- **不是知识库笔记应用**：不提供双链图谱、插件市场或云同步账号体系。
- **不是通用编程 IDE**：这里的 Markdown IDE 围绕 Spec 的阅读、审阅、版本比较与修订，不替代工程级语言服务、构建系统和调试器。
- **不是完整 Git 客户端**：不负责 fetch、pull、push、merge 或远端凭据。
- **不是多租户权限系统**：有 Admin/Collaborator 边界，但没有按账号、团队、角色的细粒度 RBAC。

## 本地优先的真实边界

渲染、搜索、Git、批注、Viewed 和 Live 都在本机完成。只有用户配置并启用 Workspace AI 后，消息、引用与工具读取的上下文才会发送给所选 Provider。

→ 继续：[快速上手](/zh/guide/getting-started) · [产品能力](/zh/features/) · [数据与隐私](/zh/advanced/data-and-privacy)
