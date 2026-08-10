---
title: 键盘快捷键
description: Markon 阅读页、Workspace Spotlight、Live、Chat、diff 与视觉查看器的默认快捷键。
---

# 键盘快捷键

按 <kbd>?</kbd> 打开当前页面的功能面板。面板只列出该页面、当前 Workspace 开关与运行状态真正可用的快捷键，因此它比静态列表更权威。

## 文档站首页

文档站首页也有一组独立快捷键。它们只用于浏览产品介绍，不会覆盖 Markon 阅读页或 diff 页的快捷键。

| 快捷键 | 功能 |
|---|---|
| <kbd>?</kbd> | 打开首页功能与快捷键面板 |
| <kbd>j</kbd> / <kbd>k</kbd> | 选择下一张 / 上一张功能介绍卡片 |
| <kbd>Enter</kbd> | 打开当前选中的功能介绍卡片 |
| <kbd>/</kbd> | 打开文档搜索 |
| <kbd>g</kbd> | 前往快速上手 |
| <kbd>f</kbd> | 前往功能介绍 |
| <kbd>d</kbd> | 前往下载区 |

## 全局与选择

| 快捷键 | 功能 |
|---|---|
| <kbd>?</kbd> | 功能与快捷键面板 |
| <kbd>t</kbd> | 主题面板 |
| <kbd>Esc</kbd> | 关闭当前浮层、取消选择或清除焦点 |
| <kbd>a</kbd> | 临时启用/禁用当前页选区工具条 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>\\</kbd> | 切换/聚焦 TOC |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> | 撤销批注操作 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | 重做 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Y</kbd> | 重做替代 |

## 导航与审阅

| 快捷键 | 功能 |
|---|---|
| <kbd>/</kbd> | 打开 Workspace Spotlight |
| <kbd>g</kbd> | 打开 Workspace Spotlight / 文件导航 |
| <kbd>j</kbd> / <kbd>k</kbd> | 下 / 上一个标题 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>j</kbd> / <kbd>k</kbd> | 下 / 上一条批注 |
| <kbd>Space</kbd> | 向下平滑滚动约 1/3 页 |
| <kbd>v</kbd> | 切换当前章节 Viewed |
| <kbd>o</kbd> | 独立折叠/展开当前章节 |
| <kbd>x</kbd> | 导出当前页 Notes |
| <kbd>e</kbd> | 打开源码编辑器 |

## Live 与 Chat

| 快捷键 | 功能 |
|---|---|
| <kbd>l</kbd> | Broadcast ⇄ Follow；Off 时直接进入上次/默认活动态 |
| <kbd>Shift</kbd>+<kbd>l</kbd> | Off ⇄ 上一次活动模式 |
| <kbd>c</kbd> | 用默认 surface 打开 Chat |
| <kbd>Shift</kbd>+<kbd>c</kbd> | 用与默认相反的 surface 打开 Chat |

## Git diff

| 快捷键 | 功能 |
|---|---|
| <kbd>m</kbd> | Raw ⇄ Rendered |
| <kbd>n</kbd> / <kbd>p</kbd> | 下 / 上一个文件 |
| <kbd>j</kbd> / <kbd>k</kbd> | 下 / 上一个变更块 |

Raw 的 Split/Unified 由视图菜单选择；文件 Viewed、过滤和侧栏状态有各自可点击控件。

## 视觉查看器

图表、图片或独立 SVG 全屏打开后：

| 快捷键 | 功能 |
|---|---|
| <kbd>+</kbd> / <kbd>=</kbd> | 放大 |
| <kbd>-</kbd> | 缩小 |
| <kbd>0</kbd> / <kbd>r</kbd> | 100% 重置 |
| <kbd>f</kbd> / <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>0</kbd> | 适应窗口 |
| <kbd>z</kbd> | 框选放大工具 |
| <kbd>Shift</kbd>+<kbd>z</kbd> | 框选缩小工具 |
| <kbd>Esc</kbd> | 关闭查看器 |

## 自定义

桌面端 **全局设置 → 快捷键** 可以重新绑定。配置写入 `settings.json`，由桌面端、CLI 启动的阅读页与 diff 页共同读取。

注册器会跳过与已注册功能冲突的组合，并在 `?` 面板中只展示实际生效项。
