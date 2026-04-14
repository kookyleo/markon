#!/usr/bin/env bash
# Bump project version atomically + enforce quality gates.
#
# Usage: scripts/bump-version.sh 0.10.0
#
# Runs (in order):
#   Pre-flight quality gates (all must pass with zero warnings):
#     - cargo fmt --check
#     - cargo clippy --all-targets -- -D warnings
#     - cargo test
#     - npx eslint 'crates/core/assets/js/**/*.js'
#     - npm test
#   Then bumps:
#     - Cargo.toml: workspace.package.version (primary source of truth)
#     - Cargo.toml: workspace.dependencies.markon-core.version (MAJOR.MINOR range)
#     - Cargo.lock: via cargo check
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

MINOR=$(echo "$NEW" | cut -d. -f1-2)

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "1/6  cargo fmt --check"
cargo fmt --check || fail "Formatting issues — run 'cargo fmt' first"

step "2/6  cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets --quiet -- -D warnings || fail "Clippy warnings must be resolved"

step "3/6  cargo test"
cargo test --quiet || fail "Rust tests failed"

step "4/6  JS lint"
npx eslint --max-warnings 0 'crates/core/assets/js/**/*.js' || fail "ESLint warnings must be resolved"

step "5/6  JS tests"
npm test --silent || fail "JS tests failed"

step "6/6  Bumping version to $NEW"
sed -i.bak -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW\"/" Cargo.toml
sed -i.bak -E "s/(markon-core = \{ path = \"crates\/core\", version = )\"[0-9]+(\.[0-9]+)?\"/\1\"$MINOR\"/" Cargo.toml
rm -f Cargo.toml.bak

cargo check --quiet

printf '\n\033[1;32m✓ Bumped to %s (dep requirement: %s)\033[0m\n' "$NEW" "$MINOR"
grep -E "^version|markon-core" Cargo.toml | head -3
echo
echo "Next: git add -A && git commit -m 'chore: bump to $NEW' && git push"
