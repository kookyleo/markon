#!/usr/bin/env bash
#
# Copy graphviz-anywhere's runtime dylib into a macOS .app bundle and make the
# executable resolve it from Contents/Frameworks.
#
# Usage:
#   scripts/macos-bundle-graphviz.sh /path/to/Markon.app aarch64-apple-darwin
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP="${1:-}"
TARGET="${2:-}"

if [[ -z "$APP" || -z "$TARGET" ]]; then
  sed -n '2,9p' "$0" >&2
  exit 1
fi

if [[ ! -d "$APP/Contents/MacOS" ]]; then
  echo "Not a macOS app bundle: $APP" >&2
  exit 1
fi

BUILD_DIR="$REPO_ROOT/target/$TARGET/release/build"
DYLIB=$(
  find "$BUILD_DIR" \
    -path '*/graphviz-anywhere-*/out/graphviz-anywhere-prebuilt-v*/lib/libgraphviz_api.dylib' \
    -type f \
    -print 2>/dev/null \
  | sort \
  | tail -n 1
)

if [[ -z "$DYLIB" ]]; then
  echo "libgraphviz_api.dylib not found under $BUILD_DIR" >&2
  exit 1
fi

EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
BIN="$APP/Contents/MacOS/$EXECUTABLE"
FRAMEWORKS="$APP/Contents/Frameworks"
DEST="$FRAMEWORKS/libgraphviz_api.dylib"
RPATH='@executable_path/../Frameworks'
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

if [[ ! -x "$BIN" ]]; then
  echo "App executable not found: $BIN" >&2
  exit 1
fi

mkdir -p "$FRAMEWORKS"
ditto "$DYLIB" "$DEST"

if ! otool -l "$BIN" | grep -q "$RPATH"; then
  install_name_tool -add_rpath "$RPATH" "$BIN"
fi

codesign --force --sign "$SIGN_IDENTITY" "$DEST"
codesign --force --sign "$SIGN_IDENTITY" "$BIN"
codesign --force --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict "$APP"

echo "Bundled $(basename "$DEST") into $APP"
