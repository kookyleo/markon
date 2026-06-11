#!/usr/bin/env bash
# Canonical quality gate, shared by scripts/bump-version.sh,
# scripts/publish-crates.sh and .githooks/pre-push.
#
# Gates, cheapest-first so the common failures surface fastest:
#   Rust  (skipped if cargo absent):  fmt --check · clippy -D warnings · test
#   TS/JS (skipped if npx absent):    tsc --noEmit · vitest
#
# Each toolchain is guarded so minimal/CI images without it aren't blocked.
# Callers own the release-only steps: npm ci / npm run build (which must run
# BEFORE any cargo compile — markon-core's build.rs embeds assets/dist/) and
# the cargo publish dry-run.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

if command -v cargo >/dev/null 2>&1; then
  step "cargo fmt --check"
  cargo fmt --check || fail "Formatting issues — run 'cargo fmt' first"

  step "cargo clippy --all-targets -- -D warnings"
  cargo clippy --all-targets --quiet -- -D warnings || fail "Clippy warnings must be resolved"

  step "cargo test"
  cargo test --quiet || fail "Rust tests failed"
fi

if command -v npx >/dev/null 2>&1; then
  step "tsc --noEmit"
  npx tsc --noEmit || fail "TypeScript typecheck failed — run 'npm run typecheck'"

  step "JS tests"
  npm test --silent || fail "JS tests failed"
fi
