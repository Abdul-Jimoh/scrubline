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

describe('numbering', () => {
  const other = j('ops', '@', 'example-corp.io');

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

describe('priority between overlapping formats', () => {
  it('an Anthropic key is not reported as an OpenAI-style key', () => {
    expect(scrub(FAKE.ANTHROPIC_KEY).text).toBe('[ANTHROPIC_KEY_1]');
  });

  it('a private key block is one finding, whatever it contains', () => {
    const block = j('-----BEGIN ', 'RSA PRIVATE KEY-----\n', FAKE.EMAIL, '\n-----END ', 'RSA PRIVATE KEY-----');
    expect(scrub(`key:\n${block}\nend`).text).toBe('key:\n[PRIVATE_KEY_1]\nend');
  });

  it('an unterminated private key block (a truncated paste) is masked to the end', () => {
    const cut = j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUA');
    expect(scrub(`pasted: ${cut}`).text).toBe('pasted: [PRIVATE_KEY_1]');
  });
});

describe('ordinary text is kept', () => {
  const keep = [
    '',
    'git clone git@github.com:openserv-labs/skills.git',
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
