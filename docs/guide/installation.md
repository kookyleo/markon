# 安装

<div class="feature-illustration">
  <img src="/illustrations/11-platforms.svg" alt="全平台覆盖" />
</div>

Markon 提供桌面应用（GUI）和命令行（CLI）两种形态。

## 桌面版

### macOS

#### 通过 Homebrew 安装（推荐）

```bash
brew tap kookyleo/markon https://github.com/kookyleo/markon
brew install --cask markon
```

后续升级：

```bash
brew upgrade --cask markon
```

首次启动仍会遇到下面说的 Gatekeeper 提示 —— brew 本身只校验下载完整性，不管签名类型。想完全跳过提示，安装时加 `--no-quarantine`：

```bash
brew install --cask --no-quarantine markon
```

#### 手动下载安装

<DownloadButton mode="os" os="macos" />

下载对应芯片的 `.dmg`，双击挂载后拖到 Applications 目录。

首次启动时，macOS Gatekeeper 会拒绝打开（因为应用使用的是 ad-hoc 签名，而非 Apple 颁发的证书）。打开 **系统设置 → 隐私与安全性**，滚动到下方 _Security_ 区，点击 **「Markon」 was blocked to protect your Mac** 旁的 **Open Anyway**；再次确认即可。之后启动不会再提示。

![macOS Gatekeeper：在系统设置点 Open Anyway，确认放行 Markon](/screenshots/macos-gatekeeper.png)

::: details 较老版本 macOS（Monterey 及更早）

如果系统设置中**没有**「Open Anyway」按钮，请改用右键方式：在 Finder 的 Applications 目录中，**右键**（或 Control+点击）Markon.app → 选择 **Open**，弹出的确认框中再点 **Open** 即可放行。

![macOS 较老版本：右键打开放行 Markon](/screenshots/macos-gatekeeper-legacy.png)

:::

### Windows

<DownloadButton mode="os" os="windows" />

下载对应 CPU 的 `-setup.exe`，双击运行安装。

NSIS 安装包未做代码签名，会触发 SmartScreen。在「Windows protected your PC」弹窗中点左下角 **More info**，展开后点右下角 **Run anyway** 即可。

![Windows SmartScreen：点 More info 展开后选择 Run anyway](/screenshots/windows-smartscreen.png)

#### 通过 Scoop 安装

如果你已经安装了 [Scoop](https://scoop.sh/)：

```powershell
scoop bucket add kookyleo https://github.com/kookyleo/markon
scoop install kookyleo/markon
```

没装过 Scoop 的话，一行 PowerShell 即可：

```powershell
irm get.scoop.sh | iex
```

（首次可能需要先 `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`）

### Linux

<DownloadButton mode="os" os="linux" />

下载 `.deb` 后安装：

```bash
sudo dpkg -i Markon_*.deb
```

或下载 `.AppImage` 直接运行：

```bash
chmod +x Markon_*.AppImage
./Markon_*.AppImage
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

用户数据统一存放在用户主目录下的 `.markon/`：

- macOS / Linux：`~/.markon/`
- Windows：`%USERPROFILE%\.markon\`

目录内主要文件：

- `settings.json` — GUI 偏好与工作区列表
- `annotation.sqlite` — 共享标注数据库（默认；可被 `MARKON_SQLITE_PATH` 覆盖）

这些文件卸载时不会自动删除，如需清理请手动移除。
