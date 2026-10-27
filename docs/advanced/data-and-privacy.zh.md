---
title: 数据与隐私
description: Markon 的 settings.json、SQLite、日志、浏览器偏好、AI 外发边界、备份与 orphan data 清理。
---

# 数据与隐私

Markon 的阅读、渲染、搜索、Git 与审阅状态默认都在本机完成。AI Chat 是唯一会把工作区内容发给外部 Provider 的可选能力。

## 数据落点

| 数据 | 默认位置或行为 |
|---|---|
| 设置、salt、工作区列表、Provider 配置 | `~/.markon/settings.json` |
| 批注、章节进度标记、Chat threads/messages | `~/.markon/annotation.sqlite` |
| 运行中服务元数据与控制套接字位置 | `~/.markon/server.lock` |
| 服务日志 | `~/.markon/logs/markond.log`，2 MiB × 当前文件与 3 份备份 |
| 主题、面板位置、普通折叠、阅读位置记忆、diff 文件进度 | 当前浏览器存储 |

可用 `MARKON_SQLITE_PATH=/path/to/annotation.sqlite` 或桌面设置覆盖数据库路径。

## SQLite 是审阅状态的唯一权威

批注与正文章节进度标记不再写入浏览器 LocalStorage：

- 浏览器操作通过同源 document-state API 写入 SQLite；
- 通过工作区门禁的浏览器可读写当前作用域，不能越界访问其他浏览器的 Personal 记录；失败不会静默降级到本地副本；
- Share 关闭时，非管理员浏览器个人记录保存在同一 SQLite 的新增私有表；管理员既有记录保留原表；
- Share 开启时选择共同记录并广播，不自动发布或合并浏览器私有 Personal 数据；关闭后恢复 Personal，不搬移或删除记录。

批注按**文件绝对路径**关联，章节进度也以文件路径关联；浏览器私有记录额外使用私有浏览器身份作为隔离键；Chat 以稳定 workspace id 关联。因此移动文件会改变审阅数据的关联，而仅升级版本或重启服务不应改变它。Markdiff 的逐文件进度、普通折叠和阅读位置记忆是浏览器本地状态，不在 Share 同步的数据集中。

## AI Chat 会发送什么

只有同时满足以下条件才会产生 Provider 请求：

1. 在全局设置中配置 Anthropic 或 OpenAI-compatible Provider；
2. 为当前工作区开启 Chat；
3. 用户发送消息。

请求可能包含：

- 用户问题；
- 当前文档路径；
- 用户附加的文字选区；
- `@` 引用文件内容；
- AI 调用 `read_file`、`list_dir`、`glob`、`grep` 读取的结果；
- 当前 thread 的历史消息。

渲染、搜索、批注、Progress、Live 与 Git 不会因此上传。API key 以明文保存在 `settings.json`，应像其它开发凭据一样保护；不要把该文件提交到仓库或同步到公共位置。

开启 Edit 后，AI 还可以提出 `edit_file` 精确替换。提案先显示 old/new diff，必须由用户 Apply；应用前重新检查源文件漂移，应用后可尝试 Undo。该工具不能新建、移动、删除文件，也不能执行命令或访问网络。

## 浏览器权限

- 任何通过工作区门禁的浏览器都可个人批注、标记 Progress 与 Export Notes，不需要 Admin 或 Share。
- Share 开启后切换到同一共同审阅数据集；关闭后恢复 Personal，不自动发布或合并浏览器私有记录。
- Chat 与 Edit 也必须由工作区开关显式启用。
- 管理与结构性写操作仍要求管理员会话。

私有身份 Cookie（`markon_personal_review`）独立于管理员会话，有效期 365 天，使用 HttpOnly、SameSite=Lax，明确 HTTPS 时增加 Secure。清除站点数据或 Cookie 过期会失去本浏览器 Personal 数据的入口，但不会删除 SQLite 行；现阶段没有账户恢复或个人数据跨设备同步。备份 SQLite 保留记录，但不能替代私有身份 Cookie。

loopback 地址本身不授予管理员身份。详情见[访问与权限](/zh/features/access)。

## 备份

先关闭服务，再复制两个权威文件：

```bash
markon shutdown
mkdir -p ~/.markon/backup-manual
cp ~/.markon/settings.json ~/.markon/annotation.sqlite ~/.markon/backup-manual/
```

冷态备份能保证 settings、数据库与 workspace id salt 属于同一时点。恢复时也应先停服务。

卸载桌面应用或 `cargo uninstall` 不会自动删除 `~/.markon`。

## 清理已关闭工作区的数据

解除注册不会立刻删除审阅历史。先查看统计：

```bash
markon cleanup
```

命令会统计不属于当前注册工作区的：

- annotations 与涉及的文件数；
- Progress 文件状态；
- Chat threads 与 messages；
- 估算 payload 字节数。

清理涵盖原表与浏览器私有表 `personal_annotations`、`personal_viewed_state`。私有记录按文件绝对路径判断工作区归属，按包含浏览器主体的复合键删除，不误删其他主体。整库备份包含全部私有表与原表。

确认后才删除；自动化可用 `markon cleanup --yes`。对于单文件工作区，只有该固定文件被视为 active，父目录中的其它数据不会因目录边界而被错误保留。

::: warning
Cleanup 是不可逆的数据删除。先备份数据库，并确认需要保留的目录已重新注册为工作区。
:::

## 对公网暴露前

协作者访问码是应用层门禁，不提供链路加密。公网部署至少应：

- 在反向代理终止 TLS；
- 登记精确 `--public-base-url` 或 `--trusted-host`；
- 视场景增加网关层认证；
- 只为需要的工作区开启 Edit、Chat 与 Share；
- 保护 `settings.json` 与数据库文件权限。

配置示例见[反向代理](/zh/advanced/reverse-proxy)。
