# Markon 功能测试

这是一个测试文档，用于验证 markon 的所有功能。

## 基础 Markdown 功能

### 文本格式

这是**粗体**文本，这是*斜体*文本，这是~~删除线~~文本。

### 列表

#### 无序列表
- 项目 1
- 项目 2
  - 子项目 2.1
  - 子项目 2.2
- 项目 3

#### 有序列表
1. 第一步
2. 第二步
3. 第三步

### 任务列表

- [x] 已完成的任务
- [ ] 未完成的任务
- [x] 另一个已完成的任务

### 表格

| 功能 | 状态 | 说明 |
|------|------|------|
| Markdown 渲染 | ✅ | 基础功能 |
| 代码高亮 | ✅ | Syntect |
| Emoji | ✅ | Unicode emoji |
| Mermaid | ✅ | 图表支持 |
| 主题切换 | ✅ | light/dark/auto |

## 代码高亮测试

### Rust 代码

\`\`\`rust
fn main() {
    println!("Hello, world!");

    let numbers = vec![1, 2, 3, 4, 5];
    let sum: i32 = numbers.iter().sum();

    println!("Sum: {}", sum);
}
\`\`\`

### Python 代码

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

# 测试
for i in range(10):
    print(f"fibonacci({i}) = {fibonacci(i)}")
\`\`\`

### JavaScript 代码

\`\`\`javascript
const greet = (name) => {
    return \`Hello, \${name}!\`;
};

console.log(greet("World"));
\`\`\`

## GitHub Alerts 测试

### NOTE - 提示信息

> [!NOTE]
> 这是一条提示信息。GitHub Alerts 支持在 Markdown 中创建醒目的提示框。

### TIP - 技巧提示

> [!TIP]
> 使用 `cargo build --release` 可以构建优化版本的程序，性能更好！

### IMPORTANT - 重要信息

> [!IMPORTANT]
> 请确保在生产环境中使用 release 模式构建，debug 模式性能较差。

### WARNING - 警告信息

> [!WARNING]
> 修改配置文件前请先备份，错误的配置可能导致程序无法启动。

### CAUTION - 严重警告

> [!CAUTION]
> 不要在生产环境中暴露调试端口，这可能导致严重的安全问题！

## Emoji 测试

支持 emoji shortcodes：

- :smile: 笑脸
- :heart: 爱心
- :rocket: 火箭
- :tada: 庆祝
- :sparkles: 闪光
- :hammer: 锤子
- :bug: Bug
- :fire: 火焰
- :white_check_mark: 完成
- :x: 错误

## Mermaid 图表测试

### 流程图

\`\`\`mermaid
graph TD
    A[开始] --> B{是否登录?}
    B -->|是| C[显示主页]
    B -->|否| D[显示登录页]
    C --> E[结束]
    D --> E
\`\`\`

### 时序图

\`\`\`mermaid
sequenceDiagram
    participant 用户
    participant 浏览器
    participant 服务器

    用户->>浏览器: 打开页面
    浏览器->>服务器: HTTP 请求
    服务器-->>浏览器: 返回 HTML
    浏览器-->>用户: 渲染页面
\`\`\`

### 饼图

\`\`\`mermaid
pie title 编程语言使用占比
    "Rust" : 35
    "Go" : 25
    "Python" : 20
    "JavaScript" : 15
    "其他" : 5
\`\`\`

## 引用

> 这是一个引用块。
>
> 可以有多行内容。
>
> — 引用来源

## 链接和图片

这是一个 [链接示例](https://github.com/kookyleo/go-grip)。

## 分隔线

---

## 内联代码

使用 `cargo build` 命令来构建项目。

## 脚注

这是一个带脚注的文本[^1]。

[^1]: 这是脚注的内容。

## 结论

以上测试涵盖了 markon 的主要功能！
