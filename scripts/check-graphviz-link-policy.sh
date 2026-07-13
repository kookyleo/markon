#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

targets=(
  .github/workflows/release.yml
  crates/gui/build.rs
  crates/gui/tauri.macos.conf.json
  scripts/build-dmg.sh
  scripts/dev-gui.sh
)

legacy_pattern='libgraphviz_api\.(dylib|so|dll)|tauri-macos-frameworks|GRAPHVIZ_ANYWHERE_DIR|graphviz_lib_dir|LD_LIBRARY_PATH=.*graphviz|@executable_path/\.\./Frameworks'

if rg -n --ignore-case "$legacy_pattern" "${targets[@]}"; then
  echo "Legacy Graphviz dynamic-runtime wiring is not allowed" >&2
  exit 1
fi

version="$({
  awk '
    $0 == "name = \"graphviz-anywhere\"" { found = 1; next }
    found && /^version = / { gsub(/"/, "", $3); print $3; exit }
  ' Cargo.lock
} || true)"

if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Unable to resolve graphviz-anywhere version from Cargo.lock" >&2
  exit 1
fi

major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
if (( major == 0 && (minor < 2 || (minor == 2 && patch < 5)) )); then
  echo "graphviz-anywhere $version predates the static-link release" >&2
  exit 1
fi

echo "Graphviz link policy: static-only ($version)"
