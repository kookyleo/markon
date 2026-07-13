# 访问权限

Markon 不需要注册账号，但权限建立在显式 capability 上，而不是访问来源：

- **管理员**持有短期、`HttpOnly` 的 Admin session，可执行管理和结构性操作。
- **其它浏览器是协作者**，能力由工作区的**功能开关**决定，并受**协作者访问码**门禁约束。
- loopback、反向代理来源 IP、`X-Forwarded-For` 都不会自动授予管理员身份。

## 显式管理员会话

管理员会话可以：

- 修改工作区的功能开关（features）、别名（alias）；
- 增删工作区；
- `git commit` / `checkout`；
- 增删文件、编辑并保存正文。

用两种方式创建同一种管理员会话：

```bash
# 自动打开浏览器；nonce 位于 URL fragment，60 秒内一次有效
markon admin open

# SSH / 无桌面环境：打印 5 分钟有效的一次性配对码
markon admin code
```

fragment nonce 有 256 bit 随机性，页面读取后会立即清除地址栏 fragment，再通过同源 POST 兑换会话；手动码最多允许 5 次失败。Admin session 默认 12 小时有效，服务重启后失效。长期 management token 只存在于 0600 lock file / 原生进程中，不会进入 HTML、URL、JavaScript 或浏览器存储。

## 协作者（按功能开关）

未持有 Admin session 的浏览器都是**协作者**，无论连接来自 loopback、局域网还是反向代理。协作者能做什么，取决于该工作区开了哪些功能开关：

- `edit` 开 → 可编辑并保存正文；
- `chat` 开 → 可用 AI 助手；
- `annotation`（共享批注 / shared）开 → 可批注；
- 其余功能开关同理，就近生效。

协作者**不能**做管理 / 结构性操作：不能改功能开关或别名、不能增删工作区、不能 `git commit` / `checkout`、不能增删文件。这些一律要求 Admin session（原生 CLI / GUI 则使用 management token）。

## 协作者访问码

**协作者访问码**是所有非管理员浏览器的门禁：某个范围设了它，协作者要先在浏览器门禁页输入正确的码才能进入。loopback 不会绕过；有效 Admin session 可以绕过。

::: warning 这是应用层的访问控制，不是传输加密
协作者访问码只在 Markon 这一层校验「能不能进」，本身不加密链路。真要把服务暴露到公网，仍需在前面套 HTTPS / 反向代理，详见[反向代理](/advanced/reverse-proxy)。
:::

### 两级、就近覆盖

协作者访问码分两级，各管各的范围：

- **全局协作者码（服务级默认）** —— 对所有没有单独设码的工作区生效。
- **工作区协作者码** —— 只覆盖该工作区。

两者的关系是「就近覆盖」：

| 工作区是否设了自己的码 | 全局是否设了码 | 协作者进入该工作区需要 |
|--------------------|-------------|----------------|
| 设了 | 任意 | **该工作区自己的码**（全局码解锁不了它） |
| 没设 | 设了 | 全局码 |
| 没设 | 没设 | 无门禁（远程直接进入） |

也就是说：**工作区自己的码会覆盖全局码**。全局码只负责那些「没有自己专属码」的工作区；一个设了专属码的工作区，必须用它自己的码，拿全局码解不开。管理员会话独立于这两级协作者门禁。

### 怎么设置

协作者访问码可以在桌面版 GUI 里设，也可以用 CLI 设：

- **GUI（本机）** —— 在工作区卡片上点**协作者锁图标**展开输入框，填入码、确认即可；清空则移除该工作区的码。
- **CLI** —— 用 `--collaborator-access-code <CODE>` 设置或清除该工作区的协作者码，明文只用于这次调用，写入 `settings.json` 时只保存加盐 hash。

  ```bash
  markon --collaborator-access-code guest-secret README.md
  ```

### 访客如何解锁

当某个范围设了协作者访问码，协作者浏览器访问对应工作区时会先看到一张**门禁页**：

1. 输入框旁有一个**按住显示**的眼睛图标——按住时明文显示已输入的码，松开即重新遮蔽，方便核对又不会把码留在屏幕上。
2. 输入正确的码并解锁后，Markon 会写入一个**签名 Cookie**，有效期约 **30 天**，在此期间该范围自动放行，无需反复输入。
3. Cookie 按范围区分：解锁了全局范围，并不会顺带解开某个设了专属码的工作区，反之亦然。

> Cookie 使用 HMAC-SHA256 与每台机器的持久盐签名，因此**重启服务后仍然有效**。连续输错会触发按来源 IP 的冷却，逐步拉长重试间隔。显式登记为 HTTPS 的 origin 会收到带 `Secure` 的 Cookie。

## Host / Origin 边界

Markon 对所有请求执行精确 Host allowlist，默认包含 localhost、实际绑定地址、当前网卡地址和 `advertised_host`。自定义 DNS、mDNS 或反向代理域名必须显式登记：

```bash
markon --entry https://docs.example.com
# 或
markon --trusted-host https://docs.example.com
```

也可以在 `settings.json` 中设置 `"trusted_hosts": ["https://docs.example.com"]`。不支持通配符；未知 Host 返回 421。状态变更与 WebSocket 还要求 Origin authority 和 Host 一致。反向代理头只可用于日志 / 运维观察，不参与 Viewer、Collaborator、Admin 的身份判断。

## 本机 CLI 管理

除了创建浏览器 Admin session，本机 CLI 还能通过 management token 直接管理工作区：

- `markon set <id|序号> <feature> <on|off>` —— 开关某工作区的功能。feature 名：`search` / `viewed` / `edit` / `live` / `chat` / `shared`。例如：`markon set 3 edit on`。
- `markon ls` / `markon detach <id|序号>` / `markon shutdown` —— 列出 / 移除工作区、关闭服务。

详见[命令行选项](/guide/cli)。

## 局限

- 协作者访问码是**应用层**的门禁，不替代 HTTPS / 反向代理等传输层安全措施。
- 管理与结构性操作要求 Admin session / management token；若要让协作者做某类协作（编辑、批注、AI），请由管理员为对应工作区打开相应功能开关。
