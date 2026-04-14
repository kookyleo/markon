# 安装

Markon 提供桌面应用（GUI）和命令行（CLI）两种形态。

## 桌面版

### macOS

从 [Releases](https://github.com/kookyleo/markon/releases/latest) 下载 `Markon_x.x.x_aarch64.dmg`，双击挂载后拖到 Applications 目录。

首次启动可能需要在 **系统设置 → 隐私与安全性** 点击 "仍要打开"（因为应用使用的是 ad-hoc 签名）。

### Windows

从 Releases 下载 `Markon_x.x.x_x64-setup.exe`，双击运行安装。

### Linux

**Debian / Ubuntu**：

```bash
wget https://github.com/kookyleo/markon/releases/latest/download/Markon_amd64.deb
sudo dpkg -i Markon_amd64.deb
```

**通用 AppImage**：

```bash
wget https://github.com/kookyleo/markon/releases/latest/download/Markon_amd64.AppImage
chmod +x Markon_amd64.AppImage
./Markon_amd64.AppImage
```

### 自动更新

桌面版启动后会定时检查更新。在 **全局设置 → 更新通道** 可选择：

- **正式版** — 仅接收通过 7 天验证期的稳定版（默认）
- **候选版** — 同时接收 RC 预览版，尝鲜新功能

## CLI 版

### Cargo（推荐）

```bash
cargo install markon
```

这会从 [crates.io](https://crates.io/crates/markon) 下载并编译 `markon` 二进制到 `~/.cargo/bin/`。

### 从源码

```bash
git clone https://github.com/kookyleo/markon.git
cd markon
cargo install --path crates/cli
```

### 从 GitHub Releases

桌面版的 `.dmg` / `.exe` / `.AppImage` 里已经捆绑了 `markon` CLI 二进制，你也可以直接从 Releases 拿预编译的 CLI 文件（如有发布）。

## 验证安装

```bash
markon --version
# Markon v0.9.1
```

## 卸载

**桌面版**：

- macOS：把 `/Applications/Markon.app` 扔进废纸篓
- Windows：控制面板 → 卸载程序
- Linux：`sudo dpkg -r markon`（deb）或删除 AppImage 文件

**CLI 版**：

```bash
cargo uninstall markon
```

用户数据（工作区配置、标注数据库）存储在：

- macOS：`~/Library/Application Support/dev.kookyleo.markon/`
- Linux：`~/.local/share/markon/`
- Windows：`%APPDATA%\dev.kookyleo.markon\`

这些目录卸载时不会自动删除，如需清理请手动移除。
