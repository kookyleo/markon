#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUI_DIR="$REPO_ROOT/crates/gui"
OUT_DIR="$REPO_ROOT/target/release/bundle"

cd "$GUI_DIR"

echo "Building .app (release)..."
APPLE_SIGNING_IDENTITY="-" cargo tauri build --bundles app

APP="$OUT_DIR/macos/Markon.app"
if [[ ! -d "$APP" ]]; then
    echo "Markon.app not found after build." >&2
    exit 1
fi

# Read version from tauri.conf.json
VERSION=$(python3 -c "import json,sys; print(json.load(open('tauri.conf.json'))['version'])")
ARCH=$(uname -m)  # arm64 / x86_64
DMG_NAME="Markon_${VERSION}_${ARCH}.dmg"
DMG_PATH="$OUT_DIR/dmg/$DMG_NAME"
mkdir -p "$OUT_DIR/dmg"

echo "Creating DMG..."
# Build a writable image, add app + Applications symlink, convert to compressed read-only
TMP_DIR=$(mktemp -d)
cp -r "$APP" "$TMP_DIR/"
ln -s /Applications "$TMP_DIR/Applications"

hdiutil create \
    -volname "Markon" \
    -srcfolder "$TMP_DIR" \
    -ov \
    -format UDZO \
    -fs HFS+ \
    "$DMG_PATH"

rm -rf "$TMP_DIR"

echo ""
echo "Done: $DMG_PATH"
open "$(dirname "$DMG_PATH")"
