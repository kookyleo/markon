# 与文档对话

<div class="feature-illustration">
  <img src="/illustrations/12-chat.svg" alt="与文档对话" />
</div>

> 需要启用：桌面版在工作区设置中勾选"AI 对话"；CLI 用 `--enable-chat`。还需在全局设置中填入 OpenAI 或 Anthropic 的 API Key。

把整个工作区当作一份可对话的资料库，AI 直接读取你目录里的 Markdown 与代码，并在回答中标出引用位置。"只读版 Claude Code"是它最直观的类比 —— 提供 `read_file` / `list_dir` / `glob` / `grep` 四个工具，但**没有任何写入或执行能力**。

## 适合的场景

- **快速理解陌生代码 / 长文档**：直接问"这个项目主入口在哪、调用链是怎样的"。
- **跨文件的事实核对**：让 AI 跑 grep 验证你记得的某个 API 用法是否还成立。
- **写作时的上下文助手**：选中一段已有内容，问 AI "这段和我刚写的是不是有冲突"。
- **新人 onboarding**：把仓库交给同事，他可以把"这个常量是哪里定义的"这种问题直接抛给 AI。

不适合让它做的事：写代码、运行命令、访问外网。所有这些都被工具层物理屏蔽。

## 启用与配置

### 1. 选择 Provider 并填 Key

打开桌面版 → **设置 → AI 对话**：

- **Provider**：`Anthropic`（推荐，含 prompt cache）或 `OpenAI`。
- **API Key**：粘贴对应平台的 key。Key 仅保存在本机的 `~/.markon/settings.json`，不会上传到任何 Markon 服务。
- **模型**（可选）：留空使用默认。Anthropic 默认 `claude-sonnet-4-6`，OpenAI 默认 `gpt-4o`。

CLI 用户：直接编辑 `~/.markon/settings.json`：

```json
{
  "chat": {
    "provider": "anthropic",
    "anthropic_api_key": "sk-ant-...",
    "model": ""
  }
}
```

### 2. 在工作区中开启

```bash
markon docs/ --enable-chat
```

或在桌面版的工作区列表里勾选 **AI 对话** 开关。

启用后，浏览器页面右下角会出现一个紫色小球。

## 三种打开方式

### 点小球展开聊天面板

最常规的入口。面板从右侧滑出，宽度可调，再点一次小球收回。

### `@` 引用工作区文件

在输入框打 `@`，弹出文件搜索 —— 工作区内**所有可读的文本文件**都可以引用，不限于 Markdown。选中后变成一个 pill，发送时会把该文件原文一并塞进 AI 的 context。

```
读一下 @src/main.rs，告诉我端口号是从哪里取的
```

### 选中文字 → 问 AI

选中正文中任意一段文字，弹出的菜单里会出现 **问 AI** 选项。点击后聊天面板自动打开，被选中的内容已作为 quote pill 填入输入框。适合"这一段写得对吗"、"这个术语在别处还有没有用过"这种针对性提问。

## 引用与回链

回答中所有的引用都遵循固定格式：

- `path/to/file.md:42` —— 单行
- `path/to/file.md:42-58` —— 行区间
- `path/to/file.md#heading-id` —— 标题锚点

它们在前端会渲染成可点击的 pill，点击直接跳转到阅读视图的对应位置。让 AI 给出的每个论断都"一键追源"，是这个功能区别于通用聊天工具的关键。

## AI 能调用的工具

四个，全部只读：

| 工具 | 作用 |
|------|------|
| `read_file(path, offset?, limit?)` | 读单个文本文件，支持分页 |
| `list_dir(path?)` | 列目录（一层），尊重 `.gitignore` |
| `glob(pattern, limit?)` | 路径模式匹配，如 `**/*.md` |
| `grep(pattern, path?, glob?, ...)` | 内容搜索，正则，可加路径/扩展名筛选 |

工具受以下约束保护：

- 所有路径必须落在工作区根目录内，越界自动拒绝。
- 二进制文件、≥ 1 MiB 的文件不会被读取。
- 工具单次输出上限 64 KiB，超出截断。
- 工具调用次数有上限，避免模型陷入循环检索。

## 多会话

每个工作区的对话独立保存，存在 `~/.markon/annotation.sqlite`（与共享标注共用一个 SQLite 数据库）。面板顶部的下拉框可以切换会话或新建。

切换工作区时不会丢历史 —— 下次打开同一个目录，所有对话仍在。

## 隐私与成本

- **API 调用**：工作区内被引用的文件、被选中的文字、AI 工具读取的内容，都会作为 prompt 发到 Provider。请只对你愿意上传的目录开启 chat。
- **Key 存储**：明文存在 `~/.markon/settings.json`，与你的其它本地配置同等敏感度。
- **prompt cache**（仅 Anthropic）：系统提示词与工作区结构会进入 5 分钟 TTL 缓存，**实际计费量在第二轮起会显著下降**。

## 自定义 Persona

如果默认提示词不满足你的需求（例如希望 AI 用更正式的语气、按特定模板回答），可以在 `settings.json` 的 `chat.system_prompt` 字段填入自定义文本。该字段会替换内置 persona 的整段，但工作区上下文与每轮的"当前文档/选区"块依然由 Markon 自动拼接。

```json
{
  "chat": {
    "system_prompt": "你是一位严谨的代码审查者，回答用..."
  }
}
```

## 相关命令行参数

```bash
markon docs/ --enable-chat                 # 仅启用本工作区
markon docs/ --enable-chat --enable-search # chat + 全文索引同时启用
```

→ 完整选项见 [命令行选项](/guide/cli)
