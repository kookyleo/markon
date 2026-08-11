---
title: 源码编辑
description: Markon 的懒加载 CodeMirror 编辑器、渲染选区定位、实时预览、保存与工作区边界。
---

# 源码编辑

<div class="feature-illustration">
  <img src="/illustrations/04-edit.svg" alt="Markon CodeMirror Markdown 编辑器" />
</div>

开启 `Edit` 后，可以在阅读上下文中修改当前 Markdown。编辑器使用 CodeMirror，并作为独立 chunk 懒加载；只阅读文档时不会下载编辑器运行时。

## 打开方式

| 入口 | 行为 |
|---|---|
| <kbd>e</kbd> | 打开当前文件源码 |
| 选中文字 → Edit | 打开编辑器，并选中对应源码文本 |
| 文件/行引用 | 打开后跳到指定 1-based 行号 |

渲染器保留源码位置，能定位时优先按行；只有选区文本时则在源码中查找并选中。

## 编辑界面

- Markdown 语法高亮；
- 行号；
- Edit / Preview 双视图；
- Preview 通过受 body limit 与 workspace capability 约束的服务端接口渲染；
- 编辑与预览滚动联动；
- 可拖动分隔条；
- 保存中/已修改状态；
- 主题、字体与 UI token 跟随全局设置。

导出 Notes 复用同一套编辑器，但运行在 `export` 模式：缓冲区不写源文件，Save 会下载 `.md`。

## 保存

按 <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> 或点击保存。保存请求必须满足：

- Workspace 开启 Edit；
- 路径属于当前 Workspace；
- 只写允许的 Markdown 文件；
- 浏览器 same-origin；
- 页面持有当前 Workspace 的 save capability。

保存成功后，已发送到服务端的文档成为新 baseline。若请求期间用户继续输入，后续内容仍保持“未保存”，不会被错误标记为干净。

关闭编辑器时，未保存改动会触发确认。普通 edit 模式关闭后重新加载页面，显示服务端最新渲染。

## 文件变化与冲突

Markon 监听 Workspace 文件变化并更新页面/索引。当前浏览器编辑器不提供多人 OT/CRDT 或 Git merge：

- 同一文件多人编辑时，后保存者可能覆盖先保存内容；
- AI edit 在 Apply 前会做 drift 检测；
- 人工编辑保存仍应通过 Git 或协作约定避免竞争。

需要审阅改动时，可回到[Git Working diff](/zh/features/git)查看实际写盘结果。

## 与权限的关系

- 管理员在 Edit 开启时可以编辑。
- 协作者也只有在 Workspace 显式开启 Edit 后才能保存。
- 开启 Chat 但关闭 Edit 时，Workspace AI 只有只读工具。
- 同时开启 Chat + Edit 后，AI 才注册审批式 `edit_file`。
