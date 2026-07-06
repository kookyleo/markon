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
#   1. Frontend build (npm ci && npm run build)
#   2. All quality gates (scripts/quality-gate.sh, same as bump-version.sh)
#   3. cargo publish --dry-run -p markon-core
#   4. cargo publish -p markon-core (lib, must go first)
#   5. Wait for crates.io index propagation
#   6. cargo publish -p markon (bin, depends on markon-core from registry)
#
# Note: markon-gui is marked publish = false and is distributed via GitHub Release.

set -euo pipefail

cd "$(dirname "$0")/.."
export GRAPHVIZ_ANYWHERE_ALLOW_DOWNLOAD="${GRAPHVIZ_ANYWHERE_ALLOW_DOWNLOAD:-1}"

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Check clean git tree
if [ -n "$(git status --porcelain)" ]; then
  fail "Working tree not clean — commit or stash changes first"
fi

# Read the workspace version for the step banner
VER=$(grep -m1 '^version = "' Cargo.toml | sed -E 's/version = "(.*)"/\1/')
step "Publishing markon-core@$VER and markon@$VER to crates.io"

# Build the frontend bundle BEFORE any cargo compile. markon-core's build.rs
# and rust_embed require assets/dist/ (gitignored), so clippy/test/package all
# fail without it. This is also what `include` in crates/core/Cargo.toml ships
# into the published tarball.
step "npm ci && npm run build"
npm ci || fail "npm ci failed"
npm run build || fail "frontend build failed"

# --- Quality gates (shared with bump-version.sh and .githooks/pre-push) ---
scripts/quality-gate.sh || fail "Quality gates failed"

# --- Dry run ---
# --allow-dirty is intentional here: npm run build creates gitignored
# assets/dist files that are explicitly included in the markon-core package.
# The tracked tree was already required clean before that build step.
step "cargo publish --dry-run -p markon-core"
cargo publish --dry-run -p markon-core --allow-dirty || fail "markon-core dry-run failed"

# --- Publish core ---
step "cargo publish -p markon-core"
cargo publish -p markon-core --allow-dirty || fail "markon-core publish failed"

# Wait for crates.io index to propagate
step "Waiting 30s for crates.io index to update…"
sleep 30

# --- Publish cli ---
step "cargo publish -p markon"
cargo publish -p markon || fail "markon publish failed"

printf '\n\033[1;32m✓ Published markon-core@%s and markon@%s\033[0m\n' "$VER" "$VER"
echo "Check: https://crates.io/crates/markon-core  https://crates.io/crates/markon"
