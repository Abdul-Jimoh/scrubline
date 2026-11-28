#!/bin/bash
# Runs factory/agent-runner.sh end to end against stubs, to check what it does when Claude hits a usage limit.
# Usage: bash factory/tests/usage-limit.sh   (needs git, jq and perl; touches no real issue, PR or remote)
#
# The stubs live in a temporary HOME's .qodo/bin, which the runner puts first on its PATH: `gh` answers with one
# ticket (#7) and logs every call, `claude` prints the result JSON a case sets and exits 1, and `npm` builds a tiny
# scrubber. The "remote" is a bare repository in the same temporary folder.
set -u
RUNNER="$(cd "$(dirname "$0")/.." && pwd)/agent-runner.sh"
T=$(mktemp -d) || exit 2
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@localhost GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@localhost
BIN="$HOME/.qodo/bin"
mkdir -p "$BIN"

cat >"$BIN/gh" <<'EOF'
#!/bin/bash
echo "gh $*" >>"$T_LOG"
case "$*" in
  *"--label agent-working"*) echo 0 ;;
  *"--label ready-for-agent"*) echo 7 ;;
  "issue view"*) echo '{"title":"A ticket","body":"## Acceptance criteria\n- [ ] x","url":"https://example.invalid/7","author":{"login":"me"}}' ;;
esac
exit 0
EOF
cat >"$BIN/claude" <<'EOF'
#!/bin/bash
cat "$T_RESULT"
echo "$T_STDERR" >&2
exit 1
EOF
cat >"$BIN/npm" <<'EOF'
#!/bin/bash
[ "$1 $2" = "run build" ] && mkdir -p dist && echo 'export const scrub = (t) => ({ text: t });' >dist/index.js
exit 0
EOF
chmod +x "$BIN"/*

# A source clone whose origin has a main branch.
git init -q --bare "$T/origin.git"
git init -q -b main "$T/src"
echo '{}' >"$T/src/package.json"
git -C "$T/src" add package.json && git -C "$T/src" commit -q -m init
git -C "$T/src" remote add origin "$T/origin.git" && git -C "$T/src" push -q origin main

fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# Runs the runner once with result JSON $1 and stderr text $2. Sets RC; the gh calls are in $T_LOG.
run() {
  export T_LOG="$T/gh.log" T_RESULT="$T/result.json" T_STDERR="$2"
  : >"$T_LOG"
  printf '%s' "$1" >"$T_RESULT"
  SCRUBLINE_REPO=me/repo SCRUBLINE_SRC="$T/src" SCRUBLINE_WORK="$T/work" bash "$RUNNER" 2>"$T/runner.err"
  RC=$?
}
PAUSE="$T/work/paused-until"

echo "# a usage limit in the result text"
run '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1764432000"}' ''
check "exits 0" '[ "$RC" = 0 ]'
check "puts the ticket back in the queue" 'grep -q "issue edit 7 -R me/repo --remove-label agent-working --add-label ready-for-agent" "$T_LOG"'
check "does not ask for help" '! grep -q agent-needs-help "$T_LOG"'
check "says so on the ticket" 'grep -q "issue comment 7 .*usage limit" "$T_LOG"'
check "pauses for about an hour" '[ -s "$PAUSE" ] && d=$(( $(cat "$PAUSE") - $(date +%s) )) && [ "$d" -gt 3500 ] && [ "$d" -le 3600 ]'

echo "# the next run, during the pause"
run '{"type":"result","is_error":true,"result":"x"}' ''
check "exits 0 without calling gh" '[ "$RC" = 0 ] && [ ! -s "$T_LOG" ]'

echo "# a 429 status, with other wording, after the pause"
echo $(($(date +%s) - 1)) >"$PAUSE"
run '{"type":"result","is_error":true,"api_error_status":429,"result":"API Error: 429"}' ''
check "runs again once the pause is over, and requeues" '[ "$RC" = 0 ] && grep -q "add-label ready-for-agent" "$T_LOG"'

echo "# a limit reported only on stderr"
rm -f "$PAUSE"
run '' "You've hit your limit · resets 5pm"
check "requeues" '[ "$RC" = 0 ] && grep -q "add-label ready-for-agent" "$T_LOG"'

echo "# any other failure"
rm -f "$PAUSE"
run '{"type":"result","is_error":true,"result":"something else broke"}' ''
check "stops for help, as before" '[ "$RC" = 1 ] && grep -q "add-label agent-needs-help" "$T_LOG"'
check "does not requeue or pause" '! grep -q "add-label ready-for-agent" "$T_LOG" && [ ! -e "$PAUSE" ]'

echo "# a pause file that is not a time"
echo garbage >"$PAUSE"
run '{"type":"result","is_error":true,"result":"something else broke"}' ''
check "is ignored and removed" '[ "$RC" = 1 ] && [ ! -e "$PAUSE" ]'

[ "$fails" = 0 ] && echo "all passed" || echo "$fails failed"
exit $((fails > 0))
