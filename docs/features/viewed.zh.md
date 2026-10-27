---
title: 进度标记与折叠（Progress / Fold）
description: Markon 的 H2–H6 Progress 状态、独立折叠、本地 UI 偏好与章节级操作。
---

# 进度标记与折叠（Progress / Fold）

<div class="feature-illustration">
  <img src="/illustrations/03-viewed.svg" alt="Markon 章节 Progress 状态" />
</div>

进度标记（Progress）是基础能力，Markon 以 H2–H6 章节为单位追踪审阅进度，并遵守审阅数据权限。Progress 与折叠相关联，但不是同一个状态。

产品能力名为「进度标记 / Progress」；旧版界面可能仍显示 Viewed。命令参数 `viewed`、数据库字段 `viewed_state` 和本页 URL 保持兼容。

## Progress

- 功能名仍为「进度标记 / Progress」，章节复选框显示「已读 / Read」；
- 勾选表示已读并折叠章节，取消勾选表示未读并展开；
- 操作提示随状态显示「标为已读 / Mark as read」或「标为未读 / Mark as unread」；
- H1 旁使用「全部已读 / All Read」，提示说明全部标为已读／未读；
- TOC 反映章节的已读／未读状态；
- Progress 保存到 SQLite；
- Share 开启后，协作者同步同一 Progress 数据。

<kbd>v</kbd> 切换当前聚焦章节。聚焦来自滚动位置、TOC 导航或 <kbd>j</kbd>/<kbd>k</kbd> 标题导航。

## 目录、聚焦与位置记忆 / Outline · Focus · Resume

目录导航（Outline）通过 TOC 跳转标题；章节聚焦（Focus）随滚动、TOC 选择或 `j` / `k` 更新。阅读位置记忆（Resume）保存在当前浏览器，与 Progress 不同，也不由 Share 共享。

## 独立折叠

<kbd>o</kbd> 只切换当前章节显示，不改变 Progress：

- H2–H6 都可以独立折叠；
- 嵌套章节按 heading level 计算范围；
- 折叠后插入可点击占位；
- 打开折叠区内的 Note 时会临时展开，关闭后恢复；
- 普通折叠偏好保存在当前浏览器，不写 SQLite，也不在 Share 客户端之间同步。

打印时默认用占位表示折叠内容；全局 `print_collapsed_content` 或 CLI `--print-collapsed-content` 可强制包含。

## 标题操作

聚焦 H2–H6 后出现，按以下顺序排列：

- 已读 / Read（当前 Personal / Shared 作用域的 Progress）；
- Print；
- Export Notes 及当前章节计数；
- Fold / Unfold。

H1 工具栏提供：

- 全部已读 / All Read（批量切换当前作用域章节的已读／未读状态）；
- 整页打印；
- 整页文字批注导出（Export Notes）；
- 全部折叠 / 全部展开。

Progress、打印、文字批注导出与折叠均是通过工作区门禁后即可使用的基础能力；H1 与章节入口读取当前 Personal / Shared 作用域。范围内没有文字批注时，导出显示计数 `0` 并禁用。只有 H1、没有 H2–H6 的文档保留整页打印与导出，不显示空的批量标记或折叠操作。没有 H1 的文档不挂载 H1 工具栏。

产品目录中，折叠归「阅读与呈现 / Reading」，进度标记归「批注与审阅 / Review」，Export Notes 归「导出与打印 / Output」。`?` 面板按当前页面已注册的快捷操作展示。`o` 只改变本地折叠；`v` 操作当前作用域的章节进度，不要求 Admin 或 Share。

章节范围从当前 heading 到下一个同级或更高层 heading 之前。

## 存储与权限

| 状态 | 存储 | 共享 |
|---|---|---|
| Progress | SQLite 私有表按浏览器隔离；既有／共同记录沿用 `viewed_state` | Share 开启时使用共同作用域 |
| Fold | 浏览器 UI 偏好 | 不共享 |

Share 关闭时，非管理员浏览器读写自己隔离持久化的 Personal 章节进度；管理员保留既有记录。Share 开启时进入共同章节进度，不自动合并 Personal 数据。Markdiff 的逐文件进度独立保存在当前浏览器。详情见[共享批注与阅读进度（Share）](/zh/advanced/shared-annotations)。
