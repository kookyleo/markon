# Markon 架构与设计原则

> 本文件记录 Markon 跨版本、跨进程都必须维持的**持久化状态与向后兼容不变量**。
> 它是工程红线:任何改动若触及下列任一条目,即属**破坏性变更**,必须提供迁移路径,
> 并在发布说明里显式标注。维护者与 AI agent 在改动「workspace 标识 / 数据库 schema /
> settings 结构」前**必读本文件**(参见 [AGENTS.md](AGENTS.md))。

## 0. 持久化状态总览

Markon 的用户数据**独立于进程**,持久在 `~/.markon/`:

| 文件 | 内容 | 关联键 |
|---|---|---|
| `settings.json` | 配置、workspace 列表、**salt** | — |
| `annotation.sqlite` | 批注、已读状态、chat 线程 | 见 §2 / §4 |
| `server.lock` | 运行中服务的 Web 端口 + 控制套接字路径 + 绑定 host | — |

进程(CLI / GUI / daemon)重启、版本升级,都**不得**使既有 workspace URL 失效,
也**不得**丢失上述数据。下面四条是保证这一点的不变量。

## 1. Workspace 标识与 URL 稳定性(最高优先级)

- **定义**:`workspace_id = sha256(salt ‖ 0x00 ‖ canonical_path)` 取前 4 字节十六进制
  (`workspace::hash_id`,`crates/core/src/workspace.rs`)。对外 URL 即 `/{workspace_id}/`。
- **稳定的三要素**,缺一不可:
  1. **salt**:每装机随机一次,持久在 `settings.json`;`AppSettings::load_at`
     (`crates/core/src/settings.rs`)非空则原样沿用。旧 settings 若已有 `workspaces` 但没有
     `salt`,必须迁移为旧算法使用的 `markon:{port}`,不得随机生成。
  2. **路径规范化**:`expand_and_canonicalize`(`workspace.rs`)幂等——对一个已规范的
     绝对路径再次规范,仍得其自身。
  3. **算法固定**:sha256 + 取前 4 字节,不得更换。
- **红线**:不得更改 hash 算法、其输入构成、salt 的来源 / 生成时机、路径规范化方式。
  任一变动都会使**全部既有 URL 失效**。
- **冷启动恢复**:CLI 与 GUI 都从 `settings.workspaces` 恢复 workspace
  (CLI 的 `initial_workspaces`、`AppSettings::to_server_config`);`WorkspaceRegistry::add`
  对 `(salt, identity path)` 幂等(重复注册只更新 flags)。目录 workspace 必须完整恢复且 id 不变。
  单文件临时 workspace 以父目录 + `single_file` 持久化,仍使用完整文件路径作为 identity;启动时仅当
  `auto_remove_single_file_workspaces` 为 true(默认值)才在恢复前清理,关闭该设置则必须按原范围恢复。
- **降级 / 迁移 fallback**:旧 settings 已有 `workspaces` 但缺 `salt` 时退化为 `markon:{port}`
  并写回,以保持升级前 URL;根本没有 settings 文件的全新安装才生成随机 salt。

### 1.1 URL 路由契约

在不触碰 `workspace_id` 稳定性的前提下,Markon 的 URL 按下列层次划分:

- **用户文档空间**:`/{workspace_id}/` 与 `/{workspace_id}/{path}`。这是唯一直接映射到
  workspace 文件系统的公开、人类可读空间;目录展开状态使用 root 页 hash,如
  `/{workspace_id}/#docs/`。
  单文件工作区也是这个空间的一种受限形态:服务根是打开文件的父目录,但可访问集合只包含
  该 md 文件本身以及它明确引用、且规范化后仍在该父目录内的本地资源;未引用的兄弟文件必须
  继续返回 404。
- **Workspace 内部功能空间**:`/_/{workspace_id}/...`。所有不代表文件本身的工作区级页面 /
  数据 / 操作都放在这里,例如 `compare`, `git`, `files`, `settings`, `chat`, `search`。
  批注 / Live 协作 WebSocket 也只能使用 `/_/{workspace_id}/ws`,使访问码门禁和资源能力在
  HTTP upgrade 前就能绑定到明确 workspace。
  这样不会占用用户文件名空间,也能在视觉上明确区分“内容 URL”和“工具 URL”。
- **全局系统空间**:`/_/...`。静态资源、unlock、dev reload 等不属于某个文件路径的系统能力
  放在这里。`/_/ws/{workspace_id}` 仅保留为工作区配置变更通知通道,不是协作数据通道。
