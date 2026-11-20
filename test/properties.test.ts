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
/** `body` characters, ending on a letter or digit as real tokens do. */
const token = (prefix: string, alphabet: string, min: number, max = min) =>
  fc.tuple(chars(alphabet, min - 1, max - 1), chars(ALNUM, 1)).map(([a, b]) => prefix + a + b);
const cat = (...parts: fc.Arbitrary<string>[]) => fc.tuple(...parts).map((p) => p.join(''));

const b64Lines = fc.array(chars(ALNUM + '+/', 16, 64), { minLength: 1, maxLength: 4 }).map((l) => l.join('\n'));
const pemLabel = fc.constantFrom('', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ');

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
  pemLabel.chain((label) =>
    b64Lines.map((body) => `-----BEGIN ${label}PRIVATE KEY-----\n${body}\n-----END ${label}PRIVATE KEY-----`),
  ),
  cat(
    chars(LOW + DIG, 1, 12).filter((l) => l !== 'git'),
    fc.constant('@'),
    chars(LOW + DIG, 1, 10),
    fc.constant('.'),
    chars(LOW, 2, 6),
  ),
);

/** Text that must survive: words, punctuation, and placeholder-shaped literals that could collide with real masks. */
const filler = fc.oneof(
  chars(ALNUM + ' .,:;!?()_-/#=+"\'', 0, 30),
  fc.tuple(fc.constantFrom('EMAIL', 'AWS_KEY', 'JWT', 'GITHUB_TOKEN', 'X'), fc.nat(4)).map(([k, n]) => `[${k}_${n}]`),
  fc.constantFrom('[', ']', '[EMAIL_', '_1]', '[]'),
);
const separator = fc.constantFrom(' ', '\n', ', ', '; ', '\t', ' (', ') ');

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

  it('scrubbing twice finds nothing new', () => {
    fc.assert(
      fc.property(document, ({ text: x }) => {
        expect(scrub(scrub(x).text).findings).toEqual([]);
      }),
      runs,
    );
  });
});
