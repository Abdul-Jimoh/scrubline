# Scrubline

Find and mask secrets and personal data in text before it is logged, shared or sent to an AI.

> **Status: early.** Built in the open during the Qodo "Build your software factory" hackathon (Nov–Dec 2026).
> Not published to npm yet. This README only describes what exists and is tested.

## Why

You paste a stack trace into a chat to get help, attach a log to a GitHub issue, or send a user's message to an LLM.
One copied line can carry a live API key, a customer's email or your home folder name. Scrubline replaces those
values with typed, numbered placeholders, so the text still makes sense to a reader or a model:

```text
in:  curl -H "Authorization: token ghp_…" … # contact jane.doe@example.com
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
| `URL_PASSWORD` | the password in a URL or connection string (`postgres://app:[URL_PASSWORD_1]@db:5432/prod`); scheme, user, host and path stay readable |
| `EMAIL` | email addresses (an SSH remote like `git@github.com:…` is kept) |

Keys are found at token boundaries: after whitespace, punctuation, `_` or quotes; after an escape (`\n`, `\t`,
`\uXXXX`), a URL-encoded byte (`%3D`, `%20`) or an ANSI colour code; and in Telegram's `…/bot<token>/…` URLs.
A complete private key block (BEGIN to END) is masked whatever its armour lines hold. A scrubbed JSON document
stays valid JSON: no mask starts inside an escape, and a mask that would start right after an escaping backslash
(`\n` + `pm_…`) takes the backslash with it. One exception is under Known limits.

Planned, not built yet, each an issue in the [backlog](https://github.com/Abdul-Jimoh/scrubline/issues): labelled
secrets (`password=…`), phone and card numbers, IP addresses, home paths, high-entropy strings, custom rules,
streaming and the CLI.

## Known limits

- A key glued to a letter or digit on either side (`xAKIA…`), other than in the cases above, is not treated as a key.
- A token that runs straight into a JWT (`xoxb-12-eyJ….….…`) is masked as the JWT, which takes priority; a prefix
  left too short for its own format (`xoxb-12-`) stays visible. Real tokens of these kinds contain no dots, so this
  needs an unusual paste.
- Values glued to each other with no separator, or to a stray `@` (`<jwt>a@b.co`, `a@b.co_c@d.co-@e.com`), can be
  split differently from what was meant, and a fragment such as `@b.co` or a second JWT's last two segments can stay
  visible.
- Any `git@…` address is kept, so a real mailbox named `git` is not masked. Addresses with `%` in the local part
  are masked only from after the last `%` (from after `%XX` when the `%` is followed by two hex digits); one whose
  local part ends in `%XX` (`jane%3D@…`) is not masked at all.
- URL-encoded addresses with no literal `@` (`?email=jane%40example.com`) are not detected.
- In plain text, a mask right after a lone backslash (`DOMAIN\jane@…`) includes the backslash, so that value gets
  its own placeholder, separate from the same address elsewhere, and `restore` puts the backslash back with it.
- A URL password holding a raw space, `"`, `<`, `>`, `` ` ``, `{`, `}`, `|`, a backslash (other than `\"` and `\\` in
  JSON) or a placeholder-shaped `[KIND_N]` is not masked. URL parsers require those characters to be
  percent-encoded (`%20`, `%22`), and an encoded password is masked.
- A URL's password runs to the last `@` before the host ends, as URL parsers read it. Text glued to the host by
  `,`, `;` or `=` with no space, and holding a later `@` (`…@db,jane@example.com`), is masked with the password,
  host included (over-masking, not a leak).
- `user:password@host` with no `scheme://` in front (`curl -u`, some config formats) is not detected.
- A private key block is masked from BEGIN to the next END line within 64 KB, even when the BEGIN belonged to a
  truncated paste and the END to a later block: everything in between is masked too (over-masking, not a leak).
- With no END line within 64 KB, a block is masked up to the first character a key block cannot hold, such as the
  quote that closes a JSON string.
- A block whose BEGIN sits in a JSON object key and whose END comes later breaks that JSON (the key material is
  still masked). Between two string values the JSON stays valid, but the fields in between are masked with it.

## How it is tested

`npm run check` runs the typecheck and all tests.

| Claim | Proof |
|---|---|
| Each format above is masked with its typed placeholder | `test/scrub.test.ts`: "every built-in detector" |
| The boundary cases above, JSON validity, and complete PGP/PEM blocks with armour lines (also in PHP-style `\/` JSON) | `test/scrub.test.ts`: "token boundaries", "private key blocks" |
| `restore(scrub(x)) === x` for any string | `test/properties.test.ts`: fast-check on arbitrary Unicode and on generated documents |
| In generated documents (fake keys of every format, armoured key blocks, emails, URLs with passwords, placeholder look-alikes; separated by whitespace, punctuation, escapes, control characters, ANSI codes and URL-encoded bytes), no planted value survives, as plain text or JSON-encoded, and the JSON stays valid | `test/properties.test.ts` |
| URL passwords: any scheme, only the password masked, encoded and `@`-holding passwords, no-password and path/query look-alikes kept, JSON (also slash-escaped) stays valid, a key as the password keeps its type, and the limits above | `test/scrub.test.ts`: "passwords in URLs" |
| Findings never contain the values | `test/scrub.test.ts`, `test/properties.test.ts` |
| Scan time stays linear: sixteen crafted 200,000-character inputs and a 4 MB input with 160,000 findings | `test/performance.test.ts` (1.5 s budget; 5–20 ms and 140–200 ms on an M-series laptop) |
| A 12 MB key block with no END line is masked rather than throwing | `test/performance.test.ts`: "very large input" |

Every key in the tests is fake and is assembled at runtime, so the repository never holds a complete key-shaped string.

## Prior work

The detector patterns, and most of the fake test values and keep-cases, started from a redactor in an earlier tool by the same author.
Here they are split into typed detectors with explicit token boundaries and rebuilt around reversible masks.

## Licence

[MIT](LICENSE)
