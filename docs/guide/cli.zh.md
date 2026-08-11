---
title: 命令行选项
description: 以 crates/cli 的 Clap 定义为准的 markon 参数、子命令、服务行为与常用部署示例。
---

# 命令行选项

`markon` 是 `markond` 后台服务的本地客户端。它负责解析配置、启动或连接服务、注册 Workspace，并通过当前用户专属的本地控制套接字执行管理操作。

## 安装

```bash
cargo install markon markond
```

两个二进制都应位于 `PATH`。缺少 `markond` 时，`markon` 会在当前进程以前台模式提供服务。

## 语法

```text
markon [OPTIONS] [FILE]
markon <COMMAND>
```

`FILE` 可以是 Markdown 文件或目录；省略时使用当前目录。传入路径后默认尝试打开浏览器。

::: tip 桌面版用户
桌面版 **Tips** 页提供 CLI 命令生成器，可根据路径、地址与访问码生成命令或 shell alias。

![GUI 内置的 CLI 命令生成器](/screenshots/gui-cli-builder.png)
:::

## 主选项

| 选项 | 代码中的行为 |
|---|---|
| `-p, --port <PORT>` | Web 端口，默认 `6419`；显式参数覆盖 settings |
| `--host [IP]` | 指定绑定地址；只写 `--host` 时进入网卡选择器 |
| `--entry [URL_PREFIX]` | 对外展示地址前缀，同时用于 QR 和 Host/origin allowlist |
| `--qr [URL_PREFIX]` | `--entry` 的别名 |
| `--trusted-host <HOST_OR_ORIGIN>` | 额外允许的精确 authority，可重复 |
| `-b, --open-browser [BASE_URL]` | 打开浏览器；无值用本地地址，有值时用给定 base |
| `--collaborator-access-code <CODE>` | 设置当前工作区协作者码；空字符串清除 |
| `--print-collapsed-content` | 打印时强制包含折叠正文；默认显示折叠占位 |
| `--salt <SALT>` | 高级 workspace-id salt 覆盖；已有安装不要随意修改 |

功能开关不再是启动参数。使用 `markon set`、桌面端或浏览器管理员页调整。

## 子命令

### `markon ls`

```bash
markon ls
markon ls --format cards
markon ls --format table
```

- stdin/stdout 都是可用 TTY 时，裸命令启动交互式 TUI。
- 非 TTY 或 `MARKON_NO_TUI` 已设置时，回退为静态 cards。
- `--format` 可明确要求 cards 或 table。

结果包含 workspace id/path、功能开关、Search ready 状态、本地/公网地址与 QR 信息。TUI 还能编辑功能、打开 Workspace、分享已开启 Shared 的协作者地址，以及进入数据清理。

### `markon set`

```bash
markon set <ID|INDEX> <FEATURE> <on|off>
```

`FEATURE`：

| 值 | 功能 |
|---|---|
| `search` | Tantivy/Jieba 内容索引与 Spotlight 搜索结果 |
| `viewed` | H2–H6 Viewed 状态和章节动作 |
| `edit` | CodeMirror 保存与 AI `edit_file` 提案 |
| `live` | Broadcast / Follow |
| `chat` | Workspace AI |
| `shared` | 协作者读写批注/Viewed，并通过 WebSocket 同步 |

示例：

```bash
markon set 1 edit on
markon set a1b2c3d4 chat off
```

### `markon detach`

```bash
markon detach <ID|INDEX>
```

从运行中注册表移除 Workspace，并持久化列表。不会删除源文件、settings 其它字段或 SQLite 历史。

### `markon cleanup`

```bash
markon cleanup
markon cleanup --yes
```

统计并可选删除不属于任何活动 Workspace 的 annotations、Viewed 与 Chat 数据。执行前请先读[数据与隐私](/zh/advanced/data-and-privacy)并备份数据库。

### `markon admin`

```bash
markon admin open
markon admin code
```

- `open`：创建 60 秒有效、一次性 URL fragment nonce 并打开浏览器；
- `code`：打印 5 分钟有效的手动配对码，适合 SSH/headless。

两者兑换相同的短期 `HttpOnly` Admin session。loopback 不自动获得管理员角色。

### `markon shutdown`

请求后台服务优雅关闭并清理运行锁。

### `markon bug` / `idea` / `ask`

```bash
markon bug  [-t TITLE] [-b BODY]
markon idea [-t TITLE] [-b BODY]
markon ask  [-t TITLE] [-b BODY]
```

通过已认证的 `gh` 创建 GitHub Issue 或 Discussion；未提供 title/body 时进入交互输入或 `$EDITOR`。

## 单服务、多工作区

```bash
markon project-a/
markon project-b/
markon README.md
markon ls
```

第一次调用启动 `markond`，之后的调用连接现有服务。目录工作区写入 settings 并恢复；单文件工作区是否自动清理由全局设置控制。

若运行中的服务版本与当前 CLI 不兼容，CLI 会刷新服务状态，而不是把新客户端命令发给旧控制协议。

## 地址与浏览器行为

```bash
markon README.md                 # 路径参数：默认尝试打开
markon                           # 当前目录：默认不强制打开
markon -b                        # 当前目录并打开本地地址
markon -b https://docs.example.com docs/
```

`--open-browser BASE_URL` 会把 Workspace 路径附加到给定 base，适合反向代理入口。

## 监听示例

```bash
markon docs/                     # 默认 settings host；新安装通常是 127.0.0.1
markon docs/ --host              # 交互选择网卡
markon docs/ --host 0.0.0.0      # 全接口
markon docs/ --host 192.168.1.5  # 指定接口
```

局域网：

```bash
markon docs/ --host 0.0.0.0 \
  --entry http://192.168.1.20:6419 \
  --collaborator-access-code guest-secret
```

反向代理：

```bash
markon docs/ --host 127.0.0.1 \
  --entry https://docs.example.com \
  --trusted-host https://docs.example.com
```

![CLI 输出访问链接与 QR](/screenshots/cli-qr.png)

`--entry` 只描述外部 origin，不提供 TLS。公网部署见[反向代理](/zh/advanced/reverse-proxy)。

## 设置优先级

CLI 读取 `~/.markon/settings.json`。大体规则是：

1. 本次显式命令行参数；
2. 已保存全局设置；
3. 内置默认值。

主题、语言、自定义样式、快捷键、Provider、工作区列表和新工作区默认开关与桌面端共享。运行中 Workspace 注册表由服务拥有，GUI 保存偏好时不会用旧快照覆盖它。

## 数据库覆盖

```bash
MARKON_SQLITE_PATH=/srv/markon/annotation.sqlite markon docs/
```

数据库保存批注、Viewed 与 Chat。是否启用 Shared 不改变存储位置，只改变协作者能力与广播。
