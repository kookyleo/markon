#!/usr/bin/env bash
#
# Wrapper around update-and-capture.ps1: install a given markon version on
# the remote Windows box via SSH and dump its post-install state.
#
# Usage:
#   scripts/win-test/run.sh 0.9.12            # tests v0.9.12-rc.1 by default
#   scripts/win-test/run.sh 0.9.12 stable     # tests v0.9.12
#
# Writes to /tmp/markon-test/state.json with version / settings.json /
# registry dump. Screenshots aren't automated — SSH runs on a different
# Window Station from the interactive desktop, so windows from here aren't
# visible to the logged-in user. Launch + screenshot manually after.
#
# Requires: ssh alias set via MARKON_WIN_HOST / MARKON_WIN_PORT env vars
# (default: the kookyleo test host).

set -euo pipefail

VERSION="${1:?usage: $0 <version> [stable|rc]}"
CHANNEL="${2:-rc}"
HOST="${MARKON_WIN_HOST:-kookyleo@gmail.com@240e:604:203:e00:213::16}"
PORT="${MARKON_WIN_PORT:-16722}"

OUT_DIR="/tmp/markon-test"
mkdir -p "$OUT_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PS1_PATH="$SCRIPT_DIR/update-and-capture.ps1"

# PowerShell -EncodedCommand takes UTF-16LE base64. Compose it:
#   param call:  <inline script body> ; & { } -Version "..." -Channel "..."
# Simplest: prepend param invocation vars and the script body, then encode.
WRAPPER=$(cat <<PS
\$Version = '$VERSION'
\$Channel = '$CHANNEL'
$(cat "$PS1_PATH")
PS
)

ENCODED=$(python3 -c "
import base64, sys
raw = sys.stdin.read().encode('utf-16le')
print(base64.b64encode(raw).decode())
" <<< "$WRAPPER")

echo "→ Running update-and-capture.ps1 on $HOST for $VERSION ($CHANNEL)"
RAW="$(ssh -p "$PORT" "$HOST" "powershell -NoProfile -EncodedCommand $ENCODED" 2>&1)"

# Strip CLIXML noise / PowerShell banner
echo "$RAW" | grep -v '^<Objs' | grep -v 'CLIXML' | grep -v 'WARNING' | grep -v 'quantum' > "$OUT_DIR/raw.txt"

python3 - "$OUT_DIR" <<'PY'
import sys, re, json
from pathlib import Path
out = Path(sys.argv[1])
text = (out / 'raw.txt').read_text()
m = re.search(r'--- BEGIN STATE ---\s*(.*?)\s*--- END STATE ---', text, re.DOTALL)
if not m:
    print('  no STATE block found — check raw.txt')
    sys.exit(1)
(out / 'state.json').write_text(m.group(1))
print(f'  state → {out}/state.json')
s = json.loads(m.group(1))
print(f'  installed:    {s.get("installed_version")}  (expected {s.get("expected_version")})')

# Quick sanity checks — flag obvious regressions
settings = json.loads(s.get('settings_json', '{}'))
bad_paths = [w['path'] for w in settings.get('workspaces', []) if w['path'].startswith(r'\\?\\')]
if bad_paths:
    print(f'  ⚠️  settings.json still carries \\\\?\\ paths:')
    for p in bad_paths: print(f'      {p}')
else:
    print('  ✓  settings.json workspace paths are clean')

for key, name in [('reg_dir_menu', 'dir'), ('reg_md_menu', '.md')]:
    val = s.get(key, '')
    if 'open_with_markon' in val:
        label = re.search(r'\(Default\)\s+REG_SZ\s+(.+)', val)
        print(f'  ✓  context menu [{name}]: {label.group(1) if label else "present"}')
    else:
        print(f'  ⚠️  context menu [{name}]: missing')
PY
