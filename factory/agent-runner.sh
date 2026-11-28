#!/bin/bash
# Scrubline's scheduled agent. Run by launchd every 15 minutes (factory/install-schedule.sh), or by hand.
#
# Each run takes at most one ticket: the oldest open issue labelled `ready-for-agent` and written by the repository
# owner (anyone can open an issue; only the owner's text is handed to the agent). It
#   1. claims it (label `agent-working`) and works in a fresh worktree from origin/main;
#   2. runs Claude Code headless on the ticket with AGENTS.md (factory/prompts/implement.md);
#   3. runs `npm run check` itself, and gives the agent the failure up to MAX_ATTEMPTS times;
#   4. pushes the branch and opens a PR with the ticket link and acceptance criteria;
#   5. waits for Qodo's review of the exact head commit, and if High or Medium findings are open (the quality gate in
#      AGENTS.md), gives them to the agent (factory/prompts/fix-review.md), checks again (with the same MAX_ATTEMPTS
#      retries) and pushes, up to MAX_REVIEW_ROUNDS times, stopping early if a finding survives a fix; Low findings
#      are listed for the human when it hands over;
#   6. stops with label `agent-needs-help` and a comment on the issue whenever a limit is hit or something fails,
#      except a Claude usage limit: then it puts the ticket back in the queue and pauses (USAGE_LIMIT_PAUSE).
# It never merges: the human does. Text the agent wrote is scrubbed with Scrubline before it is posted.
# One installation per repository: the lock is local, so two machines running this could claim the same ticket.
set -uo pipefail

