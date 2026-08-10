---
title: 章节进度与折叠
description: Markon 的 H2–H6 Viewed 状态、独立折叠、本地 UI 偏好与章节级操作。
---

# 章节进度与折叠

<div class="feature-illustration">
  <img src="/illustrations/03-viewed.svg" alt="Markon 章节 Viewed 状态" />
</div>

开启 `Viewed` 后，Markon 以 H2–H6 章节为单位追踪审阅进度。Viewed 与折叠相关联，但不是同一个状态。

## Viewed

- 标记某标题 Viewed 时，该章节同时折叠；
- 取消 Viewed 时展开；
- H1 下方显示整页进度与批量操作；
- TOC 反映 Viewed 状态；
- Viewed 保存到 SQLite；
- Shared 开启后，协作者同步同一 Viewed 数据。

<kbd>v</kbd> 切换当前聚焦章节。聚焦来自滚动位置、TOC 导航或 <kbd>j</kbd>/<kbd>k</kbd> 标题导航。

## 独立折叠

<kbd>o</kbd> 只切换当前章节显示，不改变 Viewed：

- H2–H6 都可以独立折叠；
- 嵌套章节按 heading level 计算范围；
- 折叠后插入可点击占位；
- 打开折叠区内的 Note 时会临时展开，关闭后恢复；
- 普通折叠偏好保存在当前浏览器，不写 SQLite，也不在 Shared 客户端之间同步。

打印时默认用占位表示折叠内容；全局 `print_collapsed_content` 或 CLI `--print-collapsed-content` 可强制包含。

## 标题操作

聚焦 H2–H6 后出现：

- Viewed；
- Print；
- Collapse / Expand；
- Export Notes 及当前章节计数。

H1 工具栏提供：

- 全部 Viewed / 全部未读；
- 全部折叠 / 全部展开；
- 整页打印；
- 整页 Notes 导出。

章节范围从当前 heading 到下一个同级或更高层 heading 之前。

## 存储与权限

| 状态 | 存储 | 共享 |
|---|---|---|
| Viewed | SQLite `viewed_state` | Shared 开启时 |
| Collapse | 浏览器 UI 偏好 | 不共享 |

Shared 关闭时只有管理员可读写 SQLite Viewed；协作者页面保持只读。详情见[共享批注](/advanced/shared-annotations)。
