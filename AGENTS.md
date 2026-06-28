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

## 前端 / TypeScript 约定

**所有浏览器端逻辑一律 TypeScript,源码放 `crates/core/assets/js/`。** 不写手写 `.js` 源文件,
不在模板里写业务/交互逻辑的内联 `<script>`。

- **构建**:`scripts/build.mjs`(esbuild)按入口打包到 `crates/core/assets/dist/`。新增一个浏览器
  脚本 = 加一个 `*.ts` 入口 + 在 `build.mjs` 注册一个 bundle + 在模板里加 `<script>` 标签;**绝不**
  把逻辑写回模板内联。
- **类型 / 测试**:`npm run typecheck`(`tsc --noEmit`)是真正的把关(eslint 未配 TS,对 `.ts` 一律
  "ignored",不用纠结);单测用 vitest,**与源码同目录** `*.test.ts`(`npm test`)。
- **两种打包形态**:
  - **ESM 模块**(`format:'esm'`,`<script type="module">`):主文档 app(`main.ts`)、各 diff 视图
    渲染器(`markdown-diff` / `workspace-diff`)、`diff-annotations`、`diff-shortcuts` 等。模块是
    **defer** 的,解析完才执行。
  - **经典 IIFE bundle**(`format:'iife'`,`<script src>` 不带 `type=module`):**页面控制器**——需要
    在解析期、早于 defer 模块运行的逻辑。现有:`diff-controls`(diff 页过滤 + Raw/Rendered 切换)、
    `directory`、`layout-page`(文档页 TOC 跟踪 + i18n)、`access-gate`、`git-refs`。放在模板里它们原来
    内联的同一位置,保持「解析期执行、早于模块」的时序。每个经典入口文件结尾加 `export {};` 使其成为
    模块,避免顶层声明落到全局脚本作用域而相互冲突。
- **允许保留在模板内联的,仅两类**(其余一律抽成 TS):
  1. **theme-boot**:`theme-boot.html` 及各页 `applyStylesheetMedia()` 一行——必须在首屏绘制**前同步**
     执行以防 FOUC(主题闪烁),外链脚本的网络往返会破坏这一点。
  2. **Tera 数据注入**:`{{ i18n_json }}` / `{{ shortcuts_json }}` / `{{ markdown_content_json }}`、
     以及 `i18n-boot.html` 注入 `window.__MARKON_I18N__` 的引导——这些把服务端数据插进页面,天然必须内联。
- **i18n**:文案在 `crates/core/i18n/{en,ja,zh_CN}.json5`,由 `build.rs` 在**编译期**生成
  `langs_generated.rs`。新增 key 需要 `cargo build` 才生效(仅重启进程不够);三语必须 **key 对齐**。
- **Tauri 设置界面**(`crates/gui/ui/`)是独立于 core 的另一套手写 JS,暂不纳入本 TS 流水线;若要 TS 化
  单独立项。
