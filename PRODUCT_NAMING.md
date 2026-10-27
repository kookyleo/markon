# Markon 产品命名规范

本文统一产品能力的中文名、短英文名和术语边界，供界面、功能清单、文档与代码审查使用。已确定名称为「进度标记 / Progress」「共享批注与阅读进度 / Share」和「批注 / Annotate」；全部能力与分组按下表对齐。

## 命名规则

- 每项能力都具有中文名和短英文名；英文通常一至两个单词，优先沿用 Spotlight、Markdiff、Live 等已有称呼。
- 完整能力名用于总览和说明；工作区开关、标题按钮可使用对应短名，作用范围放在上下文或提示中。
- 能力、模式、状态与动作分开命名。能力仍为「进度标记 / Progress」；进度复选框用「已读 / Read」或「全部已读 / All Read」，动作提示用「标为已读 / Mark as read」与「标为未读 / Mark as unread」。
- 同一能力跨入口保持相同短英文，不根据它出现于 Features、设置、工具栏或文档而另起名称。
- 产品命名与基础／高级行为共同生效。既有配置字段、路由、数据库和内部标识维持兼容。

## 批注术语的层级与使用位置

| 层级 | 中文 | 英文 | 使用位置 |
|---|---|---|---|
| 总能力 | 批注 | Annotate | 产品目录、Features、功能分组和帮助入口 |
| 子能力 | 高亮 | Highlight | 用颜色标记选中文字 |
| 子能力 | 删除线 | Strike | 给选中文字添加删除线 |
| 子能力 | 文字批注 | Note；多条为 Notes | 附着在原文选区上的文字意见 |
| 技术模型 | 批注记录 | `Annotation` | 数据结构、API、代码和技术说明；可表示各类批注记录 |

高亮和删除线即使没有文字内容，也属于批注。文字批注是批注的一个子功能，Note 与 Annotation 不互作同义词。产品总能力统一写「批注 / Annotate」，不再以「批注与 Notes」「批注与高亮」或「Annotations & Notes」作为另一套能力名称。英文正文可以自然地用小写 annotations 描述批注，但不把 Annotation / Annotations 当作产品能力名。

例如，删除全部批注会涉及高亮、删除线和文字批注；「导出文字批注 / Export Notes」只导出含有文字的批注。批注导航覆盖所有类型，因此用 Navigate，不叫 Note Nav；Note Link 专指文字批注链接。单独的批注回复与讨论串仍是规划能力。

## Share 与 Shared 的使用规则

- 能力名和开关短名统一为「共享批注与阅读进度 / Share」。
- Shared 可表示「已共享」状态、共同审阅作用域，或在英文描述中充当形容词；不作为高级能力名。例如 shared tokens 表示共用的样式变量，与 Share 能力无关。
- Share 共享高亮、删除线、文字批注，以及正文 H2–H6 的章节进度标记。阅读位置记忆、普通折叠和 diff 的本地文件进度均不在其同步范围内。
- CLI 首选 `share`，旧参数 `shared` 作为别名保留；配置字段 `shared_annotation`、文档路径 `shared-annotations` 等技术标识继续保留。旧版界面文案可能显示 Shared，但规范名称为 Share。
- `--shared-annotation` 已不是当前 CLI 的启动参数；当前启用方式是 `markon set <ID|INDEX> share on`。更新旧示例，不把旧启动参数当作仍然兼容的命令。

## 产品分组

| 中文分组 | 短英文 |
|---|---|
| 工作区与查找 | Workspace |
| 阅读与呈现 | Reading |
| 批注与审阅 | Review |
| 源码编辑 | Edit |
| 工作区 AI | Workspace AI |
| 协作与演示 | Team |
| 导出与打印 | Output |
| 管理与偏好 | Settings |

## 基础能力与高级能力

产品分组说明用户在做什么；基础／高级划分说明是否需要工作区功能开关。两者是独立维度。基础能力随工作区提供，高级能力由管理员按工作区选择启用。

