param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$GuiExe = "$env:LocalAppData\Markon\markon-gui.exe",
    [switch]$SkipBuild,
    [switch]$SkipGui
)

$ErrorActionPreference = "Stop"

$script:Results = @()
$script:StartedProcesses = @()
$script:LockPath = Join-Path $env:USERPROFILE ".markon\server.lock"
$script:SettingsPath = Join-Path $env:USERPROFILE ".markon\settings.json"
$script:SettingsBackup = $null
$script:CliExe = Join-Path $RepoRoot "target\debug\markon.exe"
$script:ServiceExe = Join-Path $RepoRoot "target\debug\markond.exe"

function Add-Result($Name, $Status, $Detail) {
    $script:Results += [pscustomobject]@{
        name = $Name
        status = $Status
        detail = $Detail
    }
}

function Invoke-Step($Name, [scriptblock]$Body) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Host "==> $Name"
    try {
        & $Body
        $sw.Stop()
        Add-Result $Name "ok" ("{0:n2}s" -f $sw.Elapsed.TotalSeconds)
    } catch {
        $sw.Stop()
        Add-Result $Name "failed" $_.Exception.Message
        throw
    }
}

function Invoke-Native($Name, [scriptblock]$Body) {
    & $Body
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Assert-True($Condition, $Message) {
    if (-not $Condition) {
        throw $Message
    }
}

function Stop-MarkonProcesses {
    # markond is the background service the CLI/GUI now spawn; kill it too so a
    # previous run's daemon never lingers holding the port or the control pipe.
    Get-Process markon, markon-gui, markond -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Remove-Item $script:LockPath -Force -ErrorAction SilentlyContinue
}

# Run a `markon` CLI subcommand to completion, capture its output, and fail on a
# non-zero exit. The management subcommands (ls / set / detach / shutdown) speak
# the control socket — a Windows named pipe — and the CLI now exits non-zero when
# such an op fails, so a clean exit is a real end-to-end pipe check. Returns the
# combined stdout/stderr text (callers parse it, e.g. for the server URL).
#
# Output is captured to files, NOT via a `& cli | Out-String` pipe: `markon <dir>`
# fires a best-effort browser open that spawns a grandchild process which inherits
# the stdout handle, so a pipe capture would block on EOF until that grandchild
# exits (it may linger indefinitely). We WaitForExit on the direct child only, then
# read the files — with a hard timeout so a genuine hang surfaces as a failure.
function Invoke-MarkonCli($CliArgs, $TimeoutSec = 60) {
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $script:CliExe -ArgumentList $CliArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        # Touch .Handle so the Process object caches it — without this, a
        # Start-Process -PassThru object returns $null from .ExitCode after exit.
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            throw ("markon " + ($CliArgs -join ' ') + " timed out after ${TimeoutSec}s")
        }
        $out = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + "`n" +
                (Get-Content $errFile -Raw -ErrorAction SilentlyContinue))
        if ($p.ExitCode -ne 0) {
            throw ("markon " + ($CliArgs -join ' ') + " failed (exit $($p.ExitCode)): " + $out.Trim())
        }
        return $out
    } finally {
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# Parse the first workspace id (8 hex chars) out of `markon ls` — used by the GUI
# smoke, which doesn't spawn the server itself and so has no spawn URL to read.
function Get-FirstWorkspaceId {
    $out = Invoke-MarkonCli @("ls", "--format", "table")
    $m = [regex]::Match($out, '\b([0-9a-fA-F]{8})\b')
    if (-not $m.Success) {
        throw "Could not parse a workspace id from `markon ls`: $out"
    }
    return $m.Groups[1].Value
}

function Wait-Until($Name, [scriptblock]$Predicate, [int]$TimeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        if (& $Predicate) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $Name"
}

function Wait-MarkonLock([int]$TimeoutSec = 30) {
    Wait-Until "server.lock" {
        if (-not (Test-Path $script:LockPath)) {
            return $false
        }
        try {
            $lock = Get-Content $script:LockPath -Raw | ConvertFrom-Json
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect("127.0.0.1", [int]$lock.port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(500, $false)
            if ($ok) {
                $client.EndConnect($iar)
            }
            $client.Close()
            return $ok
        } catch {
            return $false
        }
    } $TimeoutSec
    return (Get-Content $script:LockPath -Raw | ConvertFrom-Json)
}

function Invoke-Json($Method, $Uri, $Token, $Body = $null) {
    $headers = @{}
    if ($Token) {
        $headers["X-Markon-Token"] = $Token
    }
    $params = @{
        Method = $Method
        Uri = $Uri
        Headers = $headers
        UseBasicParsing = $true
        TimeoutSec = 15
    }
    if ($null -ne $Body) {
        $params["Body"] = ($Body | ConvertTo-Json -Depth 20)
        $params["ContentType"] = "application/json"
    }
    $resp = Invoke-WebRequest @params
    if ([string]::IsNullOrWhiteSpace($resp.Content)) {
        return $null
    }
    return ($resp.Content | ConvertFrom-Json)
}

function Invoke-Text($Uri) {
    return (Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 15).Content
}

function Test-HttpSurface($Base, $Id, $ExpectedEphemeral) {
    # The web/data plane is tokenless: management (incl. the workspace list) moved
    # to the control socket, so the caller supplies the workspace id (from the
    # spawn URL, or `markon ls`) instead of a removed GET /api/workspaces.
    Assert-True ($Id) "Workspace id missing"

    $dirPage = Invoke-Text "$Base/$Id/"
    Assert-True ($dirPage -match "README\.md") "Workspace root did not render/redirect to README.md"

    $mdPage = Invoke-Text "$Base/$Id/README.md"
    Assert-True ($mdPage -match "Markon Windows Smoke") "Markdown route did not render expected heading"
    Assert-True ($mdPage -match "alpha beta gamma") "Markdown route did not render expected content"

    $previewBody = @{
        content = @'
# Preview

```mermaid
graph TD; A-->B;
```
'@
    }
    $preview = Invoke-Json "POST" "$Base/api/preview" $null $previewBody
    Assert-True ($preview.html -match "Preview") "Preview API did not render markdown"
    Assert-True ($preview.html -match "markon-diagram") "Preview API did not render Mermaid server-side"
    Assert-True ($preview.html -match "<svg") "Preview API Mermaid output did not include SVG"

    $css = Invoke-WebRequest -Uri "$Base/_/css/tokens.css" -UseBasicParsing -TimeoutSec 15
    Assert-True ($css.StatusCode -eq 200) "Static CSS endpoint failed"
    $icon = Invoke-WebRequest -Uri "$Base/_/favicon.svg" -UseBasicParsing -TimeoutSec 15
    Assert-True ($icon.StatusCode -eq 200) "Static favicon endpoint failed"

    if (-not $ExpectedEphemeral) {
        # Search readiness has no management endpoint anymore — poll the workspace
        # search route itself until the index answers with a hit.
        # Wrap the response in @() and filter nulls before .Count: PowerShell
        # unwraps a single-element result to a scalar (a PSCustomObject has no
        # .Count), and an empty body deserializes to $null.
        $searchUrl = "$Base/_/$Id/search?q=alpha"
        Wait-Until "search index" {
            try {
                $hits = @(Invoke-Json "GET" $searchUrl $null | Where-Object { $null -ne $_ })
                return ($hits.Count -ge 1)
            } catch {
                return $false
            }
        } 45
        $hits = @(Invoke-Json "GET" $searchUrl $null | Where-Object { $null -ne $_ })
        Assert-True ($hits.Count -ge 1) "Search did not return README.md hit"

        # Save requires the per-workspace save token the page embeds for the
        # editor (as <meta name="save-token">), sent back as X-Markon-Token. A
        # loopback peer is NOT auto-trusted for writes, so scrape it from the page.
        $mt = [regex]::Match($mdPage, '<meta name="save-token" content="([^"]+)"')
        Assert-True ($mt.Success) "Page did not embed a save-token (is edit enabled on this workspace?)"
        $saveToken = $mt.Groups[1].Value
        $saveBody = @{
            workspace_id = $Id
            file_path = "README.md"
            content = "# Markon Windows Smoke`n`nupdated alpha beta gamma"
        }
        $save = Invoke-Json "POST" "$Base/api/save" $saveToken $saveBody
        Assert-True ($save.success -eq $true) "Save API failed: $($save.message)"
        $updated = Invoke-Text "$Base/$Id/README.md"
        Assert-True ($updated -match "updated alpha beta gamma") "Saved markdown content not served"

        # NOTE 1: add/update/remove-workspace management no longer lives on the web
        # plane — it moved to the control socket. Invoke-CliSmoke exercises it
        # through the `markon` ls/set/shutdown subcommands (which speak the named
        # pipe), so it isn't re-tested here.
        # NOTE 2: the collaboration WebSocket (/_/{id}/ws) requires the access
        # cookie from the unlock handshake even on loopback; that browser-auth flow
        # is orthogonal to the service split and not simulated here.
    } else {
        try {
            Invoke-WebRequest -Uri "$Base/$Id/sibling.md" -UseBasicParsing -TimeoutSec 15 | Out-Null
            throw "Expected sibling.md to be hidden in single-file mode"
        } catch {
            if ($_.Exception.Response.StatusCode.value__ -ne 404) {
                throw
            }
        }
    }
}

function Invoke-CliSmoke {
    $workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("markon-cli-smoke-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    Set-Content -Path (Join-Path $workspace "README.md") -Value "# Markon Windows Smoke`n`nalpha beta gamma" -Encoding UTF8
    Set-Content -Path (Join-Path $workspace "notes.txt") -Value "not indexed" -Encoding UTF8

    Assert-True (Test-Path $script:CliExe) "CLI binary missing: $script:CliExe"
    # markond must sit beside markon.exe — that's how locate_markond() finds the
    # service to spawn (and how the GUI bundles it as an externalBin sidecar).
    Assert-True (Test-Path $script:ServiceExe) "Service binary missing beside CLI: $script:ServiceExe"

    Stop-MarkonProcesses
    # `markon <dir>` locates markond.exe beside it, spawns it windowless with the
    # config on a per-user temp file, waits for readiness, forwards the workspace
    # over the control named pipe, then prints the served URL and returns — markond
    # keeps serving. No --daemon-internal, no management token: gone with the split.
    $spawnOut = Invoke-MarkonCli @("--port", "0", "--host", "127.0.0.1", $workspace)
    # The printed URL carries both the ephemeral port and this workspace's id, so
    # we target the workspace under test directly (not a 1-based index that stale
    # persisted entries could shift).
    $m = [regex]::Match($spawnOut, 'http://127\.0\.0\.1:(\d+)/([0-9a-fA-F]{8})/')
    Assert-True ($m.Success) "Could not parse the server URL from spawn output: $spawnOut"
    $port = $m.Groups[1].Value
    $id = $m.Groups[2].Value
    $base = "http://127.0.0.1:$port"

    # Wait for the web port to accept connections before probing it.
    $lock = Wait-MarkonLock 30
    Assert-True ("$($lock.port)" -eq $port) "Lock port $($lock.port) disagrees with spawn URL port $port"

    # Turn on the features the data-plane assertions rely on, over the control
    # pipe (exercises its write path). Target by id so stale workspaces can't shift
    # the selection.
    foreach ($feature in @("search", "viewed", "edit", "live", "shared")) {
        Invoke-MarkonCli @("set", $id, $feature, "on") | Out-Null
    }
    # Listing round-trips the pipe read path.
    Invoke-MarkonCli @("ls", "--format", "table") | Out-Null

    Test-HttpSurface $base $id $false

    # Shut the service down over the pipe, then confirm the web port is released.
    Invoke-MarkonCli @("shutdown") | Out-Null
    Wait-Until "service shutdown" {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect("127.0.0.1", [int]$port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(300, $false)
            if ($ok) { $client.EndConnect($iar) }
            $client.Close()
            return (-not $ok)
        } catch {
            return $true
        }
    } 15
    Remove-Item $workspace -Recurse -Force -ErrorAction SilentlyContinue
}

function Test-ContextMenuRegistry($ExpectedExe) {
    $keys = @(
        "HKCU:\Software\Classes\.md\shell\open_with_markon",
        "HKCU:\Software\Classes\.markdown\shell\open_with_markon",
        "HKCU:\Software\Classes\Directory\shell\open_with_markon",
        "HKCU:\Software\Classes\Directory\Background\shell\open_with_markon"
    )
    foreach ($key in $keys) {
        Assert-True (Test-Path $key) "Missing context menu registry key $key"
        $command = (Get-Item -Path (Join-Path $key "command")).GetValue("")
        Assert-True ($command -match [regex]::Escape($ExpectedExe)) "Context menu command does not point to ${ExpectedExe}: $command"
    }
}

function Invoke-GuiSmoke {
    if ($SkipGui) {
        Add-Result "GUI smoke" "skipped" "SkipGui was set"
        return
    }
    if (-not (Test-Path $GuiExe)) {
        Add-Result "GUI smoke" "skipped" "GUI exe not found: $GuiExe"
        return
    }

    $workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("markon-gui-smoke-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    Set-Content -Path (Join-Path $workspace "README.md") -Value "# Markon Windows Smoke`n`nalpha beta gamma`n`n![pic](pic.png)" -Encoding UTF8
    Set-Content -Path (Join-Path $workspace "sibling.md") -Value "# hidden sibling" -Encoding UTF8
    [System.IO.File]::WriteAllBytes((Join-Path $workspace "pic.png"), [byte[]](137,80,78,71,13,10,26,10))

    Stop-MarkonProcesses
    $task = "MarkonFullSmoke-$PID"
    $fileArg = Join-Path $workspace "README.md"
    $tr = ('"{0}" "{1}"' -f $GuiExe, $fileArg)
    try {
        schtasks.exe /Create /TN $task /SC ONCE /ST 23:59 /TR $tr /F /IT /RL LIMITED | Out-Null
        schtasks.exe /Run /TN $task | Out-Null
        $lock = Wait-MarkonLock 45
        $base = "http://127.0.0.1:$($lock.port)"
        # The GUI spawns the server itself, so there's no spawn URL to read here —
        # take the workspace id from the control socket via `markon ls`.
        $id = Get-FirstWorkspaceId
        Test-HttpSurface $base $id $true
        Test-ContextMenuRegistry $GuiExe
    } finally {
        schtasks.exe /Delete /TN $task /F 2>$null | Out-Null
        Stop-MarkonProcesses
        Remove-Item $workspace -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Push-Location $RepoRoot
try {
    if (Test-Path $script:SettingsPath) {
        $script:SettingsBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("markon-settings-" + [guid]::NewGuid().ToString("N") + ".json")
        Copy-Item $script:SettingsPath $script:SettingsBackup -Force
        # Start each run from an empty workspace list so entries persisted by a
        # prior (or crashed) run don't linger in the shared service and shift the
        # workspace under test. Salt and every other setting are preserved; the
        # whole file is restored from the backup in the finally block.
        try {
            $s = Get-Content $script:SettingsPath -Raw | ConvertFrom-Json
            $s.workspaces = @()
            # WriteAllText, NOT Set-Content -Encoding UTF8: PS 5.1 would prepend a
            # UTF-8 BOM that serde_json rejects ("expected value at line 1 column 1").
            [System.IO.File]::WriteAllText($script:SettingsPath, ($s | ConvertTo-Json -Depth 30))
        } catch {
            Write-Host "warning: could not reset persisted workspaces: $($_.Exception.Message)"
        }
    }

    Invoke-Step "environment" {
        Assert-True ($PSVersionTable.PSVersion.Major -ge 5) "PowerShell 5+ required"
        Assert-True (Get-Command cargo -ErrorAction SilentlyContinue) "cargo missing"
        Assert-True (Get-Command npm -ErrorAction SilentlyContinue) "npm missing"
        Write-Host "repo=$RepoRoot"
        Write-Host "gui=$GuiExe"
    }

    if (-not $SkipBuild) {
        Invoke-Step "npm install" {
            Invoke-Native "npm ci" { npm ci }
        }
        Invoke-Step "frontend build" { Invoke-Native "npm run build" { npm run build } }
        Invoke-Step "frontend tests" { Invoke-Native "npm test" { npm test } }
        Invoke-Step "cargo tests" { Invoke-Native "cargo test" { cargo test --workspace --exclude xtask } }
        Invoke-Step "debug binaries" { Invoke-Native "cargo build" { cargo build -p markon -p markond -p markon-gui } }
    }

    Invoke-Step "CLI HTTP/API/WebSocket smoke" { Invoke-CliSmoke }
    Invoke-Step "installed GUI file-open smoke" { Invoke-GuiSmoke }

    Write-Output "--- BEGIN WINDOWS SMOKE SUMMARY ---"
    Write-Output ($script:Results | ConvertTo-Json -Depth 6)
    Write-Output "--- END WINDOWS SMOKE SUMMARY ---"
} finally {
    Pop-Location
    foreach ($p in $script:StartedProcesses) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Stop-MarkonProcesses
    if ($script:SettingsBackup) {
        Copy-Item $script:SettingsBackup $script:SettingsPath -Force
        Remove-Item $script:SettingsBackup -Force -ErrorAction SilentlyContinue
    }
}
