# 共享标注

<div class="feature-illustration">
  <img src="/illustrations/07-sync.svg" alt="多端同步" />
</div>

默认情况下，Markon 的标注和已读状态存储在浏览器 LocalStorage —— 只对当前浏览器有效。启用 **共享标注** 后，这些数据会存到 SQLite 数据库，并通过 WebSocket 在所有连接的客户端间实时同步。

## 启用

**桌面版**：在工作区设置中勾选 **共享标记、便条和已读状态**。

**CLI**：

```bash
markon --shared-annotation README.md
```

启用后，同一工作区的所有浏览器会话会共享：

- 所有颜色高亮
- 删除线
- 便条笔记
- 已读状态
- 章节折叠状态

## 数据存储

### 默认路径

| 平台 | 路径 |
|------|------|
| macOS / Linux | `~/.markon/annotation.sqlite` |
| Windows | `%USERPROFILE%\.markon\annotation.sqlite` |

### 自定义路径

通过环境变量：

```bash
MARKON_SQLITE_PATH=/path/to/db markon --shared-annotation
```

桌面版：**全局设置 → 数据库**，点击 **选择…** 浏览。

## 同步机制

```
┌──────────┐  WebSocket  ┌──────────┐  WebSocket  ┌──────────┐
│ Browser A├────────────▶│  Markon  │◀────────────┤ Browser B│
└──────────┘             │  Server  │             └──────────┘
                         │    +     │
                         │  SQLite  │
                         └──────────┘
```

- 任一客户端新建/修改/删除标注 → 写入 SQLite → 广播 WebSocket 消息
- 其他客户端收到消息后立即更新 UI
- WebSocket 自动重连（指数退避），断线期间的变更在重连时一次性同步

## 多设备访问

启用 `--host 0.0.0.0` 让其他设备通过网络访问同一 Markon 实例：

```bash
markon --host 0.0.0.0 --shared-annotation --qr
```

场景：
- 手机扫 QR 码打开 → 添加标注 → 电脑浏览器实时看到
- 家里服务器跑 Markon → 手机/平板/电脑各自连接 → 共享笔记

## 团队协作

Markon 本身不区分用户身份 —— 所有连接客户端都是平等的编辑者。这种"共享白板"模式适合：

- 小团队 wiki（3-5 人）
- 读书会/讨论组的共同标注
- 技术评审会议中的实时批注

不适合：
- 需要权限管理的场景（谁能编辑、谁只能看）
- 需要审批流、版本对比的正式文档系统

## 性能

- SQLite 是嵌入式数据库，无需服务端进程
- 单库支持数万条标注无压力
- WebSocket 广播延迟通常 < 100ms

## 数据备份

SQLite 数据库就是一个文件，直接拷贝即可备份：

```bash
cp ~/.markon/annotation.sqlite ~/backup/markon-$(date +%Y%m%d).sqlite
```

恢复：把备份文件拷贝回原路径。

## 切换存储模式

从本地模式切到共享模式时，已有的 LocalStorage 标注**不会**自动迁移 —— 它们只对原浏览器可见。反之亦然。

目前没有内置的迁移工具，如需迁移可以：

1. 在本地模式下导出（浏览器 DevTools → Application → LocalStorage）
2. 手动转成 SQLite 插入语句
3. 或重新标注一次（最简单）
