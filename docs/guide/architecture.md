---
title: 运行架构
description: Markon 的 markond 服务、GUI/CLI 控制面、浏览器数据面、Workspace 持久化与权限边界。
---

# 运行架构

当前 Markon 由一个长期运行的后台服务和多个入口组成。桌面端与 CLI 不各自启动一套独立核心，而是共同连接 `markond`。

```text
┌──────────────────┐   privileged local control socket   ┌──────────────────┐
│ Desktop (Tauri 2)│ ───────────────────────────────────▶ │                  │
└──────────────────┘                                      │     markond      │
┌──────────────────┐ ───────────────────────────────────▶ │                  │
│ markon CLI       │                                      │ workspace registry
└──────────────────┘                                      │ HTTP · Git · DB  │
                                                          └────────┬─────────┘
                                                                   │ scoped HTTP /
                                                                   │ WebSocket
                                                          ┌────────▼─────────┐
                                                          │ Browser workspace│
                                                          └──────────────────┘
```

## 四个 crate 的职责

| 路径 | 职责 |
|---|---|
| `crates/core` | HTTP 路由、Markdown、搜索、Git、SQLite、Chat、控制协议与浏览器资源 |
| `crates/markond` | 唯一持有 core 的后台服务；恢复工作区并同时提供 Web 与本地控制平面 |
| `crates/cli` | `markon` 命令；启动或连接服务，通过控制套接字管理工作区 |
| `crates/gui` | Tauri 2 桌面壳与设置界面；连接同一个控制套接字 |

`crates/xtask` 只负责图标等构建期维护，不参与运行时。

## 服务生命周期

第一次运行 `markon <path>` 时：

1. CLI 读取 `~/.markon/settings.json`，解析监听地址、端口与工作区默认值。
2. 如果没有兼容的运行中服务，CLI 启动同一 `PATH` 上的 `markond`。
3. `markond` 恢复已持久化的目录工作区，建立 Web 监听与权限为本机用户的控制套接字。
4. CLI 注册本次路径；传入文件路径时默认尝试打开浏览器。

后续 `markon` 调用会连接已运行服务，而不是再占一个端口。若系统找不到 `markond`，CLI 会退回前台服务模式，但终端不能像后台模式一样立即返回。

桌面应用也连接同一服务，所以 GUI 和 CLI 看到的是同一份工作区注册表。配置更新会合并各自负责的字段，避免桌面端的旧快照覆盖服务刚写入的工作区状态。

## Workspace 模型

### 目录工作区

- 路径、别名、功能开关与协作者访问码 hash 写入 `settings.json`。
- 进程重启后恢复。
- URL 中的 workspace id 由持久 salt 与规范化路径生成，升级后必须稳定。

### 单文件工作区

- 以该文件完整路径作为身份，但服务边界是父目录。
- 只开放正文文件及 Markdown 明确引用、且仍在父目录内的本地资源。
- `auto_remove_single_file_workspaces` 默认为 `true`，启动恢复前自动清理；关闭后可以跨重启保留。

### URL 分层

| 空间 | 示例 | 用途 |
|---|---|---|
| 文档空间 | `/{workspace_id}/path/to/file.md` | 与工作区文件系统映射的可读 URL |
| 工作区功能空间 | `/_/{workspace_id}/git/history` | 搜索、Git、compare、settings、chat、WebSocket |
| 全局系统空间 | `/_/css/...`、`/_/admin` | 资源与管理员引导 |
| 浏览器 API | `/api/save`、`/api/chat/...` | 受 capability 与 same-origin 约束的程序接口 |

增删工作区、设置别名、shutdown 等管理操作不暴露在 TCP 上，只走本地控制套接字。

## 权限不是 IP 角色

Markon 不把 loopback、局域网来源或反向代理头当作管理员身份证明：

- **管理员会话**来自 `markon admin open` 或 `markon admin code`，可执行结构性操作。
- **协作者**只能使用当前工作区已开启的 Edit、Chat、Shared 等能力。
- **协作者访问码**控制非管理员浏览器是否能进入。
- **Host allowlist**拒绝未登记 authority，防止 DNS rebinding。
- 保存、设置、Git 写操作等还要求 same-origin 或工作区 capability。

完整规则见[访问与权限](/features/access)。

## 持久数据

```text
~/.markon/
├── settings.json          # 全局设置、salt、工作区
├── annotation.sqlite      # 批注、Viewed、Chat
├── server.lock            # 运行端口、控制套接字、服务版本
└── logs/markond.log       # 后台服务滚动日志
```

`markond.log` 单文件上限为 2 MiB，并保留 3 份轮转备份。数据库路径可由设置或 `MARKON_SQLITE_PATH` 覆盖。备份、清理与隐私边界见[数据与隐私](/advanced/data-and-privacy)。
