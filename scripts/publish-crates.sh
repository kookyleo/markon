#!/usr/bin/env bash
# Publish markon-core and markon to crates.io, in order.
#
# Usage: scripts/publish-crates.sh
#
# Prerequisites:
#   - CARGO_REGISTRY_TOKEN set (or `cargo login` already done)
#   - Clean git working tree
#   - Version already bumped via scripts/bump-version.sh and committed
#
# Runs:
#   1. All quality gates (same as bump-version.sh)
#   2. cargo publish --dry-run for both crates
#   3. cargo publish -p markon-core (lib, must go first)
#   4. Wait for crates.io index propagation
#   5. cargo publish -p markon (bin, depends on markon-core from registry)
#
# Note: markon-gui is marked publish = false and is distributed via GitHub Release.

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Check clean git tree
if [ -n "$(git status --porcelain)" ]; then
  fail "Working tree not clean — commit or stash changes first"
fi

# Check that current commit's Cargo.toml matches a likely release state
VER=$(grep -m1 '^version = "' Cargo.toml | sed -E 's/version = "(.*)"/\1/')
step "Publishing markon-core@$VER and markon@$VER to crates.io"

# --- Quality gates (same as bump-version) ---
step "1/7  cargo fmt --check"
cargo fmt --check || fail "Formatting issues"

step "2/7  cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets --quiet -- -D warnings || fail "Clippy warnings"

step "3/7  cargo test"
cargo test --quiet || fail "Rust tests failed"

step "4/7  JS lint + tests"
npx eslint --max-warnings 0 'crates/core/assets/js/**/*.js' || fail "ESLint warnings"
npm test --silent || fail "JS tests failed"

# --- Dry runs ---
step "5/7  cargo publish --dry-run -p markon-core"
cargo publish --dry-run -p markon-core || fail "markon-core dry-run failed"

# --- Publish core ---
step "6/7  cargo publish -p markon-core"
cargo publish -p markon-core || fail "markon-core publish failed"

# Wait for crates.io index to propagate
step "    Waiting 30s for crates.io index to update…"
sleep 30

# --- Publish cli ---
step "7/7  cargo publish -p markon"
cargo publish -p markon || fail "markon publish failed"

printf '\n\033[1;32m✓ Published markon-core@%s and markon@%s\033[0m\n' "$VER" "$VER"
echo "Check: https://crates.io/crates/markon-core  https://crates.io/crates/markon"