### 基础能力 / Essentials

| 能力领域 | 中文能力与短英文 | 提供原则 |
|---|---|---|
| 工作区与查找 | 工作区 Workspace、文件浏览 Files、统一查找 Spotlight、全文搜索 Search | 默认具备本地文件查找与搜索；全文结果需等待内容索引就绪 |
| 阅读与呈现 | 渲染 Markdown、图表 Diagrams、媒体 Media、查看器 Viewer、缩放 Zoom、目录 Outline、聚焦 Focus | 按当前文档内容提供 |
| 阅读整理 | 章节折叠 Fold、位置记忆 Resume、进度标记 Progress | 阅读和审阅的常规能力；不单设功能开关 |
| 批注 | 批注 Annotate，含 Highlight、Strike、Note、Navigate、Note Link、Undo / Redo | 任何通过工作区门禁的浏览器都可个人批注；Share 选择共同审阅数据 |
| 版本审阅 | Git 浏览 Git、差异审阅 Markdiff | 当前工作区有 Git 上下文时提供；提交和切分支继续要求管理权限 |
| 输出 | 导出文字批注 Export Notes、复制 Copy、下载 Download、打印 Print | 按内容、计数和数据访问权限决定可用状态 |
| 个性化与管理 | 主题 Theme、排版 Typography、快捷键 Shortcuts、操作 Actions、权限 Access、隐私 Privacy、备份 Backup、清理 Cleanup | 作为设置或管理操作提供；管理操作仍需权限与必要确认 |

Search 和 Progress 是基础能力，不在功能开关行提供。索引采用既有自动更新与资源限制；普通折叠和阅读位置记忆保持浏览器本地偏好。不因基础／高级划分新增尚未实现的索引控制或进度显示设置。

### 高级能力 / Advanced

| 中文名 | 短英文／开关名 | 选择开启的理由 | 关联子能力与条件 |
|---|---|---|---|
| 源码编辑 | Edit | 从阅读与审阅扩展到修改原文件 | Edit Here、Preview、Save Guard；协作者按授权编辑，结构操作还需管理员 |
| 工作区 AI | Chat | 需要配置模型服务，并由用户选择使用 AI | Workspace AI 下的 Mentions、Citations、File Tools、Suggestions、Approval、Threads；修改提案还需 Edit |
| 同步演示 | Live | 需要主动选择演示和跟随工作流 | Present、Follow；不自动开启 Share 或源码编辑 |
| 共享批注与阅读进度 | Share | 选择共同审阅数据与多人同步 | 高亮、删除线、文字批注与正文章节进度；不自动发布或合并浏览器私有数据 |

高级开关行仅包含四项，顺序固定：

```text
[ ] Edit  [ ] Chat  [ ] Live  [ ] Share
```

全新安装的四项高级能力默认关闭；新工作区继承用户已保存的全局默认值，需要时独立调整。产品名称「工作区 AI / Workspace AI」保留，开关使用短名 Chat。

### 能力、权限与上下文

- 任何通过工作区门禁的浏览器都可使用 Annotate、Progress 和 Export Notes，无需 Admin 或 Share。Share 关闭时使用 Personal；非管理员的个人批注与章节进度按浏览器身份隔离，持久化到同一 SQLite 的新增私有表，管理员既有数据保留原表。Share 开启时使用 Shared 共同数据；不自动发布或合并浏览器私有数据，关闭后恢复 Personal 数据。
- 页面按上下文提供入口。例如 Git 能力要求工作区有仓库上下文，视觉查看器要求有支持的媒体；Export Notes 按可访问的文字批注计数启用。
- 文件新增、删除、Git 提交、切换分支和数据清理等管理操作，继续受权限和各自条件约束。基础能力分类不放宽这些约束。
- 高级能力开启只开放其明确范围；Chat 不自动开启 Edit，Live 不自动开启 Share。
- 旧设置中的工作区字段 `enable_search` / `enable_viewed` 和全局默认字段 `default_search` / `default_viewed` 继续接受读取，但旧的 `false` 不再禁用基础能力；有效运行状态始终提供 Search 与 Progress。既有工作区标识、URL 和审阅数据不变。

