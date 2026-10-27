---
title: 批注（Annotate）
description: Markon 的跨区块文本锚点、三色高亮、删除线、Notes、撤销重做与 SQLite 持久化。
---

# 批注（Annotate）

<div class="feature-illustration">
  <img src="/illustrations/05-annotate.svg" alt="Markon 文本批注（Annotate）" />
</div>

在正文中选择文字，会出现选区工具条。它可以把一次阅读判断保存成高亮、删除线或带文字的 Note。

## 名称与层级

**批注 / Annotate** 是总能力，包含**高亮 / Highlight**、**删除线 / Strike** 和**文字批注 / Note**。Note 仅指附着在原文上的文字意见，多条时写 Notes；没有文字内容的高亮和删除线也属于批注。`Annotation` 是实现中的批注记录类型，用于代码、API 和技术说明。

产品能力统一称「批注 / Annotate」，文字子功能称「文字批注 / Note」。例如，「导出文字批注 / Export Notes」只导出有文字内容的记录；「清除全部批注」还会清除纯高亮和纯删除线。对已有文字批注追加回复仍是规划能力。

## 批注方式

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
- 可以复制单条「局部引用 + Note」Markdown；
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

批注始终由 `annotation.sqlite` 保存，不镜像、迁移、排队或降级到 LocalStorage。任何通过工作区门禁的浏览器都可使用 Annotate、Progress 与 Export Notes，不需要管理员会话或开启 Share。

| 作用域 | 审阅数据 |
|---|---|
| Personal（Share 关闭） | 非管理员浏览器按私有身份隔离；管理员既有数据保留原存储 |
| Shared（Share 开启） | 当前工作区的用户共同读写同一数据集，并实时同步 |

两个作用域使用同一 SQLite。浏览器个人记录使用新增私有表，管理员既有／共同记录沿用原表。切换不会自动发布或合并浏览器私有 Personal 数据；关闭 Share 后恢复 Personal。界面明确显示当前作用域。

私有身份 Cookie 独立于 Admin。清除浏览器站点数据会失去本浏览器 Personal 数据的入口；现阶段没有账户恢复或个人数据跨设备同步。昵称与颜色仅是署名，不是身份凭据。数据继续按文件绝对路径关联；修改经同源 HTTP 写库，Shared 修改再由 WebSocket 广播。服务失败时明确报错，不降级到浏览器存储。

## 清除、导出与打印

- 页面 footer 可以清除当前文件全部批注，并要求确认；清除不会重置章节进度，进度通过「全部已读 / All Read」复选框单独管理已读／未读状态；
- H1 与 H2–H6 的操作可按整页或章节[导出文字批注（Export Notes）](/zh/features/export)；
- 打印正文会保留高亮、删除线和 Note 内容；
- diff 页面也能建立批注、统计和导出文字批注（Export Notes）。

共享机制见[共享批注与阅读进度（Share）](/zh/advanced/shared-annotations)，备份见[数据与隐私](/zh/advanced/data-and-privacy)。
