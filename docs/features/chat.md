---
title: Workspace AI
description: Markon 的 Anthropic/OpenAI-compatible Provider、工作区文件工具、引用、threads 与审批式 edit_file。
---

# Workspace AI

<div class="feature-illustration">
  <img src="/illustrations/12-chat.svg" alt="Markon Workspace AI" />
</div>

Workspace AI 是一个受当前 Workspace 边界约束的阅读助手。它能调查文件、给出可点击引用；当 Edit 也开启时，还能提出必须由用户确认的精确文件修改。

## 启用条件

1. 在桌面端 **全局设置 → AI Chat** 配置 Provider、API key、base URL 与 model。
2. 为目标 Workspace 开启 `Chat`。
3. 如果希望 AI 提出修改，再同时开启 `Edit`。

支持：

- Anthropic；
- OpenAI-compatible API（可配置 base URL）。

默认模型由代码按 Provider 选择：Anthropic 为 `claude-sonnet-4-6`，OpenAI-compatible 为 `gpt-4o`。模型列表可以从 Provider 的 `/v1/models` 刷新并缓存到 settings。

API key 明文存入 `~/.markon/settings.json`，请把它当作开发凭据保护。

## 打开方式

### 页内面板

点击右下角 Chat 球，或按 <kbd>c</kbd>。面板可拖动、缩放，位置与尺寸按 Workspace 保存在当前浏览器。

### 独立窗口

设置默认 Chat surface 为 popout，或按 <kbd>Shift</kbd>+<kbd>c</kbd> 临时使用与默认相反的形式。页内面板与窗口之间会转交当前草稿和未发送引用。

### 从选区提问

在正文选中文字，点击选区工具条的 Chat。选区会变成输入框上方的引用 pill；可在发送前单独移除。

### `@` 引用文件

输入 `@` 搜索 Workspace 内可读文本文件。选中后，该文件内容随本轮请求发送。文件列表与读取都经过 WorkspaceFs，单文件工作区不会因此扩大范围。

## 文件调查工具

每个 Chat session 默认得到四个只读工具：

| 工具 | 作用 |
|---|---|
| `read_file(path, offset?, limit?)` | 分页读取 UTF-8 文本 |
| `list_dir(path?)` | 列出一层目录 |
| `glob(pattern, limit?)` | 按路径模式找文件 |
| `grep(pattern, path?, glob?, ...)` | 用正则搜索内容 |

约束：

- 相对路径必须留在 Workspace capability 内；
- 拒绝二进制或非 UTF-8 文件；
- 单文件上限 1 MiB；
- 单次工具输出上限 64 KiB；
- 每个用户回合最多 8 个 agent step；
- 模型不能执行命令或访问网络。

目录与 glob 遵守 Workspace 的忽略规则。

## 审批式文件修改

当 `Chat` 与 `Edit` 同时开启，工具注册表会增加 `edit_file(path, old_string, new_string)`。

流程不是“模型直接写盘”：

1. 模型提出 exact-string replace。
2. 后端校验路径、UTF-8、1 MiB 上限，以及 `old_string` 恰好出现一次。
3. Chat 显示 old/new diff 卡片，agent 暂停。
4. 用户选择 **Apply** 或 **Reject**；也可按 Enter / Esc。
5. Apply 前重新读取文件，检测提案后是否已发生 drift。
6. 成功应用后显示 **Undo**；Undo 同样校验当前内容，避免覆盖后续改动。

`edit_file` 不能创建新文件、移动、删除或运行命令。结构性文件操作仍要求管理员在 Workspace 页面明确执行。

## 引用与回链

AI 输出中的下列格式会渲染为可点击引用：

- `path/to/file.md:42`
- `path/to/file.md:42-58`
- `path/to/file.md#heading-id`

Markdown 文件打开阅读视图并定位；其它可读文本文件保持工作区边界。引用让答案可以回到证据，而不是只显示一段不可核对的总结。

## Threads

每个 Workspace 可以创建多个 thread，并支持：

- 列表与切换；
- 自动标题；
- 重命名；
- 删除；
- 保存消息内容、工具调用和 edit 状态。

threads/messages 位于 `annotation.sqlite`，按稳定 workspace id 关联。服务重启后仍保留。

## 隐私与成本

会发送给 Provider 的内容可能包括：

- 用户问题与 thread 历史；
- 当前文档路径；
- 文字选区；
- `@` 文件；
- 工具读取结果；
- edit 提案的执行结果。

不会因为开启 Chat 自动上传整个目录。工具按模型请求逐项读取，但读取内容会进入对应 Provider 的请求；只对愿意发送的 Workspace 开启。

完整边界见[数据与隐私](/advanced/data-and-privacy)。
