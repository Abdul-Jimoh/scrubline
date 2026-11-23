# AGENTS.md

Instructions for coding agents and reviewers working on Scrubline.

## What this project is

Scrubline is a zero-dependency TypeScript library that finds secrets and personal data in text (API keys, tokens,
private key blocks, emails) and replaces them with typed, numbered masks such as `[AWS_KEY_1]`. `restore(text, map)`
puts the originals back from a map that stays on the user's machine.

People run it on logs, stack traces and pastes before sharing them or sending them to an AI, so the input is
untrusted. A missed secret is a leak that cannot be taken back.

- `src/detectors.ts`: the detectors, in priority order (first listed wins an overlap).
- `src/scrub.ts`: collects spans, assigns placeholders, builds the result; `restore`.
- `src/stream.ts`: `scrubStream` and `StreamScrubber`: chunked input with the same result as `scrub` of the whole.
- `src/cli.ts`: the `scrubline` command (stdin or a file to stdout, the map file, `restore`).
- `test/scrub.test.ts`: examples and regressions. `test/properties.test.ts`: fast-check properties on generated
  documents. `test/performance.test.ts`: crafted inputs that must scan in linear time. `test/cli.test.ts`: builds
  `dist/` and runs the command as a child process. `test/stream.test.ts`: chunk boundaries, stream limits and
  memory.
- `test/fixtures.ts`: one fake sample per detector (`FAKE`), assembled at runtime with `j()`.
- `factory/`: the scheduled agent. `agent-runner.sh` takes the oldest open issue labelled `ready-for-agent`, runs a
  headless coding agent on it with the prompts in `factory/prompts/`, checks, opens a PR, and works through Qodo's
  findings within fixed retry limits; `install-schedule.sh` runs it every 15 minutes with launchd (macOS).

## Setup and checks

Node.js 20 or later.

```sh
npm ci            # install exact pinned dev dependencies (TypeScript, Vitest, fast-check, @types/node)
npm run check     # typecheck + all tests; must pass before a PR
npm run build     # emit dist/ (only needed to try the package by hand)
```

A change is not done until `npm run check` passes. A bug fix comes with a test that fails on the code before the fix.

## Project rules

### 1. A speed trade-off names the case it gives up, and that case gets a test

**Applies to:** `src/detectors.ts` and `src/scrub.ts`: any guard, bound, length limit or skip added to keep scanning
fast or to avoid false positives.

**Do:** in a comment next to the trade-off, name the input it stops masking (for example "a JWT right after `_`").
Add a test for that input: either it is masked, or it is listed under README "Known limits" and the test pins the
behaviour.

**Why:** the JWT start guard was widened so that `eyJ-eyJ-…` could not make the scan quadratic. Nobody wrote down
that it also stopped masking `jwt_eyJ…`. Qodo found the leak in the review of PR #1.

### 2. No complete key-shaped string in the repository

**Applies to:** every file: tests, fixtures, docs, README examples, commit messages and PR descriptions.

**Do:** build fake credentials from parts at runtime (`j('ghp_', '…')`, as in `test/fixtures.ts`). In prose, cut
the value short (`ghp_…`). Never paste a real key, even a revoked one.

**Why:** secret scanners and GitHub push protection flag key-shaped strings whether or not they are live, and a
secret-masking library must not ship one.

### 3. Findings, errors and logs never carry the matched value

**Applies to:** `src/scrub.ts` (the `Finding` type), and any future CLI output, error message, debug log or
exception thrown while scanning.

**Do:** report only the kind, placeholder and offsets. The original value goes only into the `map` returned to the
caller.

**Why:** callers log findings and errors as a matter of course; a value in either one is the leak this library
exists to stop.

### 4. A new or changed detector is covered in four places

**Applies to:** adding or changing an entry in `DETECTORS` (`src/detectors.ts`).

**Do:** in the same PR,
1. add or update its fake sample in `FAKE` (`test/fixtures.ts`);
2. add its format to the `planted` generator in `test/properties.test.ts`, with the separators it can appear next to;
3. add a crafted input to `test/performance.test.ts` if it has a repeating or unbounded part;
4. add or update its row in the README table.

**Why:** the property test only finds leaks in shapes the generator produces. Leaving `_` and `-` out of the
separators hid three leaks until Day 1's review.

### 5. The README states only what a test proves

**Applies to:** `README.md`, especially "What it detects today", "Known limits" and "How it is tested".

**Do:** each claim maps to a test named in "How it is tested". Anything planned goes under "Planned, not built yet".
A known gap goes under "Known limits" instead of being left out.

**Why:** an independent check before the first push found README claims the tests did not support. People choose a
security tool by its README.

## Constraints

- No runtime dependencies. Dev dependencies are pinned to exact versions.
- Scanning must stay linear in the input size. Avoid regexes that can backtrack across a long run from many starts.
- `restore(scrub(x).text, scrub(x).map) === x` for every string `x`.