### 审阅作用域 / Personal · Shared

- Personal：Share 关闭时的个人审阅。非管理员浏览器使用独立于 Admin 的私有身份 Cookie，个人批注与正文章节进度以浏览器身份和文件绝对路径共同隔离，数据保存在服务端 SQLite；管理员保留既有原表数据。
- Shared：Share 开启时的共同审阅。进入当前工作区的用户读写同一共同数据集，并实时同步。共同数据沿用原表；切换不会自动发布、合并、复制或删除浏览器私有 Personal 数据。
- API 作用域分为 `owner` / `personal` / `shared`，前两者界面都标为 Personal。管理员 Personal 使用既有 owner 原表，Share 开启会把这份旧数据集开放为共同审阅；浏览器私有 Personal 表不自动导入。
- 界面明确显示当前 Personal / Shared 作用域；选区工具条、Progress、Export Notes 始终处理当前作用域的数据。Admin 不再是启用基础批注的条件，仅控制管理操作。
- 私有身份不等同账号，也不是昵称或代表色。清除浏览器站点数据或私有身份 Cookie 过期会失去对应 Personal 数据的访问入口；现阶段不提供账户恢复或跨设备同步个人数据。Share 是团队共同数据能力，不能用来自动迁移个人数据。

## 完整能力与主要子功能

### 工作区与查找 / Workspace

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 工作区 | Workspace | 目录和单文件工作区 |
| 文件浏览 | Files | 文件／目录列表与浏览 |
| 文件导航与搜索 | Spotlight | 统一查找入口，包含文件导航和内容搜索 |
| 全文搜索 | Search | 在当前工作区内搜索内容；基础能力，无需单独开启 |
| 文件管理 | File Actions | 新建、删除等结构操作；需要对应权限 |

### 阅读与呈现 / Reading

| 中文名 | 短英文 | 范围 |
|---|---|---|
| Markdown 渲染 | Markdown | 渲染文档与扩展语法 |
| 图表呈现 | Diagrams | Markdown 中的图表 |
| 媒体查看 | Media | 图片、音频、视频等支持的媒体 |
| 视觉查看器 | Viewer | 图片、SVG 与图表的全屏查看 |
| 缩放 | Zoom | 查看器内缩放与框选缩放 |
| 目录导航 | Outline | 文档目录与标题跳转 |
| 章节聚焦 | Focus | 当前章节的定位与阅读焦点 |
| 章节折叠 | Fold | 独立于进度标记的折叠与展开 |
| 阅读位置记忆 | Resume | 返回上次阅读位置；保留设备本地范围 |

### 批注与审阅 / Review

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 批注 | Annotate | 高亮、删除线和文字批注的上位能力 |
| 高亮 | Highlight | 三色文字高亮 |
| 删除线 | Strike | 对选中文字添加删除线 |
| 文字批注 | Note | 锚定原文的文字意见；多条时用 Notes |
| 批注导航 | Navigate | 定位各类批注，包含没有文字 Note 的高亮和删除线 |
| 文字批注链接 | Note Link | 定位文字批注的链接 |
| 撤销与重做 | Undo / Redo | 当前批注操作的撤销与重做 |
| 进度标记 | Progress | 原 Viewed 能力；状态为已读 Read／未读 Unread，功能名保持 Progress |
| 章节进度 | Section Progress | 普通文档按 H2–H6 章节标记 |
| 文件进度 | File Progress | diff 中按变更文件标记，当前为浏览器本地状态 |
| Git 浏览 | Git | 分支、标签和提交历史 |
| Markdown 差异对比 | Markdiff | 渲染／源码视图中的 Markdown 变更审阅 |

