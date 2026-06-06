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
     (`crates/core/src/settings.rs`)**仅在 salt 为空时生成**,非空则原样沿用。
  2. **路径规范化**:`expand_and_canonicalize`(`workspace.rs`)幂等——对一个已规范的
     绝对路径再次规范,仍得其自身。
  3. **算法固定**:sha256 + 取前 4 字节,不得更换。
- **红线**:不得更改 hash 算法、其输入构成、salt 的来源 / 生成时机、路径规范化方式。
  任一变动都会使**全部既有 URL 失效**。
- **冷启动恢复**:CLI 与 GUI 都从 `settings.workspaces` 恢复**全部** workspace
  (CLI 的 `initial_workspaces`、`AppSettings::to_server_config`);`WorkspaceRegistry::add`
  对 `(salt, path)` 幂等(重复注册只更新 flags)。因此「无 FILE 冷启动」也能完整恢复所有
  workspace,且 id 不变。
- **降级 fallback**:salt 缺失时退化为 `markon:{port}`——仅当根本没有 settings 文件时触发;
  正常安装绝不应走到这里。

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
- 反序列化容错:读取失败回退默认(`load_at` 的 `unwrap_or_default`),但 `normalize()`
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
