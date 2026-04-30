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
#   scripts/dev-gui.sh --watch      # cargo tauri dev (Rust hot reload) +
#                                   # npm run dev (TS esbuild watch).
#                                   # Rust edits restart the binary;
#                                   # TS edits rebuild on save — Cmd-R the
#                                   # webview to pick them up.
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

sync_dev_bundle_icon() {
  local src="crates/gui/icons/icon.icns"
  local dst="target/debug/Contents/Resources/icon.icns"
  local plist="target/debug/Contents/Info.plist"

  [[ -f "$src" ]] || return 0

  mkdir -p "$(dirname "$dst")"
  cp -f "$src" "$dst"

  # Nudge LaunchServices/Dock to notice the dev bundle changed.
  [[ -f "$plist" ]] && touch "$plist"
}

# ── 1. Kill any running Markon instance ──────────────────────────────────────
echo "▶ Killing running Markon instances…"
pkill -x "markon-gui" 2>/dev/null || true
pkill -x "Markon"     2>/dev/null || true
# Tauri bundles sometimes run as "Markon" app bundle:
osascript -e 'tell application "Markon" to quit' 2>/dev/null || true
sleep 0.3

# ── 2. Hot-reload mode (esbuild watch + cargo tauri dev) ─────────────────────
# Rust changes → `cargo tauri dev` rebuilds + restarts the binary.
# TS changes  → `npm run dev` (esbuild watch) bundles into assets/dist/.
# rust-embed in debug mode reads from disk every request, so a TS rebuild is
# visible after a manual webview reload (Cmd-R).
if [[ $WATCH -eq 1 ]]; then
  sync_dev_bundle_icon

  ESBUILD_LOG="${TMPDIR:-/tmp}/markon-esbuild.log"
  echo "▶ Starting esbuild watcher (npm run dev) — logs: $ESBUILD_LOG"
  npm run dev > "$ESBUILD_LOG" 2>&1 &
  ESBUILD_PID=$!

  # Tear down the watcher when this script exits, no matter how it ends.
  cleanup() {
    if kill -0 "$ESBUILD_PID" 2>/dev/null; then
      echo "▶ Stopping esbuild watcher (pid $ESBUILD_PID)…"
      kill "$ESBUILD_PID" 2>/dev/null || true
      wait "$ESBUILD_PID" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM

  # Wait for esbuild's first bundle to land before launching tauri so the
  # initial webview load gets fresh main.js / viewed.js.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f crates/core/assets/dist/main.js && -f crates/core/assets/dist/viewed.js ]] && break
    sleep 0.2
  done

  echo "▶ Starting cargo tauri dev (Rust hot reload)…"
  cargo tauri dev
  exit $?
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

sync_dev_bundle_icon

# ── 4. Launch ────────────────────────────────────────────────────────────────
echo "▶ Launching $BIN"
"$BIN" &
disown
echo "✓ Markon started (pid $!)"
