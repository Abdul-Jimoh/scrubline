import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { restore, scrub } from '../src/index.js';

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

/** One generator per built-in format. */
const planted = fc.oneof(
  cat(fc.constantFrom('AKIA', 'ASIA'), chars(UP + DIG, 16)),
  token('ghp_', ALNUM, 36),
  token('github_pat_', ALNUM + '_', 60, 82),
  token('sk-ant-api03-', B64URL, 80, 95),
  token('sk-proj-', B64URL, 40, 60),
  token('glpat-', B64URL, 20, 26),
  token('xoxb-', ALNUM + '-', 20, 50),
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
  ),
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

/** A document of filler with planted secrets; `secrets` lists what was planted. */
const document = fc
  .array(fc.tuple(fc.oneof(planted.map((s) => ({ s })), filler.map((f) => ({ f }))), separator), { maxLength: 25 })
  .map((parts) => ({
    text: parts.map(([p, sep]) => ('s' in p ? p.s : p.f) + sep).join(''),
    secrets: parts.flatMap(([p]) => ('s' in p ? [p.s] : [])),
  }));

const runs = { numRuns: 500 };

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

  it('scrubbing twice finds nothing new', () => {
    fc.assert(
      fc.property(document, ({ text: x }) => {
        expect(scrub(scrub(x).text).findings).toEqual([]);
      }),
      runs,
    );
  });
});
