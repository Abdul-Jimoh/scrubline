#!/bin/bash
# Scrubline's scheduled agent. Run by launchd every 15 minutes (factory/install-schedule.sh), or by hand.
#
# Each run takes at most one ticket: the oldest open issue labelled `ready-for-agent`. It
#   1. claims it (label `agent-working`) and works in a fresh worktree from origin/main;
#   2. runs Claude Code headless on the ticket with AGENTS.md (factory/prompts/implement.md);
#   3. runs `npm run check` itself, and gives the agent the failure up to MAX_ATTEMPTS times;
#   4. pushes the branch and opens a PR with the ticket link and acceptance criteria;
#   5. waits for Qodo's review of the exact head commit, and if findings are open, gives them to the agent
#      (factory/prompts/fix-review.md), checks again and pushes, up to MAX_REVIEW_ROUNDS times;
#   6. stops with label `agent-needs-help` and a comment on the issue whenever a limit is hit.
# It never merges: the human does.
set -uo pipefail

REPO=${SCRUBLINE_REPO:-Abdul-Jimoh/scrubline}
SRC=${SCRUBLINE_SRC:-$(cd "$(dirname "$0")/.." && pwd)}   # a clone of the repo (any branch checked out)
WORK=${SCRUBLINE_WORK:-$HOME/.scrubline-factory}          # worktrees and run logs, outside the repo
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}          # implement + check attempts
MAX_REVIEW_ROUNDS=${MAX_REVIEW_ROUNDS:-2} # fix rounds after Qodo findings
AGENT_TIMEOUT=${AGENT_TIMEOUT:-2400}     # seconds per agent session
REVIEW_TIMEOUT=${REVIEW_TIMEOUT:-1500}   # seconds to wait for a Qodo review of a commit
PROMPTS="$(cd "$(dirname "$0")" && pwd)/prompts"

# launchd starts with a bare PATH.
export PATH="$HOME/.qodo/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$WORK/runs"
# One run at a time.
if ! mkdir "$WORK/lock" 2>/dev/null; then exit 0; fi
trap 'rmdir "$WORK/lock"' EXIT

# A ticket already claimed (working, or stopped for help) blocks the queue until a human clears it.
claimed=$(gh issue list -R "$REPO" --state open --label agent-working --json number --jq 'length')
[ "$claimed" = 0 ] || exit 0
ISSUE=$(gh issue list -R "$REPO" --state open --label ready-for-agent --json number,createdAt \
  --jq 'sort_by(.createdAt) | .[0].number // empty')
[ -n "$ISSUE" ] || exit 0

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-issue-$ISSUE"
RUN_DIR="$WORK/runs/$RUN_ID"
BRANCH="agent/issue-$ISSUE"
WT="$WORK/worktrees/issue-$ISSUE"
mkdir -p "$RUN_DIR"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN_DIR/run.log"; }

comment() { gh issue comment "$ISSUE" -R "$REPO" --body "$1" >/dev/null; }