- **JSON / 数据 API**:`/api/...`。保存、chat agent、preview 等**面向浏览器**的程序接口保持在
  API 命名空间内,并由各自 capability token / admin session / same-origin gate 控制。
  **workspace 管理操作(增删改 workspace、改别名、设访问码、shutdown)已整体移出 TCP**,改走
  本地控制套接字(见 [D-2](#d-2-管理面移出-tcp走本地控制套接字2026-07)),TCP 上不再暴露任何管理端点。
- **废弃路径**:`/{workspace_id}/_/...` 与旧 `/search?ws=...` 不提供兼容;
  旧协作通道 `/_/ws` 同样不提供兼容;
  这类路径要么按用户文件路径处理,要么返回 404。新链接必须使用 `/_/{workspace_id}/...`。

实现约束:后端新增 URL 必须优先通过 `server.rs` 中的 route helper 生成;前端新增 URL 必须优先
通过 `crates/core/assets/js/core/routes.ts` 生成,避免在组件里散落手写字符串。

## 2. 批注与已读数据

- **表结构**(`crates/core/src/server.rs`,均以 `CREATE TABLE IF NOT EXISTS` 建立):
  - `annotations(id TEXT PRIMARY KEY, file_path TEXT, data TEXT)`
  - `viewed_state(file_path TEXT PRIMARY KEY, state TEXT, updated_at)`
- **关联键是文件的绝对路径 `file_path`,不是 `workspace_id`**。⇒ 批注 / 已读的存活只取决于
  **文件路径是否不变**,与版本号、与 URL 是否变化**都无关**。
- **库位置**:默认 `~/.markon/annotation.sqlite`,可由 `MARKON_SQLITE_PATH` 环境变量或
  settings 的 `db_path` 覆盖(`server.rs`)。
- **批注内容兼容**:`annotations.data` 是完整 Annotation JSON。锚点新增能力只能以可选字段扩展;
  当前 `anchor.version = 2` 追加有序 `fragments`,同时保留原 `position / exact / prefix /
  suffix` 平面锚点。读取端必须继续接受没有 `version / fragments` 的历史批注,不得要求数据库迁移。
- **建表用 `IF NOT EXISTS`**,升级不重建、不清空。
- **红线**:不得更改 `file_path` 的语义 / 规范化方式;不得 DROP 或重命名既有列;不得变更
  默认库路径。schema 演进**只能**加表,或加 nullable / 带默认值的新列。

## 3. `settings.json` 结构演进

- **新增字段必须带 `#[serde(default = "...")]`**(示例:`web_editor_theme` 默认 `"follow"`),
  以保证旧文件反序列化不失败、且不丢未知字段。
- 反序列化容错:`load_at` 遇到 schema mismatch / 损坏 / 不可读 settings 时,必须优先恢复或稳定
  推导 `salt` / `workspaces`,不得静默生成随机新 salt 后覆盖旧文件;`normalize()`
  **只规整新字段**(如把未知 `web_editor_theme` 收敛为 `follow`),**绝不重置 `salt` 或
  `workspaces`**。
- **不得**对 `AppSettings` 启用 `deny_unknown_fields`——保留「旧版本读新文件时忽略未知字段」
  的降级兼容。

## 4. chat 数据(次要)

- `chat_threads` / `chat_messages` 按 `workspace_id` 关联(`crates/core/src/chat/storage.rs`)。
  因此 §1 的 URL 稳定性**同时**保护了 chat 历史:只要 workspace_id 不变,chat 线程就不丢关联。

## 升级 / 发布纪律

- 触及 §1–§3 任一 = 破坏性变更:必须写迁移代码,并在 RELEASE 说明里显式标注。
- **升级前冷态备份**:停服后复制 `~/.markon/{settings.json, annotation.sqlite}`
  (实践:存到 `~/.markon/backup-pre-<version>/`)。
- **升级后验证清单**:
  1. `markon ls` 列出的每个 workspace id 与升级前**逐一一致**(URL 未变);
  2. 任一 workspace 的批注 / 已读在页面上仍可见(数据未丢);
  3. `settings.json` 的 `salt` 与升级前相同。

## 设计决策

### D-1. 不内建 TLS / 安全通道,委托外层(2026-06)

**决策:markon 自身只服务明文 HTTP(`axum::serve`),不内建 TLS,也不内建证书 / CA 管理。**
传输加密交给前置层终止:面向公网用**反向代理**(Caddy / nginx + Let's Encrypt,见
`REVERSE_PROXY.zh.md`);面向 IP / 内网 / 远程自用用**网络层**(Tailscale / WireGuard)。

**理由(性价比评估的结论)**:
- TLS 的真实成本不在代码(axum + rustls 仅数十行),而在**证书与信任**。
- 公网 CA(Let's Encrypt 等)**不为 IP / 内网地址签发**,且需域名 + challenge + 续期 ——
  内建 ACME 复杂,且对最常见的「按 IP 访问」根本走不通。
- 唯一能便宜内建的是**自签名**,但只给「加密不认证」(浏览器警告 / 需每设备装根证书),
  挡不住主动 MITM,且会让 markon 退化成 mini-CA,与「保持简单」相悖。
- 反代(真证书、零警告)与 Tailscale(真证书 + 天然设备级准入 + 全程加密、零 app 改动)
  在各自层面都做得更干净。**关注点分离:通道在 markon 之下,app 保持纯 HTTP。**

**正交的应用层控制(markon 确实提供)**:
- **显式 capability 分权**(授权层):浏览器默认是 Viewer / Collaborator;只有持有短期、
  `HttpOnly` Admin session 的页面才能改功能开关 / 别名、执行 git commit/checkout、增删文件。
  TCP peer 即使是 loopback 也不会自动成为管理员。原生 CLI / GUI 的管理员身份不再依赖任何 token,
  而是由「连到本地控制套接字」这一事实本身赋予(套接字的文件权限 / ACL 即认证,见 [D-2](#d-2-管理面移出-tcp走本地控制套接字2026-07))。
- **管理员 bootstrap**:`markon admin open` 通过 URL fragment 传递 256-bit、60 秒、一次性 nonce;
  `markon admin code` 提供 5 分钟、最多 5 次尝试的手动配对码。两者只兑换同一种 12 小时
  Admin session,服务重启即失效。fragment 在发起兑换前从地址栏 / 历史中清除。
- **可选协作者访问码门禁**(认证层,见 `server.rs` 的 access gate / `access_scope_for`)——
  对所有非 Admin 浏览器一致生效,不因 loopback 绕过;两级就近覆盖(全局 + 按工作区)。
- **Host / Origin 边界**:每个请求的 Host 必须属于 localhost、实际绑定 / advertised 地址、
  `--entry` 或显式 `trusted_hosts`。`Origin == Host` 只负责同源,不能替代 Host allowlist;
  这两层共同阻断 DNS rebinding。反向代理头不参与身份授权。
- **Cookie**:协作者与 Admin cookie 均使用 HMAC-SHA256;显式 HTTPS origin 下追加 `Secure`。
  Cookie 算法升级会让旧 cookie 一次性失效,不影响任何持久化数据。

**按访问方式的推荐**:`localhost` → 无需任何加密;内网 IP 自用 → Tailscale(或纯本地、
零依赖时用可选自签名);公网域名 → 反代 + Let's Encrypt。

### D-2. 管理面移出 TCP,走本地控制套接字(2026-07)

**决策:把 core 拆成一个独立的服务进程 `markond`,`markon`(CLI)与 `markon-gui` 都退化为
「运行于本机的特权客户端」;两者不再内嵌 core,只通过一条本地控制套接字驱动服务。管理 /
管理员操作整体离开 TCP。**

**进程与两个平面**:
- **`markond`** = 唯一持有 core 的服务进程(`crates/markond`)。它同时监听两个 listener:
  - **控制面(control plane)**:一条本地套接字 —— unix 上是 `~/.markon/control.sock`(0600),
    Windows 上是命名管道(named pipe),由 `interprocess` crate 统一抽象。协议是**长度前缀分帧的
    JSON**(`tokio_util::codec::LengthDelimitedCodec` + serde_json),**不是 HTTP**。
  - **数据面(data plane)**:TCP + HTTP/axum,照旧服务浏览器 / 局域网(§1.1 的 URL 契约、
    访问码门禁、Host/Origin 边界都在这一面)。
- **`markon` / `markon-gui`** = 平级的特权本地壳子。二者都能在没有服务时**拉起** `markond`,
  也能**挂接**到已在运行的实例;服务是**独立生命周期**的,壳子退出不会停掉它。

**权限 = 你从哪个 listener 进来**。连到控制套接字 ⇒ 特权管理员客户端,**无需任何 token**——
套接字的文件权限(unix 0600 / Windows 命名管道 ACL)本身就是认证。从 TCP 进来 ⇒ 公开浏览器,
继续受访问码 / same-origin / Host allowlist 约束。原先那套 `X-Markon-Token` + `require_local_and_token`
的 loopback 管理端点因此**整体删除**。

**理由**:
- 管理面一旦离开 TCP,DNS rebinding / loopback+token 泄露 / 原生管理 API 暴露面这一整类攻击面
  对控制面**直接消失**——它根本不在网络上。数据面只保留浏览器本就需要的那些端点。
- 「壳子 / 服务」分离让 CLI 与 GUI 共享同一个后台服务与同一份 workspace 注册表:一处打开、
  两处可见,不再各起一个 server 抢机器锁。
- 权限绑定在「通信通道」而非「请求内容」上,判定简单且不可伪造:没有本机套接字访问权,就拿不到
  管理员身份。

**机密传递**:壳子拉起 `markond` 时,把含 salt / 协作者访问码 hash 的 `DaemonConfig` 写进一个
**0600 临时文件**(Windows 靠 per-user `%TEMP%` 的 ACL),以 `markond --config <path>` 传入;
机密**绝不进 argv / 环境变量**。`markond` 读取后即删除该文件,壳子在就绪握手结束后再兜底删一次。

**打包**:GUI 通过 Tauri 的 `externalBin`(sidecar)把 `markond` 与自身打进同一个 app bundle,
放在主程序旁边;`daemon::locate_markond` 以「与当前可执行文件同目录」为首选查找位置,因此 CLI 与
GUI 都能就近找到并拉起服务。

**跨平台边界**:控制套接字与拉起逻辑(`daemon::spawn_and_connect`)都已跨平台;Windows 的命名管道
路径与拉起行为需在真实 Windows 上跑 `scripts/win-test/full-smoke.ps1` 验证(该脚本通过 `markon`
的 `ls` / `set` / `shutdown` 子命令间接压测命名管道)。
