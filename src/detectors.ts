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
  /**
   * A backslash right before a span is a path separator, not an escape, so the span does not take it (see `scrub`'s
   * `absorbEscape`). Only for formats where that backslash can never start a valid JSON escape.
   */
  readonly keepsBackslashBefore?: boolean;
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

/** `://`, or `:\/\/` as JSON that escapes slashes (PHP) writes it. */
const URL_SEPARATOR = /:(?:\/\/|\\\/\\\/)/g;
/**
 * A character a URL scheme can end with (`postgres`, `mongodb+srv`, `git+ssh`), or `\0`: a key glued to the scheme
 * by `-` (`sk-proj-…-postgres://`) claims the scheme too, and the password after it must still be masked.
 */
const SCHEME_CHAR = /[A-Za-z0-9+.\0-]/;
const PLACEHOLDER_AT = /\[[A-Z][A-Z0-9_]*_\d+\]/y;
const HEX4 = /[0-9A-Fa-f]{4}/y;
/**
 * Characters that end a URL wherever they appear: they end it in running text or a JSON string. Trade-off: a password
 * that holds one raw (whitespace or a control character, `"`, `<`, `>`, `` ` ``, `{`, `}`, `|`) is not masked,
 * because the scan stops before its `@`. URL parsers require them to be percent-encoded, which is masked.
 */
const URL_END = new Uint8Array(128);
for (let c = 1; c <= 32; c++) URL_END[c] = 1;
for (const c of '"<>`{}|\x7f') URL_END[c.charCodeAt(0)] = 1;
/** Where the authority ends and the path, query or fragment begins: `/`, `?`, `#`. */
const isPathStart = (c: number) => c === 47 || c === 63 || c === 35;

interface AuthorityScan {
  /** First `:` outside opaque ranges, or -1. */
  colon: number;
  /** The `@` that ends the userinfo, or -1. */
  at: number;
  /** Claimed text and placeholders: kept out of the mask, but scanned past. `true` marks a `[URL_PASSWORD_N]`. */
  opaque: [number, number, boolean][];
  /** Where the scan stopped, and whether on `/`, `?` or `#`. */
  end: number;
  atPathStart: boolean;
}

/**
 * Scans a URL authority from `k`. Normally it stops at the path, and the userinfo runs to the last `@` before it,
 * as URL parsers read it (a raw `@` in a password stays inside the mask). With `pastPath`, it reads on through `/`,
 * `?` and `#` to the first `@`, stopping at the next `://`.
 *
 * Claimed text (`\0`, with a backslash a claimed span took with it) and placeholders (`[AWS_KEY_1]`) are scanned past
 * and recorded, not treated as an end: a key as the user name (`s3n://AKIA…:<secret>@bucket`) must not hide the
 * password after it, and a key inside a password keeps its own type while the rest is masked around it. Scrubbing
 * the output again sees placeholders where the first pass saw claimed text, so it finds nothing new.
 */
function scanAuthority(input: string, k: number, pastPath: boolean): AuthorityScan {
  const scan: AuthorityScan = { colon: -1, at: -1, opaque: [], end: k, atPathStart: false };
  for (; k < input.length; k++) {
    const c = input.charCodeAt(k);
    if (c === 0 || (c === 92 && input.charCodeAt(k + 1) === 0)) {
      const from = k;
      if (c === 92) k++;
      while (input.charCodeAt(k + 1) === 0) k++;
      scan.opaque.push([from, k + 1, false]);
      continue;
    }
    if (c === 91 /* [ */) {
      PLACEHOLDER_AT.lastIndex = k;
      if (PLACEHOLDER_AT.test(input)) {
        scan.opaque.push([k, PLACEHOLDER_AT.lastIndex, input.startsWith('[URL_PASSWORD_', k)]);
        k = PLACEHOLDER_AT.lastIndex - 1;
        continue;
      }
    }
    if (c === 92 && input[k + 1] === '/') {
      // `\/`: a `/` in JSON that escapes slashes (PHP).
      if (!pastPath) {
        scan.atPathStart = true;
        break;
      }
      if (input[k - 1] === ':' && input.startsWith('\\/\\/', k)) break; // the next URL
      k++;
      continue;
    }
    if (c === 92 /* \ */) {
      // In a JSON string, `\\` is a backslash and `\u00e9` a non-ASCII letter (Python's json.dumps writes them so).
      // Any other escape (`\"`, `\n`) ends the URL: `\"` most often closes an inner JSON string, and reading
      // past it ran into the next field. Trade-off: a password holding a `"` in JSON-encoded text is not masked.
      if (input[k + 1] === '\\') {
        k++;
        continue;
      }
      HEX4.lastIndex = k + 2;
      if (input[k + 1] === 'u' && HEX4.test(input) && parseInt(input.slice(k + 2, k + 6), 16) >= 0x80) {
        k += 5;
        continue;
      }
      break;
    }
    if (c < 128 && URL_END[c]) break;
    if (isPathStart(c)) {
      if (!pastPath) {
        scan.atPathStart = true;
        break;
      }
      if (c === 47 && input[k - 1] === ':' && input[k + 1] === '/') break; // the next URL
      continue;
    }
    if (c === 64 /* @ */) {
      scan.at = k;
      if (pastPath) {
        k++;
        break;
      }
    } else if (c === 58 /* : */ && scan.colon === -1) scan.colon = k;
  }
  scan.end = k;
  return scan;
}

