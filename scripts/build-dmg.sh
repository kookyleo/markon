#!/usr/bin/env bash
#
# build-dmg.sh — Build a Markon .dmg for one or both macOS architectures.
#
# Usage:
#   scripts/build-dmg.sh                # current host architecture (default)
#   scripts/build-dmg.sh aarch64        # Apple Silicon only
#   scripts/build-dmg.sh x86_64         # Intel only
#   scripts/build-dmg.sh both           # both architectures (cross-compile)
#
# Output: target/release/bundle/dmg/Markon_<version>_<arch>.dmg
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUI_DIR="$REPO_ROOT/crates/gui"
DMG_OUT="$REPO_ROOT/target/release/bundle/dmg"

usage() { sed -n '2,12p' "$0"; }

ARG="${1:-host}"
case "$ARG" in
  -h|--help) usage; exit 0 ;;
  aarch64|arm64)    TARGETS=("aarch64-apple-darwin") ;;
  x86_64|x64|intel) TARGETS=("x86_64-apple-darwin") ;;
  both|all)         TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin") ;;
  host)
    case "$(uname -m)" in
      arm64|aarch64) TARGETS=("aarch64-apple-darwin") ;;
      x86_64)        TARGETS=("x86_64-apple-darwin") ;;
      *) echo "Unsupported host arch: $(uname -m)" >&2; exit 1 ;;
    esac
    ;;
  *) usage >&2; exit 1 ;;
esac

cd "$GUI_DIR"
VERSION=$(python3 -c "import json; print(json.load(open('tauri.conf.json'))['version'])")
mkdir -p "$DMG_OUT"

for TARGET in "${TARGETS[@]}"; do
  case "$TARGET" in
    aarch64-apple-darwin) ARCH="aarch64" ;;
    x86_64-apple-darwin)  ARCH="x86_64" ;;
  esac

  echo "Building .app for $TARGET (release)..."
  rustup target add "$TARGET" >/dev/null 2>&1 || true
  APPLE_SIGNING_IDENTITY="-" cargo tauri build --bundles app --target "$TARGET"

  APP="$REPO_ROOT/target/$TARGET/release/bundle/macos/Markon.app"
  if [[ ! -d "$APP" ]]; then
    echo "Markon.app not found at $APP" >&2
    exit 1
  fi

  DMG_NAME="Markon_${VERSION}_${ARCH}.dmg"
  DMG_PATH="$DMG_OUT/$DMG_NAME"

  echo "Creating $DMG_NAME ..."
  TMP_DIR=$(mktemp -d)
  cp -R "$APP" "$TMP_DIR/"
  ln -s /Applications "$TMP_DIR/Applications"

  hdiutil create \
      -volname "Markon" \
      -srcfolder "$TMP_DIR" \
      -ov \
      -format UDZO \
      -fs HFS+ \
      "$DMG_PATH"

  rm -rf "$TMP_DIR"
  echo "Done: $DMG_PATH"
done

open "$DMG_OUT"
