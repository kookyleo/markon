#!/usr/bin/env bash
# Bump project version atomically + enforce quality gates.
#
# Usage: scripts/bump-version.sh 0.10.0
#
# Runs (in order):
#   Pre-flight checks:
#     - Cargo.toml / Cargo.lock have no pending edits (no half-finished bump)
#   Quality gates (all must pass with zero warnings):
#     - cargo fmt --check
#     - cargo clippy --all-targets -- -D warnings
#     - cargo test
#     - npx eslint 'crates/core/assets/js/**/*.js'
#     - npm test
#   Version edit:
#     - Cargo.toml: workspace.package.version (primary source of truth)
#     - Cargo.toml: workspace.dependencies.markon-core.version (MAJOR.MINOR range)
#     - Cargo.lock: via cargo check
#   Commit + push:
#     - Stage ONLY Cargo.toml + Cargo.lock (never `-A`, which would sweep up
#       untracked build artefacts like crates/gui/gen/schemas/*)
#     - Commit as "chore: bump to $NEW"
#     - Push so the bump is guaranteed to be the top commit at push time —
#       .github/workflows/auto-rc.yml keys off this push to tag `vX.Y.Z-rc.N`
#       and trigger the release workflow. If the bump commit weren't HEAD,
#       the release pipeline would silently skip.
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

step "0/7  Pre-flight checks"
if ! git diff --quiet HEAD -- Cargo.toml Cargo.lock; then
  fail "Cargo.toml or Cargo.lock has uncommitted edits — commit or stash first"
fi
if ! git diff --cached --quiet -- Cargo.toml Cargo.lock; then
  fail "Cargo.toml or Cargo.lock is staged — unstage or commit first"
fi

step "1/7  cargo fmt --check"
cargo fmt --check || fail "Formatting issues — run 'cargo fmt' first"

step "2/7  cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets --quiet -- -D warnings || fail "Clippy warnings must be resolved"

step "3/7  cargo test"
cargo test --quiet || fail "Rust tests failed"

step "4/7  JS lint"
npx eslint --max-warnings 0 'crates/core/assets/js/**/*.js' || fail "ESLint warnings must be resolved"

step "5/7  JS tests"
npm test --silent || fail "JS tests failed"

step "6/7  Bumping version to $NEW"
sed -i.bak -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW\"/" Cargo.toml
sed -i.bak -E "s/(markon-core = \{ path = \"crates\/core\", version = )\"[0-9]+(\.[0-9]+)?\"/\1\"$MINOR\"/" Cargo.toml
rm -f Cargo.toml.bak

cargo check --quiet

# Sanity: only Cargo.toml and Cargo.lock should have changed relative to HEAD.
changed=$(git diff --name-only HEAD | sort -u)
expected=$(printf 'Cargo.lock\nCargo.toml\n')
if [ "$changed" != "$expected" ]; then
  printf '\033[1;31m✗ Unexpected tracked-file changes after bump:\033[0m\n%s\n' "$changed" >&2
  fail "Refusing to commit — expected only Cargo.toml + Cargo.lock"
fi

step "7/7  Commit and push"
git add Cargo.toml Cargo.lock
git commit -m "chore: bump to $NEW"

# Push so the bump commit is HEAD on origin/main — auto-rc.yml keys off
# this to create `vX.Y.Z-rc.N` and trigger release.yml.
git push

printf '\n\033[1;32m✓ Bumped to %s (dep requirement: %s), pushed to origin\033[0m\n' "$NEW" "$MINOR"
grep -E "^version|markon-core" Cargo.toml | head -3
echo
echo "Auto RC should now tag v${NEW}-rc.1 and kick off the release workflow."
echo "Watch: gh run list --workflow=auto-rc.yml --limit 3"
