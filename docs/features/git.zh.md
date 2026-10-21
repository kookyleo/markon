---
title: Git 浏览与对比
description: Markon 的分支、标签、历史、工作区 diff、commit diff、任意 ref compare 与管理员写操作。
---

# Git 浏览与对比

目录工作区位于 Git 仓库内时，Markon 会在文件浏览器旁提供只读 Git 信息，并为管理员开放少量本地写操作。

## 工作区首页

Git 仓库的根页会显示：

- 当前 branch 或 detached HEAD；
- branches、tags 与 commit 数量；
- 最近提交的作者、主题、hash 与相对时间；
- Clean / Dirty 状态；
- HEAD 相对父提交的 diff；
- 工作区相对 HEAD 的 Working diff；
- 文件与目录各自最近一次提交摘要。

分支下拉可搜索 branches/tags。协作者能浏览，checkout 按钮只对管理员可用。

## 历史、分支与标签

`Git history` 页面支持按 branch、作者和时间过滤。每条提交可以打开完整 Markdown diff。

Branches 页面展示当前分支、默认分支与 ahead/behind 信息；Tags 页面按时间列出标签。它们都只读取本地仓库，不访问远端。

## 三类 diff

| 入口 | 比较范围 |
|---|---|
| Working diff | HEAD 与工作区，包含未跟踪的 Markdown 文件 |
| Commit diff | 某提交与其父提交 |
| Compare | 任意合法 base 与 compare ref，也可把 worktree 作为 compare |

后端先读取 Markdown blob 与变更元数据，再生成同一套结构化 diff 数据，Raw 与 Rendered 视图共享它。

## Rendered 与 Raw

### Rendered

按 Markdown AST 区块比较标题、段落、列表、表格、代码和图表。未变化的上下文会折叠，修改区块有词级标记，更适合审阅文义。

### Raw

显示源码行 diff，可在 **Split** 与 **Unified** 布局之间切换。文件新增、删除、重命名与二进制/不可渲染情况会给出明确状态。

共同能力包括：

- 文件树与侧栏折叠；
- 按 Added / Modified / Deleted 等状态过滤；
- 逐文件进度（File Progress）、已读（Read）复选框与隐藏已读文件（Hide Read Files）；
- `n` / `p` 上下变更块；
- `m` 切换 Raw / Rendered；
- 在 diff 上建立批注、统计 Notes、导出文件范围 Notes；
- 从改动文件跳回当前工作区版本。

文件进度仍归 Progress 功能组；每个文件用「已读 / Read」复选框表示状态，操作提示为「标为已读 / Mark as read」或「标为未读 / Mark as unread」。计数采用 `n / total read`，例如 `2 / 5 read`；中文显示已读数量。Hide Read Files 隐藏已读文件，取消后仍可查看。

文件已读／未读状态保存在当前浏览器；Share 共享的是正文 H2–H6 章节进度，不同步这里的文件进度。

## 管理员操作

以下操作需要显式管理员会话并通过 same-origin 校验：

- checkout 本地 branch；
- 把当前工作区改动创建为一个本地 commit；
- 从目录页新建文件或目录、删除文件。

Markon 不做 `fetch`、`pull`、`push`、merge、rebase，也不保存远端凭据。它的定位是本地 Markdown 审阅面，不是完整 Git 客户端。

## 路径与 ref 校验

- compare ref 会先由 Git 验证，不直接拼入 shell；
- diff 只读取工作区所属仓库；
- 文件读取继续经过 WorkspaceFs 边界；
- checkout / commit 等写操作不会向协作者开放。

远程浏览时，仍应先配置[访问权限](/zh/features/access)与[反向代理](/zh/advanced/reverse-proxy)。
