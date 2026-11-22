import { describe, expect, it } from 'vitest';
import { DETECTORS, restore, scrub } from '../src/index.js';
import { AROUND, FAKE, j } from './fixtures.js';

describe('every built-in detector masks its format with a typed placeholder', () => {
  it('has a fake sample for every detector', () => {
    expect(Object.keys(FAKE).sort()).toEqual(DETECTORS.map((d) => d.kind).sort());
  });

  for (const [kind, value] of Object.entries(FAKE)) {
    it(kind, () => {
      const [pre, post] = AROUND[kind as keyof typeof FAKE] ?? ['', ''];
      const { text, map, findings } = scrub(`before ${pre}${value}${post} after`);
      expect(text).toBe(`before ${pre}[${kind}_1]${post} after`);
      expect(map).toEqual({ [`[${kind}_1]`]: value });
      const start = 7 + pre.length;
      expect(findings).toEqual([{ kind, placeholder: `[${kind}_1]`, start, end: start + value.length }]);
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

  it('masks a JWT right after an underscore or a hyphen (found by Qodo in the review of PR #1)', () => {
    expect(scrub(`jwt_${FAKE.JWT}`).text).toBe('jwt_[JWT_1]');
    expect(scrub(`auth-${FAKE.JWT} next`).text).toBe('auth-[JWT_1] next');
    expect(scrub(`{"id_token":"x_${FAKE.JWT}"}`).text).toBe('{"id_token":"x_[JWT_1]"}');
    // Glued to a letter or digit it is not a token boundary, as for every other kind.
    expect(scrub(`x${FAKE.JWT}`).text).toBe(`x${FAKE.JWT}`);
  });

  it('masks addresses joined to each other (found by the test generator after the JWT fix)', () => {
    for (const sep of ['_', '-', '.', '+', '__']) {
      const { text, map } = scrub(`a@b.co${sep}c@d.co and c@d.co`);
      // The joining characters stay outside the mask, so the second address keeps one placeholder everywhere.
      expect(text).toBe(`[EMAIL_1]${sep}[EMAIL_2] and [EMAIL_2]`);
      expect(restore(text, map)).toBe(`a@b.co${sep}c@d.co and c@d.co`);
    }
    expect(scrub('a@b.co_git@github.com:org/repo').text).toBe('[EMAIL_1]_git@github.com:org/repo');
    expect(scrub('a@b.co_c@d.co@e.com').text).toBe('[EMAIL_1]_c@[EMAIL_2]');
  });

  it('masks fixed-length keys followed by an underscore or a hyphen (found by the test generator after the JWT fix)', () => {
    expect(scrub(`${FAKE.GOOGLE_API_KEY}_prod`).text).toBe('[GOOGLE_API_KEY_1]_prod');
    expect(scrub(`${FAKE.TELEGRAM_BOT_TOKEN}-bot`).text).toBe('[TELEGRAM_BOT_TOKEN_1]-bot');
  });

  it('masks keys inside a JSON-escaped log line, and the line stays valid JSON', () => {
    const msg = `line1\n${FAKE.GITHUB_TOKEN}\t${FAKE.AWS_KEY}\n${FAKE.ANTHROPIC_KEY}\n${FAKE.EMAIL}\r${FAKE.JWT}`;
    const out = scrub(JSON.stringify({ msg })).text;
    expect(JSON.parse(out)).toEqual({
      msg: 'line1\n[GITHUB_TOKEN_1]\t[AWS_KEY_1]\n[ANTHROPIC_KEY_1]\n[EMAIL_1]\r[JWT_1]',
    });
  });

  it('masks a Telegram token in its usual place, the API URL path', () => {
    const url = `https://api.telegram.org/bot${FAKE.TELEGRAM_BOT_TOKEN}/sendMessage`;
    expect(scrub(url).text).toBe('https://api.telegram.org/bot[TELEGRAM_BOT_TOKEN_1]/sendMessage');
  });

  it('masks keys after ANSI colour codes, raw or JSON-escaped, and after URL-encoded bytes', () => {
    expect(scrub(`\x1b[32m${FAKE.GITHUB_TOKEN}\x1b[0m`).text).toBe('\x1b[32m[GITHUB_TOKEN_1]\x1b[0m');
    expect(scrub(`\\u001b[1m${FAKE.AWS_KEY}`).text).toBe('\\u001b[1m[AWS_KEY_1]');
    expect(scrub(`token%3D${FAKE.GITHUB_TOKEN}&x=1`).text).toBe('token%3D[GITHUB_TOKEN_1]&x=1');
    expect(scrub(`Bearer%20${FAKE.OPENAI_KEY}`).text).toBe('Bearer%20[OPENAI_KEY_1]');
  });

  it('never starts a match inside a \\uXXXX escape, so JSON with control characters stays valid', () => {
    for (const value of [FAKE.TELEGRAM_BOT_TOKEN, FAKE.EMAIL, FAKE.AWS_KEY]) {
      const out = scrub(JSON.stringify({ m: `\x01${value}` })).text;
      expect(JSON.parse(out).m).toMatch(/^\x01\[[A-Z_]+_1\]$/);
    }
    // Four hex digits followed by `@b.co` is not an email: the digits belong to the escape.
    expect(JSON.parse(scrub(JSON.stringify({ m: '\x01@b.co' })).text)).toEqual({ m: '\x01@b.co' });
  });

  it('a token whose first letter could end an escape takes the backslash with it, so JSON stays valid', () => {
    // `\n` + `pm_…` reads as a newline then `pm_…`, or as a backslash then an npm token; mask either way.
    const npm = FAKE.NPM_TOKEN.slice(1);
    const stripe = FAKE.STRIPE_KEY.slice(1);
    for (const m of [`\n${npm}`, `x\r${stripe}`]) {
      const json = JSON.stringify({ m });
      const { text, map } = scrub(json);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(text).not.toContain(npm);
      expect(text).not.toContain(stripe);
      expect(restore(text, map)).toBe(json);
    }
    // A backslash that is itself escaped (`\\`) is left alone.
    expect(scrub(`C:\\\\${FAKE.NPM_TOKEN}`).text).toBe('C:\\\\[NPM_TOKEN_1]');
  });

  it('masks an address after a backslash that is not an escape (DOMAIN\\user style)', () => {
    const { text, map } = scrub(`CORP\\${FAKE.EMAIL}`);
    expect(text).toBe('CORP[EMAIL_1]');
    expect(map['[EMAIL_1]']).toBe(`\\${FAKE.EMAIL}`);
  });

  it('masks an address right after a % that does not start a URL-encoded byte', () => {
    expect(scrub(`a%${FAKE.EMAIL}`).text).toBe('a%[EMAIL_1]');
    expect(scrub(`x %${FAKE.EMAIL}`).text).toBe('x %[EMAIL_1]');
    expect(scrub(`token%3D${FAKE.EMAIL}`).text).toBe('token%3D[EMAIL_1]');
  });

  it('a lower-priority match that overlaps a key does not hide a real value inside it', () => {
    // The email pattern first matches from `npm_…` (its local part allows `_` and `%`); found by fast-check.
    expect(scrub(`${FAKE.NPM_TOKEN}%3D${FAKE.EMAIL}`).text).toBe('[NPM_TOKEN_1]%3D[EMAIL_1]');
  });

  it('does not mask a key prefix inside a longer word', () => {
    for (const line of ['risk-assessment-for-the-quarter-2026', 'fork_test_handlesEverythingNicely', 'EURASIAN1234567890ABCDEFGH'])
      expect(scrub(line).text).toBe(line);
  });
});

describe('passwords in URLs (issue #3)', () => {
  const pw = FAKE.URL_PASSWORD;

  it('masks only the password, for any scheme', () => {
    for (const scheme of ['postgres', 'postgresql', 'mysql', 'mongodb+srv', 'redis', 'amqp', 'https', 'git+ssh']) {
      const url = `${scheme}://app:${pw}@db.internal:5432/prod?sslmode=require`;
      expect(scrub(`DATABASE_URL=${url}`).text).toBe(`DATABASE_URL=${scheme}://app:[URL_PASSWORD_1]@db.internal:5432/prod?sslmode=require`);
    }
  });

  it('gives the same password the same placeholder in two URLs, and restores exactly', () => {
    const input = `primary postgres://app:${pw}@a.internal/db replica postgres://ro:${pw}@b.internal/db`;
    const { text, map } = scrub(input);
    expect(text).toBe('primary postgres://app:[URL_PASSWORD_1]@a.internal/db replica postgres://ro:[URL_PASSWORD_1]@b.internal/db');
    expect(restore(text, map)).toBe(input);
  });

  it('masks a URL-encoded password whole, and one with a raw @ or : up to the last @', () => {
    expect(scrub('mysql://root:p%40ss%3Aw0rd@localhost/app').text).toBe('mysql://root:[URL_PASSWORD_1]@localhost/app');
    const { text, map } = scrub('redis://u:p@ss:w0rd@cache:6379');
    expect(text).toBe('redis://u:[URL_PASSWORD_1]@cache:6379');
    expect(map['[URL_PASSWORD_1]']).toBe('p@ss:w0rd');
  });

  it('masks a password with no user name, and not an empty one', () => {
    expect(scrub(`redis://:${pw}@cache:6379`).text).toBe('redis://:[URL_PASSWORD_1]@cache:6379');
    expect(scrub('redis://:@cache:6379').findings).toEqual([]);
  });

  it('does not mask a URL with no password, or a :…@ after the authority', () => {
    for (const line of [
      'postgres://app@db.internal/prod',
      'https://db.internal:5432/x',
      'https://example.com/a:b@c',
      'https://example.com/?q=a:b@c',
      'https://example.com?q=a:b@c',
      'https://example.com#a:b@c',
      'see ://a:b@c and a:b@c',
    ])
      // (`app@db.internal` is still masked as an address by the email detector.)
      expect(scrub(line).findings.filter((f) => f.kind === 'URL_PASSWORD')).toEqual([]);
  });

  it('masks a password in JSON, including JSON that escapes slashes or quotes, and the JSON stays valid', () => {
    const json = JSON.stringify({ url: `postgres://app:${pw}@db/x`, quoted: 'postgres://app:pa"ss@db/x', next: 'kept' });
    expect(JSON.parse(scrub(json).text)).toEqual({
      url: 'postgres://app:[URL_PASSWORD_1]@db/x',
      quoted: 'postgres://app:[URL_PASSWORD_2]@db/x',
      next: 'kept',
    });
    const php = json.replaceAll('/', '\\/');
    expect(JSON.parse(scrub(php).text).url).toBe('postgres://app:[URL_PASSWORD_1]@db/x');
  });

  it('a key used as the password keeps its own type', () => {
    expect(scrub(`https://x-access-token:${FAKE.GITHUB_TOKEN}@github.com/org/repo.git`).text).toBe(
      'https://x-access-token:[GITHUB_TOKEN_1]@github.com/org/repo.git',
    );
  });

  it('masks the password when a key glued to the scheme claims the scheme too (found by the test generator)', () => {
    expect(scrub(`${FAKE.OPENAI_KEY}-postgres://:${pw}@db`).text).toBe('[OPENAI_KEY_1]://:[URL_PASSWORD_1]@db');
  });

  it('a user name that is an address is masked as an email, and the password separately', () => {
    expect(scrub(`smtp://${FAKE.EMAIL}:${pw}@mail.example.com:587`).text).toBe('smtp://[EMAIL_1]:[URL_PASSWORD_1]@mail.example.com:587');
  });

  it('scrubbing the output again finds nothing new', () => {
    const input = `postgres://app:${pw}@db/x https://u:x${FAKE.GITHUB_TOKEN}@h postgres://u:p@h,${FAKE.EMAIL}`;
    expect(scrub(scrub(input).text).findings).toEqual([]);
  });

  // Known limits (README): the trade-offs named in findUrlPasswords, pinned here.
  it('known limit: a password holding a raw space, quote or placeholder is not masked', () => {
    for (const line of [
      'postgres://app:pa ss@db/x',
      'postgres://app:pa"ss@db/x',
      'postgres://app:pa<ss@db/x',
      'postgres://app:pa|ss@db/x',
      'postgres://app:pa\\qss@db/x',
      'postgres://app:pa[EMAIL_1]ss@db/x',
    ])
      expect(scrub(line).findings).toEqual([]);
  });

  it('known limit: user:password@host with no scheme is not detected', () => {
    expect(scrub(`curl -u app:${pw}@db`).findings).toEqual([]);
  });

  it('known limit: text glued to the host by , = or ; and holding a later @ is masked with the password', () => {
    const { text, map } = scrub(`postgres://app:${pw}@db,${FAKE.EMAIL}`);
    expect(text).toBe('postgres://app:[URL_PASSWORD_1]@example.com');
    expect(map['[URL_PASSWORD_1]']).toBe(`${pw}@db,jane.doe`);
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

  it('a complete PGP block is one finding, whatever its armour lines hold', () => {
    const block = j(
      '-----BEGIN PGP ',
      'PRIVATE KEY BLOCK-----\nVersion: GnuPG v1.4.11 (GNU/Linux)\nComment: Alice <alice@example.com> "work" key!\n\n',
      'lQOYBF4xyzPGPbody==\n=Ab1c\n-----END PGP ',
      'PRIVATE KEY BLOCK-----',
    );
    expect(scrub(`${block}\n`).text).toBe('[PRIVATE_KEY_1]\n');
  });

  it('a complete block in JSON that escapes slashes (PHP) is one finding', () => {
    const block = j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBg/kqhkiG9w0+BAQEFAASC\nab/cd/ef==\n-----END ', 'PRIVATE KEY-----');
    const php = JSON.stringify({ key: block, next: 'kept' }).replaceAll('/', '\\/');
    expect(JSON.parse(scrub(php).text)).toEqual({ key: '[PRIVATE_KEY_1]', next: 'kept' });
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
