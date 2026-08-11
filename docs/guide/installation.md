# Installation

<div class="feature-illustration">
  <img src="/illustrations/11-platforms.svg" alt="Supported desktop platforms" />
</div>

Markon is available as a desktop application and as a command-line tool.

## Desktop app

### macOS

#### Install with Homebrew (recommended)

```bash
brew tap kookyleo/markon https://github.com/kookyleo/markon
brew install --cask markon
```

Upgrade later with `brew upgrade --cask markon`. Markon currently uses an ad-hoc signature, so macOS may still show a Gatekeeper warning. To skip quarantine during installation, use:

```bash
brew install --cask --no-quarantine markon
```

#### Install manually

<DownloadButton mode="os" os="macos" />

Download the `.dmg` for your Mac, mount it, and drag Markon into Applications. On first launch, open **System Settings → Privacy & Security**, find the message that Markon was blocked, and choose **Open Anyway**.

![Allow Markon from macOS Privacy & Security settings](/screenshots/macos-gatekeeper.png)

::: details macOS Monterey and earlier
If **Open Anyway** is unavailable, Control-click Markon.app in Applications, choose **Open**, then confirm **Open** in the dialog.

![Open Markon from the Finder context menu on older macOS versions](/screenshots/macos-gatekeeper-legacy.png)
:::

### Windows

<DownloadButton mode="os" os="windows" />

Download the `-setup.exe` for your CPU and run it. If SmartScreen shows “Windows protected your PC,” select **More info**, then **Run anyway**.

![Allow the Markon installer through Windows SmartScreen](/screenshots/windows-smartscreen.png)

#### Install with Scoop

```powershell
scoop bucket add kookyleo https://github.com/kookyleo/markon
scoop install kookyleo/markon
```

If Scoop is not installed, see [scoop.sh](https://scoop.sh/) or run `irm get.scoop.sh | iex` in PowerShell.

### Linux

<DownloadButton mode="os" os="linux" />

Install the Debian package:

```bash
sudo dpkg -i Markon_*.deb
```

Or run the AppImage:

```bash
chmod +x Markon_*.AppImage
./Markon_*.AppImage
```

### Updates

The desktop app periodically checks for updates. Under **Global settings → Update channel**, choose **Stable** for releases that have completed the validation period, or **Candidate** to include RC previews.

## CLI

### Cargo (recommended)

```bash
cargo install markon markond
```

This installs two binaries into `~/.cargo/bin/`:

- [`markon`](https://crates.io/crates/markon), the CLI and local control client;
- [`markond`](https://crates.io/crates/markond), the long-running background service.

Both should be on `PATH`. If `markond` is missing, the CLI falls back to foreground service mode and occupies the current terminal.

### Build from source

```bash
git clone https://github.com/kookyleo/markon.git
cd markon
cargo install --path crates/markond
cargo install --path crates/cli
```

### GitHub Releases

The desktop app bundles the service. For servers and CLI-only environments, install `markon` and `markond` through Cargo, or use prebuilt CLI assets when a release provides them.

## Verify

```bash
markon --version
command -v markond
```

You normally do not invoke `markond` directly; the desktop app or CLI starts it with the appropriate temporary configuration.

## Uninstall

- **macOS:** move `/Applications/Markon.app` to Trash.
- **Windows:** uninstall Markon from Installed apps.
- **Linux:** run `sudo dpkg -r markon` for the Debian package, or delete the AppImage.
- **CLI:** run `cargo uninstall markon markond`.

User data remains in `~/.markon/` on macOS and Linux or `%USERPROFILE%\.markon\` on Windows. `settings.json` stores preferences and workspaces; `annotation.sqlite` stores annotations, Viewed state, and conversations. Remove these files manually only if you also want to erase your data.
