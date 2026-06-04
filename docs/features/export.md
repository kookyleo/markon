# 批注导出

<div class="feature-illustration">
  <img src="/illustrations/05-annotate.svg" alt="批注导出" />
</div>

读完一篇文档，标注和便条往往就是你思考的精华。**批注导出**让你把整页标注挑一挑、整理成 Markdown —— 贴给 AI 当上下文，或存档备查。

## 快速使用

在 `H1` 标题工具栏点击 **导出批注**（在「打印」旁边），进入一个全屏的两步向导：

<!-- TODO: screenshot: 导出入口 (/screenshots/export-entry.png) -->

1. **选择** —— 勾选要导出哪些标注
2. **整理** —— 生成 Markdown，复制或下载

## 第一步：选择内容

弹出的全屏列表按**所在标题分组**，列出本页每一条标注。默认全部勾选，你可以：

| 操作 | 效果 |
|------|------|
| 逐条勾选 | 精确控制单条的去留 |
| 分组勾选 | 整节一键全选/取消 |
| 全选 / 全不选 | 顶部按钮，一步到位 |
| 类型筛选 | 点击 🟠 / 🟢 / 🟡 / <s>删除线</s> / 📝 标签，切换该类型全部标注的勾选 |

<!-- TODO: screenshot: 选择列表 (/screenshots/export-select.png) -->

列表上下两端都有 **取消** / **下一步** 操作栏，长列表也无需来回滚动。底部实时显示「已选 N 项」。

## 第二步：整理为 Markdown

点击 **下一步**，选中的标注会按文档顺序、按标题分组渲染成 Markdown，并载入编辑器（复用[快捷编辑](/features/edit)的同款界面，支持编辑与实时预览）：

| 操作 | 效果 |
|------|------|
| **复制** | 把当前内容复制到剪贴板 |
| **下载 .md** | 保存为本地 Markdown 文件（文件名取自文档标题） |
| **← 返回** | 回到第一步重新挑选，已勾选状态保留 |

导出的 Markdown 形如：

```markdown
# Annotations — 我的文档

*3 annotations*

---

## Section A

1. **Yellow highlight** — "quick"
2. **Note** — "brown fox"
   > animal subject

## Section B

3. **Strikethrough** — "Lorem"
```

> 只导出你的高亮与便条，不携带文档其余正文 —— 适合直接贴进外部 AI 工具，而不暴露全文。

## 单条快速复制

不想走整个向导？每条标注都能单独复制：

- **便条卡片 / 弹窗** —— 点击卡片上的 **⧉** 复制按钮
- **高亮浮窗** —— 选中或点击已高亮的文本，工具栏中点 **复制**

复制出的是以这一条为主体的「引用 + 便条」Markdown：

```markdown
> brown fox

animal subject
```

纯高亮（无便条）则只复制引用本身。

---

→ 标注本身的用法详见 [注解与笔记](/features/annotations)
