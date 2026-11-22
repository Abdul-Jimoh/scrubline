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

### From code

```ts
import { scrub, restore } from 'scrubline';

const { text, findings, map } = scrub(logLine);
// text:     the masked text, safe to share
// findings: [{ kind, placeholder, start, end }]; offsets into the input, never the values, so safe to log
// map:      { '[EMAIL_1]': 'jane.doe@…' }; keep it local

const answer = await askModel(text);
console.log(restore(answer, map)); // placeholders in the model's answer become the originals again
```

### From a shell

```sh
npm run build   # until the package is published; builds dist/cli.js
# mask the clipboard before pasting it into a chat, then put the originals back into the answer
pbpaste | node dist/cli.js --map ~/.scrubline/map.json | pbcopy
pbpaste | node dist/cli.js restore --map ~/.scrubline/map.json
```

`scrubline [file] [--map <file>] [--summary]` masks a file or stdin to stdout; every other byte is left as it was.
`--map` keeps the originals in a JSON file (mode 0600) and adds to it on each run, so a value keeps its placeholder
across pastes. Runs that share a map take turns (a `.lock` file next to it holds the running process's id; a lock left by a run that
was stopped is taken over), a symlinked map is written through to its target, and placeholder text you typed yourself is recorded as standing for itself, so no later run gives it a value.
`--summary` prints a count per kind to stderr. `scrubline restore [file] --map <file>` puts the originals back.
Errors exit with code 2 and never show input text, map values, arguments or file names; a reader that stops early
(`| head`) is not an error. From code, the same is `scrub(text, { map })`.

### Behaviour

- The same value always gets the same placeholder; distinct values of one kind are numbered `_1`, `_2`, ….
- If the input already contains placeholder-shaped text such as `[EMAIL_1]`, numbering skips it, so
  `restore(scrub(x).text, scrub(x).map)` returns `x` exactly.
- With a map from earlier runs (`scrub(x, { map })`, or the CLI's `--map`), a placeholder in the input that is in that
  map stands for its value, so `restore` turns it into the value: a follow-up paste that quotes `[EMAIL_1]` restores
  to the address.
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
secrets (`password=…`), phone and card numbers, IP addresses, home paths, high-entropy strings, custom rules
and streaming.

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
- A URL password holding whitespace, a control character, `"` (also `\"` in JSON), `<`, `>`, `` ` ``, `{`, `}`, `|`
  or a backslash (other than `\\` and `\uXXXX` for a non-ASCII letter in JSON) is not masked. URL parsers require
  those characters to be percent-encoded (`%20`, `%22`), and an encoded password is masked.
- A raw `/`, `?` or `#` in a password is masked, except when everything between the `:` and that character is
  digits, which reads as a port (`postgres://u:1234/x@host`), or that `:` is inside an IPv6 host
  (`http://[::1]:…`). Such a password that also holds a raw `@`, in either order, is masked only up to one of its
  `@`s, and the rest stays visible. The other way round, a
  port that is not digits, or empty, followed by an `@` later in the path (`http://host:port/?to=a@b.co`), is masked
  as a password up to that `@` (over-masking).
- A URL password starting with the text `[URL_PASSWORD_N]`, alone or right after a key (it reads as
  already-scrubbed output), holding `://`, or starting with `//`, is not masked.
- A URL's password runs to the last `@` before the host ends, as URL parsers read it. Text glued to the host by any
  character that does not end a URL (anything but whitespace, a control character, `"`, `` ` ``, `<`, `>`, `{`, `}`,
  `|`, a backslash, `/`, `?` or `#`; a `'` does not end it), and holding a later `@`
  (`url='postgres://…@db',email='jane@example.com'`), is masked with the password, host included; an address glued on
  that way loses its name into the mask and its domain stays visible.
- A key whose own characters include `_` or `-` (JWT, Anthropic, OpenAI, GitHub fine-grained, GitLab, Slack, SendGrid)
  runs on through a `_` or `-` into whatever follows. When that is a SendGrid key (`sk-ant-…_SG.….…`), the part from
  its first `.` on stays visible. (A Telegram token after such a key is masked whole: it is matched first.)
- A key whose body holds another format's prefix after a `-` (`xoxb-…-sk-…`) is split between the two kinds. When
  the part before is too short for its own format, it stays visible: at most the prefix and 9 characters
  (`xoxb-1234-`); the rest is masked.
- `user:password@host` with no `scheme://` in front (`curl -u`, some config formats) is not detected.
- The CLI reads its input as UTF-8: a byte that is not valid UTF-8 comes out as U+FFFD (`�`).
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
| In generated documents (fake keys of every format, armoured key blocks, emails, URLs with passwords, placeholder look-alikes; separated by whitespace, punctuation, escapes, control characters, ANSI codes and URL-encoded bytes), no planted value survives, as plain text or JSON-encoded, and the JSON stays valid; separated by whitespace, quotes or escapes, every character of every planted value is inside a mask | `test/properties.test.ts` |
| URL passwords: any scheme, only the password masked, encoded passwords and ones holding a raw `@`, `:`, `/`, `?` or `#`, ports, IPv6 hosts and path or query look-alikes kept, JSON (slash-escaped, `\u`-escaped, nested) stays valid, a key as the user name or inside the password keeps its type and does not hide the password, and the limits above | `test/scrub.test.ts`: "passwords in URLs" |
| The CLI: bytes kept (BOM, CRLF, non-ASCII, no final newline), file or stdin, the map file (mode 0600 new or rewritten, merged across runs and across 8 overlapping runs, never reassigned, symlinks followed, leftover temporary files removed), typed placeholders kept, a stopped run's lock taken over and a live one waited for, restore, `--summary`, `--`, exit codes, `\| head`, and errors that show no input, map value or argument | `test/cli.test.ts` (runs the built `dist/cli.js`); `test/scrub.test.ts`: "continuing from an earlier map" |
| Findings never contain the values | `test/scrub.test.ts`, `test/properties.test.ts` |
| Scan time stays linear: twenty crafted 200,000-character inputs and a 4 MB input with 160,000 findings | `test/performance.test.ts` (1.5 s budget; under 40 ms and 140–200 ms on an M-series laptop) |
| A 12 MB key block with no END line is masked rather than throwing | `test/performance.test.ts`: "very large input" |

Every key in the tests is fake and is assembled at runtime, so the repository never holds a complete key-shaped string.

## Prior work

The detector patterns, and most of the fake test values and keep-cases, started from a redactor in an earlier tool by the same author.
Here they are split into typed detectors with explicit token boundaries and rebuilt around reversible masks.

## Licence

[MIT](LICENSE)
