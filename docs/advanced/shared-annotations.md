---
title: 共享批注
description: Markon 以 SQLite 为唯一权威、HTTP 写入、WebSocket 广播的共享 annotations 与 Viewed 状态。
---

# 共享批注

<div class="feature-illustration">
  <img src="/illustrations/07-sync.svg" alt="Markon 共享批注同步" />
</div>

Shared 不是另一种存储模式。批注与 Viewed 始终写入本机 SQLite；开启 Shared 只让已通过门禁的协作者访问同一数据集，并接收实时广播。

## 启用

在管理员浏览器的 Workspace 根页开启 `Shared`，或：

```bash
markon set <ID|INDEX> shared on
```

共享内容：

- 三色高亮；
- 删除线；
- Notes；
- H2–H6 Viewed 状态。

**独立折叠状态不共享。** 它是每个浏览器自己的 UI 偏好，保存在当前浏览器；Live Broadcast 可以临时同步演示动作，但不会把普通折叠偏好写入共享 Viewed 数据。

## 数据流

```text
Browser A ── same-origin HTTP command ──▶ SQLite
                                              │
                                              ├── WebSocket event ──▶ Browser B
                                              └── WebSocket event ──▶ Browser C
```

WebSocket 不接受批注/Viewed 写库请求，只承担广播输出。这样断开某个 socket 不会产生第二份离线数据；重连后客户端重新读取服务端权威状态。

## 权限变化

| Shared | 管理员 | 协作者 |
|---|---|---|
| Off | 读写个人审阅状态 | 页面保持只读，可正常原生选择/复制 |
| On | 读写同一状态 | 通过协作者门禁后读写并实时同步 |

关闭 Shared 不删除或搬移任何记录，只收回协作者能力并停止协作广播。

## 多设备

```bash
markon docs/ \
  --host 0.0.0.0 \
  --entry http://192.168.1.20:6419 \
  --collaborator-access-code guest-secret
```

管理员可以从 `markon ls` TUI 复制协作者地址。只有 Shared 已开启的 Workspace 才显示分享操作，且复制出的 URL 不携带管理员 bootstrap。

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

- 按用户区分私有批注；
- 需要逐人 RBAC、审批流或审计日志；
- 高延迟离线编辑与自动合并。

同一 Shared Workspace 的协作者是同一数据集的平等编辑者。

## 备份与清理

停服后备份 `settings.json` 与 `annotation.sqlite`。解除注册不会删除历史；确认不再需要后使用 `markon cleanup` 查看并清理 orphan data。

→ 完整说明见[数据与隐私](/advanced/data-and-privacy)。
