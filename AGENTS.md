# AGENTS.md

面向在本仓库工作的 AI agent(及人类维护者)的项目级约定。

## 改动前必读:持久化兼容不变量

修改以下任一区域前,**必须**先读 [ARCHITECTURE.md](ARCHITECTURE.md) 的「持久化状态与向后
兼容」,并遵守其红线:

- **Workspace 标识 / URL**:`workspace::hash_id`、salt 的生成与读取、`expand_and_canonicalize`。
  改算法 / 输入 / salt 来源 = 全部既有 URL 失效。
- **数据库 schema**:`annotations` / `viewed_state` / chat 表。批注按**文件绝对路径**存,不按
  workspace_id;只能加表 / 加列(nullable 或带默认),不得改列、DROP 或改默认库路径。
- **`settings.json` 字段**:新字段一律 `#[serde(default = "...")]`;`normalize()` 不得重置
  `salt` 或 `workspaces`;不得启用 `deny_unknown_fields`。

**判据**:版本升级与进程重启后,`markon ls` 的 workspace id 必须**逐一不变**,批注 / 已读数据
必须**不丢**。涉及上述变更时,先冷态备份 `~/.markon/{settings.json, annotation.sqlite}`。

## 通用约定

- License:Apache-2.0。
- 提交信息用英文,简短准确,不出现 AI / Claude 等字样。
- 改动代码后及时编译 / 测试 / lint:`cargo build` `cargo test` `cargo clippy`,以及
  `npm test`(`crates/core/assets`、`crates/gui`);非明确要求不 `git push`。
- 设计颜色统一走 `crates/core/assets/css/tokens.css` 的 `--markon-*` / `--mk-editor-*`
  token,不在组件里硬编码色值。
