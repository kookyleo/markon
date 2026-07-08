#!/usr/bin/env bash
#
# Prepare graphviz-anywhere's runtime dylib at a stable path so Tauri can bundle
# it through bundle.macOS.frameworks.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

TARGET="${TAURI_ENV_TARGET_TRIPLE:-}"
if [[ -z "$TARGET" ]]; then
  TARGET="$(rustc -vV | awk '/^host:/ { print $2 }')"
fi

case "$TARGET" in
  *-apple-darwin) ;;
  *) exit 0 ;;
esac

BUILD_DIRS=()
for dir in "$REPO_ROOT/target/$TARGET/release/build" "$REPO_ROOT/target/release/build"; do
  if [[ -d "$dir" ]]; then
    BUILD_DIRS+=("$dir")
  fi
done

if [[ "${#BUILD_DIRS[@]}" -eq 0 ]]; then
  echo "No release build directories found for graphviz-anywhere" >&2
  exit 1
fi

DYLIBS=()
while IFS= read -r -d '' output; do
  while IFS= read -r line; do
    case "$line" in
      cargo:rustc-link-search=native=*)
        lib_dir="${line#cargo:rustc-link-search=native=}"
        dylib="$lib_dir/libgraphviz_api.dylib"
        if [[ -f "$dylib" ]]; then
          DYLIBS+=("$dylib")
        fi
        ;;
    esac
  done < "$output"
done < <(find "${BUILD_DIRS[@]}" -path '*/graphviz-anywhere-*/output' -type f -print0 2>/dev/null)

if [[ "${#DYLIBS[@]}" -eq 0 ]]; then
  while IFS= read -r -d '' dylib; do
    DYLIBS+=("$dylib")
  done < <(
    find "${BUILD_DIRS[@]}" \
      -path '*/graphviz-anywhere-*/out/graphviz-anywhere-prebuilt-v*/lib/libgraphviz_api.dylib' \
      -type f \
      -print0 2>/dev/null
  )
fi

if [[ "${#DYLIBS[@]}" -eq 0 ]]; then
  echo "libgraphviz_api.dylib not found in Cargo release build output" >&2
  exit 1
fi

DYLIB=$(
  for dylib in "${DYLIBS[@]}"; do
    stat -f '%m %N' "$dylib"
  done | sort -nr | head -n 1 | sed -E 's/^[0-9]+ //'
)

DEST_DIR="$REPO_ROOT/target/tauri-macos-frameworks"
DEST="$DEST_DIR/libgraphviz_api.dylib"

mkdir -p "$DEST_DIR"
ditto "$DYLIB" "$DEST"

echo "Prepared libgraphviz_api.dylib for macOS bundle: $DEST"