/**
 * Passwords in URLs: `scheme://user:password@host`. Only the password is masked. Trade-off: text glued to the host by
 * any character that does not end a URL (anything but whitespace, control characters, `"`, `` ` ``, `<>{}|`, a backslash
 * and `/?#`: so `,` `'` `=` `:` and the rest glue)
 * and containing a later `@` (`url='…@db',email='jane@b.co'`) is masked as part of the password, host included; an
 * address glued on that way loses its name into the mask and keeps its domain visible.
 *
 * A raw `/`, `?` or `#` in a password (`Pa#ss`, or base64 `ab/cd==`) ends the authority for a URL parser, but people
 * write them. When the authority has a `:` and no `@`, the scan reads on to the first `@`. Trade-offs: it does not
 * when the text between `:` and the `/`, `?` or `#` is one or more digits, which is read as a port
 * (`http://host:8080/?to=a@b.co`), or when that `:` is inside an IPv6 host (`http://[::1]:80/…`); so the password
 * `u:1234/x@host` is not masked. A password with such a character and also a raw `@`, in either order, is masked only
 * up to one of its `@`s, and the rest stays visible.
 * Over-masking the other way: a port that is not digits, or empty, followed by an `@` later in the path
 * (`http://host:port/?to=jane@b.co`), is masked as a password up to that `@`.
 *
 * Each scan stops at the next `://`, so the search stays linear. Trade-off: a password holding `://`, or starting with
 * `//` (so that `://` follows the user name), is not masked.
 */
/**
 * Whether the password starting at `p` is scrubbed output: a `[URL_PASSWORD_N]` comes first, after any keys masked
 * before it. A password read past its path (`[URL_PASSWORD_1]@aa&t=…@b.co`) would otherwise be read to a later `@`
 * the second time. Trade-off: a password starting with the text `[URL_PASSWORD_N]`, alone or right after a key
 * (`AKIA…[URL_PASSWORD_1]tail`), is not masked.
 */
function alreadyMasked(opaque: readonly [number, number, boolean][], p: number): boolean {
  for (const [s, e, isPassword] of opaque) {
    if (e <= p) continue;
    if (s !== p) return false;
    if (isPassword) return true;
    p = e;
  }
  return false;
}

/**
 * For `StreamScrubber`: the start of the scheme of the last URL before `end` whose authority may still be open at
 * `end`, or -1. `findUrlPasswords` needs that scheme to find the password, however long the user name is, so a stream
 * keeps the text from there. A URL ends where `scanAuthority` stops: a character in `URL_END`, or a backslash other
 * than `\\`, `\/` and `\uXXXX` for a non-ASCII character. `claimed` (sorted, from earlier detectors) is scanned past,
 * with a backslash right before it, as `scanAuthority` scans past `\0`. Found by Qodo in the review of PR #22: counting
 * no backslash as an end kept everything after `http://u:p@h\n` until the next space.
 */
export function openUrlStart(
  input: string,
  end: number,
  claimed: readonly { start: number; end: number }[] = [],
): number {
  const sep = Math.max(input.lastIndexOf('://', end - 3), input.lastIndexOf(':\\/\\/', end - 5));
  if (sep <= 0 || !SCHEME_CHAR.test(input[sep - 1]!)) return -1;
  let i = 0;
  for (let k = sep + 1; k < end; k++) {
    while (i < claimed.length && claimed[i]!.end <= k) i++;
    const next = claimed[i];
    const c = input.charCodeAt(k);
    if (next && (next.start <= k || (c === 92 && next.start === k + 1))) {
      k = next.end - 1;
      continue;
    }
    if (c === 92) {
      const d = input[k + 1];
      HEX4.lastIndex = k + 2;
      if (d === '\\' || d === '/') k++;
      else if (d === 'u' && HEX4.test(input) && parseInt(input.slice(k + 2, k + 6), 16) >= 0x80) k += 5;
      else return -1;
    } else if (c < 128 && URL_END[c]) return -1;
  }
  let s = sep - 1;
  while (s > 0 && SCHEME_CHAR.test(input[s - 1]!)) s--;
  return s;
}

