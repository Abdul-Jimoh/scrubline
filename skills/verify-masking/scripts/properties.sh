#!/bin/sh
# Runs the property tests with more runs than the suite's 500, then puts the run count back, also on failure.
# Usage: sh properties.sh [runs]   (default 20000; run from the repository root)
# Exits with vitest's status; exits 3 if test/properties.test.ts could not be put back.
set -u
runs=${1:-20000}
file=test/properties.test.ts
case $runs in '' | *[!0-9]*) echo "properties.sh: runs must be a number" >&2; exit 2 ;; esac
git diff --quiet -- "$file" || { echo "properties.sh: $file has uncommitted changes; stopping" >&2; exit 2; }
grep -q 'const runs = { numRuns: 500 }' "$file" || { echo "properties.sh: run count line not found in $file" >&2; exit 2; }

# Stop before touching the file unless the backup is a full copy (found by Qodo in the review of PR #32).
backup=$(mktemp) || { echo "properties.sh: mktemp failed" >&2; exit 2; }
if ! cp "$file" "$backup" || ! cmp -s "$file" "$backup"; then
  echo "properties.sh: could not back up $file; stopping" >&2
  rm -f "$backup"
  exit 2
fi
restore() {
  [ -f "$backup" ] && cp "$backup" "$file" && rm -f "$backup"
}
trap restore EXIT INT TERM
sed 's/const runs = { numRuns: 500 }/const runs = { numRuns: Number(process.env.RUNS) }/' "$backup" > "$file"

RUNS=$runs ./node_modules/.bin/vitest run "$file" --testTimeout=900000
status=$?
restore
trap - EXIT INT TERM
if git diff --quiet -- "$file"; then
  echo "properties.sh: $runs runs each, exit $status; run count restored"
else
  echo "properties.sh: $file was not restored" >&2
  exit 3
fi
exit $status
