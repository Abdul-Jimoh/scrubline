---
name: verify-masking
description: Verify a Scrubline detector change end to end on concrete inputs. Checks that no part of a value stays visible, that restore is exact, that a stream cut at every position matches scrub, and that JSON stays valid. Also checks that the inputs fail on the commit before the change, and runs the full suite and the property tests at 20,000 runs. Use it after adding or changing a detector, before asking for a push, or when a report says a value leaks.
---

# Verify a masking change

Scrubline's promise is that a value never stays visible, and that `restore(scrub(x))` gives `x` back exactly. A stream
must also give the same text and map as `scrub()` of the whole text. Unit tests pass on the inputs someone thought
of. This procedure checks a change on the inputs that matter for it, and shows those inputs fail without the change.
It changes no code. Its result is a report.

## Inputs

Ask for any of these that are missing, and don't guess them:

1. **The change:** the commit range to verify, as `<base>..<head>`. For a branch, `head` is `HEAD` and `base` is
   `git merge-base HEAD origin/main`. For a merged change, `base` is the first parent of the merge.
2. **Cases:** one or more inputs that the change is meant to fix or protect, and for each one the exact values that
   must not survive. Take them from the issue or PR. If the issue gives an expected scrubbed output, include it as
   `expect`.

## Stop and ask when

- There is no input, or no value that must stay hidden. A check with no secret only proves restore and streams.
- A value looks like a real credential or a real person's data. Use fakes only (AGENTS.md rule 2). Write a key-shaped
  fake as parts (`["AKIA", "..."]`) so no key-shaped literal lands in a file.
- The issue doesn't say what the output should be, and two readings would both mask the value. Ask which one is meant.
- `node_modules` is missing and `npm ci` fails, or a build fails.
- A `fix` case passes on the base commit. It doesn't show the change, so ask for a case that does, or for an OK to
  relabel it `guard`. Don't drop it silently. A `guard` case passing on the base is expected, not a reason to stop.

## Steps

Run every command from the repository root. Keep `SKILL_DIR=skills/verify-masking`.

1. **Record the state.** Run `git rev-parse --short HEAD`, `git status --short` and `node --version`. If `src/` or
   `test/` have uncommitted changes, say that the head build includes them.
2. **Write the cases** to a file outside the repository: `CASES=$(mktemp -d)/cases.json`. Use this format:
   ```json
   { "cases": [ { "name": "issue #30: drive letter, address in path", "kind": "fix",
                  "input": ["file://C:/Users/bob/Mail/jane", "@", "corp.com.eml"],
                  "secrets": ["bob", ["jane", "@", "corp.com.eml"]] } ] }
   ```
   Give each case a `kind`: `fix` for an input the change is meant to fix (it must fail on the base), or `guard` for
   behaviour that must not change (it may pass on both). Decide the kind from the issue before running anything.
   Include the plain form, and each form the change claims to cover: JSON, JSON inside JSON, escaped, other case.
3. **Check the head.** Run `npm run build`, then `node $SKILL_DIR/scripts/check.mjs --lib dist --cases $CASES`.
   Expect every case to print `PASS`. A `FAIL` line names the check and the visible text: stop and report it.
4. **Check the base (fail first).** Run `BASE_OUT=$(mktemp -d)`, then
   `LIB=$(sh $SKILL_DIR/scripts/build-at.sh <base> $BASE_OUT)`, and check that it exited 0; then
   `node $SKILL_DIR/scripts/check.mjs --lib $LIB --cases $CASES --base`. With `--base`, the summary counts `fix` cases
   that pass on the base as `unshown`. Expect `unshown: 0`: each `fix` case fails, and each `guard` case may pass.
5. **Run the suite.** Run `npm run check`. Record the number of tests passed. Every test must pass.
6. **Run the property tests at 20,000 runs**, as one command: `sh $SKILL_DIR/scripts/properties.sh 20000`. Run it
   alone, not chained with `&&` or `;`, and with no variable set before it. It sets the run count, runs the
   properties, puts the count back (also on failure or interrupt), and prints `run count restored`. It refuses to start
   if `test/properties.test.ts` has uncommitted changes. It takes a few minutes. A failure prints a `Counterexample`:
   record it whole, and check on the base before calling it new. If the command can't run (for example, it needs an
   approval this session can't give), report step 6 as not run and the result as **not verified**.
7. **Check scan time when a pattern changed.** If `git diff <base>..<head> -- src/` adds or changes a regex with an
   unbounded repeat (`*`, `+`, `{n,}`), find the crafted input for it in `test/performance.test.ts`. Run
   `npx vitest run test/performance.test.ts`. If no crafted input covers the new repeat, report that as a gap.
8. **Save the evidence** to `docs/evidence-raw/verify-masking/<YYYY-MM-DD>-<head>.md`. That path is ignored by git.
   Include the commands, the cases file, both `check.mjs` outputs, the test counts and the property result.

## Expected result

| Check | Head | Base |
|---|---|---|
| `check.mjs` on each case | `PASS` | each `fix` case `FAIL`s (`unshown: []`); a `guard` case may pass |
| `npm run check` | all tests pass | not run |
| Property tests, 20,000 runs | 13 passed, run count restored | only to triage a failure |
| Crafted input for a changed repeat | present and within budget | not run |

Report as **verified** only when every row matches. Otherwise report **not verified**, with the failing row and its
output. Don't fix code inside this procedure. Report the failure, and leave the fix to a separate task.

## Never

- Commit, push, or edit `src/` or `test/` as part of this check. Step 6 edits only the run count, and step 6 puts it
  back.
- Put real secrets in a cases file, the report, or a terminal command.
- Treat a passing `npm run check` alone as proof: the cases and the fail-first run are the point.
