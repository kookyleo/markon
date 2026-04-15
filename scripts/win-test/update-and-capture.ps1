# Markon Windows auto-test helper.
#
# Called by the Mac dev machine over SSH. For a given version tag, this:
#   1. Kills any running markon-gui in the user's interactive session
#   2. Downloads the *.x64-setup.exe from the RC release on GitHub
#   3. Runs the installer silently (NSIS /S)
#   4. Dumps diagnostic state (version, settings.json, registry entries)
#
# No UI screenshot: SSH sessions run on a separate Window Station from the
# interactive desktop, so windows launched from here aren't visible to the
# logged-in user and vice versa. Launching markon is left to the user who
# can then screenshot in their own session.
#
# Output contract: stdout ends with
#   --- BEGIN STATE ---
#   <json diagnostic blob>
#   --- END STATE ---
# so the Mac-side wrapper can extract it deterministically.

# Expects $Version (required) and $Channel (default "rc") to be set by the
# caller — run.sh prepends them as simple assignments before encoding the
# whole thing for powershell -EncodedCommand (a script that starts with
# `param()` wouldn't compose that way).
if (-not $Version) { throw "Version not set" }
if (-not $Channel) { $Channel = "rc" }
$ErrorActionPreference = "Stop"

$tag = if ($Channel -eq "rc") { "v$Version-rc.1" } else { "v$Version" }
$asset = "Markon_${Version}_x64-setup.exe"
$url = "https://github.com/kookyleo/markon/releases/download/$tag/$asset"
$cacheDir = "$env:TEMP\markon-test"
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$setup = "$cacheDir\$asset"

Write-Host "=== Preparing to install $tag ==="

# ── Stop any running instance ──────────────────────────────────────────────
Get-Process markon-gui -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Killing markon-gui PID=$($_.Id)"
    Stop-Process -Id $_.Id -Force
    Start-Sleep -Milliseconds 500
}

# ── Download ───────────────────────────────────────────────────────────────
if (-not (Test-Path $setup)) {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
} else {
    Write-Host "Using cached $setup"
}

# ── Install silently ───────────────────────────────────────────────────────
Write-Host "Running $setup /S"
Start-Process -FilePath $setup -ArgumentList "/S" -Wait
Start-Sleep -Seconds 2

# ── Locate installed exe ───────────────────────────────────────────────────
$exe = "$env:LocalAppData\Markon\markon-gui.exe"
if (-not (Test-Path $exe)) {
    throw "Post-install: markon-gui.exe not found at $exe"
}
$installedVer = (Get-Item $exe).VersionInfo.FileVersion
Write-Host "Installed version: $installedVer"

# ── State dump ─────────────────────────────────────────────────────────────
$settingsPath = "$env:USERPROFILE\.markon\settings.json"
$settingsRaw = if (Test-Path $settingsPath) {
    [System.IO.File]::ReadAllText($settingsPath)
} else { "{}" }

$regDir = (reg query "HKCU\Software\Classes\Directory\shell\open_with_markon" 2>&1) -join "`n"
$regMd  = (reg query "HKCU\Software\Classes\.md\shell\open_with_markon" 2>&1) -join "`n"

$state = [pscustomobject]@{
    expected_version = $Version
    installed_version = $installedVer
    exe_path = $exe
    settings_json = $settingsRaw
    reg_dir_menu = $regDir
    reg_md_menu = $regMd
}

Write-Output "--- BEGIN STATE ---"
Write-Output ($state | ConvertTo-Json -Depth 5)
Write-Output "--- END STATE ---"
