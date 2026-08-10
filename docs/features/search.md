---
title: Workspace Spotlight
description: Markon 的统一文件导航、H1 标题元数据与 Tantivy/Jieba Markdown 全文搜索。
---

# Workspace Spotlight

<div class="feature-illustration">
  <img src="/illustrations/02-search.svg" alt="Workspace Spotlight 搜索" />
</div>

Workspace Spotlight 把文件导航与全文搜索放在同一个面板。按 <kbd>/</kbd> 或 <kbd>g</kbd> 打开，方向键选择，Enter 跳转，Esc 关闭。

## 文件导航

工作区文件 API 提供：

- Workspace-relative path；
- 文件名；
- 是否为 Markdown；
- Markdown 首个顶层 H1 的纯文本标题（若存在）；
- 可访问 URL。

H1 提取走与渲染器一致的 Supramark AST，因此支持 Setext 标题与 inline formatting，并不会把代码块或 blockquote 中的 `#` 当作文档标题。

文件导航受 WorkspaceFs capability 与 ignore 规则约束。单文件 Workspace 只返回固定文件。

## 全文搜索

开启 `Search` 后，服务为 Markdown 建立 Tantivy 索引：

| 字段 | 行为 |
|---|---|
| path | 作为精确 route key，用于增量删除/替换 |
| file_name | 建立索引并存储 |
| title | 第一个 Markdown heading，缺失时回退文件名 |
| content | 建立索引但不在 Tantivy 再存一份全文 |

查询覆盖 file name、title 与 content。命中 snippet 在返回结果时通过 WorkspaceFs 读取对应文件生成，避免索引内再保留一份完整正文。

## 中英文与大小写

索引和查询共同使用 Jieba tokenizer + LowerCaser：

- 中文按词切分；
- 拉丁文本不区分大小写；
- CJK 不受大小写过滤影响。

## 资源与更新

- 索引位于自动清理的临时 MmapDirectory，服务退出后清除；
- 初次构建只预收集路径，正文按 64 文件一批并行读取；
- Tantivy writer 只在一个受互斥保护的写入路径使用；
- watcher 把一批 create/modify/delete/rename 合并为一次 commit + reader reload；
- ignore 规则或目录拓扑变化时重建 route set；
- 搜索查询本身保持无写锁读取。

这些限制用于控制大工作区的内存峰值和增量索引开销，实际速度取决于文件数、正文大小和存储设备。

## 范围与限制

- 只索引 `.md` 文件；文件导航可以包含其它允许的文件。
- 不跨 Workspace 搜索。
- 查询使用 Tantivy QueryParser，不提供站点级高级查询 UI。
- 代码块仍是 Markdown content 的一部分，会进入索引。
- Search 关闭时不建立内容索引，但文件导航仍可用。
