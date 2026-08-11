#!/usr/bin/env bash
# Canonical quality gate: the same checks CI runs, in one local command.
# Run it before opening a pull request (see README.md).
#
# Gates, cheapest-first so the common failures surface fastest:
#   Rust  (skipped if cargo absent):  fmt --check · clippy all-features -D warnings · test
#   TS/JS (skipped if npm absent):    npm run lint · vitest
#
# Each toolchain is guarded so minimal/CI images without it aren't blocked.
#
# Run `npm run build` first if assets/dist/ is missing or stale — markon-core's
# build.rs embeds it, so cargo compiles against whatever bundle is on disk.
# Packaging itself is not checked here; CI's Package job owns that.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

if command -v cargo >/dev/null 2>&1; then
  step "cargo fmt --check"
  cargo fmt --check || fail "Formatting issues — run 'cargo fmt' first"

  step "Graphviz static-link policy"
  scripts/check-graphviz-link-policy.sh || fail "Legacy Graphviz runtime wiring found"

  step "cargo clippy --all-targets --all-features -- -D warnings"
  cargo clippy --all-targets --all-features --quiet -- -D warnings || fail "Clippy warnings must be resolved"

  step "cargo test"
  cargo test --quiet || fail "Rust tests failed"
fi

if command -v npm >/dev/null 2>&1; then
  step "npm run lint"
  npm run lint --silent || fail "TypeScript lint failed — run 'npm run lint'"

  step "JS tests"
  npm test --silent || fail "JS tests failed"
fi
