#!/bin/bash
# Scrubline's scheduled agent. Run by launchd every 15 minutes (factory/install-schedule.sh), or by hand.
#
# Each run takes at most one ticket: the oldest open issue labelled `ready-for-agent` and written by the repository
# owner (anyone can open an issue; only the owner's text is handed to the agent). It
#   1. claims it (label `agent-working`) and works in a fresh worktree from origin/main;
#   2. runs Claude Code headless on the ticket with AGENTS.md (factory/prompts/implement.md);
#   3. runs `npm run check` itself, and gives the agent the failure up to MAX_ATTEMPTS times;
#   4. pushes the branch and opens a PR with the ticket link and acceptance criteria;
#   5. waits for Qodo's review of the exact head commit, and if findings are open, gives them to the agent
#      (factory/prompts/fix-review.md), checks again and pushes, up to MAX_REVIEW_ROUNDS times;
#   6. stops with label `agent-needs-help` and a comment on the issue whenever a limit is hit or something fails.
# It never merges: the human does. Text the agent wrote is scrubbed with Scrubline before it is posted.
set -uo pipefail

REPO=${SCRUBLINE_REPO:-Abdul-Jimoh/scrubline}
OWNER=${REPO%%/*}
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
# One run at a time. The lock holds this run's pid; a lock whose process is gone (power loss, kill -9) is taken over.
LOCK="$WORK/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then exit 0; fi
  # A lock with no pid yet is only stale once it is over a minute old.
  if [ -z "$holder" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then exit 0; fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# A ticket already claimed (working, or stopped for help) blocks the queue until a human clears it.
claimed=$(gh issue list -R "$REPO" --state open --label agent-working --json number --jq 'length') || exit 0
[ "$claimed" = 0 ] || exit 0
ISSUE=$(gh issue list -R "$REPO" --state open --label ready-for-agent --author "$OWNER" --json number,createdAt \
  --jq 'sort_by(.createdAt) | .[0].number // empty') || exit 0
[ -n "$ISSUE" ] || exit 0

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-issue-$ISSUE"
RUN_DIR="$WORK/runs/$RUN_ID"
BRANCH="agent/issue-$ISSUE"
WT="$WORK/worktrees/issue-$ISSUE"
PR_URL=""
PUSHED=no
mkdir -p "$RUN_DIR"
# Log lines go to the run log and stderr, never stdout, so they cannot mix into a captured value.
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$RUN_DIR/run.log" >&2; }

# Text the agent wrote (on stdin), masked with Scrubline itself before it reaches a public comment or PR body. The
# scrubber is a copy built from origin/main before the agent starts, outside every folder the agent can write.
SCRUBBER="$WORK/scrubber/$RUN_ID"
trap 'rm -rf "$LOCK" "$SCRUBBER"' EXIT
scrubbed() {
  SCRUBBER_DIST="$SCRUBBER" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const { scrub } = await import(process.env.SCRUBBER_DIST + "/index.js");
    process.stdout.write(scrub(readFileSync(0, "utf8")).text);' 2>/dev/null ||
    echo "_(not shown: it could not be scrubbed)_"
}

comment() { gh issue comment "$ISSUE" -R "$REPO" --body "$1" >/dev/null || log "could not comment on #$ISSUE"; }

needs_help() {
  trap - INT TERM
  log "STOP: $1"
  local detail="" where
  [ -s "$RUN_DIR/blocker.md" ] && detail=$'\n\n**What the agent wrote:**\n\n'"$(head -c 3000 "$RUN_DIR/blocker.md" | scrubbed)"
  if [ "$PUSHED" = yes ]; then where="Branch \`$BRANCH\`${PR_URL:+, PR $PR_URL}."
  else where="Nothing was pushed; the local work stays in the runner's worktree until the next run starts the ticket over."; fi
  comment "The scheduled agent stopped and needs a human: **$1**${detail}

Run \`$RUN_ID\`. $where Remove \`agent-needs-help\` and \`agent-working\` to release the queue; add \`ready-for-agent\` again to retry from scratch."
  gh issue edit "$ISSUE" -R "$REPO" --add-label agent-needs-help >/dev/null || log "could not label #$ISSUE"
  exit 1
}
trap 'needs_help "the run was interrupted"' INT TERM

# Fills {{NAME}} in a prompt template from the shell variables of the same name; fails on a missing or empty template.
render() {
  local text
  [ -s "$1" ] || return 1
  text=$(cat "$1")
  for name in ISSUE BRANCH RUN_DIR ATTEMPT MAX_ATTEMPTS PREV PR_URL SHA ROUND MAX_ROUNDS; do
    text=${text//\{\{$name\}\}/${!name:-}}
  done
  printf '%s' "$text"
}

# Renders template $1 and runs the agent on it, writing its result to $2. A missing template stops the run rather
# than sending the agent an empty prompt.
run_agent() {
  local prompt
  prompt=$(render "$PROMPTS/$1") || needs_help "prompt template $1 is missing"
  agent "$prompt" "$2"
}

# Runs Claude Code headless in the worktree with the rendered prompt. Settings hooks still apply (no --bare).
# The tool list keeps the agent to editing, the project's checks and local git; it cannot run node, push, or touch
# issues and PRs. `npm run check`, `npm test` and vitest run code the agent can edit, so this limits mistakes, not a
# determined agent: the ticket text must be the owner's, and the runner posts nothing the agent wrote without
# scrubbing it with a scrubber the agent cannot change.
agent() {
  local prompt="$1" out="$2"
  [ -n "$prompt" ] || needs_help "empty prompt"
  log "agent: $(basename "$out")"
  (cd "$WT" && perl -e 'alarm shift; exec @ARGV' "$AGENT_TIMEOUT" \
    claude -p "$prompt" \
      --add-dir "$RUN_DIR" \
      --permission-mode acceptEdits \
      --allowedTools 'Read' 'Edit' 'Write' 'Grep' 'Glob' \
        'Bash(npm run check)' 'Bash(npm run typecheck)' 'Bash(npm test*)' 'Bash(npx vitest *)' 'Bash(npx tsc *)' \
        'Bash(git status*)' 'Bash(git diff*)' 'Bash(git log*)' 'Bash(git show*)' 'Bash(git add *)' \
        'Bash(git commit -m *)' 'Bash(gh issue view *)' 'Bash(ls *)' \
      --disallowedTools 'Bash(git push*)' 'Bash(git commit --amend*)' 'Bash(git commit * --amend*)' 'Bash(git reset*)' 'Bash(git rebase*)' \
        'Bash(git checkout*)' 'Bash(gh pr *)' 'Bash(gh issue comment*)' 'Bash(gh issue edit*)' 'Bash(node *)' \
        'WebFetch' 'WebSearch' \
      --output-format json >"$out" 2>"$out.err")
  local rc=$? summary=""
  [ -s "$out" ] && summary=$(jq -r '"\(.num_turns) turns, \((.duration_ms // 0) / 1000 | floor) s"' "$out" 2>/dev/null)
  # 142 is SIGALRM: the session ran past AGENT_TIMEOUT.
  log "agent exit $rc (${summary:-no result}$([ "$rc" = 142 ] && echo ", timed out after $AGENT_TIMEOUT s"))"
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
    if [ -n "$out" ] && printf '%s' "$out" | jq -e --arg sha "$sha" \
      '.review_session.commit_sha == $sha and .review_session.status == "completed" and (.qar_operation_result_truncated != true)' >/dev/null 2>&1; then
      printf '%s' "$out"
      return 0
    fi
    # Qodo reviews new commits on its own; ask once if it has not finished after five minutes.
    if [ "$waited" -ge 300 ] && [ "$nudged" = 0 ]; then
      gh pr comment "$PR_URL" --body '/agentic_review' >/dev/null && log "asked Qodo to review $sha"
      nudged=1
    fi
    sleep 60
    waited=$((waited + 60))
  done
  return 1
}

# The agent/ branch belongs to the runner: a retry starts from main and replaces what a stopped run pushed.
push() { git -C "$WT" push -q --force -u origin "$BRANCH" && PUSHED=yes; }

# --- Claim the ticket ------------------------------------------------------------------------------------------
log "picked issue #$ISSUE"
gh issue edit "$ISSUE" -R "$REPO" --remove-label ready-for-agent --add-label agent-working >/dev/null ||
  { log "could not claim #$ISSUE"; exit 1; }
comment "Picked up by the scheduled agent (run \`$RUN_ID\`), on branch \`$BRANCH\`. Limits: $MAX_ATTEMPTS attempts to pass the checks, $MAX_REVIEW_ROUNDS rounds of review fixes."
gh issue view "$ISSUE" -R "$REPO" --json title,body,url,author >"$RUN_DIR/issue.json" || needs_help "could not read the ticket"
[ "$(jq -r .author.login "$RUN_DIR/issue.json")" = "$OWNER" ] || needs_help "the ticket is not written by the repository owner"
TITLE=$(jq -r .title "$RUN_DIR/issue.json")
ISSUE_URL=$(jq -r .url "$RUN_DIR/issue.json")

git -C "$SRC" fetch -q origin main || needs_help "git fetch failed"
git -C "$SRC" worktree remove --force "$WT" 2>/dev/null
git -C "$SRC" worktree add -q -B "$BRANCH" "$WT" origin/main || needs_help "could not create the worktree"
(cd "$WT" && npm ci --silent && npm run build --silent) >"$RUN_DIR/npm-ci.log" 2>&1 || needs_help "npm ci or the build failed"
mkdir -p "$SCRUBBER" && cp -R "$WT/dist/." "$SCRUBBER/" || needs_help "could not copy the scrubber"

# --- Implement, with a retry limit ------------------------------------------------------------------------------
ATTEMPT=1
run_agent implement.md "$RUN_DIR/agent-implement.json"
until checks_pass "$ATTEMPT"; do
  [ -s "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"
  [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ] && needs_help "checks still failing after $MAX_ATTEMPTS attempts"
  PREV=$ATTEMPT
  ATTEMPT=$((ATTEMPT + 1))
  run_agent fix-checks.md "$RUN_DIR/agent-fix-checks-$ATTEMPT.json"
done
[ -s "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"

# --- Open the PR (or reuse the one a stopped run left) ---------------------------------------------------------
push || needs_help "git push failed"
{
  echo "Ticket: $ISSUE_URL (closes #$ISSUE)"
  echo
  echo "Opened by the scheduled agent (\`factory/agent-runner.sh\`, run \`$RUN_ID\`). \`npm run check\` passed on attempt $ATTEMPT of $MAX_ATTEMPTS. A human decides whether to merge."
  echo
  jq -r .body "$RUN_DIR/issue.json" | awk '/^## Acceptance criteria/{on=1; print; next} on && /^## /{exit} on'
  echo
  echo "## Agent's report"
  echo
  if [ -s "$RUN_DIR/report.md" ]; then head -c 6000 "$RUN_DIR/report.md" | scrubbed; else echo "_The agent wrote no report._"; fi
} >"$RUN_DIR/pr-body.md"
PR_URL=$(gh pr list -R "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // empty')
if [ -n "$PR_URL" ]; then
  gh pr edit "$PR_URL" --body-file "$RUN_DIR/pr-body.md" >/dev/null || log "could not update $PR_URL"
else
  PR_URL=$(gh pr create -R "$REPO" --base main --head "$BRANCH" --title "$TITLE (#$ISSUE)" --body-file "$RUN_DIR/pr-body.md") ||
    needs_help "gh pr create failed"
fi
log "PR $PR_URL"

# --- Review loop -----------------------------------------------------------------------------------------------
MAX_ROUNDS=$MAX_REVIEW_ROUNDS
ROUND=0
while :; do
  SHA=$(git -C "$WT" rev-parse HEAD)
  review=$(wait_for_review "$SHA") || needs_help "no completed Qodo review of ${SHA:0:7} after $((REVIEW_TIMEOUT / 60)) minutes"
  printf '%s' "$review" >"$RUN_DIR/review-$ROUND.json"
  open=$(jq -e '[(.findings // [])[] | select(.attribution_status | IN("pending","partial_implementation","not_implemented","focus_areas_edited"))]' \
    "$RUN_DIR/review-$ROUND.json") || needs_help "could not read Qodo's review of ${SHA:0:7}"
  count=$(printf '%s' "$open" | jq length)
  log "Qodo review of ${SHA:0:7}: $count open finding(s)"
  [ "$count" = 0 ] && break
  [ "$ROUND" -ge "$MAX_ROUNDS" ] && needs_help "$count Qodo finding(s) still open after $MAX_ROUNDS fix rounds"
  ROUND=$((ROUND + 1))
  printf '%s\n' "$open" >"$RUN_DIR/findings-$ROUND.json"
  run_agent fix-review.md "$RUN_DIR/agent-fix-review-$ROUND.json"
  checks_pass "review-$ROUND" || needs_help "checks failed after review fix round $ROUND"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] && needs_help "the agent changed nothing for $count open finding(s); see its report"
  push || needs_help "git push failed"
done

# --- Hand over -------------------------------------------------------------------------------------------------
trap - INT TERM
gh issue edit "$ISSUE" -R "$REPO" --remove-label agent-working >/dev/null || log "could not unlabel #$ISSUE"
comment "The scheduled agent finished: $PR_URL is ready for a human. \`npm run check\` passes, and Qodo's review of \`${SHA:0:7}\` has no open findings ($ROUND fix round(s)). Run \`$RUN_ID\`."
log "done: $PR_URL"