needs_help() {
  log "STOP: $1"
  local detail=""
  [ -f "$RUN_DIR/blocker.md" ] && detail=$'\n\n**What the agent wrote:**\n\n'"$(head -c 3000 "$RUN_DIR/blocker.md")"
  comment "The scheduled agent stopped and needs a human: **$1**${detail}

Run \`$RUN_ID\`. Branch \`$BRANCH\`${PR_URL:+, PR $PR_URL}. Remove \`agent-needs-help\` and \`agent-working\` to release the queue."
  gh issue edit "$ISSUE" -R "$REPO" --add-label agent-needs-help >/dev/null
  exit 1
}

# Fills {{NAME}} in a prompt template from the shell variables of the same name.
render() {
  local text
  text=$(cat "$1")
  for name in ISSUE BRANCH RUN_DIR ATTEMPT MAX_ATTEMPTS PREV PR_URL SHA ROUND MAX_ROUNDS; do
    text=${text//\{\{$name\}\}/${!name:-}}
  done
  printf '%s' "$text"
}

# Runs Claude Code headless in the worktree with the rendered prompt. Settings hooks still apply (no --bare).
agent() {
  local prompt="$1" out="$2"
  log "agent: $(basename "$out")"
  (cd "$WT" && perl -e 'alarm shift; exec @ARGV' "$AGENT_TIMEOUT" \
    claude -p "$prompt" \
      --permission-mode acceptEdits \
      --allowedTools 'Read' 'Edit' 'Write' 'Grep' 'Glob' \
        'Bash(npm run *)' 'Bash(npm ci)' 'Bash(npx vitest *)' 'Bash(npx tsc *)' 'Bash(node *)' \
        'Bash(git status*)' 'Bash(git diff*)' 'Bash(git log*)' 'Bash(git show*)' 'Bash(git add *)' 'Bash(git commit *)' \
        'Bash(gh issue view *)' 'Bash(ls *)' 'Bash(cat *)' \
      --disallowedTools 'Bash(git push*)' 'Bash(gh pr *)' 'Bash(gh issue comment*)' 'Bash(gh issue edit*)' \
      --output-format json >"$out" 2>"$out.err")
  log "agent exit $? ($(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${r.num_turns} turns, ${Math.round(r.duration_ms/1000)} s`)}catch{console.log("no result")}' "$out"))"
}

# True when `npm run check` passes and the branch has committed work and a clean tree.
checks_pass() {
  local logf="$RUN_DIR/check-$1.log"
  (cd "$WT" && npm run check) >"$logf" 2>&1 || { log "check $1: npm run check failed"; tail -60 "$logf" >"$logf.tail"; mv "$logf.tail" "$logf"; return 1; }
  [ -z "$(git -C "$WT" status --porcelain)" ] || { log "check $1: uncommitted changes"; echo "uncommitted changes:" >>"$logf"; git -C "$WT" status --short >>"$logf"; return 1; }
  [ -n "$(git -C "$WT" log --oneline origin/main..HEAD)" ] || { log "check $1: nothing committed"; echo "no commits on the branch" >>"$logf"; return 1; }
  log "check $1: pass"
}

# Prints the Qodo review of commit $1 as JSON once it is complete; returns 1 on timeout.
wait_for_review() {
  local sha="$1" waited=0 nudged=0 out
  while [ "$waited" -lt "$REVIEW_TIMEOUT" ]; do
    out=$(qodo read pr-review-session findings --pr-url "$PR_URL" --extended 2>/dev/null) || out=""
    if [ -n "$out" ] && echo "$out" | jq -e --arg sha "$sha" \
      '.review_session.commit_sha == $sha and .review_session.status == "completed" and (.qar_operation_result_truncated != true)' >/dev/null 2>&1; then
      printf '%s' "$out"
      return 0
    fi
    # Qodo reviews new commits on its own; ask once if it has not started after five minutes.
    if [ "$waited" -ge 300 ] && [ "$nudged" = 0 ]; then
      gh pr comment "$PR_URL" --body '/agentic_review' >/dev/null && log "asked Qodo to review $sha"
      nudged=1
    fi
    sleep 60
    waited=$((waited + 60))
  done
  return 1
}

open_findings() { jq '[.findings[] | select(.attribution_status | IN("pending","partial_implementation","not_implemented","focus_areas_edited"))]'; }

# --- Claim the ticket ------------------------------------------------------------------------------------------
log "picked issue #$ISSUE"
gh issue edit "$ISSUE" -R "$REPO" --remove-label ready-for-agent --add-label agent-working >/dev/null
comment "Picked up by the scheduled agent (run \`$RUN_ID\`), on branch \`$BRANCH\`. Limits: $MAX_ATTEMPTS attempts to pass the checks, $MAX_REVIEW_ROUNDS rounds of review fixes."
gh issue view "$ISSUE" -R "$REPO" --json title,body,url >"$RUN_DIR/issue.json"
TITLE=$(jq -r .title "$RUN_DIR/issue.json")
ISSUE_URL=$(jq -r .url "$RUN_DIR/issue.json")