function* findUrlPasswords(input: string): Iterable<readonly [number, number]> {
  for (const m of input.matchAll(URL_SEPARATOR)) {
    if (m.index === 0 || !SCHEME_CHAR.test(input[m.index - 1]!)) continue;
    const from = m.index + m[0].length;
    const scan = scanAuthority(input, from, false);
    let { at, opaque } = scan;
    const { colon } = scan;
    const port = /^[0-9]+$/.test(input.slice(colon + 1, scan.end));
    // The `:` is inside an IPv6 host when a `[` before it is still open, also after a user name (`app@[::1]:5432`).
    // A closed bracketed user name (`[admin]:`, `[USER_1]:`) is not a host. Found by Qodo in the review of PR #13.
    const beforeColon = input.slice(from, colon);
    const ipv6 = beforeColon.lastIndexOf('[') > beforeColon.lastIndexOf(']');
    // `at < colon`: the `@` belongs to the user name (`jane@corp.com:ab/cd@db`), and the password still needs its own.
    if ((at === -1 || at < colon) && colon !== -1 && scan.atPathStart && !port && !ipv6) {
      const more = scanAuthority(input, scan.end, true);
      if (more.at !== -1) {
        at = more.at;
        opaque = opaque.concat(more.opaque);
      }
    }
    if (colon === -1 || at <= colon) continue;
    if (alreadyMasked(opaque, colon + 1)) continue;
    // The password, without the claimed text and placeholders inside it.
    let p = colon + 1;
    for (const [s, e] of opaque) {
      if (e <= p) continue;
      if (s >= at) break;
      if (s > p) yield [p, s];
      p = e;
    }
    if (p < at) yield [p, at];
  }
}

/**
 * The start of a home folder, up to the separator before the user name: `/Users/`, `/home/`, and a Windows drive's
 * `X:\Users\` (also written `X:\\Users\\` in JSON, `X:\\\\Users\\\\` in JSON inside JSON, or `X:/Users/`). A Windows
 * path uses one separator throughout; trade-off: a mixed one (`C:/Users\jane`) is not a home path, nor is `/users/…`
 * in lower case (only Windows paths are matched in any case). The one-separator rule also
 * means an odd run of `\` before the name never appears in valid JSON (`\U` and `\u` + `sers` are not escapes), so
 * its last `\` is a separator, not an escape. The drive letter may be `\0`: a key glued on by `-` or `_`
 * (`<jwt>-C:\Users\…`) runs on through it, and the name after it must still be masked (found by the test generator).
 * `\\+` backtracks only over its own run, which follows one drive letter: linear.
 */
const HOME_PREFIX = /\/(?:Users|home)\/|[A-Za-z\0]:(\\+|\/)[Uu][Ss][Ee][Rr][Ss]\1/g;
/**
 * Before `/Users` or `/home`: not inside a path or a word (`foo/Users/x`, `/opt/home/x`, `./home/x`), except after an
 * escape (`\n/home/jane` in JSON) or `file://`. Trade-off: a relative path such as `../home/jane` or `x//home/jane`
 * is not masked.
 */
const POSIX_HOME_START = new RegExp(start('A-Za-z0-9./'), 'y');
/**
 * Right after `file://` in any case (`FILE:///Users/…`), or after `://` whose scheme is claimed text: a key glued on
 * by `_` or `-` runs on into `file` (`sk-proj-…_file:///Users/…`), and the name after it must still be masked (found
 * by the test generator).
 */
const AFTER_FILE_URL = /(?<=(?:file|\0):\/\/)/iy;
/** Before a drive letter: not glued to a letter or digit (`xC:\Users\…`), except after an escape. */
const DRIVE_START = new RegExp(start(ALNUM), 'y');
/** A Windows home prefix (as in `HOME_PREFIX`) starting at `lastIndex`, its drive letter at a boundary. */
const WINDOWS_PREFIX_AT = new RegExp(`${start(ALNUM)}[A-Za-z]:(\\\\+|/)[Uu][Ss][Ee][Rr][Ss]\\1`, 'y');
/**
 * Characters that end a user name: whitespace and control characters (`\0`, claimed text, too), quotes, path
 * separators and punctuation that cannot be in a Windows user name, and `(` `)` `` ` `` `{` `}`, which put a path in
 * running text. Trade-off: a Windows name holding a space, `'`, `(` or `)` (`C:\Users\Jane Doe`, `O'Brien`) is masked
 * only up to that character, and the rest stays visible.
 */
const NAME_END = new Uint8Array(128);
for (let c = 0; c <= 32; c++) NAME_END[c] = 1;
for (const c of '/\\"\'`:;,<>|?*[]=(){}\x7f') NAME_END[c.charCodeAt(0)] = 1;
/**
 * Folders under the home root that belong to no one, with `All Users` (it holds a space) checked in the scan. Compared
 * without case (`C:\Users\public`). Trade-off: a person whose user name is one of these is not masked.
 */
