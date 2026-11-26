import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { restore, scrub, StreamScrubber } from '../src/index.js';

// Generated values are fake by construction: random characters in the shape of each format.
const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOW = 'abcdefghijklmnopqrstuvwxyz';
const DIG = '0123456789';
const ALNUM = UP + LOW + DIG;
const B64URL = ALNUM + '_-';

const chars = (alphabet: string, min: number, max = min) =>
  fc.string({ unit: fc.constantFrom(...alphabet), minLength: min, maxLength: max });
/** A prefix and a body drawn from the format's whole alphabet: real keys can end on `-` or `_`. */
const token = (prefix: string, alphabet: string, min: number, max = min) => chars(alphabet, min, max).map((b) => prefix + b);
const cat = (...parts: fc.Arbitrary<string>[]) => fc.tuple(...parts).map((p) => p.join(''));

const b64Lines = fc.array(chars(ALNUM + '+/', 16, 64), { minLength: 1, maxLength: 4 }).map((l) => l.join('\n'));
const pemLabel = fc.constantFrom('', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', 'PGP ');
/** Armour and header lines real blocks carry, including characters a bare key body never holds. */
const armour = fc
  .array(
    fc.constantFrom(
      'Version: GnuPG v1.4.11 (GNU/Linux)',
      'Comment: Alice <alice@example.com> "work" key!',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0A1B2C3D4E5F6071',
    ),
    { maxLength: 2 },
  )
  .map((lines) => lines.map((l) => `${l}\n`).join(''));

/** One generator per built-in format whose whole match is the secret. */
/** The Luhn check digit for `body`. */
const luhnDigit = (body: string) => {
  let sum = 0;
  for (let i = body.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = body.charCodeAt(i) - 48;
    if (double && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
};
/** How card networks group each length: a first group of four, then groups of three to six. */
const CARD_GROUPS: Record<number, number[]> = { 13: [4, 3, 3, 3], 14: [4, 6, 4], 15: [4, 6, 5], 16: [4, 4, 4, 4], 17: [4, 4, 4, 5], 18: [4, 4, 4, 6], 19: [4, 4, 4, 4, 3] };
/** A card number that passes the Luhn check and starts with 2 to 6, ungrouped or grouped by spaces or dashes. */
const card = fc
  .tuple(fc.constantFrom('2', '3', '4', '5', '6'), fc.integer({ min: 13, max: 19 }), fc.constantFrom('', ' ', '-'))
  .chain(([first, length, sep]) => chars(DIG, length - 2).map((mid) => ({ digits: first + mid, sep })))
  .map(({ digits, sep }) => {
    const all = digits + luhnDigit(digits);
    if (!sep) return all;
    let at = 0;
    return CARD_GROUPS[all.length]!.map((n) => all.slice(at, (at += n))).join(sep);
  });

const whole = fc.oneof(
  card,
  cat(fc.constantFrom('AKIA', 'ASIA'), chars(UP + DIG, 16)),
  token('ghp_', ALNUM, 36),
  token('github_pat_', ALNUM + '_', 60, 82),
  token('sk-ant-api03-', B64URL, 80, 95),
  token('sk-proj-', B64URL, 40, 60),
  token('glpat-', B64URL, 20, 26),
  // A body holding `sk-` after a `-` is split with an OpenAI-style key: README "Known limits".
  token('xoxb-', ALNUM + '-', 20, 50).filter((t) => !/(?:^xoxb-|-)sk-/.test(t)),
  token('AIza', ALNUM + '_-', 35),
  token('sk_live_', ALNUM, 24, 99),
  token('whsec_', ALNUM, 32),
  token('npm_', ALNUM, 36),
  token('hf_', ALNUM, 34),
  cat(fc.constant('SG.'), token('', B64URL, 22), fc.constant('.'), token('', B64URL, 43)),
  cat(fc.constant('dop_v1_'), chars('0123456789abcdef', 64)),
  cat(chars(DIG, 8, 10), fc.constant(':'), token('', B64URL, 35)),
  cat(token('eyJ', B64URL, 10, 40), fc.constant('.'), token('eyJ', B64URL, 10, 60), fc.constant('.'), token('', B64URL, 10, 43)),
  fc.tuple(pemLabel, armour, b64Lines).map(([label, head, body]) => {
    const block = label === 'PGP ' ? 'PRIVATE KEY BLOCK' : 'PRIVATE KEY';
    return `-----BEGIN ${label}${block}-----\n${head}${body}\n-----END ${label}${block}-----`;
  }),
  cat(
    chars(LOW + DIG, 1, 12).filter((l) => l !== 'git'),
    fc.constantFrom('', '.', '+', '-', '_'),
    chars(LOW + DIG, 0, 8),
    fc.constant('@'),
    chars(LOW + DIG + '-', 1, 10),
    fc.constant('.'),
    chars(LOW, 2, 6),
  )
    // After a bare `%`, a two-hex-digit name (`%aa@b.co`) reads as a URL-encoded byte: README "Known limits".
    .filter((e) => !/^[0-9a-f]{2}@/.test(e)),
);

/**
 * A URL with a password, which is the only part masked. The password holds what URL parsers accept raw in a userinfo,
 * `@` and `:` included; the user name may be empty.
 */
const urlWithPassword = fc
  .tuple(
    fc.constantFrom('postgres', 'postgresql', 'mongodb+srv', 'redis', 'amqp', 'https', 's3n'),
    // The user name may be empty, a key (an AWS key ID in an s3n:// URL) or an address (smtp://jane@corp.com:…).
    fc.oneof(
      chars(LOW + DIG, 0, 8),
      cat(fc.constantFrom('AKIA', 'ASIA'), chars(UP + DIG, 16)),
      cat(chars(LOW, 1, 8), fc.constant('@'), chars(LOW, 2, 8), fc.constant('.com')),
    ),
    fc.oneof(
      chars(ALNUM + "!$&'()*+,;=~._-%@:", 12, 24),
      // A raw /, ? or # (base64, or typed by hand), which URL parsers would read as the end of the authority.
      cat(chars(LOW, 4, 8), fc.constantFrom('/', '?', '#'), chars(ALNUM + '/?#+=', 8, 16)),
    ),
    chars(LOW, 2, 10),
    fc.constantFrom('', '.internal', '.example.com'),
    fc.constantFrom('', ':5432', '/db', ':6379/0?ssl=true'),
  )
  .map(([scheme, user, pw, host, domain, rest]) => {
    const head = `${scheme}://${user}:`;
    return [`${head}${pw}@${host}${domain}${rest}`, pw, head.length] as const;
  });

/**
 * A home-directory path, of which only the user name is masked. It brings its own neighbour in front: the document's
 * separators include `/`, and `x//home/jane` is not a home path (README "Known limits"). Names are 6 or more
 * characters so that random filler does not contain one by chance, and leave out the shared folder names. Rule 6
 * (AGENTS.md): the spellings include mixed case where Windows and URL schemes ignore it (`c:\uSeRs\`, `FILE://`).
 */
const homePath = fc
  .tuple(
    fc.constantFrom(' ', '\n', '(', '"', "'", '=', ':', '\\n', '\t', '\x1b[32m', '\\u001b[31m', '%20', '_', '-', '[', 'file://', 'FILE://'),
    fc.constantFrom('/Users/', '/home/', 'C:\\Users\\', 'd:\\users\\', 'C:\\\\Users\\\\', 'C:/Users/', 'c:\\uSeRs\\', 'C:\\USERS\\'),
    chars(LOW + UP + DIG + '._-', 6, 14).filter((n) => /[^.]$/.test(n) && !['shared', 'public', 'default'].includes(n.toLowerCase())),
    fc.constantFrom('', '/', '\\', ':', ' ', '"', "'", ')', '/projects/app/index.js:3:9', '\\app\\index.js', '\\\\x'),
  )
  .map(([before, prefix, name, after]) => [`${before}${prefix}${name}${after}`, name, before.length + prefix.length] as const);

/** `[text, secret, offset]`: what is planted, the part of it that must not survive, and where that part starts. */
const planted = fc.oneof(
  { arbitrary: whole.map((s) => [s, s, 0] as const), weight: 17 },
  { arbitrary: urlWithPassword, weight: 2 },
  { arbitrary: homePath, weight: 2 },
);

/** Text that must survive: words, punctuation, and placeholder-shaped literals that could collide with real masks. */
const filler = fc.oneof(
  chars(ALNUM + ' .,:;!?()_-/#=+"\'', 0, 30),
  fc.tuple(fc.constantFrom('EMAIL', 'AWS_KEY', 'JWT', 'GITHUB_TOKEN', 'X'), fc.nat(4)).map(([k, n]) => `[${k}_${n}]`),
  fc.constantFrom('[', ']', '[EMAIL_', '_1]', '[]'),
  // Text that turns into a key-shaped run once an escape letter sits in front of it (`\n` + `pm_…`).
  fc.constantFrom('pm_', 'k_live_', 'hp_').chain((p) => token(p, ALNUM, 36)),
);
// Real neighbours of a key: whitespace, punctuation, assignments, quotes, JSON escapes written out as text, control
// characters (JSON-encoded as \u0001), ANSI colour codes and URL-encoded bytes. (A key glued to a letter or digit
// on either side is not a key boundary; test/scrub.test.ts covers Telegram's `/bot<token>`.) `_` and `-` were
// missing here, which hid a JWT leak that Qodo found in the review of PR #1.
const separator = fc.constantFrom(
  ...[' ', '\n', ', ', '; ', '\t', ' (', ') ', '\\n', '\\t', '=', '"', ':', '/', "='", '\r\n', '_', '-'],
  ...['\x01', '\x1f', '\x1b[32m', '\x1b[0m ', '\\u001b[31m', '%3D', '%20', '&token=', '\\u00e9', '\\', '%'],
);

/**
 * Separators no key or URL can run on through. Joined by `_`, `-`, `:`, `=` or `%`, which a key's or a userinfo's own
 * characters include, a value can take the start of the next one with it (README "Known limits").
 */
const boundary = fc.constantFrom(' ', '\n', ', ', '; ', '\t', ' (', ') ', '\\n', '"', '\r\n', '\x01', '\x1b[0m ', '\\u001b[31m');

/** A document of filler with planted secrets; `secrets` lists what was planted, `at` where each one starts. */
const documentWith = (sep: fc.Arbitrary<string>) => fc
  .array(fc.tuple(fc.oneof(planted.map((s) => ({ s })), filler.map((f) => ({ f }))), sep), { maxLength: 25 })
  .map((parts) => {
    let text = '';
    const secrets: string[] = [];
    const at: number[] = [];
    for (const [p, sep] of parts) {
      if ('s' in p) {
        secrets.push(p.s[1]);
        at.push(text.length + p.s[2]);
      }
      text += ('s' in p ? p.s[0] : p.f) + sep;
    }
    return { text, secrets, at };
  });
const document = documentWith(separator);

/**
 * JSON written by hand around values that start on an escape letter or an escape (`\n` + `pm_…`, `\r@a.co`,
 * `\u0072@a.co`) or follow a run of backslashes, then encoded one to three layers deep (issues #21 and #24). A raw run
 * stays short enough that, three layers out, a match never takes more than the 32 backslashes it may (README "Known
 * limits"). `layers` is how many layers decode before scrubbing; a `"` or a lone backslash can stop that early.
 */
const escapeBefore = fc.oneof(
  {
    arbitrary: cat(
      fc.nat(3).map((n) => '\\\\'.repeat(n)),
      fc.constantFrom('', ' ', 'x', '\\n', '\\r', '\\t', '\\b', '\\f', '\\u0001', '\\u00e9', '\\/'),
    ),
    weight: 19,
  },
  // Text that leaves the inner layer invalid from the start: a lone backslash, `\v` (not a JSON escape), a quote.
  { arbitrary: fc.constantFrom('\\', '\\\\\\', '\\v', '"'), weight: 1 },
);
const escapeMatch = fc.oneof(
  token('npm_', ALNUM, 36),
  token('pm_', ALNUM, 36),
  token('ghp_', ALNUM, 36),
  token('sk_live_', ALNUM, 24),
  token('k_live_', ALNUM, 24),
  cat(chars(LOW, 0, 3), fc.constantFrom('', '\\u0072', '\\u006a'), chars(LOW, 0, 3), fc.constant('@a.co')).filter((e) => !e.startsWith('@')),
);
const nestedJson = fc
  .tuple(fc.array(fc.tuple(escapeBefore, escapeMatch, escapeBefore), { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 3 }))
  .map(([parts, depth]) => {
    let doc = `{"m":"${parts.map((p) => p.join('')).join(' ')}"}`;
    for (let i = 1; i < depth; i++) doc = JSON.stringify({ m: doc });
    return { doc, depth };
  });
/** How many layers of `{"m": …}` decode, outermost first, up to `depth`. */
function decodedLayers(doc: string, depth: number): number {
  let value: unknown = doc;
  for (let k = 0; k < depth; k++) {
    try {
      value = (JSON.parse(value as string) as { m: unknown }).m;
    } catch {
      return k;
    }
    if (typeof value !== 'string') return k + 1;
  }
  return depth;
}

const runs = { numRuns: 500 };

/** Scrubs `x` as a stream, cut at the given points (fractions of its length), and returns the output and map. */
function streamed(x: string, cuts: readonly number[], window: number, asBytes = false) {
  const s = new StreamScrubber({ window });
  const input: string | Uint8Array = asBytes ? new TextEncoder().encode(x) : x;
  const at = [...new Set(cuts.map((c) => Math.floor(c * input.length)))].sort((a, b) => a - b);
  let text = '';
  let last = 0;
  for (const p of [...at, input.length]) {
    text += s.push(input.slice(last, p));
    last = p;
  }
  return { text: text + s.end(), map: s.map };
}
const cuts = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 40 });
/** Several documents in a row, long enough that a stream with a window of 512 to 1,024 writes text out mid-way. */
const longDocument = fc.array(document, { minLength: 1, maxLength: 6 }).map((ds) => ds.map((d) => d.text).join('\n'));
/** Placeholder-shaped text written as `(EMAIL_1)`: a stream cannot reserve a placeholder before it arrives. */
const noLiterals = (x: string) => x.replace(/\[([A-Z][A-Z0-9_]*_\d+)\]/g, '($1)');

describe('properties', () => {
  it('restore(scrub(x)) === x for any string, including unpaired surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (x) => {
        const { text, map } = scrub(x);
        expect(restore(text, map)).toBe(x);
      }),
      runs,
    );
  });

  it('restore(scrub(x)) === x for documents full of secrets and placeholder look-alikes', () => {
    fc.assert(
      fc.property(document, ({ text: x }) => {
        const { text, map } = scrub(x);
        expect(restore(text, map)).toBe(x);
      }),
      runs,
    );
  });

  it('no planted secret survives in the scrubbed text', () => {
    fc.assert(
      fc.property(document, ({ text: x, secrets }) => {
        const { text } = scrub(x);
        for (const s of secrets) expect(text).not.toContain(s);
      }),
      runs,
    );
  });

  it('every character of every planted secret is inside a mask, when secrets are separated by a boundary', () => {
    // Stricter than the test above: a secret split into a visible part and a masked part passes that one.
    fc.assert(
      fc.property(documentWith(boundary), ({ text: x, secrets, at }) => {
        const { findings } = scrub(x);
        const masked = new Uint8Array(x.length);
        for (const f of findings) masked.fill(1, f.start, f.end);
        secrets.forEach((s, i) => {
          for (let k = at[i]!; k < at[i]! + s.length; k++) expect(masked[k], `${JSON.stringify(s)} at ${k - at[i]!}`).toBe(1);
        });
      }),
      runs,
    );
  });

  it('findings point at the original values and never carry them', () => {
    fc.assert(
      fc.property(document, ({ text: x, secrets }) => {
        const { findings, map } = scrub(x);
        for (const f of findings) expect(x.slice(f.start, f.end)).toBe(map[f.placeholder]);
        const logged = JSON.stringify(findings);
        for (const s of secrets) expect(logged).not.toContain(s);
      }),
      runs,
    );
  });

  it('a JSON-encoded document stays valid JSON and loses every planted secret', () => {
    fc.assert(
      fc.property(document, ({ text: x, secrets }) => {
        const out = scrub(JSON.stringify({ msg: x })).text;
        const { msg } = JSON.parse(out) as { msg: string };
        for (const s of secrets) expect(msg).not.toContain(s);
      }),
      runs,
    );
  });

  it('with an earlier map, restore gives the input back with the map\'s placeholders filled in', () => {
    // A follow-up paste: placeholders from the earlier map stand for their values (README "Behaviour").
    fc.assert(
      fc.property(document, document, ({ text: first }, { text: x }) => {
        const earlier = scrub(first).map;
        const { text, map } = scrub(x, { map: earlier });
        expect(restore(text, map)).toBe(restore(x, earlier));
      }),
      runs,
    );
  });

  it('scrubbing twice finds nothing new', () => {
    fc.assert(
      fc.property(document, ({ text: x }) => {
        expect(scrub(scrub(x).text).findings).toEqual([]);
      }),
      runs,
    );
  });

  it('a stream cut anywhere gives the same text and map as scrubbing the whole input', () => {
    // Windows of 512 or more hold every generated match (the longest is a key block of about 450 characters).
    fc.assert(
      fc.property(longDocument.map(noLiterals), cuts, fc.integer({ min: 512, max: 1024 }), (x, at, window) => {
        expect(streamed(x, at, window)).toEqual({ text: scrub(x).text, map: scrub(x).map });
      }),
      runs,
    );
  });

  it('a stream of UTF-8 bytes cut anywhere, mid-character included, gives the same result as the decoded whole', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), cuts, fc.integer({ min: 64, max: 96 }), (x, at, window) => {
        const whole = scrub(noLiterals(new TextDecoder().decode(new TextEncoder().encode(x))));
        expect(streamed(noLiterals(x), at, window, true)).toEqual({ text: whole.text, map: whole.map });
      }),
      runs,
    );
  });

  it('a stream restores exactly and loses every planted secret, placeholder look-alikes included', () => {
    fc.assert(
      fc.property(fc.array(documentWith(separator), { minLength: 1, maxLength: 6 }), cuts, fc.integer({ min: 512, max: 1024 }), (ds, at, window) => {
        const x = ds.map((d) => d.text).join('\n');
        const { text, map } = streamed(x, at, window);
        expect(restore(text, map)).toBe(x);
        for (const s of ds.flatMap((d) => d.secrets)) expect(text).not.toContain(s);
      }),
      runs,
    );
  });

  it('every layer of nested JSON that decoded before scrubbing still decodes after, in one go and as a stream', () => {
    fc.assert(
      fc.property(nestedJson, cuts, ({ doc, depth }, at) => {
        const { text, map } = scrub(doc);
        expect(decodedLayers(text, depth)).toBeGreaterThanOrEqual(decodedLayers(doc, depth));
        expect(restore(text, map)).toBe(doc);
        expect(streamed(doc, at, 64)).toEqual({ text, map });
      }),
      runs,
    );
  });
});
