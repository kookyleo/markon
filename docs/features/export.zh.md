---
title: 导出 Notes
description: 把 Markon 的整页或章节 Notes 整理为可编辑、可复制、可下载的 Markdown。
---

# 导出 Notes

Markon 导出的不是页面截图，而是按正文顺序整理的 Markdown。导出前可以继续删改，最后复制到剪贴板或下载为 `.md` 文件。

## 从哪里导出

| 入口 | 范围 |
|---|---|
| H1 工具栏的 `Export Notes (n)` | 当前文件的全部文字 Notes |
| H2–H6 的 `Export Notes (n)` | 当前标题到下一个同级或更高层标题之前 |
| rendered diff 的 `Export Notes (n)` | 当前 diff 中的 Notes |

括号中的数字只统计包含 Note 文本的批注。单纯高亮或删除线不会单独进入 Notes 导出。

## 导出编辑器

点击入口后，Markon 复用按需加载的 CodeMirror 编辑器打开一个临时缓冲区：

1. 第一行是可编辑的下载文件名；
2. 其余内容是按文档顺序生成的引用与 Note Markdown；
3. 可以直接修改、删除或重排内容；
4. `Copy` 复制当前缓冲区；
5. `Download` 把当前内容下载为本地 `.md` 文件。

这个模式不会调用文件保存 API，也不会改写原 Markdown。关闭导出编辑器时，底层页面保持原样。

## 没有 Notes 时

范围内没有文字 Notes，入口会短暂提示为空，不会打开一个空编辑器。需要导出单条内容时，也可以在对应 Note 卡片或高亮弹层里复制“局部引用 + Note”。

## 与打印的区别

- Notes 导出适合继续整理、进入 issue 或合并到评审记录；
- [章节打印](/zh/features/print)保留渲染样式、图表和批注外观，适合 PDF 或纸质输出；
- 两者都支持按章节限定范围。

批注的数据边界与备份方式见[批注与 Notes](/zh/features/annotations)和[数据与隐私](/zh/advanced/data-and-privacy)。