### 源码编辑 / Edit

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 源码编辑 | Edit | Markdown 源码修改 |
| 选区定位源码 | Edit Here | 从渲染选区定位源码 |
| 实时预览 | Preview | 对照编辑结果 |
| 保存保护 | Save Guard | 未保存提醒及相关保护 |

### 工作区 AI / Workspace AI

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 工作区 AI | Workspace AI | 统一产品名 |
| AI 对话 | Chat | 打开对话的入口与短开关名 |
| 文件引用 | Mentions | 在输入中引用文件 |
| 出处引用 | Citations | 回答中的来源回链 |
| 文件调查 | File Tools | 读取、列目录、查找文件和检索内容 |
| 修改建议 | Suggestions | 等待用户决定的修改提案 |
| 修改审批 | Approval | Apply / Reject；修改需要 Edit |
| 多对话 | Threads | 同一工作区的多个对话 |

### 协作与演示 / Team

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 共享批注与阅读进度 | Share | 选择并同步同一份共同批注与章节进度；不影响 Personal 基础批注能力 |
| 协作者署名 | Identity | 昵称与代表色；属于轻量署名 |
| 同步演示 | Live | 只同步页面位置、章节焦点、选区等阅读上下文；正文章节进度由 Share 同步，不经 Live 转发 |
| 演示模式 | Present | Live 的主讲模式；内部协议名 `broadcast` 保持兼容 |
| 跟随模式 | Follow | Live 的跟随模式 |

「共享批注与阅读进度」中的阅读进度指当前可以共享的章节进度标记。阅读位置记忆仍保留在设备本地；diff 文件进度当前也不因此转为共享状态。

### 导出与打印 / Output

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 导出文字批注 | Export Notes | 有文字内容的 Notes，按正文顺序导出 Markdown |
| 复制 | Copy | 复制引用、批注、路径等当前对象 |
| 下载 | Download | 下载导出的 Markdown |
| 打印 | Print | 整页或章节打印，可使用浏览器另存 PDF |

### 管理与偏好 / Settings

| 中文名 | 短英文 | 范围 |
|---|---|---|
| 访问与权限 | Access | 管理员、协作者和能力边界 |
| 协作者访问码 | Access Code | 协作者门禁 |
| 数据与隐私 | Privacy | 数据位置与外发范围说明 |
| 备份与恢复 | Backup | 数据备份及恢复指引；不承诺独立一键工具 |
| 数据清理 | Cleanup | 既有数据清理功能 |
| 主题 | Theme | 系统、浅色与深色主题 |
| 字体与排版 | Typography | 字体、字号、布局等偏好 |
| 快捷键 | Shortcuts | 查看和自定义快捷键 |
| 操作与快捷键 | Actions | 当前上下文已接通的快捷操作面板 |

## 高级开关与兼容标识

| 中文名 | 短英文 | 兼容标识 | 当前划分 |
|---|---|---|---|
| 全文搜索 | Search | CLI：`search`；工作区字段：`enable_search`；全局默认字段：`default_search` | 基础能力，无开关 |
| 进度标记 | Progress | CLI：`viewed` / `progress`；工作区字段：`enable_viewed`；全局默认字段：`default_viewed` | 基础能力，无开关 |
| 源码编辑 | Edit | edit / enable_edit | 高级能力，保留开关 |
| AI 对话 | Chat | chat / enable_chat | 高级能力，保留开关 |
| 同步演示 | Live | live / enable_live | 高级能力，保留开关 |
| 共享批注与阅读进度 | Share | share；旧 shared / shared_annotation | 高级能力，保留开关 |

Progress 与 Share 的短英文分别强调进度能力和共享能力；完整中文或提示中解释其具体作用。CLI 使用 `edit`、`chat`、`live`、`share` 作为高级能力名；`shared`、`annotation`、`notes` 继续作为 Share 的兼容别名。旧 `search`、`viewed`、`progress` 的 `on` 命令接受并提示基础能力始终可用，`off` 明确拒绝；不再通过它们关闭基础能力。

