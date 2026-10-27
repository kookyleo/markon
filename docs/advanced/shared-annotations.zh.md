---
title: 共享批注与阅读进度（Share）
description: 允许协作者读写并同步同一份批注与章节进度标记，以 SQLite 为权威存储。
---

# 共享批注与阅读进度（Share）

<div class="feature-illustration">
  <img src="/illustrations/07-sync.svg" alt="Markon 共享批注与阅读进度" />
</div>

**共享批注与阅读进度 / Share** 允许协作者读取、修改并同步同一份批注与章节进度标记。数据始终保存在本机 SQLite，个人审阅无需开启 Share；该开关用于选择共同数据与实时同步。

能力名与开关短名统一用 Share；Shared 用于表示共同审阅作用域、「已共享」状态或普通英语描述。旧版界面可能仍显示 Shared。CLI 首选 `share`，旧参数 `shared` 继续作为别名；配置字段 `shared_annotation` 和本页 URL 保持兼容。

## 启用

在管理员浏览器的 Workspace 根页开启 `Share`，或：

```bash
markon set <ID|INDEX> share on
```

共享内容：

- 三色高亮；
- 删除线；
- 文字批注（Notes）；
- 正文 H2–H6 的章节进度标记（Progress）。

**阅读位置记忆、普通折叠状态和 Markdiff 的逐文件进度不在 Share 同步范围内。** 它们是浏览器本地状态。Live 另行提供演示跟随，不会因此把这些本地状态转成共享章节进度。

## 数据流

```text
Browser A ── same-origin HTTP command ──▶ SQLite
                                              │
                                              ├── WebSocket event ──▶ Browser B
                                              └── WebSocket event ──▶ Browser C
```

WebSocket 不接受批注/Progress 写库请求，只承担广播输出。这样断开某个 socket 不会产生第二份离线数据；重连后客户端重新读取服务端权威状态。

## Personal 与 Shared 作用域

任何通过工作区门禁的浏览器都可使用 Annotate、Progress 与 Export Notes；这些基础能力不要求 Admin。

| Share | 当前作用域 | 审阅数据 |
|---|---|---|
| Off | Personal | 非管理员浏览器各自隔离持久化个人记录；管理员保留既有记录 |
| On | Shared | 工作区用户共同读写同一份记录，并实时同步 |

两个作用域都保存到同一 SQLite：浏览器个人记录使用新增私有表，管理员既有／共同记录保留原表。开启 Share 不会自动发布或合并浏览器私有 Personal 数据；关闭后恢复 Personal，不搬移或删除任一数据集。界面显示 Personal / Shared，明确当前操作范围。

管理员的 Personal 使用既有 owner 原表，与 Share 开启后开放的共同审阅是同一旧数据集；因此开启 Share 会让协作者访问这些既有 owner 记录。非管理员浏览器私有 Personal 表仍单独保留，不自动导入。API 作用域为 `owner`、`personal`、`shared`，界面把前两者都显示为 Personal。

独立于 Admin 的私有身份 Cookie 用于访问本浏览器的 Personal 数据。清除站点数据会失去该入口；它不是账号，目前没有账户恢复或个人数据跨设备同步。昵称与颜色不能作为私有身份认证。

Edit、Chat 分别控制源码编辑与 AI；Share 不授予这些权限，也不授予管理权限。Live 另行提供同步演示，不会发布 Personal 审阅数据。

## 多设备

```bash
markon docs/ \
  --host 0.0.0.0 \
  --public-base-url http://192.168.1.20:6419 \
  --collaborator-access-code guest-secret
```

管理员可以从 `markon ls` TUI 复制协作者地址。只有 Share 已开启的 Workspace 才显示分享操作，且复制出的 URL 不携带管理员 bootstrap。

## 数据库

| 平台 | 默认路径 |
|---|---|
| macOS / Linux | `~/.markon/annotation.sqlite` |
| Windows | `%USERPROFILE%\.markon\annotation.sqlite` |

覆盖：

```bash
MARKON_SQLITE_PATH=/srv/markon/annotation.sqlite markon docs/
```

## 适用边界

适合：

- 小团队同步审阅；
- 手机、平板、电脑查看同一审阅状态；
- 评审会与读书会。

不适合：

- 按账号恢复或跨设备同步个人批注；
- 需要逐人 RBAC、审批流或审计日志；
- 高延迟离线编辑与自动合并。

开启 Share 的同一工作区中，协作者是同一审阅数据集的平等编辑者。

## 备份与清理

停服后备份 `settings.json` 与 `annotation.sqlite`。解除注册不会删除历史；确认不再需要后使用 `markon cleanup` 查看并清理 orphan data。

→ 完整说明见[数据与隐私](/zh/advanced/data-and-privacy)。
