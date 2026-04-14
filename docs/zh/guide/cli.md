# 命令行选项

本页介绍 CLI 版 `markon` 的所有选项。桌面版用户通常不需要关心这些 —— GUI 的图形化设置覆盖了大部分配置。

## 基础用法

```bash
markon [FILE] [OPTIONS]
```

- **`FILE`** — 要渲染的 Markdown 文件或目录（可选）。省略时使用当前目录。

## 选项速查

| 选项 | 说明 | 默认 |
|------|------|------|
| `-p, --port <PORT>` | HTTP 服务器端口 | `6419` |
| `--host [IP]` | 绑定地址，省略值时交互式选择 | `127.0.0.1` |
| `-b, --browser [URL]` | 启动后自动打开浏览器 | 否 |
| `--qr [URL]` | 生成 QR 码，可指定公网 URL | — |
| `-t, --theme <THEME>` | 配色主题：`light` / `dark` / `auto` | `auto` |
| `--enable-search` | 启用全文搜索（Tantivy 索引） | false |
| `--enable-viewed` | 启用 Section Viewed 复选框 | false |
| `--enable-edit` | 启用 Markdown 在线编辑 | false |
| `--shared-annotation` | 启用共享标注（SQLite 同步） | false |
| `--salt <STRING>` | 自定义 workspace ID salt | — |

## 常用场景

### 个人本地阅读

```bash
markon README.md -b
```

最简单的用法：渲染一个文件并自动打开浏览器。

### 浏览整个项目的文档

```bash
markon docs/ --enable-search -b
```

以目录为工作区，启用全文搜索。

### 局域网共享给团队

```bash
markon --host 0.0.0.0 --qr --shared-annotation --enable-viewed
```

- `--host 0.0.0.0` — 绑定所有网络接口，局域网可访问
- `--qr` — 终端打印 QR 码方便移动端扫码
- `--shared-annotation` — 启用 SQLite 数据库共享标注和已读状态
- `--enable-viewed` — 启用 Section Viewed 功能

### 交互式选择网络接口

```bash
markon --host
```

运行后会列出所有可用的网络接口，上下方向键选择。

### 经反向代理暴露

```bash
markon -b https://docs.example.com --qr https://docs.example.com
```

当 Markon 部署在反向代理后面时，`-b` 和 `--qr` 分别指定浏览器打开的 URL 和 QR 码编码的 URL。

→ 配置细节见 [反向代理](/zh/advanced/reverse-proxy)

### 启用所有功能

```bash
markon --host 0.0.0.0 \
  --enable-search \
  --enable-viewed \
  --enable-edit \
  --shared-annotation \
  --qr \
  -b
```

## `--host` 详解

`--host` 参数有几种形式：

```bash
markon                       # 默认：绑定 127.0.0.1，仅本机可访问（最安全）
markon --host                # 交互式菜单选择可用接口
markon --host 0.0.0.0        # 绑定所有接口，局域网可访问
markon --host 192.168.1.5    # 绑定到指定 IP
```

## 主题选择

```bash
markon --theme light    # 强制浅色
markon --theme dark     # 强制深色
markon --theme auto     # 跟随系统（默认）
```

## 数据存储位置

启用 `--shared-annotation` 时，SQLite 数据库默认存储在：

- **Linux/macOS**：`~/.local/share/markon/annotations.db`
- **Windows**：`%APPDATA%\markon\annotations.db`

自定义路径：

```bash
MARKON_SQLITE_PATH=/path/to/db markon --shared-annotation
```
