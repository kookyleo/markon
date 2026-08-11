---
title: 工作区与文件浏览
description: Markon 多工作区、单文件隔离、GitHub 风格目录页、文件操作与 Workspace Spotlight 入口。
---

# 工作区与文件浏览

Markon 的基本单位是 **Workspace**。它既可以是一个目录，也可以是一个被严格限制范围的单文件。

## 目录页提供什么

打开目录工作区后，根页面不是简单的链接列表，而是工作区仪表面：

- GitHub 风格的文件/目录列表，以及每项最近提交摘要和时间；
- 可在树中原地展开子目录，展开状态写入 URL hash；
- `All files` / `Markdown` 文件筛选；
- 文件名、H1 文档标题与内容统一进入 Workspace Spotlight；
- Git 仓库显示当前分支、分支/标签切换器、提交数和工作区改动；
- 右侧显示六个功能开关与 Git 状态；
- 别名、绝对路径、workspace id 和当前 URL 可直接复制。

表格列宽可以拖动，布局偏好保存在当前浏览器。窄屏会切换成适合移动端的单列布局。

## 文件与目录操作

持有管理员会话时，目录页还可以：

- 新建 Markdown 文件；
- 新建目录；
- 删除文件；
- 修改 Workspace 别名；
- 调整 `Search`、`Viewed`、`Edit`、`Live`、`Chat`、`Shared` 开关。

这些接口会再次校验管理员角色、same-origin 和工作区路径，协作者不能通过直接构造请求获得结构性写权限。

## Workspace Spotlight

按 <kbd>/</kbd> 或 <kbd>g</kbd> 打开统一查找器。结果分为：

- 文件名与路径；
- Markdown 的首个顶层 H1 文档标题；
- 全文命中及上下文片段。

可以用方向键移动、Enter 打开、Esc 关闭。Search 未开启时仍可使用文件导航；内容索引结果取决于该工作区的 Search 开关。

→ 搜索实现与限制见 [Workspace Spotlight](/zh/features/search)。

## 目录工作区的持久性

目录工作区记录在 `~/.markon/settings.json` 中。重新启动 `markond` 后，路径、别名、功能开关和 workspace id 都会恢复。

同一路径重复注册不会创建第二份工作区，而是更新现有条目的功能状态。`markon ls` 展示当前注册表；`markon detach <id|序号>` 只解除注册，不删除目录或文档。

## 单文件隔离

用 Markon 打开一个 `.md` / `.markdown` 文件时会建立单文件工作区：

- 搜索只覆盖该文件；
- 未引用的同目录文件不可访问；
- 明确引用的图片、样式、音频、视频等资源可以读取，但规范化后必须仍位于父目录内；
- 逃出父目录的 `../`、绝对路径与越界 symlink 会被拒绝。

设置项 `auto_remove_single_file_workspaces` 控制这些工作区是否在下次服务启动时自动移除，默认为开启。

## 多入口共享同一注册表

桌面端、`markon` CLI 和浏览器管理员页看到的是同一个服务状态：

```bash
markon docs/                 # 注册或打开目录
markon README.md             # 注册或打开单文件
markon ls                    # 交互式浏览；非 TTY 时输出静态 cards
markon set 1 edit on         # 修改第 1 个工作区
markon detach 1              # 解除注册，不删除文件
```

完整命令见[命令行选项](/zh/guide/cli)。
