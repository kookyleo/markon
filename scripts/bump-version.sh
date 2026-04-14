#!/usr/bin/env bash
# Bump project version atomically across all version fields.
#
# Usage: scripts/bump-version.sh 0.10.0
#
# Updates:
#   - Cargo.toml: workspace.package.version (primary source of truth)
#   - Cargo.toml: workspace.dependencies.markon-core.version (minor-only range)
#   - Cargo.lock: via cargo check
#
# The minor-range dep version tracks "MAJOR.MINOR" (e.g. 0.10) so patch bumps
# don't require touching two places — only minor/major bumps do.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>  (e.g. 0.10.0)" >&2
  exit 1
fi

NEW="$1"
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in MAJOR.MINOR.PATCH format" >&2
  exit 1
fi

# Extract MAJOR.MINOR for the dep requirement
MINOR=$(echo "$NEW" | cut -d. -f1-2)

cd "$(dirname "$0")/.."

# 1. workspace.package.version
sed -i.bak -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW\"/" Cargo.toml

# 2. workspace.dependencies.markon-core version
sed -i.bak -E "s/(markon-core = \{ path = \"crates\/core\", version = )\"[0-9]+(\.[0-9]+)?\"/\1\"$MINOR\"/" Cargo.toml

rm -f Cargo.toml.bak

# 3. Refresh Cargo.lock
cargo check --quiet

echo "Bumped to $NEW (dep requirement: $MINOR)"
grep -E "^version|markon-core" Cargo.toml | head -3
