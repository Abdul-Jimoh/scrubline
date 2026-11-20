import { describe, expect, it } from 'vitest';
import { DETECTORS, restore, scrub } from '../src/index.js';
import { FAKE, j } from './fixtures.js';

describe('every built-in detector masks its format with a typed placeholder', () => {
  it('has a fake sample for every detector', () => {
    expect(Object.keys(FAKE).sort()).toEqual(DETECTORS.map((d) => d.kind).sort());
  });

  for (const [kind, value] of Object.entries(FAKE)) {
    it(kind, () => {
      const { text, map, findings } = scrub(`before ${value} after`);
      expect(text).toBe(`before [${kind}_1] after`);
      expect(map).toEqual({ [`[${kind}_1]`]: value });
      expect(findings).toEqual([{ kind, placeholder: `[${kind}_1]`, start: 7, end: 7 + value.length }]);
    });
  }
});

describe('token boundaries', () => {
  // Each of these leaked before the boundaries stopped relying on \b (found by the pre-push verifier).
  const cases: [string, string, string][] = [
    ['a Google key ending in -', j('AIza', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', '-'), 'GOOGLE_API_KEY'],
    ['a Telegram token ending in -', j('123456789', ':', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '-'), 'TELEGRAM_BOT_TOKEN'],
    ['a 20-character GitLab token ending in -', j('glpat-', 'Xy7Zq2Wm9Rt4Lp8Kd3V', '-'), 'GITLAB_TOKEN'],
  ];
  for (const [name, value, kind] of cases) {
    it(`masks ${name}, mid-text and at the end`, () => {
      expect(scrub(`key ${value} end`).text).toBe(`key [${kind}_1] end`);
      expect(scrub(`key ${value}`).text).toBe(`key [${kind}_1]`);
    });
  }

  it('masks keys right after an underscore and before one', () => {
    expect(scrub(`TOKEN_${FAKE.GITHUB_TOKEN}_x`).text).toBe('TOKEN_[GITHUB_TOKEN_1]_x');
  });

  it('masks keys inside a JSON-escaped log line, and the line stays valid JSON', () => {
    const msg = `line1\n${FAKE.GITHUB_TOKEN}\t${FAKE.AWS_KEY}\n${FAKE.ANTHROPIC_KEY}\n${FAKE.EMAIL}\r${FAKE.JWT}`;
    const out = scrub(JSON.stringify({ msg })).text;
    expect(JSON.parse(out)).toEqual({
      msg: 'line1\n[GITHUB_TOKEN_1]\t[AWS_KEY_1]\n[ANTHROPIC_KEY_1]\n[EMAIL_1]\r[JWT_1]',
    });
  });

  it('does not mask a key prefix inside a longer word', () => {
    for (const line of ['risk-assessment-for-the-quarter-2026', 'fork_test_handlesEverythingNicely', 'EURASIAN1234567890ABCDEFGH'])
      expect(scrub(line).text).toBe(line);
  });
});

describe('numbering', () => {
  const other = j('ops', '@', 'example.com');

  it('numbers distinct values per kind and reuses the placeholder for a repeated value', () => {
    const input = `${FAKE.EMAIL} cc ${other}; key ${FAKE.AWS_KEY}; again ${FAKE.EMAIL}`;
    const { text, findings } = scrub(input);
    expect(text).toBe('[EMAIL_1] cc [EMAIL_2]; key [AWS_KEY_1]; again [EMAIL_1]');
    expect(findings.map((f) => f.placeholder)).toEqual(['[EMAIL_1]', '[EMAIL_2]', '[AWS_KEY_1]', '[EMAIL_1]']);
  });

  it('skips placeholder-shaped text that is already in the input, so restore stays exact', () => {
    const input = `literal [EMAIL_1] and [EMAIL_2], then ${FAKE.EMAIL}`;
    const { text, map } = scrub(input);
    expect(text).toBe('literal [EMAIL_1] and [EMAIL_2], then [EMAIL_3]');
    expect(restore(text, map)).toBe(input);
  });
});

describe('findings', () => {
  const input = `token ${FAKE.GITHUB_TOKEN} for ${FAKE.EMAIL}`;
  const { findings, map } = scrub(input);

  it('point at the original text', () => {
    for (const f of findings) expect(input.slice(f.start, f.end)).toBe(map[f.placeholder]);
  });

  it('never carry the secret itself, so they are safe to log', () => {
    const logged = JSON.stringify(findings);
    expect(logged).not.toContain(FAKE.GITHUB_TOKEN);
    expect(logged).not.toContain(FAKE.EMAIL);
  });
});

describe('restore', () => {
  it('puts the originals back', () => {
    const input = `curl -H "x-api-key: ${FAKE.ANTHROPIC_KEY}" # by ${FAKE.EMAIL}`;
    const { text, map } = scrub(input);
    expect(restore(text, map)).toBe(input);
  });

  it('works on text an AI rewrote around the placeholders', () => {
    const { map } = scrub(`mail ${FAKE.EMAIL}`);
    expect(restore('Send the report to [EMAIL_1] today.', map)).toBe(`Send the report to ${FAKE.EMAIL} today.`);
  });

  it('leaves placeholders it does not know', () => {
    expect(restore('[EMAIL_9] and [NOT_A_KIND_1]', { '[EMAIL_1]': 'x' })).toBe('[EMAIL_9] and [NOT_A_KIND_1]');
  });
});

describe('private key blocks', () => {
  it('an Anthropic key is not reported as an OpenAI-style key', () => {
    expect(scrub(FAKE.ANTHROPIC_KEY).text).toBe('[ANTHROPIC_KEY_1]');
  });

  it('an encrypted PEM block with header lines is one finding', () => {
    const block = j(
      '-----BEGIN ',
      'RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B2C3D4E5F6071\n\nMIIEpAIBAAKCAQEA\n-----END ',
      'RSA PRIVATE KEY-----',
    );
    expect(scrub(`key:\n${block}\nend`).text).toBe('key:\n[PRIVATE_KEY_1]\nend');
  });

  it('a PGP private key block is one finding', () => {
    const block = j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOYBF4xyzPGPbody==\n-----END PGP ', 'PRIVATE KEY BLOCK-----');
    expect(scrub(`${block}\n`).text).toBe('[PRIVATE_KEY_1]\n');
  });

  it('an unterminated block (a truncated paste) is masked to its end', () => {
    const cut = j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUA');
    expect(scrub(`pasted: ${cut}`).text).toBe('pasted: [PRIVATE_KEY_1]');
  });

  it('a block inside JSON is masked and the JSON stays valid, with or without its END line', () => {
    const cut = j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUA');
    for (const key of [FAKE.PRIVATE_KEY, cut]) {
      const out = scrub(JSON.stringify({ key, next: 'kept' })).text;
      expect(JSON.parse(out)).toEqual({ key: '[PRIVATE_KEY_1]', next: 'kept' });
    }
  });
});

describe('ordinary text is kept', () => {
  const keep = [
    '',
    'git clone git@github.com:example-org/example-repo.git',
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'session 3f2a1b4c-1111-2222-3333-444455556666',
    'tx 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'import type { Node } from "@types/node"',
    'ssh deploy@localhost',
    'src/components/UserProfileSettingsPanel.tsx',
    // Stripe publishable keys are meant to be public.
    j('pk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
    'sk-short',
  ];
  for (const line of keep) it(`keeps: ${JSON.stringify(line)}`, () => expect(scrub(line)).toEqual({ text: line, findings: [], map: {} }));
});
