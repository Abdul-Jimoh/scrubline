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
  /**
   * Yields spans `[start, end)` of `input` to mask, in increasing order and not overlapping each other. Text that a
   * higher-priority detector already claimed arrives as `\0` characters, which no detector may match.
   */
  readonly find: (input: string) => Iterable<readonly [number, number]>;
}

/** A detector from a global regex, with an optional second look at each match. */
function regexDetector(kind: string, pattern: RegExp, accept?: (match: string) => boolean): Detector {
  return {
    kind,
    *find(input) {
      for (const m of input.matchAll(pattern)) if (m[0] && (!accept || accept(m[0]))) yield [m.index, m.index + m[0].length];
    },
  };
}

/**
 * A character before a token's start that does not glue it to a word: one that ends an escape (`\n`, `\t`, `\uXXXX`),
 * a URL-encoded byte (`%3D`, `%20`) or an ANSI colour code (`ESC[32m`, also written `\u001b[32m`). Logs put keys
 * right after these. Evaluated just after that character.
 */
const ENDS_ESCAPE = String.raw`(?<!\\[nrtfbv])(?<!\\u[0-9A-Fa-f]{4})(?<!%[0-9A-Fa-f]{2})(?<!(?:\x1b|\\u001b|\\x1b|\\033|\\e)\[[0-9;]*m)`;

/**
 * Where a token may start: not right after a character of `inToken`, unless that character ends an escape. `\b` is
 * not used: it counts `_` as a word character (so `TOKEN_ghp_…` was missed) and a key ending in `-` never matched a
 * trailing `\b`. Written as one lookbehind: an alternation of lookbehinds was 50 times slower in V8.
 */
const start = (inToken: string) => `(?<![${inToken}]${ENDS_ESCAPE})`;
/** Where a token must end: the next character cannot continue it. */
const end = (inToken: string) => `(?![${inToken}])`;

const ALNUM = 'A-Za-z0-9';
const B64URL = 'A-Za-z0-9_-';

/** A bounded token. `guard` is the class a neighbour must not be in (before, and after unless `endGuard` is given). */
function token(kind: string, body: string, guard = ALNUM, endGuard = guard): Detector {
  return regexDetector(kind, new RegExp(`${start(guard)}${body}${end(endGuard)}`, 'g'));
}

// Private key blocks: PEM and PGP. A complete block is masked from BEGIN to END whatever it holds (a `Comment:`
// line, `\/` in PHP JSON). Without an END line (a truncated paste), the block runs to the first character a key
// block cannot hold, such as the `"` that closes a JSON string.
const KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_FOOTER = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
/** Longest block, BEGIN to END, treated as one key (an RSA-4096 PEM is about 3.3 KB; PGP blocks can be larger). */
const MAX_BLOCK = 64 * 1024;

/** ASCII characters a key block body can hold: base64, whitespace, and what armour and header lines use. */
const KEY_BODY_CHAR = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=:,.()<>@'- \t\n\v\f\r")
  KEY_BODY_CHAR[c.charCodeAt(0)] = 1;

/**
 * End of a truncated block's body: the first character a key block cannot hold, with `\n`, `\r`, `\t` and `\/`
 * escapes (JSON) counted as part of the body. A loop, not a regex: a repeated alternation overflowed V8's stack on
 * bodies of about 10 MB.
 */
function keyBodyEnd(input: string, i: number): number {
  for (;;) {
    const c = input.charCodeAt(i);
    if (c < 128 && KEY_BODY_CHAR[c]) i++;
    else if (c === 92 && i + 1 < input.length && 'nrt/'.includes(input[i + 1]!)) i += 2;
    else return i;
  }
}

/** ASCII base64url characters: the alphabet of a JWT segment. */
const B64URL_CHAR = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-') B64URL_CHAR[c.charCodeAt(0)] = 1;

const JWT_START = new RegExp(start(ALNUM), 'y');

/**
 * JWTs: `eyJ` + header, `.` + payload, `.` + signature, each segment 8 or more base64url characters. A JWT may follow
 * `_` or `-` (`jwt_eyJ…`), so a run like `eyJ_eyJ_…` has a possible start every four characters. A regex rescans the
 * run from each one, which is quadratic; this scan remembers where the current run ends, and after a failed start it
 * moves past that start's first segment, which every later start in the segment shares. It stays linear.
 */
function* findJwts(input: string): Iterable<readonly [number, number]> {
  let runFrom = -1;
  let runTo = -1;
  /** First index at or after `i` that is not base64url. */
  const runEnd = (i: number): number => {
    if (i >= runFrom && i <= runTo) return runTo;
    let k = i;
    for (; k < input.length; k++) {
      const c = input.charCodeAt(k);
      if (c >= 128 || !B64URL_CHAR[c]) break;
    }
    runFrom = i;
    runTo = k;
    return k;
  };
  for (let p = input.indexOf('eyJ'); p !== -1; ) {
    JWT_START.lastIndex = p;
    if (!JWT_START.test(input)) {
      p = input.indexOf('eyJ', p + 1);
      continue;
    }
    const e1 = runEnd(p + 3);
    const e2 = input[e1] === '.' ? runEnd(e1 + 1) : -1;
    const e3 = e2 !== -1 && input[e2] === '.' ? runEnd(e2 + 1) : -1;
    if (e1 - p >= 11 && e2 - e1 > 8 && e3 - e2 > 8) {
      yield [p, e3];
      p = input.indexOf('eyJ', e3);
    } else p = input.indexOf('eyJ', e1);
  }
}

