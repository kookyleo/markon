#!/usr/bin/env bash
# Publish one workspace crate, treating "this version is already on crates.io"
# as success and everything else as failure.
#
# The release pipeline is dispatched by hand and re-run after partial failures,
# and a crate is sometimes published outside it, so meeting a version that is
# already up is routine and must not fail the release.
#
# This replaces a `cargo search` + version-compare fallback that was supposed
# to tolerate the same case and did not: promote run 35894717815 failed on
# `markon-core@0.15.23 already exists on crates.io index`, with the comparison
# swallowed by `grep -q` so the logs did not even say which half went wrong.
# Matching cargo's own message needs no second network call and nothing to
# parse.
#
#   scripts/publish-crate.sh <crate> [extra cargo publish args...]

set -uo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <crate> [cargo publish args...]" >&2
  exit 2
fi

crate=$1
shift

out=$(cargo publish -p "$crate" "$@" 2>&1)
code=$?
printf '%s\n' "$out"

if [ "$code" -eq 0 ]; then
  exit 0
fi

# Both spellings cargo has used for an already-published version.
if printf '%s' "$out" | grep -qE 'already exists on crates\.io|already uploaded'; then
  echo "$crate: this version is already on crates.io — treating as published"
  exit 0
fi

exit "$code"
