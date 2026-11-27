#!/bin/sh
# Compiles src/ as it is at <commit> into <out-dir>/dist, without touching the worktree.
# Usage: build-at.sh <commit> <out-dir>   (<out-dir> must be empty; make it with mktemp -d)
# Prints only the dist directory to pass to check.mjs as --lib.
set -eu
if [ $# -ne 2 ]; then
  echo "usage: build-at.sh <commit> <out-dir>" >&2
  exit 2
fi
commit=$1
out=$2
repo=$(git rev-parse --show-toplevel)
git -C "$repo" rev-parse --verify --quiet "$commit^{commit}" >/dev/null || {
  echo "build-at.sh: unknown commit $commit" >&2
  exit 2
}
if [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
  echo "build-at.sh: $out is not empty" >&2
  exit 2
fi
mkdir -p "$out"
git -C "$repo" archive "$commit" package.json src tsconfig.json tsconfig.build.json | tar -x -C "$out"
ln -s "$repo/node_modules" "$out/node_modules"
# Compiler output goes to stderr, so stdout is only the dist path; a failed build exits non-zero.
"$repo/node_modules/.bin/tsc" -p "$out/tsconfig.build.json" >&2
echo "$out/dist"
