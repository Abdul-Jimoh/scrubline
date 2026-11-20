/**
 * Built-in detectors. Each one names the mask it produces (`AWS_KEY` → `[AWS_KEY_1]`).
 *
 * Order is priority: when two matches overlap, the detector listed first wins. Specific formats come before the
 * generic ones that would also match them (`sk-ant-…` is an Anthropic key before it is an `sk-…` OpenAI-style key).
 *
 * Patterns adapted from a redactor in an earlier tool by the same author.
 */
export interface Detector {
  /** Mask label: upper snake case, used as `[KIND_N]`. */
  readonly kind: string;
  /** Must carry the `g` flag. */
  readonly pattern: RegExp;
  /** Optional second look at a match; returning false keeps the text as it is. */
  readonly accept?: (match: string) => boolean;
}

/**
 * Where a token may start: not inside a word, or straight after an escape such as `\n` or `\t` (JSON logs put a key
 * right after the `n` of `\n`). `\b` is not used: `_` counts as a word character for it, so `TOKEN_ghp_…`
 * was missed, and a key ending in `-` never matched a trailing `\b`.
 */
// Written as one nested lookbehind ("no token character before, unless that character follows a backslash"): an
// alternation of two lookbehinds was 50 times slower in V8.
const start = (inToken: string) => String.raw`(?<!(?<!\\)[${inToken}])`;
/** Where a token must end: the next character cannot continue it. */
const end = (inToken: string) => `(?![${inToken}])`;

/** One unit of a key block: base64, whitespace, header lines (`Proc-Type: 4,ENCRYPTED`) or a `\n`-style escape. */
const PEM_BODY = String.raw`(?:[A-Za-z0-9+/=\s:,.-]|\\[nrt])`;

const ALNUM = 'A-Za-z0-9';
const B64URL = 'A-Za-z0-9_-';

/** A token: optional prefix, then a body, bounded on both sides. `guard` is the class a neighbour must not be in. */
function token(body: string, guard = ALNUM, endGuard = guard): RegExp {
  return new RegExp(`${start(guard)}${body}${end(endGuard)}`, 'g');
}

export const DETECTORS: readonly Detector[] = [
  {
    kind: 'PRIVATE_KEY',
    // PEM and PGP blocks, also inside JSON strings (`\n` escapes). Without an END line (a truncated paste) the
    // block runs to the first character a key block cannot hold, such as the `"` that closes a JSON string.
    pattern: new RegExp(
      String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:${PEM_BODY}*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|${PEM_BODY}*)`,
      'g',
    ),
  },
  // JWT and EMAIL guard the start with their whole body class, so a long run like `eyJ-eyJ-…` or `a.a.a.…` has
  // one possible start instead of one per `-` or `.`; otherwise each start rescans the run and the scan is quadratic.
  { kind: 'JWT', pattern: token(`eyJ[${B64URL}]{8,}\\.[${B64URL}]{8,}\\.[${B64URL}]{8,}`, B64URL) },
  { kind: 'ANTHROPIC_KEY', pattern: token(`sk-ant-[${B64URL}]{16,}`, ALNUM, B64URL) },
  { kind: 'OPENAI_KEY', pattern: token(`sk-(?:proj-|svcacct-|admin-)?[${B64URL}]{20,}`, ALNUM, B64URL) },
  { kind: 'GITHUB_TOKEN', pattern: token(`(?:gh[pousr]_[${ALNUM}]{30,}|github_pat_[${ALNUM}_]{30,})`) },
  { kind: 'GITLAB_TOKEN', pattern: token(`glpat-[${B64URL}]{20,}`, ALNUM, B64URL) },
  { kind: 'SLACK_TOKEN', pattern: token(`xox[abprs]-[${ALNUM}-]{10,}`, ALNUM, `${ALNUM}-`) },
  { kind: 'AWS_KEY', pattern: token('(?:AKIA|ASIA)[0-9A-Z]{16}') },
  { kind: 'GOOGLE_API_KEY', pattern: token(`AIza[${B64URL}]{35}`, ALNUM, B64URL) },
  // Secret and restricted keys only: Stripe publishable keys (pk_) are public by design.
  { kind: 'STRIPE_KEY', pattern: token(`(?:(?:sk|rk)_(?:live|test)_[${ALNUM}]{16,}|whsec_[${ALNUM}]{20,})`) },
  { kind: 'NPM_TOKEN', pattern: token(`npm_[${ALNUM}]{30,}`) },
  { kind: 'HUGGINGFACE_TOKEN', pattern: token(`hf_[${ALNUM}]{30,}`) },
  { kind: 'SENDGRID_KEY', pattern: token(`SG\\.[${B64URL}]{16,}\\.[${B64URL}]{16,}`, ALNUM, B64URL) },
  { kind: 'DIGITALOCEAN_TOKEN', pattern: token('do[opr]_v1_[0-9a-f]{64}') },
  { kind: 'TELEGRAM_BOT_TOKEN', pattern: token(`[0-9]{8,10}:[${B64URL}]{35}`, ALNUM, B64URL) },
  {
    kind: 'EMAIL',
    // The start guard also excludes `\`, so in `\njane@…` the match starts at `j`, not at the `n` of the escape.
    pattern: token(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}`, String.raw`A-Za-z0-9._%+\\-`, ALNUM),
    // `git@github.com:org/repo` is an SSH remote, not a person.
    accept: (m) => !/^git@/i.test(m),
  },
];
