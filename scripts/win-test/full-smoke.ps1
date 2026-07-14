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

# Run a `markon` CLI subcommand to completion and fail on a non-zero exit. The
# management subcommands (ls / set / detach / shutdown) speak the control socket
# — a Windows named pipe — so a clean exit is itself an end-to-end pipe check.
function Invoke-MarkonCli($CliArgs, $WorkDir = $null) {
    $params = @{
        FilePath = $script:CliExe
        ArgumentList = $CliArgs
        Wait = $true
        PassThru = $true
        NoNewWindow = $true
    }
    if ($WorkDir) { $params["WorkingDirectory"] = $WorkDir }
    $p = Start-Process @params
    if ($p.ExitCode -ne 0) {
        throw ("markon " + ($CliArgs -join ' ') + " failed with exit code " + $p.ExitCode)
    }
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

function ConvertTo-Array($Value) {
    if ($null -eq $Value) {
        return @()
    }
    $propNames = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if (($propNames -contains "value") -and ($propNames -contains "Count")) {
        return @($Value.value)
    }
    return @($Value)
}

function Invoke-Text($Uri) {
    return (Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 15).Content
}

function Send-WsText($Ws, [string]$Text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $seg = [System.ArraySegment[byte]]::new($bytes, 0, $bytes.Length)
    $Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Receive-WsText($Ws, [int]$TimeoutSec = 10) {
    $buffer = New-Object byte[] 16384
    $ms = New-Object System.IO.MemoryStream
    $cts = [System.Threading.CancellationTokenSource]::new()
    $cts.CancelAfter([TimeSpan]::FromSeconds($TimeoutSec))
    do {
        $seg = [System.ArraySegment[byte]]::new($buffer, 0, $buffer.Length)
        $result = $Ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
        if ($result.Count -gt 0) {
            $ms.Write($buffer, 0, $result.Count)
        }
    } while (-not $result.EndOfMessage)
    return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
}

function Test-HttpSurface($Base, $ExpectedEphemeral) {
    # The web/data plane is tokenless: management moved to the control socket
    # (named pipe on Windows), so nothing here carries X-Markon-Token anymore.
    $workspaces = ConvertTo-Array (Invoke-Json "GET" "$Base/api/workspaces" $null)
    Assert-True ($workspaces.Count -ge 1) "No workspaces returned"
    $ws = $workspaces | Select-Object -First 1
    $id = $ws.id
    Assert-True ($id) "Workspace id missing"
    if ($ExpectedEphemeral) {
        Assert-True ($ws.ephemeral -eq $true) "Expected GUI file-open workspace to be ephemeral"
        Assert-True ($ws.single_file -eq "README.md") "Expected single_file README.md"
    }

    $dirPage = Invoke-Text "$Base/$id/"
    if ($ExpectedEphemeral) {
        Assert-True ($dirPage -match "README\.md") "Ephemeral root did not redirect/render README.md"
    } else {
        Assert-True ($dirPage -match "README\.md") "Directory listing missing README.md"
    }

    $mdPage = Invoke-Text "$Base/$id/README.md"
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
        Wait-Until "search index" {
            $state = ConvertTo-Array (Invoke-Json "GET" "$Base/api/workspaces" $null)
            return (($state | Where-Object { $_.id -eq $id }).search_ready -eq $true)
        } 45
        $searchUrl = "$Base/_/$id/search?q=alpha"
        $search = ConvertTo-Array (Invoke-Json "GET" $searchUrl $null)
        Assert-True ($search.Count -ge 1) "Search did not return README.md hit"

        $saveBody = @{
            workspace_id = $id
            file_path = "README.md"
            content = "# Markon Windows Smoke`n`nupdated alpha beta gamma"
        }
        $save = Invoke-Json "POST" "$Base/api/save" $null $saveBody
        Assert-True ($save.success -eq $true) "Save API failed: $($save.message)"
        $updated = Invoke-Text "$Base/$id/README.md"
        Assert-True ($updated -match "updated alpha beta gamma") "Saved markdown content not served"

        # NOTE: add/update/remove-workspace management no longer lives on the web
        # plane — it moved to the control socket. Invoke-CliSmoke exercises it
        # through the `markon` ls/set/shutdown subcommands (which speak the named
        # pipe), so it isn't re-tested here.

        $wsClient = [System.Net.WebSockets.ClientWebSocket]::new()
        $wsClient.ConnectAsync([Uri]"ws://127.0.0.1:$($Base.Split(':')[-1])/_/ws", [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
        Send-WsText $wsClient "README.md"
        $initial = Receive-WsText $wsClient
        Assert-True ($initial -match "all_annotations") "WebSocket did not send initial annotations"
        Receive-WsText $wsClient | Out-Null
        Send-WsText $wsClient (@{
            type = "new_annotation"
            annotation = @{
                id = "win-smoke-annotation"
                text = "hello"
            }
            op_id = "win-smoke-op"
        } | ConvertTo-Json -Depth 10 -Compress)
        $echo = Receive-WsText $wsClient
        Assert-True ($echo -match "win-smoke-annotation") "WebSocket annotation echo missing"
        $wsClient.Dispose()
    } else {
        try {
            Invoke-WebRequest -Uri "$Base/$id/sibling.md" -UseBasicParsing -TimeoutSec 15 | Out-Null
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
    # over the control named pipe, then returns — markond keeps serving. No
    # --daemon-internal, no management token: those are gone with the split.
    Invoke-MarkonCli @("--port", "0", "--host", "127.0.0.1", $workspace) $workspace

    $lock = Wait-MarkonLock 30
    $base = "http://127.0.0.1:$($lock.port)"

    # Turn on the features the data-plane assertions rely on, over the control
    # pipe (exercises its write path). Targets are 1-based indices from `markon ls`.
    foreach ($feature in @("search", "viewed", "edit", "live", "shared")) {
        Invoke-MarkonCli @("set", "1", $feature, "on")
    }
    # Listing round-trips the pipe read path.
    Invoke-MarkonCli @("ls", "--format", "table")

    Test-HttpSurface $base $false

    # Shut the service down over the pipe, then confirm the web port is released.
    Invoke-MarkonCli @("shutdown")
    Wait-Until "service shutdown" {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect("127.0.0.1", [int]$lock.port, $null, $null)
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
        Test-HttpSurface $base $true
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
        Invoke-Step "debug binaries" { Invoke-Native "cargo build" { cargo build -p markon-cli -p markond -p markon-gui } }
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
