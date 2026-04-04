# Markon Windows Context Menu Registration
# Run as current user (no admin needed — writes to HKCU)
# Usage: .\windows-register-context-menu.ps1 [-Uninstall]
# Or pass -ExePath to specify the binary path explicitly.

param(
    [switch]$Uninstall,
    [string]$ExePath = ""
)

$label = "用 Markon 打开"
$key   = "open_with_markon"

if (-not $ExePath) {
    # Try to find the built binary relative to this script
    $root    = Split-Path $PSScriptRoot -Parent
    $release = Join-Path $root "target\release\markon-gui.exe"
    $debug   = Join-Path $root "target\debug\markon-gui.exe"

    if (Test-Path $release) { $ExePath = $release }
    elseif (Test-Path $debug) { $ExePath = $debug }
    else {
        Write-Error "markon-gui.exe not found. Build first with 'cargo build -p markon-gui' or pass -ExePath."
        exit 1
    }
}

$ExePath = (Resolve-Path $ExePath).Path
Write-Host "Using binary: $ExePath"

function Register {
    $paths = @(
        @{ Reg = "HKCU:\Software\Classes\.md\shell\$key";                    Cmd = "`"$ExePath`" `"%1`"" },
        @{ Reg = "HKCU:\Software\Classes\.markdown\shell\$key";              Cmd = "`"$ExePath`" `"%1`"" },
        @{ Reg = "HKCU:\Software\Classes\Directory\shell\$key";              Cmd = "`"$ExePath`" `"%1`"" },
        @{ Reg = "HKCU:\Software\Classes\Directory\Background\shell\$key";   Cmd = "`"$ExePath`" `"%W`"" }
    )

    foreach ($p in $paths) {
        New-Item -Path "$($p.Reg)\command" -Force | Out-Null
        Set-ItemProperty -Path $p.Reg         -Name ""      -Value $label
        Set-ItemProperty -Path $p.Reg         -Name "Icon"  -Value "$ExePath,0"
        Set-ItemProperty -Path "$($p.Reg)\command" -Name "" -Value $p.Cmd
    }

    # Refresh shell
    $code = @"
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
"@
    $shell = Add-Type -MemberDefinition $code -Name Shell -PassThru
    $shell::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

    Write-Host "✓ Context menu registered. Right-click a .md file or folder to use Markon."
}

function Unregister {
    $keys = @(
        "HKCU:\Software\Classes\.md\shell\$key",
        "HKCU:\Software\Classes\.markdown\shell\$key",
        "HKCU:\Software\Classes\Directory\shell\$key",
        "HKCU:\Software\Classes\Directory\Background\shell\$key"
    )
    foreach ($k in $keys) {
        if (Test-Path $k) { Remove-Item -Path $k -Recurse -Force }
    }
    Write-Host "✓ Context menu entries removed."
}

if ($Uninstall) { Unregister } else { Register }