git -C "$SRC" fetch -q origin main || needs_help "git fetch failed"
git -C "$SRC" worktree remove --force "$WT" 2>/dev/null
git -C "$SRC" worktree add -q -B "$BRANCH" "$WT" origin/main || needs_help "could not create the worktree"
(cd "$WT" && npm ci --silent) >"$RUN_DIR/npm-ci.log" 2>&1 || needs_help "npm ci failed"

# --- Implement, with a retry limit ------------------------------------------------------------------------------
ATTEMPT=1
agent "$(render "$PROMPTS/implement.md")" "$RUN_DIR/agent-implement.json"
until checks_pass "$ATTEMPT"; do
  [ -f "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"
  [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ] && needs_help "checks still failing after $MAX_ATTEMPTS attempts"
  PREV=$ATTEMPT
  ATTEMPT=$((ATTEMPT + 1))
  agent "$(render "$PROMPTS/fix-checks.md")" "$RUN_DIR/agent-fix-checks-$ATTEMPT.json"
done
[ -f "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"

# --- Open the PR -----------------------------------------------------------------------------------------------
git -C "$WT" push -q -u origin "$BRANCH" || needs_help "git push failed"
{
  echo "Ticket: $ISSUE_URL (closes #$ISSUE)"
  echo
  echo "Opened by the scheduled agent (\`factory/agent-runner.sh\`, run \`$RUN_ID\`). \`npm run check\` passed on attempt $ATTEMPT of $MAX_ATTEMPTS. A human decides whether to merge."
  echo
  jq -r .body "$RUN_DIR/issue.json" | awk '/^## Acceptance criteria/{on=1} on'
  echo
  echo "## Agent's report"
  echo
  if [ -f "$RUN_DIR/report.md" ]; then head -c 6000 "$RUN_DIR/report.md"; else echo "_The agent wrote no report._"; fi
} >"$RUN_DIR/pr-body.md"
PR_URL=$(gh pr create -R "$REPO" --base main --head "$BRANCH" --title "$TITLE (#$ISSUE)" --body-file "$RUN_DIR/pr-body.md") ||
  needs_help "gh pr create failed"
log "opened $PR_URL"

# --- Review loop -----------------------------------------------------------------------------------------------
MAX_ROUNDS=$MAX_REVIEW_ROUNDS
ROUND=0
while :; do
  SHA=$(git -C "$WT" rev-parse HEAD)
  review=$(wait_for_review "$SHA") || needs_help "no completed Qodo review of $SHA after $((REVIEW_TIMEOUT / 60)) minutes"
  echo "$review" >"$RUN_DIR/review-$ROUND.json"
  open=$(echo "$review" | open_findings)
  count=$(echo "$open" | jq length)
  log "Qodo review of $SHA: $count open finding(s)"
  [ "$count" = 0 ] && break
  [ "$ROUND" -ge "$MAX_ROUNDS" ] && needs_help "$count Qodo finding(s) still open after $MAX_ROUNDS fix rounds"
  ROUND=$((ROUND + 1))
  echo "$open" >"$RUN_DIR/findings-$ROUND.json"
  agent "$(render "$PROMPTS/fix-review.md")" "$RUN_DIR/agent-fix-review-$ROUND.json"
  checks_pass "review-$ROUND" || needs_help "checks failed after review fix round $ROUND"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] && needs_help "the agent changed nothing for $count open finding(s); see its report"
  git -C "$WT" push -q origin "$BRANCH" || needs_help "git push failed"
done

# --- Hand over -------------------------------------------------------------------------------------------------
gh issue edit "$ISSUE" -R "$REPO" --remove-label agent-working >/dev/null
comment "The scheduled agent finished: $PR_URL is ready for a human. \`npm run check\` passes, and Qodo's review of \`${SHA:0:7}\` has no open findings ($ROUND fix round(s)). Run \`$RUN_ID\`."
log "done: $PR_URL"
