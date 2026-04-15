# Launch markon via WinAppDriver and screenshot all four Settings tabs,
# using the Ctrl+1..4 shortcuts wired into ui/index.html.
#
# Assumes WinAppDriver is already running on 127.0.0.1:4723 (set up by the
# one-off interactive launch; it self-starts on login after that).
#
# Output: "--- BEGIN PNG:<tab> ---\n<base64>\n--- END PNG:<tab> ---"
# delimited blocks on stdout for each tab. The Mac-side wrapper extracts
# them into /tmp/markon-test/tab-<name>.png.

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:4723"

$cap = '{"desiredCapabilities":{"app":"C:\\Users\\leo\\AppData\\Local\\Markon\\markon-gui.exe","appWorkingDir":"C:\\Users\\leo\\AppData\\Local\\Markon"}}'
$r = Invoke-WebRequest -Uri "$base/session" -Method POST -Body $cap -ContentType "application/json" -UseBasicParsing -TimeoutSec 30
$sid = ($r.Content | ConvertFrom-Json).sessionId
$ses = "$base/session/$sid"
Write-Host "session=$sid"
Start-Sleep -Seconds 2

# WinAppDriver /keys expects each key as a separate array element.
# "\uE009" = Ctrl, "\uE000" = NULL (release all modifiers).
# Using literal JSON escapes avoids the PowerShell string-splitting
# surrogate-pair trap we hit earlier.
$tabs = @(
    @{ n = 'global';     key = '1' },
    @{ n = 'workspaces'; key = '2' },
    @{ n = 'tips';       key = '3' },
    @{ n = 'about';      key = '4' }
)
foreach ($t in $tabs) {
    $body = '{"value":["\uE009","' + $t.key + '","\uE000"]}'
    Invoke-WebRequest -Uri "$ses/keys" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 5 | Out-Null
    Start-Sleep -Milliseconds 600
    $r = Invoke-WebRequest -Uri "$ses/screenshot" -UseBasicParsing -TimeoutSec 15
    Write-Output "--- BEGIN PNG:$($t.n) ---"
    Write-Output (($r.Content | ConvertFrom-Json).value)
    Write-Output "--- END PNG:$($t.n) ---"
}

# Close the session (markon keeps running in tray)
try { Invoke-WebRequest -Uri "$ses" -Method DELETE -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {}
Write-Host "done"
