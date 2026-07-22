# 共享批注

<div class="feature-illustration">
  <img src="/illustrations/07-sync.svg" alt="多端同步" />
</div>

Markon 的个人批注和已读状态始终存储在本机 SQLite。启用 **共享批注** 后，同一数据集再通过 WebSocket 向所有已获准的协作者实时同步；关闭共享不会搬移或删除数据，只会停止协作输出。

## 启用

在浏览器工作区设置中勾选 **共享批注和已读状态**，或使用 `markon set <ID> shared on`。

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
MARKON_SQLITE_PATH=/path/to/db markon README.md
```

桌面版：**全局设置 → 数据库**，点击 **选择…** 浏览。

## 同步机制

```
Browser A ──HTTP mutation──▶ SQLite
    ▲                            │
    └──── WebSocket broadcast ───┼──▶ Browser B
                                 └──▶ Browser C
```

- 任一客户端新建/修改/删除批注 → 通过 HTTP 写入 SQLite → 按共享开关广播 WebSocket 消息
- 其他客户端收到消息后立即更新 UI
- WebSocket 自动重连（指数退避），断线期间的变更在重连时一次性同步

## 多设备访问

启用 `--host 0.0.0.0` 让其他设备通过网络访问同一 Markon 实例：

```bash
markon --host 0.0.0.0 --qr
```

然后在浏览器工作区设置中启用 **共享批注和已读状态**。

场景：
- 手机扫 QR 码打开 → 添加批注 → 电脑浏览器实时看到
- 家里服务器跑 Markon → 手机/平板/电脑各自连接 → 共享笔记

## 团队协作

Markon 本身不区分用户身份 —— 所有连接客户端都是平等的编辑者。这种「共享白板」模式适合：

- 小团队 wiki（3-5 人）
- 读书会/讨论组的共同批注
- 技术评审会议中的实时批注

不适合：
- 需要权限管理的场景（谁能编辑、谁只能看）
- 需要审批流、版本对比的正式文档系统

## 性能

- SQLite 是嵌入式数据库，无需服务端进程
- 单库支持数万条批注无压力
- WebSocket 广播延迟通常 < 100ms

## 数据备份

SQLite 数据库就是一个文件，直接拷贝即可备份：

```bash
cp ~/.markon/annotation.sqlite ~/backup/markon-$(date +%Y%m%d).sqlite
```

恢复：把备份文件拷贝回原路径。

## 旧版数据迁移

升级后，页面会把当前浏览器来源下的旧版 LocalStorage 批注与 SQLite 合并；SQLite 中同 ID 的数据
优先，本地独有批注会补写进去，成功后清除该来源副本。浏览器同源策略仍禁止新 IP 直接读取旧 IP
下的存储；如旧数据只存在于已经不可访问的旧地址，需要临时恢复该地址并打开一次以完成迁移。