## 标题操作的短英文

| 操作 | H1 整页 | H2–H6 当前章节 |
|---|---|---|
| 进度复选框 | 全部已读 / All Read | 已读 / Read |
| 未读时的操作提示 | 全部标为已读 / Mark all as read | 标为已读 / Mark as read |
| 已读时的操作提示 | 全部标为未读 / Mark all as unread | 标为未读 / Mark as unread |
| 打印 | 打印本页 / Print Page | 打印本节 / Print Section |
| 导出文字批注 | 导出本页文字批注 / Export Notes | 导出本节文字批注 / Export Notes |
| 折叠 | 全部折叠 / Fold All | 折叠 / Fold |
| 展开 | 全部展开 / Unfold All | 展开 / Unfold |

导出在两处沿用 Export Notes，提示说明本页／本节范围，计数仅包含文字批注。Progress 是功能组名，Read / All Read 是复选框标签；复选框勾选表示已读，未勾选表示未读，提示随当前状态提供 Mark as read / Mark as unread。标题旁不再使用 Mark、Marked、Mark All 或 Unmark 作为进度控件名称。

### Diff 文件进度的文案

- 功能名仍为「文件进度 / File Progress」，属于 Progress。
- 文件复选框统一显示「已读 / Read」；未勾选时为未读 Unread，操作提示为 Mark as read，勾选后提示为 Mark as unread。
- 计数采用 `n / total read`，例如 `2 / 5 read`；中文显示已读数量，而不是已标记数量。
- 过滤项统一为「隐藏已读文件 / Hide Read Files」。启用后隐藏已读文件，取消后仍能查看它们。
- 文件进度仍保存在当前浏览器；本次标签调整不把它改为 Shared 正文章节进度，也不改变既有存储字段、API 或 URL。

## Export Notes 的归属与显示条件

「导出文字批注 / Export Notes」归属「导出与打印 / Output」，读取批注数据。分组归属与入口的显示条件分别定义：

| 场景 | 出现条件 | 作用范围 |
|---|---|---|
| 普通文档 H1 | 存在主标题时挂载整页工具栏；常驻显示 | 当前文件全部文字批注 |
| 普通文档 H2–H6 | 存在该章节标题并聚焦时显示章节操作 | 当前章节及其子章节 |
| 没有 H1 的文档 | 当前不挂载 H1 工具栏；章节入口按实际标题提供 | 不伪造主标题 |

标签为 `Export Notes (n)`。`n` 是当前范围内含有非空文字内容的 Note 数量，不计纯高亮或纯删除线。计数为 `0` 时入口仍显示并禁用，不打开空导出编辑器。

任何通过工作区门禁的浏览器都可导出当前 Personal 或 Shared 范围内的文字批注。计数只统计当前作用域，零计数禁用；不得读取其他浏览器的 Personal 数据。入口显示不依赖 Edit、Chat 或 Live；导出使用临时编辑缓冲区，不会因此要求源码编辑权限，也不会保存覆盖原文件。

以上表格描述普通文档标题操作。Markdiff 可复用 Export Notes 导出当前 diff 的文字批注，具体 diff 控件与普通文档标题各自按页面上下文展示。

## 尚未具备的讨论能力

| 中文名 | 短英文 | 状态 |
|---|---|---|
| 批注回复 | Replies | #135 规划，当前不计入现有能力清单 |
| 批注讨论串 | Discussion | #135 规划，当前不计入现有能力清单 |

本文记录产品命名与行为约定。既有数据库、配置字段与 URL 保持兼容；基础能力不再允许关闭，高级能力仍按工作区单独启用。配图更新清单见 [PRODUCT_VISUAL_TODO.md](PRODUCT_VISUAL_TODO.md)。
