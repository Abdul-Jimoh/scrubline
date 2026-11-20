# Scrubline

Find and mask secrets and personal data in text before it is logged, shared or sent to an AI.

> **Status: early.** Built in the open during the Qodo "Build your software factory" hackathon (Nov–Dec 2026).
> Not published to npm yet. This README only describes what exists and is tested.

## Why

You paste a stack trace into a chat to get help, attach a log to a GitHub issue, or send a user's message to an LLM.
One copied line can carry a live API key, a customer's email or your home folder name. Scrubline replaces those
values with typed, numbered placeholders, so the text still makes sense to a reader or a model:

```text
in:  curl -H "Authorization: token ghp_…" … # contact jane.doe@example-corp.io
out: curl -H "Authorization: token [GITHUB_TOKEN_1]" … # contact [EMAIL_1]
```

The originals stay in a local map, so you can put them back into an AI's answer with `restore`.

## Try it

Requires Node.js 20 or later.

```sh
git clone https://github.com/Abdul-Jimoh/scrubline.git
cd scrubline
npm ci
npm run check   # typecheck + all tests
```

## Usage

```ts
import { scrub, restore } from 'scrubline';

const { text, findings, map } = scrub(logLine);
// text:     the masked text, safe to share
// findings: [{ kind, placeholder, start, end }]; offsets into the input, never the values, so safe to log
// map:      { '[EMAIL_1]': 'jane.doe@…' }; keep it local

const answer = await askModel(text);
console.log(restore(answer, map)); // placeholders in the model's answer become the originals again
```

- The same value always gets the same placeholder; distinct values of one kind are numbered `_1`, `_2`, ….
- If the input already contains placeholder-shaped text such as `[EMAIL_1]`, numbering skips it, so
  `restore(scrub(x).text, scrub(x).map)` returns `x` exactly.
- Zero runtime dependencies.

## What it detects today

| Kind | Format |
|---|---|
| `PRIVATE_KEY` | PEM and PGP private key blocks, including a truncated block with no end line |
| `JWT` | JSON Web Tokens (`eyJ….….…`) |
| `ANTHROPIC_KEY`, `OPENAI_KEY` | `sk-ant-…`, `sk-…` / `sk-proj-…` |
| `GITHUB_TOKEN`, `GITLAB_TOKEN` | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `glpat-` |
| `AWS_KEY` | access key IDs (`AKIA…`, `ASIA…`) |
| `GOOGLE_API_KEY`, `SLACK_TOKEN`, `STRIPE_KEY` | `AIza…`, `xox[abprs]-…`, `sk_live_`/`rk_live_`/`whsec_` |
| `NPM_TOKEN`, `HUGGINGFACE_TOKEN`, `SENDGRID_KEY`, `DIGITALOCEAN_TOKEN`, `TELEGRAM_BOT_TOKEN` | their published formats |
| `EMAIL` | email addresses (an SSH remote like `git@github.com:…` is kept) |

Not yet: labelled secrets (`password=…`), connection strings, phone and card numbers, IP addresses, home paths,
high-entropy strings, custom rules, streaming and the CLI. These are tracked as issues.

## How it is tested

| Claim | Proof |
|---|---|
| Each format above is masked with its typed placeholder | `test/scrub.test.ts` ("every built-in detector") |
| `restore(scrub(x)) === x` for any string | `test/properties.test.ts`: fast-check, arbitrary Unicode and generated documents |
| No planted secret survives | `test/properties.test.ts`: random documents of fake keys, emails and placeholder look-alikes |
| Findings never contain the values | `test/scrub.test.ts` and `test/properties.test.ts` |
| Scan time stays linear on crafted input | `test/performance.test.ts`: 200,000-character worst cases |

Every key in the tests is fake and is assembled at runtime, so the repository never holds a complete key-shaped string.

## Prior work

The detector patterns started from a redactor in an earlier tool by the same author, split into typed detectors and rebuilt around reversible masks.

## Licence

[MIT](LICENSE)
