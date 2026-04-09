#!/usr/bin/env bash
#
# dev-gui.sh — Fast dev loop for markon-gui.
#
# Kills any running Markon instance, builds (debug by default), and launches
# the freshly built binary directly. No DMG, no install step.
#
# Usage:
#   scripts/dev-gui.sh              # debug build, run binary
#   scripts/dev-gui.sh --release    # release build, run binary
#   scripts/dev-gui.sh --watch      # use `cargo tauri dev` (hot reload)
#
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="debug"
WATCH=0
for arg in "$@"; do
  case "$arg" in
    --release) MODE="release" ;;
    --watch)   WATCH=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ── 1. Kill any running Markon instance ──────────────────────────────────────
echo "▶ Killing running Markon instances…"
pkill -x "markon-gui" 2>/dev/null || true
pkill -x "Markon"     2>/dev/null || true
# Tauri bundles sometimes run as "Markon" app bundle:
osascript -e 'tell application "Markon" to quit' 2>/dev/null || true
sleep 0.3

# ── 2. Hot-reload mode (cargo tauri dev) ─────────────────────────────────────
if [[ $WATCH -eq 1 ]]; then
  echo "▶ Starting cargo tauri dev (hot reload)…"
  exec cargo tauri dev
fi

# ── 3. Build ─────────────────────────────────────────────────────────────────
echo "▶ Building markon-gui ($MODE)…"
if [[ "$MODE" == "release" ]]; then
  cargo build -p markon-gui --release
  BIN="target/release/markon-gui"
else
  cargo build -p markon-gui
  BIN="target/debug/markon-gui"
fi

if [[ ! -x "$BIN" ]]; then
  echo "✗ Binary not found at $BIN" >&2
  exit 1
fi

# ── 4. Launch ────────────────────────────────────────────────────────────────
echo "▶ Launching $BIN"
"$BIN" &
disown
echo "✓ Markon started (pid $!)"