const SHARED_HOME = new Set(['shared', 'public', 'default']);
/** Whether `input[i]` can be part of a user name; false past the end. */
function isNameChar(input: string, i: number): boolean {
  if (i >= input.length) return false;
  const c = input.charCodeAt(i);
  return c >= 128 || !NAME_END[c];
}
/**
 * Whether four characters are the hex of a `\uXXXX` escape for a character that can be part of a user name: a
 * non-ASCII letter (`é`) or an ASCII one (`j`, found by Qodo in the review of PR #18). An escaped separator or quote
 * (`/`, `"`) ends the name.
 */
const isNameEscape = (hex: string): boolean =>
  /^[0-9A-Fa-f]{4}$/.test(hex) && isNameChar(String.fromCharCode(parseInt(hex, 16)), 0);

/**
 * The user name in a home-directory path: `/Users/[HOME_USER_1]/projects`, the rest of the path kept. The name runs to
 * the first character of `NAME_END` or the end of the text; in a POSIX or `\\` (JSON) path, a `\uXXXX` escape for a
 * name character (a letter, ASCII or not) is part of it. Trailing dots are left out (`see /home/jane.` ends a sentence);
 * trade-off: a name that really ends in `.` keeps that dot visible.
 */
function* findHomeUsers(input: string): Iterable<readonly [number, number]> {
  HOME_PREFIX.lastIndex = 0;
  for (let m = HOME_PREFIX.exec(input); m; m = HOME_PREFIX.exec(input)) {
    const prefixEnd = HOME_PREFIX.lastIndex;
    const guard = input[m.index] === '/' ? POSIX_HOME_START : DRIVE_START;
    guard.lastIndex = m.index;
    AFTER_FILE_URL.lastIndex = m.index;
    const atBoundary = guard.test(input) || (guard === POSIX_HOME_START && AFTER_FILE_URL.test(input));
    // Each try starts one character further on, and the name scan below moves past what it reads: linear.
    HOME_PREFIX.lastIndex = m.index + 1;
    if (!atBoundary) continue;
    // Escapes are read in a POSIX path, or after an even run of backslashes (the path is JSON-encoded).
    const escapes = m[1] === undefined || m[1] === '/' || m[1].length % 2 === 0;
    let e = prefixEnd;
    for (;;) {
      if (isNameChar(input, e)) e++;
      else if (escapes && input.startsWith('\\u', e) && isNameEscape(input.slice(e + 2, e + 6))) e += 6;
      else break;
    }
    // A name run on into the drive letter of a Windows home path (`/Users/jane%20d:\users\bob`) ends before it, so that
    // path's name is masked too (found by the test generator).
    WINDOWS_PREFIX_AT.lastIndex = e - 1;
    if (e > prefixEnd && input[e] === ':' && WINDOWS_PREFIX_AT.test(input)) e--;
    while (e > prefixEnd && input[e - 1] === '.') e--;
    if (e === prefixEnd) continue;
    HOME_PREFIX.lastIndex = e;
    const name = input.slice(prefixEnd, e).toLowerCase();
    const allUsers = name === 'all' && input.slice(e, e + 6).toLowerCase() === ' users' && !isNameChar(input, e + 6);
    if (!SHARED_HOME.has(name) && !allUsers) yield [prefixEnd, e];
  }
}

export const DETECTORS: readonly Detector[] = [
  { kind: 'PRIVATE_KEY', find: findKeyBlocks },
  // Before JWT and the `sk-` formats: a Telegram token's random half can hold `-sk-…`, which an OpenAI-style match
  // would take, and a JWT or key glued on by `-` or `_` would run into its digits; either left the rest of the token
  // visible (found by the test generator). No other format here holds a `:`, so a Telegram match never cuts into one.
  // Telegram's API puts the token straight after `bot` in the URL path: `https://api.telegram.org/bot<token>/…`.
  regexDetector(
    'TELEGRAM_BOT_TOKEN',
    new RegExp(`(?<![${ALNUM}]${ENDS_ESCAPE}(?<!/bot))[0-9]{8,10}:[${B64URL}]{35}${end(ALNUM)}`, 'g'),
  ),
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
  // After the key formats, so a key used as a URL password keeps its own type; before EMAIL, so `user:pw@host.com`
  // is not read as the address `pw@host.com`.
  { kind: 'URL_PASSWORD', find: findUrlPasswords },
  // After URL_PASSWORD, so a password holding `/home/…` stays one mask; before EMAIL, so `/home/jane@corp.com` is
  // masked as the user name.
  { kind: 'HOME_USER', find: findHomeUsers, keepsBackslashBefore: true },
  { kind: 'EMAIL', find: findEmails },
];