REPO=${SCRUBLINE_REPO:-Abdul-Jimoh/scrubline}
OWNER=${REPO%%/*}
SRC=${SCRUBLINE_SRC:-$(cd "$(dirname "$0")/.." && pwd)}   # a clone of the repo (any branch checked out)
WORK=${SCRUBLINE_WORK:-$HOME/.scrubline-factory}          # worktrees and run logs, outside the repo
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}          # implement + check attempts
MAX_REVIEW_ROUNDS=${MAX_REVIEW_ROUNDS:-2} # fix rounds after Qodo findings
AGENT_TIMEOUT=${AGENT_TIMEOUT:-2400}     # seconds per agent session
REVIEW_TIMEOUT=${REVIEW_TIMEOUT:-1500}   # seconds to wait for a Qodo review of a commit
USAGE_LIMIT_PAUSE=${USAGE_LIMIT_PAUSE:-3600} # seconds to wait after a Claude usage limit before taking a ticket
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

# After a Claude usage limit, no ticket is taken until the pause ends: a run before then would hit the same limit.
PAUSE="$WORK/paused-until"
if [ -s "$PAUSE" ]; then
  until_s=$(cat "$PAUSE")
  case $until_s in '' | *[!0-9]*) rm -f "$PAUSE" ;; *) [ "$(date +%s)" -lt "$until_s" ] && exit 0 ;; esac
fi

# A ticket already claimed (working, or stopped for help) blocks the queue until a human clears it.
claimed=$(gh issue list -R "$REPO" --state open --label agent-working --json number --jq 'length') || exit 0
[ "$claimed" = 0 ] || exit 0
ISSUE=$(gh issue list -R "$REPO" --state open --label ready-for-agent --author "$OWNER" --limit 1000 --json number,createdAt \
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
  # In a review round, what the agent did with each finding (fixed, or disputed with evidence; AGENTS.md quality gate).
  [ "${ROUND:-0}" -gt 0 ] && [ -s "$RUN_DIR/report.md" ] &&
    detail+=$'\n\n**The agent\'s report:**\n\n'"$(tail -c 3000 "$RUN_DIR/report.md" | scrubbed)"
  if [ "$PUSHED" = yes ]; then where="Branch \`$BRANCH\`${PR_URL:+, PR $PR_URL}."
  else where="Nothing was pushed; the local work stays in the runner's worktree until the next run starts the ticket over."; fi
  comment "The scheduled agent stopped and needs a human: **$1**${detail}

Run \`$RUN_ID\`. $where Remove \`agent-needs-help\` and \`agent-working\` to release the queue; add \`ready-for-agent\` again to retry from scratch."
  gh issue edit "$ISSUE" -R "$REPO" --add-label agent-needs-help >/dev/null || log "could not label #$ISSUE"
  exit 1
}
trap 'needs_help "the run was interrupted"' INT TERM

# True when agent result $1 (and its stderr, $1.err) says the session hit a Claude usage or rate limit. A limit is not
# the ticket's fault and passes on its own, so it should not wait for a human. Anything not recognised here still
# stops for help, as before.
usage_limited() {
  jq -e '.is_error == true and ((.api_error_status // 0) == 429
    or ((.result // "") | test("usage limit|hit your limit|rate limit"; "i")))' "$1" >/dev/null 2>&1 ||
    grep -qiE 'usage limit|hit your limit|rate limit' "$1.err" 2>/dev/null
}

# Puts the ticket back in the queue after a usage limit and pauses the runner for USAGE_LIMIT_PAUSE seconds. A retry
# starts from main (see `push`), so the work of this run is redone, not continued.
requeue() {
  trap - INT TERM
  local until_s=$(($(date +%s) + USAGE_LIMIT_PAUSE)) where
  echo "$until_s" >"$PAUSE"
  log "PAUSE: Claude usage limit; back in the queue, next run after $(date -u -r "$until_s" +%FT%TZ 2>/dev/null || echo "$USAGE_LIMIT_PAUSE s")"
  if [ "$PUSHED" = yes ]; then where=" The branch and PR stay as they are until the retry replaces them${PR_URL:+ ($PR_URL)}."
  else where=" Nothing was pushed."; fi
  gh issue edit "$ISSUE" -R "$REPO" --remove-label agent-working --add-label ready-for-agent >/dev/null ||
    needs_help "the agent hit a Claude usage limit, and the ticket could not be put back in the queue"
  comment "The scheduled agent hit a Claude usage limit (run \`$RUN_ID\`) and put this ticket back in the queue. It starts over in about $((USAGE_LIMIT_PAUSE / 60)) minutes.$where"
  exit 0
}

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
# scrubbing it with a scrubber the agent cannot change. The agent does not commit: it stages its work and writes the
# message to commit-msg.txt, and the runner commits (`commit_staged`). In the first live run the agent's commits were
# denied by a too-narrow allow rule; allowing every `git commit` form instead would let flags such as `-n` skip the
# repository's commit hooks, which no deny pattern reliably blocks.
# Claude Code's default commit and PR attribution is turned off for the session: the repository's commit-msg hook
# refuses AI attribution, and in the third live run the default trailer made the runner's commit fail twice.
AGENT_SETTINGS='{"includeCoAuthoredBy":false,"attribution":{"commit":"","pr":""}}'
agent() {
  local prompt="$1" out="$2"
  [ -n "$prompt" ] || needs_help "empty prompt"
  log "agent: $(basename "$out")"
  (cd "$WT" && perl -e 'alarm shift; exec @ARGV' "$AGENT_TIMEOUT" \
    claude -p "$prompt" \
      --add-dir "$RUN_DIR" \
      --settings "$AGENT_SETTINGS" \
      --permission-mode acceptEdits \
      --allowedTools 'Read' 'Edit' 'Write' 'Grep' 'Glob' \
        'Bash(npm run check)' 'Bash(npm run typecheck)' 'Bash(npm test*)' 'Bash(npx vitest *)' 'Bash(npx tsc *)' \
        'Bash(git status*)' 'Bash(git diff*)' 'Bash(git log*)' 'Bash(git show*)' 'Bash(git add *)' \
        'Bash(gh issue view *)' 'Bash(ls *)' \
      --disallowedTools 'Bash(git push*)' 'Bash(git commit*)' 'Bash(git reset*)' 'Bash(git rebase*)' \
        'Bash(git checkout*)' 'Bash(gh pr *)' 'Bash(gh issue comment*)' 'Bash(gh issue edit*)' 'Bash(node *)' \
        'WebFetch' 'WebSearch' \
      --output-format json >"$out" 2>"$out.err")
  local rc=$? summary=""
  [ -s "$out" ] && summary=$(jq -r '"\(.num_turns) turns, \((.duration_ms // 0) / 1000 | floor) s"' "$out" 2>/dev/null)
  # 142 is SIGALRM: the session ran past AGENT_TIMEOUT.
  log "agent exit $rc (${summary:-no result}$([ "$rc" = 142 ] && echo ", timed out after $AGENT_TIMEOUT s"))"
  # A usage limit is waited out; any other failure may have left half-done work that still passes the checks: stop.
  [ "$rc" != 0 ] && [ "$rc" != 142 ] && usage_limited "$out" && requeue
  [ "$rc" = 0 ] || needs_help "the agent session ended with exit $rc$([ "$rc" = 142 ] && echo " (timed out)")"
}

# Commits what the agent staged, and only that, through the repository's commit hooks, with the agent's
# commit-msg.txt (or a default naming the ticket). A file the agent left unstaged is not swept in: it fails the
# clean-tree check below. Sets COMMITTED=yes when it made a commit.
COMMITTED=no
commit_staged() {
  COMMITTED=no
  git -C "$WT" diff --cached --quiet && return 0
  local msg="$RUN_DIR/commit-msg.txt"
  [ -s "$msg" ] || printf '%s (#%s)\n\nCommitted by the scheduled agent runner.\n' "$TITLE" "$ISSUE" >"$msg"
  # Git's own output (a commit hook's reason for refusing, say) goes to the check log the agent reads on a retry.
  if git -C "$WT" commit -q -F "$msg" >"$1" 2>&1; then
    COMMITTED=yes
    log "committed the agent's staged work"
  else
    log "the runner could not commit the staged work"
    return 1
  fi
}

# Undoes the runner's own commit when the checks then fail, keeping the work staged for the next attempt, so only
# commits that passed the checks ever reach the pull request.
uncommit() { [ "$COMMITTED" = yes ] && git -C "$WT" reset -q --soft HEAD~1 && COMMITTED=no; return 0; }

# True when the staged work is committed, `npm run check` passes on that commit, the tree is clean, and the branch has
# committed work. The check runs after the commit, so a commit hook that changes content cannot slip past it.
checks_pass() {
  local logf="$RUN_DIR/check-$1.log"
  commit_staged "$logf" || { echo "The runner could not commit the staged work; git's output is above." >>"$logf"; return 1; }
  (cd "$WT" && npm run check) >"$logf" 2>&1 || { log "check $1: npm run check failed"; tail -60 "$logf" >"$logf.tail"; mv "$logf.tail" "$logf"; uncommit; return 1; }
  [ -z "$(git -C "$WT" status --porcelain)" ] || { log "check $1: changes left unstaged or uncommitted"; echo "Changes not in the commit. Stage the ones that belong to the change with git add; scratch files belong in the run folder, not the worktree:" >>"$logf"; git -C "$WT" status --short >>"$logf"; uncommit; return 1; }
  [ -n "$(git -C "$WT" log --oneline origin/main..HEAD)" ] || { log "check $1: nothing committed"; echo "no commits on the branch" >>"$logf"; return 1; }
  rm -f "$RUN_DIR/commit-msg.txt"
  log "check $1: pass"
}

# Checks the staged work and, while that fails, gives the agent the failure (factory/prompts/fix-checks.md), up to
# MAX_ATTEMPTS attempts. Used after the implement step and after every review fix round, so a refused commit or a
# failing test in a review round gets the same retries as in the first one. $1 prefixes the check log names; $2 says
# where in the run the limit was hit.
checks_with_retries() {
  ATTEMPT=1
  until checks_pass "$1$ATTEMPT"; do
    [ -s "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"
    [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ] && needs_help "checks still failing after $MAX_ATTEMPTS attempts$2"
    PREV="$1$ATTEMPT"
    ATTEMPT=$((ATTEMPT + 1))
    run_agent fix-checks.md "$RUN_DIR/agent-fix-checks-$1$ATTEMPT.json"
  done
  [ -s "$RUN_DIR/blocker.md" ] && needs_help "the agent reported a blocker"
}

# Prints the Qodo review of commit $1 as JSON once it is complete; returns 1 on timeout.
wait_for_review() {
  local sha="$1" waited=0 nudged=0 out
  while [ "$waited" -lt "$REVIEW_TIMEOUT" ]; do
    out=$(qodo read pr-review-session findings --pr-url "$PR_URL" --extended --json 2>/dev/null) || out=""
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
# With a package.json saying "type": "module", so Node 20 (no module detection) loads the copy as ES modules.
mkdir -p "$SCRUBBER" && cp -R "$WT/dist/." "$SCRUBBER/" && printf '{ "type": "module" }\n' >"$SCRUBBER/package.json" ||
  needs_help "could not copy the scrubber"

# --- Implement, with a retry limit ------------------------------------------------------------------------------
ATTEMPT=1
run_agent implement.md "$RUN_DIR/agent-implement.json"
checks_with_retries "" ""
IMPLEMENT_ATTEMPTS=$ATTEMPT

# --- Open the PR (or reuse the one a stopped run left) ---------------------------------------------------------
push || needs_help "git push failed"
# The PR description: ticket, acceptance criteria and the agent's report, which review rounds add to.
write_pr_body() {
  {
    echo "Ticket: $ISSUE_URL (closes #$ISSUE)"
    echo
    echo "Opened by the scheduled agent (\`factory/agent-runner.sh\`, run \`$RUN_ID\`). \`npm run check\` passed on attempt $IMPLEMENT_ATTEMPTS of $MAX_ATTEMPTS. A human decides whether to merge."
    echo
    jq -r .body "$RUN_DIR/issue.json" | awk '/^## Acceptance criteria/{on=1; print; next} on && /^## /{exit} on'
    echo
    echo "## Agent's report"
    echo
    # A long report keeps its start (the acceptance criteria) and its end (the latest review round).
    if [ ! -s "$RUN_DIR/report.md" ]; then echo "_The agent wrote no report._"
    elif [ "$(wc -c <"$RUN_DIR/report.md")" -le 6000 ]; then scrubbed <"$RUN_DIR/report.md"
    else { head -c 3000 "$RUN_DIR/report.md"; printf '\n\n_[…]_\n\n'; tail -c 3000 "$RUN_DIR/report.md"; } | scrubbed; fi
  } >"$RUN_DIR/pr-body.md"
}
write_pr_body
PR_URL=$(gh pr list -R "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // empty')
if [ -n "$PR_URL" ]; then
  gh pr edit "$PR_URL" --body-file "$RUN_DIR/pr-body.md" >/dev/null || needs_help "could not update the PR description"
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
  # Open unless its status is one Qodo documents as closed (`qodo read pr-review-session findings --help`; a fixed
  # finding reads `implemented`), so a new or renamed status is never read as clean.
  open=$(jq -e '[(.findings // [])[] | select(.attribution_status | IN("implemented","full_implementation","dismissed","detected_after_merge","outdated") | not)]' \
    "$RUN_DIR/review-$ROUND.json") || needs_help "could not read Qodo's review of ${SHA:0:7}"
  # The quality gate (AGENTS.md): open High and Medium findings block, and so does any level not known here; Low
  # (`informational`) findings are listed for the human at hand-over and never block.
  blocking=$(printf '%s' "$open" | jq '[.[] | select(.action_level != "informational")]')
  count=$(printf '%s' "$blocking" | jq length)
  log "Qodo review of ${SHA:0:7}: $count open High or Medium finding(s), $(printf '%s' "$open" | jq 'map(select(.action_level == "informational")) | length') open Low"
  [ "$count" = 0 ] && break
  # A stall: a finding handed over last round is still open after the agent's fix.
  if [ "$ROUND" -gt 0 ]; then
    again=$(jq -rn --argjson now "$blocking" --slurpfile before "$RUN_DIR/findings-$ROUND.json" \
      '[$now[].id] - ([$now[].id] - [$before[0][].id]) | length')
    [ "$again" != 0 ] && needs_help "$again High or Medium finding(s) still open after the agent's fix in round $ROUND; see its report"
  fi
  [ "$ROUND" -ge "$MAX_ROUNDS" ] && needs_help "$count High or Medium finding(s) still open after $MAX_ROUNDS fix rounds"
  ROUND=$((ROUND + 1))
  printf '%s\n' "$blocking" >"$RUN_DIR/findings-$ROUND.json"
  run_agent fix-review.md "$RUN_DIR/agent-fix-review-$ROUND.json"
  checks_with_retries "review-$ROUND-" " in review fix round $ROUND"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$SHA" ] && needs_help "the agent changed nothing for $count open finding(s); see its report"
  push || needs_help "git push failed"
  write_pr_body
  gh pr edit "$PR_URL" --body-file "$RUN_DIR/pr-body.md" >/dev/null || needs_help "could not update the PR description"
done
# Low findings from every round, fixed or not (AGENTS.md quality gate). Rounds are read in order (a glob would put
# round 10 before round 2), and each finding shows its latest record, even if a later review gave it another level.
# Titles are Qodo's text, scrubbed like everything else posted.
reviews=()
for ((r = 0; r <= ROUND; r++)); do reviews+=("$RUN_DIR/review-$r.json"); done
low_list=$(jq -rs '[to_entries[] | .key as $round | (.value.findings // [])[] | . + {round: $round}]
    | group_by(.id) | map(select(any(.action_level == "informational")) | max_by(.round))[]
    | "- \(.title) (`\(.location.file_path // "?"):\(.location.start_line // "?")`, \(.action_level), \(.attribution_status))"' \
    "${reviews[@]}" | scrubbed)
[ -n "$low_list" ] || low_list="None."

# --- Hand over -------------------------------------------------------------------------------------------------
trap - INT TERM
# The hand-over carries the Low findings for the human, so it must arrive; only then is the claim released.
gh issue comment "$ISSUE" -R "$REPO" --body "The scheduled agent finished: $PR_URL is ready for a human. \`npm run check\` passes, and Qodo's review of \`${SHA:0:7}\` has no open High or Medium findings ($ROUND fix round(s)), so the quality gate in AGENTS.md is met. Run \`$RUN_ID\`.

**Low findings for you** (the agent leaves them to you; status in Qodo's latest review):
$low_list" >/dev/null || needs_help "$PR_URL is ready, but the hand-over comment (with the Low findings) could not be posted"
# If the label stayed, every later run would see a claimed ticket and wait: say so instead of finishing quietly.
gh issue edit "$ISSUE" -R "$REPO" --remove-label agent-working >/dev/null ||
  needs_help "$PR_URL is ready, but the agent-working label could not be removed"
log "done: $PR_URL"
