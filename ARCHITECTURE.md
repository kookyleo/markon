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
| `server.lock` | 运行中 daemon 的端口 + 管理 token | — |

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
- **冷启动恢复**:CLI 与 GUI 都从 `settings.workspaces` 恢复**全部** workspace
  (CLI 的 `initial_workspaces`、`AppSettings::to_server_config`);`WorkspaceRegistry::add`
  对 `(salt, path)` 幂等(重复注册只更新 flags)。因此「无 FILE 冷启动」也能完整恢复所有
  workspace,且 id 不变。
- **降级 / 迁移 fallback**:旧 settings 已有 `workspaces` 但缺 `salt` 时退化为 `markon:{port}`
  并写回,以保持升级前 URL;根本没有 settings 文件的全新安装才生成随机 salt。

### 1.1 URL 路由契约

在不触碰 `workspace_id` 稳定性的前提下,Markon 的 URL 按下列层次划分:

- **用户文档空间**:`/{workspace_id}/` 与 `/{workspace_id}/{path}`。这是唯一直接映射到
  workspace 文件系统的公开、人类可读空间;目录展开状态使用 root 页 hash,如
  `/{workspace_id}/#docs/`。
- **Workspace 内部功能空间**:`/_/{workspace_id}/...`。所有不代表文件本身的工作区级页面 /
  数据 / 操作都放在这里,例如 `compare`, `git`, `files`, `settings`, `chat`, `search`。
  这样不会占用用户文件名空间,也能在视觉上明确区分“内容 URL”和“工具 URL”。
- **全局系统空间**:`/_/...`。静态资源、WebSocket、unlock、dev reload 等不属于某个文件路径的
  系统能力放在这里。
- **JSON / 管理 API**:`/api/...`。CLI/GUI 管理、保存、chat agent 等程序接口保持在 API
  命名空间内,并由各自 token / same-origin / loopback gate 控制。
- **废弃路径**:`/{workspace_id}/_/...` 与旧 `/search?ws=...` 不提供兼容;
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
- **按来源分权**(授权层):**本机(loopback)= 管理员**,免码放行全部能力(改功能开关 /
  别名、增删工作区、git commit/checkout、增删文件);**远程 = 协作者**,能力由该工作区的
  功能开关(feature flags)决定,不能做管理 / 结构性操作。
- **可选协作者访问码门禁**(认证层,见 `server.rs` 的 access gate / `access_scope_for`)——
  只拦**远程**访客(本机始终放行),两级就近覆盖(全局 + 按工作区);解决「知道 URL 就能进」,
  与 TLS(保密层)是**两件不同的事**。
- 一旦经任意 HTTPS 暴露,协作者访问码 cookie 应按 `X-Forwarded-Proto: https` 条件追加 `Secure`
  (**尚未实现**,留作正式上线 HTTPS 时的小跟进)。

**按访问方式的推荐**:`localhost` → 无需任何加密;内网 IP 自用 → Tailscale(或纯本地、
零依赖时用可选自签名);公网域名 → 反代 + Let's Encrypt。
