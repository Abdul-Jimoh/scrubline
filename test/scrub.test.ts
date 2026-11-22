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

  it('masks a Telegram token whose random half holds -sk- (found by the test generator)', () => {
    const token = j('00000000', ':', 'AAAAA-s', 'k-AAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(scrub(`bot ${token} end`).text).toBe('bot [TELEGRAM_BOT_TOKEN_1] end');
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

  it('masks a password in JSON, including JSON that escapes slashes or non-ASCII letters, and the JSON stays valid', () => {
    const json = JSON.stringify({ url: `postgres://app:${pw}@db/x`, back: 'postgres://app:pa\\ss@db/x', next: 'kept' });
    expect(JSON.parse(scrub(json).text)).toEqual({
      url: 'postgres://app:[URL_PASSWORD_1]@db/x',
      back: 'postgres://app:[URL_PASSWORD_2]@db/x',
      next: 'kept',
    });
    // Python's json.dumps writes é as \u00e9 (found by the verifier).
    expect(scrub('{"url": "postgres://app:p\\u00e9ss@host/x"}').text).toBe('{"url": "postgres://app:[URL_PASSWORD_1]@host/x"}');
    const php = json.replaceAll('/', '\\/');
    expect(JSON.parse(scrub(php).text).url).toBe('postgres://app:[URL_PASSWORD_1]@db/x');
  });

  it('a key used as the password keeps its own type', () => {
    expect(scrub(`https://x-access-token:${FAKE.GITHUB_TOKEN}@github.com/org/repo.git`).text).toBe(
      'https://x-access-token:[GITHUB_TOKEN_1]@github.com/org/repo.git',
    );
  });

  it('a key as the user name does not hide the password (found by the verifier)', () => {
    // An AWS key ID and secret in an s3n:// or s3a:// URL, as Hadoop configs write them, also percent-encoded.
    const secret = j('wJalrXUtnFEMI', '%2FK7MDENG%2F', 'bPxRfiCYEXAMPLEKEY');
    expect(scrub(`s3n://${FAKE.AWS_KEY}:${secret}@bucket/path`).text).toBe('s3n://[AWS_KEY_1]:[URL_PASSWORD_1]@bucket/path');
    expect(JSON.parse(scrub(JSON.stringify({ fs: `s3a://${FAKE.AWS_KEY}:${secret}@bucket` })).text)).toEqual({
      fs: 's3a://[AWS_KEY_1]:[URL_PASSWORD_1]@bucket',
    });
    expect(scrub(`https://${FAKE.JWT}:${pw}@host/x`).text).toBe('https://[JWT_1]:[URL_PASSWORD_1]@host/x');
    expect(scrub(`https://${FAKE.GITHUB_TOKEN}:${pw}@localhost/x`).text).toBe('https://[GITHUB_TOKEN_1]:[URL_PASSWORD_1]@localhost/x');
    expect(scrub(`postgres://[USER_1]:${pw}@host/x`).text).toBe('postgres://[USER_1]:[URL_PASSWORD_1]@host/x');
  });

  it('a key inside a password keeps its type, and the rest of the password is masked around it (found by the verifier)', () => {
    const { text, map } = scrub(`postgres://app:xx-${FAKE.GITHUB_TOKEN}@host/x and postgres://app:${FAKE.AWS_KEY}!tail@host/x`);
    expect(text).toBe('postgres://app:[URL_PASSWORD_1][GITHUB_TOKEN_1]@host/x and postgres://app:[AWS_KEY_1][URL_PASSWORD_2]@host/x');
    expect(map['[URL_PASSWORD_1]']).toBe('xx-');
    expect(map['[URL_PASSWORD_2]']).toBe('!tail');
    // A placeholder-shaped text in a password is left as typed, so restore stays exact.
    const input = `postgres://app:pa[EMAIL_1]ss@db/x`;
    const r = scrub(input);
    expect(r.text).toBe('postgres://app:[URL_PASSWORD_1][EMAIL_1][URL_PASSWORD_2]@db/x');
    expect(restore(r.text, r.map)).toBe(input);
  });

  it('masks a password holding a raw #, ? or / (found by the verifier)', () => {
    for (const secret of ['Pa#ssw0rd', 'Pa?ss', 'ab/cd+ef==', 'a/b?c#d'])
      expect(scrub(`mysql://root:${secret}@localhost:3306/app?x=1`).text).toBe('mysql://root:[URL_PASSWORD_1]@localhost:3306/app?x=1');
    expect(scrub('redis://:Pa#ss@cache:6379').text).toBe('redis://:[URL_PASSWORD_1]@cache:6379');
  });

  it('an address as the user name does not stop a password with a raw / or # being masked (found by the verifier)', () => {
    const input = `postgres://${FAKE.EMAIL}:ab/cd@db/x smtp://${FAKE.EMAIL}:Pa#ss@smtp.example.com:587`;
    const { text } = scrub(input);
    expect(text).toBe('postgres://[EMAIL_1]:[URL_PASSWORD_1]@db/x smtp://[EMAIL_1]:[URL_PASSWORD_2]@smtp.example.com:587');
    expect(scrub(text).findings).toEqual([]);
    // A user name with an @ and a port is still a port.
    expect(scrub('postgres://app@db:5432/x?e=a@b.co').findings.filter((f) => f.kind === 'URL_PASSWORD')).toEqual([]);
  });

  it('a bracketed or placeholder user name, or a password starting with #, / or ?, still masks it (found by the verifier)', () => {
    expect(scrub('postgres://[USER_1]:ab/cd@host/x').text).toBe('postgres://[USER_1]:[URL_PASSWORD_1]@host/x');
    expect(scrub('postgres://[admin]:Pa#ss@host/x').text).toBe('postgres://[admin]:[URL_PASSWORD_1]@host/x');
    for (const secret of ['#Secret1', '/abcSecret', '?abc'])
      expect(scrub(`postgres://app:${secret}@db/x`).text).toBe('postgres://app:[URL_PASSWORD_1]@db/x');
  });

  it('a / in a password in JSON that escapes slashes is masked with the rest (found by the verifier)', () => {
    const php = JSON.stringify({ u: 'postgres://app:ab/cd@db.internal/x' }).replaceAll('/', '\\/');
    expect(JSON.parse(scrub(php).text)).toEqual({ u: 'postgres://app:[URL_PASSWORD_1]@db.internal/x' });
  });

  it('a port, an IPv6 host or a path with an address is not read as a password', () => {
    for (const line of [
      'http://localhost:8080/login?next=/x&email=a@b.co',
      'http://host:8080?to=a@b.co',
      'http://[::1]:80/x?e=a@b.co',
      // A user name before an IPv6 host (found by Qodo in the review of PR #13).
      'postgres://app@[::1]:5432/x?e=a@b.co',
      'postgres://app@[fe80::1]/x?e=a@b.co',
      'https://example.com/a:b/c@d',
    ])
      expect(scrub(line).findings.filter((f) => f.kind === 'URL_PASSWORD')).toEqual([]);
  });

  it('JSON inside a JSON string does not run one URL into the next field (found by the verifier)', () => {
    const inner = JSON.stringify({ url: 'postgres://app@host', email: FAKE.EMAIL });
    const out = scrub(JSON.stringify(inner)).text;
    expect(JSON.parse(JSON.parse(out))).toEqual({ url: 'postgres://app@host', email: '[EMAIL_1]' });
  });

  it('masks the password when a key glued to the scheme claims the scheme too (found by the test generator)', () => {
    expect(scrub(`${FAKE.OPENAI_KEY}-postgres://:${pw}@db`).text).toBe('[OPENAI_KEY_1]://:[URL_PASSWORD_1]@db');
  });

  it('a user name that is an address is masked as an email, and the password separately', () => {
    expect(scrub(`smtp://${FAKE.EMAIL}:${pw}@mail.example.com:587`).text).toBe('smtp://[EMAIL_1]:[URL_PASSWORD_1]@mail.example.com:587');
  });

  it('scrubbing the output again finds nothing new', () => {
    const input = `postgres://app:${pw}@db/x https://u:x${FAKE.GITHUB_TOKEN}@h postgres://u:p@h,${FAKE.EMAIL} ${j(
      // Found by the test generator: a password read past its path, then a key and a later @.
      'postgres://:aaaa/AAAAAAAA@aa&token=',
      FAKE.JWT,
      '-a@a.aa',
    )} postgres://app:hunter2@db,[URL_PASSWORD_1],${FAKE.EMAIL} x://u:pw@h[URL_PASSWORD_1]b@c.co`;
    expect(scrub(scrub(input).text).findings).toEqual([]);
  });

  // Known limits (README): the trade-offs named in findUrlPasswords, pinned here.
  it('known limit: a password holding whitespace, a control character, a quote, <>`{}| or a backslash is not masked', () => {
    for (const ch of [' ', '\t', '\x01', '"', '<', '>', '`', '{', '}', '|', '\\q', '\x7f'])
      expect(scrub(`postgres://app:pa${ch}ss@db/x`).findings).toEqual([]);
    // A quote in JSON-encoded text, written \".
    expect(scrub(JSON.stringify({ u: 'postgres://app:pa"ss@db/x' })).findings).toEqual([]);
  });

  it('known limit: a password that is all digits before a /, ? or # is read as a port; one with / and @ is cut at the @', () => {
    expect(scrub('postgres://u:1234/x@host/db').findings).toEqual([]);
    expect(scrub('postgres://u:ab/c@d@host/db').text).toBe('postgres://u:[URL_PASSWORD_1]@d@host/db');
    // The @ before the /: the part after it stays visible too.
    expect(scrub('postgres://u:ab@c/d@host/db').text).toBe('postgres://u:[URL_PASSWORD_1]@c/d@host/db');
  });

  it('known limit: a password starting with the text [URL_PASSWORD_N] is not masked (it reads as scrubbed output)', () => {
    expect(scrub('postgres://u:[URL_PASSWORD_1]ss@host/db').findings).toEqual([]);
    expect(scrub(`postgres://u:${FAKE.AWS_KEY}[URL_PASSWORD_1]tail@host/x`).text).toBe('postgres://u:[AWS_KEY_1][URL_PASSWORD_1]tail@host/x');
    expect(scrub('postgres://u:pa[URL_PASSWORD_1]ss@host/db').text).toBe('postgres://u:[URL_PASSWORD_2][URL_PASSWORD_1][URL_PASSWORD_3]@host/db');
  });

  it('known limit: a password holding :// or starting with // is not masked', () => {
    for (const line of ['postgres://app:a://b@host', 'postgres://app://b@host'])
      expect(scrub(line).findings.filter((f) => f.kind === 'URL_PASSWORD')).toEqual([]);
  });

  it('known limit: a port that is not digits, or empty, with an @ later in the path is masked as a password', () => {
    expect(scrub('http://host:port/path?to=a@b.co').text).toBe('http://host:[URL_PASSWORD_1]@b.co');
    expect(scrub('http://host:/path?to=a@b.co').text).toBe('http://host:[URL_PASSWORD_1]@b.co');
  });

  it('known limit: user:password@host with no scheme is not detected', () => {
    expect(scrub(`curl -u app:${pw}@db`).findings).toEqual([]);
  });

  it('known limit: an address glued to the host by punctuation is masked with the password, leaving its domain', () => {
    for (const glue of [';', '=', "'", '&', '+'])
      expect(scrub(`postgres://app:${pw}@db${glue}${FAKE.EMAIL}`).text).toBe('postgres://app:[URL_PASSWORD_1]@example.com');
    expect(scrub(`url='postgres://app:${pw}@db',email='${FAKE.EMAIL}'`).text).toBe("url='postgres://app:[URL_PASSWORD_1]@example.com'");
    const { text, map } = scrub(`postgres://app:${pw}@db,${FAKE.EMAIL}`);
    expect(text).toBe('postgres://app:[URL_PASSWORD_1]@example.com');
    expect(map['[URL_PASSWORD_1]']).toBe(`${pw}@db,jane.doe`);
    // Found by the test generator.
    expect(scrub('postgres://:AAAAAAAAAAAA@aa:a@a.aa ').text).toBe('postgres://:[URL_PASSWORD_1]@a.aa ');
  });
});

describe('known limit: keys joined by a character of their own alphabet', () => {
  it('a key that may hold _ runs on through it into the next key, leaving that key\'s tail visible (found by the test generator)', () => {
    const sendgrid = FAKE.SENDGRID_KEY;
    // `_SG` joins the Anthropic key; `.<id>.<secret>` stays visible.
    expect(scrub(`${FAKE.ANTHROPIC_KEY}_${sendgrid}`).text).toBe(`[ANTHROPIC_KEY_1]${sendgrid.slice(2)}`);
  });

  it('a Telegram token after such a key is masked whole: it is matched first (found by the verifier, fixed after)', () => {
    const telegram = FAKE.TELEGRAM_BOT_TOKEN;
    expect(scrub(`${FAKE.OPENAI_KEY}_${telegram}`).text).toBe('[OPENAI_KEY_1][TELEGRAM_BOT_TOKEN_1]');
    expect(scrub(`${FAKE.SLACK_TOKEN}-${telegram}`).text).toBe('[SLACK_TOKEN_1][TELEGRAM_BOT_TOKEN_1]');
    expect(scrub(`${FAKE.JWT}-${telegram}`).text).toBe('[JWT_1][TELEGRAM_BOT_TOKEN_1]');
  });

  it('a key whose body holds another prefix after - is split; a short start stays visible (found by the test generator)', () => {
    expect(scrub(j('xox', 'b-s', 'k-', 'A'.repeat(20))).text).toBe(j('xox', 'b-[OPENAI_KEY_1]'));
    expect(scrub(j('xox', 'b-1234-s', 'k-', 'A'.repeat(20))).text).toBe(j('xox', 'b-1234-[OPENAI_KEY_1]'));
    // Long enough for its own format, the start is masked too.
    expect(scrub(j('xox', 'b-123456789-s', 'k-', 'A'.repeat(20))).text).toBe('[SLACK_TOKEN_1][OPENAI_KEY_1]');
  });

  it('a JWT runs on the same way into a SendGrid key', () => {
    expect(scrub(`${FAKE.JWT}_${FAKE.SENDGRID_KEY}`).text).toBe(`[JWT_1]${FAKE.SENDGRID_KEY.slice(2)}`);
  });
});

describe('home-directory paths (issue #5)', () => {
  const mask = (s: string) => scrub(s).text;

  it('masks the name in /Users, /home and Windows paths on any drive, JSON-escaped too; the rest of the path is kept', () => {
    expect(mask('at Object.<anonymous> (/Users/jane/projects/app/index.js:3:9)')).toBe(
      'at Object.<anonymous> (/Users/[HOME_USER_1]/projects/app/index.js:3:9)',
    );
    expect(mask('open /home/jane/.bashrc')).toBe('open /home/[HOME_USER_1]/.bashrc');
    expect(mask(String.raw`at C:\Users\jane\app\index.js:3:9`)).toBe(String.raw`at C:\Users\[HOME_USER_1]\app\index.js:3:9`);
    expect(mask(String.raw`D:\Users\jane\x`)).toBe(String.raw`D:\Users\[HOME_USER_1]\x`);
    expect(mask(String.raw`{"path":"C:\\Users\\jane\\app\\index.js"}`)).toBe(
      String.raw`{"path":"C:\\Users\\[HOME_USER_1]\\app\\index.js"}`,
    );
    expect(mask('C:/Users/jane/app')).toBe('C:/Users/[HOME_USER_1]/app');
    expect(mask(String.raw`c:\users\jane\x`)).toBe(String.raw`c:\users\[HOME_USER_1]\x`);
  });

  it('masks a Windows path in JSON inside JSON (found by the test generator)', () => {
    const doc = JSON.stringify({ msg: JSON.stringify({ path: String.raw`C:\Users\jane\x` }) });
    const out = scrub(doc).text;
    expect(JSON.parse(JSON.parse(out).msg)).toEqual({ path: String.raw`C:\Users\[HOME_USER_1]\x` });
  });

  it('masks the name when a key glued on by - or _ ran on into the drive letter (found by the test generator)', () => {
    expect(mask(String.raw`${FAKE.JWT}-C:\Users\jane\x`)).toBe(String.raw`[JWT_1]:\Users\[HOME_USER_1]\x`);
    expect(mask(`${FAKE.ANTHROPIC_KEY}_C:/Users/jane`)).toBe('[ANTHROPIC_KEY_1]:/Users/[HOME_USER_1]');
    // The same with `file://`: the key takes `file`.
    expect(mask(`${FAKE.OPENAI_KEY}_file:///Users/jane `)).toBe('[OPENAI_KEY_1]:///Users/[HOME_USER_1] ');
  });

  it('a name that runs on into the drive letter of a Windows home path ends before it (found by the test generator)', () => {
    expect(mask(String.raw`/Users/jane%3D%20d:\users\bob x`)).toBe(String.raw`/Users/[HOME_USER_1]d:\users\[HOME_USER_2] x`);
    expect(mask(String.raw`/home/d:\Users\bob`)).toBe(String.raw`/home/d:\Users\[HOME_USER_1]`);
    // Glued to a letter, the drive letter is part of the name, and what follows is not a home path (`xC:\Users\…`).
    expect(mask(String.raw`/home/janed:\Users\bob`)).toBe(String.raw`/home/[HOME_USER_1]:\Users\bob`);
  });

  it('a Windows name after a single backslash keeps the backslash outside the mask', () => {
    const { findings } = scrub(String.raw`C:\Users\nancy\x`);
    expect(findings).toEqual([{ kind: 'HOME_USER', placeholder: '[HOME_USER_1]', start: 9, end: 14 }]);
  });

  it('masks the name at the end of a path: before a space, a quote, a colon or the end of the text', () => {
    expect(mask('cd /home/jane now')).toBe('cd /home/[HOME_USER_1] now');
    expect(mask('HOME="/home/jane"')).toBe('HOME="/home/[HOME_USER_1]"');
    expect(mask("HOME='/home/jane'")).toBe("HOME='/home/[HOME_USER_1]'");
    expect(mask('PATH=/home/jane:/usr/bin')).toBe('PATH=/home/[HOME_USER_1]:/usr/bin');
    expect(mask('cd /home/jane')).toBe('cd /home/[HOME_USER_1]');
    expect(mask(String.raw`C:\Users\jane`)).toBe(String.raw`C:\Users\[HOME_USER_1]`);
    expect(mask('/Users/jane\n')).toBe('/Users/[HOME_USER_1]\n');
  });

  it('a dot that ends a sentence is not part of the name; dots inside it are', () => {
    expect(scrub('files are in /home/jane.doe.').map).toEqual({ '[HOME_USER_1]': 'jane.doe' });
  });

  it('keeps shared folders and a home root with no name', () => {
    for (const kept of [
      '/Users/Shared/file',
      '/Users/Shared',
      String.raw`C:\Users\Public\Desktop`,
      String.raw`C:\Users\Default\NTUSER.DAT`,
      String.raw`C:\Users\All Users\x`,
      String.raw`C:\\Users\\public\\x`,
      'ls /home/',
      'ls /home/ now',
      '/home//x',
      '/home',
    ])
      expect(scrub(kept).findings, kept).toEqual([]);
    // Only the whole folder name is shared.
    expect(mask('/Users/Sharedjane/x')).toBe('/Users/[HOME_USER_1]/x');
    expect(mask('/home/all users')).toBe('/home/all users');
    expect(mask('/home/all usersx')).toBe('/home/[HOME_USER_1] usersx');
  });

  it('only at a path boundary', () => {
    for (const kept of ['/opt/home/x', 'foo/Users/x', './home/x', 'xC:\\Users\\jane', 'https://example.com/home/jane'])
      expect(scrub(kept).findings, kept).toEqual([]);
    expect(mask('file:///Users/jane/a.js')).toBe('file:///Users/[HOME_USER_1]/a.js');
    expect(mask('file:///C:/Users/jane/a.js')).toBe('file:///C:/Users/[HOME_USER_1]/a.js');
    // After an escape in JSON, or after punctuation.
    expect(mask(String.raw`"a\n/home/jane\t/Users/jane"`)).toBe(String.raw`"a\n/home/[HOME_USER_1]\t/Users/[HOME_USER_1]"`);
    expect(mask('(/home/jane) [/Users/jane] -/home/jane _/home/jane')).toBe(
      '(/home/[HOME_USER_1]) [/Users/[HOME_USER_1]] -/home/[HOME_USER_1] _/home/[HOME_USER_1]',
    );
  });

  it('the same name gets the same placeholder across paths, and restore round-trips', () => {
    const input = String.raw`/Users/jane/a /home/jane/b C:\Users\jane\c "C:\\Users\\jane\\d" /home/bob/e`;
    const { text, map } = scrub(input);
    expect(text).toBe(
      String.raw`/Users/[HOME_USER_1]/a /home/[HOME_USER_1]/b C:\Users\[HOME_USER_1]\c "C:\\Users\\[HOME_USER_1]\\d" /home/[HOME_USER_2]/e`,
    );
    expect(map).toEqual({ '[HOME_USER_1]': 'jane', '[HOME_USER_2]': 'bob' });
    expect(restore(text, map)).toBe(input);
  });

  it('a JSON document with home paths stays valid JSON', () => {
    const doc = JSON.stringify({ a: String.raw`C:\Users\nancy\x`, b: '/home/jos\u00e9/x', c: '/home/rita\n' });
    const out = scrub(doc).text;
    expect(JSON.parse(out)).toEqual({ a: String.raw`C:\Users\[HOME_USER_1]\x`, b: '/home/[HOME_USER_2]/x', c: '/home/[HOME_USER_3]\n' });
    // A non-ASCII letter written as \uXXXX is part of the name.
    const escaped = String.raw`"/home/jos\u00e9/x"`;
    expect(scrub(escaped).map).toEqual({ '[HOME_USER_1]': String.raw`jos\u00e9` });
  });

  it('an ASCII letter written as \\uXXXX is part of the name too, so JSON stays valid (found by Qodo in the review of PR #18)', () => {
    for (const [doc, name] of <[string, string][]>[
      [String.raw`"/home/\u006aane/x"`, String.raw`\u006aane`],
      [String.raw`"/home/ja\u006Ee/x"`, String.raw`ja\u006Ee`],
      [String.raw`"C:\\Users\\\u006aane\\x"`, String.raw`\u006aane`],
    ]) {
      const { text, map } = scrub(doc);
      expect(Object.values(map), doc).toEqual([name]);
      expect(JSON.parse(text), doc).toMatch(/[/\\]\[HOME_USER_1\][/\\]x$/);
    }
    // An escaped separator or quote still ends the name.
    expect(scrub(String.raw`"/home/jane\u002fx"`).map).toEqual({ '[HOME_USER_1]': 'jane' });
    expect(scrub(String.raw`"/home/jane\u0022x"`).map).toEqual({ '[HOME_USER_1]': 'jane' });
  });

  it('a Windows home root in any case, and FILE:// in any case (found by Qodo in the review of PR #18)', () => {
    for (const root of ['uSeRs', 'USers', 'usERS'])
      expect(mask(`C:\\${root}\\jane\\x`), root).toBe(`C:\\${root}\\[HOME_USER_1]\\x`);
    expect(mask(String.raw`/home/d:\uSeRs\bob`)).toBe(String.raw`/home/d:\uSeRs\[HOME_USER_1]`);
    expect(mask('FILE:///Users/alice/x')).toBe('FILE:///Users/[HOME_USER_1]/x');
    expect(mask('File:///home/alice/x')).toBe('File:///home/[HOME_USER_1]/x');
  });

  it('a name that is also an address is masked as the user name; a key in the name keeps its type', () => {
    expect(mask(`/home/${FAKE.EMAIL}/x`)).toBe('/home/[HOME_USER_1]/x');
    expect(mask(`/home/${FAKE.AWS_KEY}/x`)).toBe('/home/[AWS_KEY_1]/x');
  });

  it('scrubbing the output again finds nothing new', () => {
    const once = mask(String.raw`/Users/jane/a C:\Users\jane\b C:\\Users\\bob\\c /home/x-${FAKE.GITHUB_TOKEN}`);
    expect(scrub(once).findings).toEqual([]);
  });

  describe('known limits', () => {
    it('a Windows name with a space, apostrophe or parenthesis is masked only up to it', () => {
      expect(mask(String.raw`C:\Users\Jane Doe\x`)).toBe(String.raw`C:\Users\[HOME_USER_1] Doe\x`);
      expect(mask(String.raw`C:\Users\O'Brien\x`)).toBe(String.raw`C:\Users\[HOME_USER_1]'Brien\x`);
      expect(mask(String.raw`C:\Users\jane(2)\x`)).toBe(String.raw`C:\Users\[HOME_USER_1](2)\x`);
    });

    it('relative paths, mixed Windows separators, slash-escaped JSON and other home roots are not detected', () => {
      for (const kept of [
        '../home/jane/x',
        'x//home/jane',
        String.raw`C:/Users\jane\x`,
        '/users/jane/x',
        String.raw`"\/home\/jane"`,
        '~/x',
        '/root/x',
        String.raw`C:\Documents and Settings\jane`,
      ])
        expect(scrub(kept).findings, kept).toEqual([]);
    });

    it('a person whose user name is a shared folder name is not masked, and a final dot stays visible', () => {
      expect(mask('/home/public/x')).toBe('/home/public/x');
      expect(scrub('/home/jane./x').map).toEqual({ '[HOME_USER_1]': 'jane' });
    });
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

describe('continuing from an earlier map (issue #4)', () => {
  const other = j('ops', '@', 'example.org');

  it('keeps earlier placeholders and numbers new values after them', () => {
    const first = scrub(`mail ${FAKE.EMAIL}`);
    const { text, map } = scrub(`${other} and ${FAKE.EMAIL}`, { map: first.map });
    expect(text).toBe('[EMAIL_2] and [EMAIL_1]');
    expect(map).toEqual({ '[EMAIL_1]': FAKE.EMAIL, '[EMAIL_2]': other });
  });

  it('never reuses a number from the map, even for a kind not in the input', () => {
    const { text } = scrub(FAKE.EMAIL, { map: { '[EMAIL_1]': 'x', '[EMAIL_3]': 'y', '[AWS_KEY_1]': 'z' } });
    expect(text).toBe('[EMAIL_2]');
  });

  it('a placeholder in the input that is in the map restores to its value', () => {
    const { map } = scrub(FAKE.EMAIL);
    const next = scrub('as I said, [EMAIL_1]', { map });
    expect(restore(next.text, next.map)).toBe(`as I said, ${FAKE.EMAIL}`);
  });

  it('rejects a map entry that is not a placeholder and a string, without echoing it', () => {
    const bad = { token: FAKE.GITHUB_TOKEN } as Record<string, string>;
    expect(() => scrub('x', { map: bad })).toThrow(TypeError);
    try {
      scrub('x', { map: bad });
    } catch (e) {
      expect(String(e)).not.toContain(FAKE.GITHUB_TOKEN);
    }
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
