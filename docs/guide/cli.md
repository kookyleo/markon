# 命令行选项

本页介绍 CLI 版 `markon` 的所有选项。桌面版用户通常不需要关心这些 —— GUI 的图形化设置覆盖了大部分配置。

## 基础用法

```bash
markon [FILE] [OPTIONS]
```

- **`FILE`** — 要渲染的 Markdown 文件或目录（可选）。省略时使用当前目录。

::: tip 桌面版用户
桌面版内置了可视化的 CLI 命令生成器——打开 **Tips** 标签页，填写目标路径、服务地址和协作者访问码，即可一键复制完整命令或生成 shell alias。

![GUI 内置的 CLI 命令生成器](/screenshots/gui-cli-builder.png)
:::

## 选项速查

| 选项 | 说明 | 默认 |
|------|------|------|
| `-p, --port <PORT>` | HTTP 服务器端口 | `6419` |
| `--host [IP]` | 绑定地址，省略值时交互式选择 | `127.0.0.1` |
| `-b, --open-browser [BASE_URL]` | 自动打开浏览器；可选传入 BASE_URL 覆盖默认（不传则用本地工作区地址） | 是（若提供路径） |
| `--entry, --qr [PREFIX]` | 指定外部访问地址前缀（生成二维码） | — |
| `--collaborator-access-code <CODE>` | 设置或清除该工作区的协作者访问码（远程访客门禁；本机始终免码） | — |
| `--print-collapsed-content` | 打印时包含折叠章节的内容（默认隐藏折叠内容） | false |
| `--salt <STRING>` | 自定义 workspace ID salt | — |

工作区功能（搜索、已读追踪、编辑、Live、AI 对话、共享批注）统一在浏览器工作区设置页中控制；CLI 只继承全局默认值来初始化新工作区。

## 工作区管理

Markon 支持在同一个服务实例中管理多个工作区。你可以通过以下命令进行维护：

### 列出活跃工作区

```bash
markon ls
```

输出示例：
```text
#    ID         PATH
---  ---        ----
1    abc12345   /Users/me/project-a
2    def67890   /Users/me/project-b
```

### 移除工作区

你可以通过 `ls` 命令输出的序号或 ID 来移除不再需要的工作区：

```bash
markon detach 1          # 通过序号移除
markon detach abc12345   # 通过 ID 移除
```

### 开关工作区功能

本机 CLI 可以像桌面 GUI 一样直接开关某个工作区的功能（走本机管理 API，等同管理员，无需任何码）：

```bash
markon set 3 edit on         # 通过序号，打开「编辑」
markon set abc12345 chat off # 通过 ID，关闭「AI 对话」
```

- 第一个参数是 `ls` 输出里的**序号或 ID**。
- feature 名可选：`search`（搜索）/ `viewed`（已读追踪）/ `edit`（编辑）/ `live`（Live）/ `chat`（AI 对话）/ `shared`（共享批注）。
- 最后一个参数是 `on` 或 `off`。

> 管理与结构性操作（改功能开关 / 别名、增删工作区、git 提交等）只在本机可用；远程访客只有该工作区功能开关允许的协作能力。详见[访问权限](/features/access)。

### 停止服务

当你不再需要 Markon 时，可以关闭后台驻留的服务进程：

```bash
markon shutdown
```

### 反馈与提问

除了 `ls` / `detach` / `shutdown`，CLI 还提供几个反馈类子命令，方便你直接从终端联系作者：

```bash
markon bug      # 报告一个 Bug
markon idea     # 提一个功能建议
markon ask      # 提问或寻求帮助
```

## 驻留模式

Markon CLI 默认以守护进程（Daemon）模式运行。当你第一次启动时，它会自动转入后台并不再占用终端。你可以随时通过 `ls` 查看状态或 `shutdown` 关闭它。
## 基础逻辑

Markon 采用 **“单服务 + 多工作区”** 模型，且 CLI 默认开启 **后台驻留 (Daemon)** 模式。

- **首次运行**：Markon 会启动后台服务并立即释放终端控制权。
- **后续运行**：新实例会自动检测后台服务，将路径作为新工作区追加，并在浏览器中尝试打开。

无论是哪种情况，终端都会反馈当前工作区的访问地址。


## 常用场景

### 个人本地阅读

```bash
markon README.md
```

最简单的用法：渲染一个文件。程序会尝试自动打开浏览器。

### 浏览整个项目的文档

```bash
markon docs/
```

以目录为工作区。搜索、编辑等功能可在打开后的工作区设置页开启；新工作区的初始值来自全局默认设置。

### 局域网共享给团队

```bash
markon --host 0.0.0.0 --entry http://192.168.1.100:6419
```

- `--host 0.0.0.0` — 绑定所有网络接口，局域网可访问
- `--entry` — 指定外部访问地址前缀，终端将打印完整的工作区二维码
- 在浏览器工作区设置页启用 **共享批注** / **已读追踪** 等功能

![CLI 启动后显示访问链接和 QR 码，移动端扫码即可打开](/screenshots/cli-qr.png)

### 交互式选择网络接口

```bash
markon --host
```

运行后会列出所有可用的网络接口，上下方向键选择。

### 经反向代理暴露

```bash
markon --entry https://docs.example.com
```

当 Markon 部署在反向代理后面时，使用 `--entry` 指定外部访问的前缀。Markon 会在该前缀后自动追加具体工作区的 ID。

→ 配置细节见 [反向代理](/advanced/reverse-proxy)


### 设置协作者访问码

```bash
markon --collaborator-access-code guest-secret README.md
```

给远程访客加一道门禁：设了协作者访问码后，从其它机器访问该工作区要先在门禁页输入正确的码；**本机（桌面版 / 本机浏览器）始终免码放行**。明文只用于这次 CLI 调用，Markon 写入 `settings.json` 时只保存加盐 hash。传空字符串则清除该工作区的码。详见[访问权限](/features/access)。

## `--host` 详解

`--host` 参数有几种形式：

```bash
markon                       # 默认：绑定 127.0.0.1，仅本机可访问（最安全）
markon --host                # 交互式菜单选择可用接口
markon --host 0.0.0.0        # 绑定所有接口，局域网可访问
markon --host 192.168.1.5    # 绑定到指定 IP
```

## 数据存储位置

工作区启用 **共享批注** 或 **AI 对话** 后，SQLite 数据库默认存储在：

- **Linux/macOS**：`~/.markon/annotation.sqlite`
- **Windows**：`%USERPROFILE%\.markon\annotation.sqlite`

自定义路径：

```bash
MARKON_SQLITE_PATH=/path/to/db markon README.md
```

## 共享配置

CLI 启动时会自动读取 `~/.markon/settings.json`（如果存在），继承：

- **自定义样式** (`web_styles`) — 主色、字体、面板透明度等
- **快捷键** (`shortcuts`) — 用户在桌面版中重新绑定的按键
- **阅读页语言** (`web_language`) — 浏览器页面显示语言

这份配置文件由桌面版的 **全局设置** 维护。推荐流程：**用桌面版配好样式和快捷键，然后
CLI 自动继承**。两端在同一台机器上共享同一份配置。

命令行参数（如 `--port`、`--host`）仍然是显式指定的 —— 它们覆盖配置文件里对应的字段。
如果配置文件不存在（从未启动过桌面版），CLI 使用内置默认值。
