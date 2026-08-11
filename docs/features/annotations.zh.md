---
title: 批注与 Notes
description: Markon 的跨区块文本锚点、三色高亮、删除线、Notes、撤销重做与 SQLite 持久化。
---

# 批注与 Notes

<div class="feature-illustration">
  <img src="/illustrations/05-annotate.svg" alt="Markon 文本批注与 Notes" />
</div>

在正文中选择文字，会出现选区工具条。它可以把一次阅读判断保存成高亮、删除线或带文字的 Note。

## 四类操作

| 操作 | 用途 |
|---|---|
| 橙色高亮 | 重要或需关注 |
| 绿色高亮 | 认可或已确认 |
| 黄色高亮 | 待确认或存疑 |
| 删除线 | 过时或建议删除 |
| Note | 在任一选区上附加文字 |

同一选区可有高亮与 Note。选区跨越多个段落、列表项、表格单元等 DOM 区块时，会保存有序 fragments，并继续兼容旧版单片段锚点。

## 选区工具条

- 鼠标或触摸选择文字后出现；
- <kbd>a</kbd> 可临时启用/禁用当前页工具条，方便只做原生选择与复制；
- <kbd>Esc</kbd> 清除选区或关闭当前浮层；
- Edit/Chat 已开启时，工具条同时提供跳源码或带选区提问入口。

## Notes 的显示与编辑

- 宽屏优先显示右侧 margin card；
- 窄屏使用贴近来源的 popup；
- 点击来源高亮可重新定位对应 Note；
- 编辑时在当前 card/popup 内完成，不必跳到另一个固定位置；
- 可以复制单条“局部引用 + Note”Markdown；
- 已折叠章节中的来源会临时展开，关闭 Note 后恢复原折叠状态。

## 撤销、重做与导航

| 快捷键 | 操作 |
|---|---|
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> | 撤销 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | 重做 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Y</kbd> | 重做替代 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>J</kbd> | 下一条批注 |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> | 上一条批注 |

undo stack 上限为 50。跨区块批注、Note 文本修改与删除都进入同一操作栈。

## 持久化与权限

批注始终由 `annotation.sqlite` 保存，浏览器不再镜像、迁移、排队或降级到 LocalStorage。

| Workspace 状态 | 谁能读写同一数据集 |
|---|---|
| Shared 关闭 | 显式管理员会话 |
| Shared 开启 | 管理员 + 已通过门禁的协作者 |

操作先通过 document-state HTTP API 写入 SQLite；Shared 开启时，服务再向其它客户端广播变更。服务不可用或无权限时会明确失败，页面保持只读。

批注以文件绝对路径关联。移动文件会改变关联；服务重启或升级不应改变。

## 清除、导出与打印

- 页面 footer 可以清除当前文件全部批注，并要求确认；
- H1 与 H2–H6 的操作可按整页或章节[导出 Notes](/zh/features/export)；
- 打印正文会保留高亮、删除线和 Note 内容；
- diff 页面也能建立批注、统计和导出 Notes。

共享机制见[共享批注](/zh/advanced/shared-annotations)，备份见[数据与隐私](/zh/advanced/data-and-privacy)。