function* findKeyBlocks(input: string): Iterable<readonly [number, number]> {
  let footer = -2; // index of the next footer at or after the last search; -1: none left; -2: not searched yet
  let footerEnd = 0;
  let prevEnd = 0;
  for (const h of input.matchAll(KEY_HEADER)) {
    if (h.index < prevEnd) continue;
    const bodyStart = h.index + h[0].length;
    // Footers are searched forward only and each search starts past the last one found, so the scan stays linear.
    if (footer !== -1 && footer < bodyStart) {
      KEY_FOOTER.lastIndex = bodyStart;
      const f = KEY_FOOTER.exec(input);
      footer = f ? f.index : -1;
      footerEnd = f ? f.index + f[0].length : 0;
    }
    prevEnd = footer !== -1 && footer - bodyStart <= MAX_BLOCK ? footerEnd : keyBodyEnd(input, bodyStart);
    yield [h.index, prevEnd];
  }
}

// EMAIL guards its start with its whole local-part class, so a long run like `a.a.a.…` has one possible start
// instead of one per `.`; otherwise each start rescans the run and the scan is quadratic.
// An address may not start on the letter of an escape, so in `\njane@…` it starts at `j`, not at the `n` (after
// other characters, `DOMAIN\jane@…`, it starts right after the backslash). The local part leaves out `%`
// (obsolete in addresses): with it, a URL-encoded run like `…%3D…%3D…@` was one long local part that every start
// inside it rescanned. A start right after `%` is allowed unless the `%` begins a URL-encoded byte (`%3D`).
const EMAIL_BODY = `[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}${end(ALNUM)}`;
const EMAIL = new RegExp(
  `${start('A-Za-z0-9._+-')}(?<!\\\\(?=[nrtfbv]|u[0-9A-Fa-f]{4}))(?<!%(?=[0-9A-Fa-f]{2}))${EMAIL_BODY}`,
  'g',
);
/**
 * An address joined to the previous one by `.`, `_`, `+` or `-` (`jane@x.com_bob@y.com`), which the start guard would
 * block. The joining characters stay outside the mask, so the address gets the same placeholder as anywhere else.
 */
const EMAIL_NEXT = new RegExp(`[._+-]+(?=[A-Za-z0-9])(${EMAIL_BODY})`, 'y');
/** `git@github.com:org/repo` is an SSH remote, not a person. */
const SSH_REMOTE = /^git@/i;

function* findEmails(input: string): Iterable<readonly [number, number]> {
  for (EMAIL.lastIndex = 0; ; ) {
    const m = EMAIL.exec(input);
    if (!m) return;
    let s = m.index;
    let e = s + m[0].length;
    // Tried only right after a match, so each try starts at a new place and the scan stays linear.
    for (;;) {
      if (!SSH_REMOTE.test(input.slice(s, e))) yield [s, e];
      EMAIL_NEXT.lastIndex = e;
      const n = EMAIL_NEXT.exec(input);
      // Followed by `@` (`c@d.co@e.com`) it is not one address; leave that to the main search, as before.
      if (!n || input[e + n[0].length] === '@') break;
      s = e + n[0].length - n[1]!.length;
      e += n[0].length;
    }
    EMAIL.lastIndex = e;
  }
}

export const DETECTORS: readonly Detector[] = [
  { kind: 'PRIVATE_KEY', find: findKeyBlocks },
  { kind: 'JWT', find: findJwts },
  token('ANTHROPIC_KEY', `sk-ant-[${B64URL}]{16,}`, ALNUM, B64URL),
  token('OPENAI_KEY', `sk-(?:proj-|svcacct-|admin-)?[${B64URL}]{20,}`, ALNUM, B64URL),
  token('GITHUB_TOKEN', `(?:gh[pousr]_[${ALNUM}]{30,}|github_pat_[${ALNUM}_]{30,})`),
  token('GITLAB_TOKEN', `glpat-[${B64URL}]{20,}`, ALNUM, B64URL),
  token('SLACK_TOKEN', `xox[abprs]-[${ALNUM}-]{10,}`, ALNUM, `${ALNUM}-`),
  token('AWS_KEY', '(?:AKIA|ASIA)[0-9A-Z]{16}'),
  // Google keys and Telegram tokens have a fixed length, so only a following letter or digit makes the run something
  // else; `_` or `-` right after (`…_prod`) still ends the key.
  token('GOOGLE_API_KEY', `AIza[${B64URL}]{35}`),
  // Secret and restricted keys only: Stripe publishable keys (pk_) are public by design.
  token('STRIPE_KEY', `(?:(?:sk|rk)_(?:live|test)_[${ALNUM}]{16,}|whsec_[${ALNUM}]{20,})`),
  token('NPM_TOKEN', `npm_[${ALNUM}]{30,}`),
  token('HUGGINGFACE_TOKEN', `hf_[${ALNUM}]{30,}`),
  token('SENDGRID_KEY', `SG\\.[${B64URL}]{16,}\\.[${B64URL}]{16,}`, ALNUM, B64URL),
  token('DIGITALOCEAN_TOKEN', 'do[opr]_v1_[0-9a-f]{64}'),
  // Telegram's API puts the token straight after `bot` in the URL path: `https://api.telegram.org/bot<token>/…`.
  regexDetector(
    'TELEGRAM_BOT_TOKEN',
    new RegExp(`(?<![${ALNUM}]${ENDS_ESCAPE}(?<!/bot))[0-9]{8,10}:[${B64URL}]{35}${end(ALNUM)}`, 'g'),
  ),
  { kind: 'EMAIL', find: findEmails },
];
