import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  MIN_WINDOW,
  restore,
  scrub,
  scrubStream,
  StreamScrubber,
  type StreamOptions,
} from '../src/index.js';
import { FAKE, j } from './fixtures.js';

/** Pushes each chunk and returns everything written out, plus the map. */
function run(chunks: readonly (string | Uint8Array)[], options?: StreamOptions) {
  const s = new StreamScrubber(options);
  let text = '';
  for (const c of chunks) text += s.push(c);
  return { text: text + s.end(), map: s.map, scrubber: s };
}
const lines = (x: string) => x.split(/(?<=\n)/);
const filler = (n: number) => 'log line ok\n'.repeat(Math.ceil(n / 12)).slice(0, n);

describe('scrubbing a stream', () => {
  it('masks a private key block that arrives line by line as one value', () => {
    const x = `start\n${FAKE.PRIVATE_KEY}\nend\n`;
    const { text } = run(lines(x), { window: 64 });
    expect(text).toBe('start\n[PRIVATE_KEY_1]\nend\n');
    // The same with the window filled several times over before, inside and after the key.
    const long = `${filler(500)}${FAKE.PRIVATE_KEY}\n${filler(500)}`;
    expect(run(lines(long), { window: 64 }).text).toBe(scrub(long).text);
  });

  it('masks a token cut by a chunk boundary, at every cut', () => {
    const x = `${filler(100)}token=${FAKE.GITHUB_TOKEN} next\n${filler(100)}`;
    for (let cut = 0; cut <= x.length; cut++) {
      const { text } = run([x.slice(0, cut), x.slice(cut)], { window: 64 });
      expect(text).toBe(scrub(x).text);
    }
  });

  it('continues an earlier map and keeps one placeholder per value across chunks', () => {
    const earlier = scrub(FAKE.EMAIL).map;
    const x = `${FAKE.EMAIL} ${filler(300)} ${FAKE.EMAIL} ${FAKE.AWS_KEY} [EMAIL_1]`;
    const { text, map } = run(lines(x), { map: earlier, window: 64 });
    expect(text).toBe(scrub(x, { map: earlier }).text);
    expect(map).toEqual(scrub(x, { map: earlier }).map);
  });

  it('decodes UTF-8 bytes split inside a character', () => {
    const x = `naïve café ☕ 😀 ${FAKE.EMAIL} ünïcödé`;
    const bytes = new TextEncoder().encode(x);
    const chunks = Array.from({ length: bytes.length }, (_, i) => bytes.slice(i, i + 1));
    expect(run(chunks, { window: 64 }).text).toBe(scrub(x).text);
  });

  it('known limit: placeholder text that arrives after its number was given out is masked as [PLACEHOLDER_n]', () => {
    // `scrub` reserves `[EMAIL_1]` before numbering, so the address gets `[EMAIL_2]`. A stream has already written
    // `[EMAIL_1]` for the address when the text arrives, so it masks the text instead, and restore still round-trips.
    const x = `${FAKE.EMAIL}\n${filler(200)}see [EMAIL_1] and [EMAIL_7]\n`;
    const { text, map } = run(lines(x), { window: 64 });
    expect(text).toBe(`[EMAIL_1]\n${filler(200)}see [PLACEHOLDER_1] and [EMAIL_7]\n`);
    expect(restore(text, map)).toBe(x);
    expect(scrub(x).text.startsWith('[EMAIL_2]')).toBe(true);
  });

  it('known limit: a value recognised only more than a window after it starts can be written out in part', () => {
    // An address is known only once its `@` and domain arrive; with a window shorter than that, its start has gone
    // out already. The default window is 128 KiB, so this takes an address longer than that.
    const email = j('jane.', 'x'.repeat(100), '@example.com');
    const x = `${filler(100)}${email} ${filler(100)}`;
    const { text } = run(x.match(/[^]{1,3}/g)!, { window: 64 });
    expect(scrub(x).text).not.toContain('jane.');
    expect(text).toContain('jane.');
  });

  it('never writes out half of a placeholder, so restore round-trips (Qodo, PR #22)', () => {
    // With a window of 4, `aaa[` went out before `EMAIL_1]` arrived, the address after it was given `[EMAIL_1]`, and
    // restore turned the typed text into the address. A window shorter than a placeholder is now refused.
    expect(() => new StreamScrubber({ window: 4 })).toThrow(RangeError);
    const x = `${'a'.repeat(100)}[EMAI`;
    const rest = `L_1] ${FAKE.EMAIL} ${filler(200)}`;
    const { text, map } = run([...(x + rest)], { window: MIN_WINDOW });
    expect(restore(text, map)).toBe(x + rest);
    expect(text).toBe(scrub(x + rest).text);
  });

  it('masks a URL password after a user name longer than the window (Qodo, PR #22)', () => {
    const password = j('S3cr3t', '!Pa55$', 'w0rd');
    const x = `${filler(100)}postgres://${'u'.repeat(1000)}:${password}@db.internal/x\n${filler(100)}`;
    const { text } = run(x.match(/[^]{1,16}/g)!, { window: 64 });
    expect(text).toBe(scrub(x).text);
    expect(text).not.toContain('Pa55');
    // With the default window and a 400 KiB user name, in 64 KiB chunks.
    const big = `postgres://${'u'.repeat(400 * 1024)}:${password}@db.internal/x\n`;
    expect(run(big.match(/[^]{1,65536}/g)!).text).toBe(scrub(big).text);
  });

  it('masks a one-letter address after a backslash run longer than the window (Qodo, PR #23)', () => {
    // The address takes at most 32 backslashes, so its start is never written out before `r@` arrives.
    for (const n of [1, 31, 32, 33, 63, 64, 68, 200, 1000]) for (const address of ['r@a.aa', '\\u0072@a.aa']) {
      const x = `${filler(100)}${'\\'.repeat(n)}${address} end\n${filler(100)}`;
      for (const size of [1, 7, 16, 64]) {
        const { text, map } = run(x.match(new RegExp(`[^]{1,${size}}`, 'g'))!, { window: 64 });
        expect(text, `${n} backslashes, chunks of ${size}`).toBe(scrub(x).text);
        expect(text).not.toContain('@a.aa');
        expect(restore(text, map)).toBe(x);
      }
    }
    // Whether a token takes the backslash before it depends on the whole run; the context keeps its parity.
    for (let n = 30; n < 140; n++) {
      const x = `${filler(100)}${'\\'.repeat(n)}${FAKE.NPM_TOKEN} end\n${filler(100)}`;
      expect(run(x.match(/[^]{1,7}/g)!, { window: 64 }).text, `${n} backslashes`).toBe(scrub(x).text);
    }
  });

  it('takes the same backslash run as scrub when a chunk boundary falls inside it (issue #24)', () => {
    // Runs around the 32 cap, before a token and an address that start on an escape letter or an escape, each cut
    // at every point inside the run and inside the match (a token is found only once all of it has arrived); then
    // the whole text in small chunks.
    const npm = FAKE.NPM_TOKEN.slice(1);
    for (const n of [1, 2, 15, 16, 31, 32, 33, 34, 63, 64, 65, 66, 67, 97]) {
      for (const tail of [`n${npm}`, 'r@a.aa', '\\u0072@a.aa']) {
        const head = `${filler(100)}x${'\\'.repeat(n)}`;
        const x = `${head}${tail} end\n${filler(100)}`;
        const whole = scrub(x);
        for (let at = head.length - n; at <= head.length + tail.length; at++) {
          const { text, map } = run([x.slice(0, at), x.slice(at)], { window: 64 });
          const where = `${n} backslashes before ${tail.slice(0, 8)}, cut at ${at - head.length}`;
          // The map too: the same text with a placeholder standing for a different run would restore differently.
          expect({ text, map }, where).toEqual({ text: whole.text, map: whole.map });
          expect(restore(text, map)).toBe(x);
        }
        for (const size of [1, 5, 7, 16]) {
          const { text, map } = run(x.match(new RegExp(`[^]{1,${size}}`, 'g'))!, { window: 64 });
          expect({ text, map }, `chunks of ${size}`).toEqual({ text: whole.text, map: whole.map });
        }
      }
    }
  });

  it('drops a URL from the context once it has ended, escaped line end included (Qodo, PR #22)', () => {
    // After `\n` (two characters, as in JSON), the URL has ended; a long run after it must not stay in memory.
    for (const end of ['\\n', '\\"', ' ', '"']) {
      const x = `postgres://u:${j('S3cr3t', '!Pa55$', 'w0rd')}@db${end}${'a'.repeat(20000)}`;
      const s = new StreamScrubber({ window: 64 });
      let text = '';
      let peak = 0;
      for (const c of x.match(/[^]{1,16}/g)!) {
        text += s.push(c);
        peak = Math.max(peak, s.buffered);
      }
      expect(text + s.end()).toBe(scrub(x).text);
      expect(peak, JSON.stringify(end)).toBeLessThan(1000);
    }
    // A key that took the backslash before it (`\npm_…`) does not end the user name.
    const password = j('S3cr3t', '!Pa55$', 'w0rd');
    const x = `${filler(100)}postgres://u\\${FAKE.NPM_TOKEN}${'u'.repeat(500)}:${password}@db.internal/x\n`;
    expect(run(x.match(/[^]{1,16}/g)!, { window: 64 }).text).toBe(scrub(x).text);
  });

  it('keeps the order of text when a string arrives between the bytes of one character (Qodo, PR #22)', () => {
    const s = new StreamScrubber();
    const text = s.push(new Uint8Array([0xc3])) + s.push('X') + s.push(new Uint8Array([0xa9])) + s.end();
    expect(text).toBe('\ufffdX\ufffd');
  });

  it('holds a match that is longer than the window until it ends, and masks it whole', () => {
    const key = j('ghp_', 'A'.repeat(5000));
    const x = `${filler(50)}\n${key} ${filler(50)}`;
    const chunks = x.match(/[^]{1,7}/g)!;
    const s = new StreamScrubber({ window: 64 });
    let text = '';
    let peak = 0;
    for (const c of chunks) {
      text += s.push(c);
      peak = Math.max(peak, s.buffered);
    }
    text += s.end();
    expect(text).toBe(scrub(x).text);
    expect(peak).toBeGreaterThan(key.length); // memory grows with the open match: README "Known limits"
  });

  it('keeps memory bounded by the window on a long input with a fixed set of secrets', () => {
    // 64 MB in 64 KiB chunks; the README's 1 GB figure was measured the same way by hand.
    const block = `${filler(2000)} ${FAKE.EMAIL} ${FAKE.AWS_KEY} ${FAKE.PRIVATE_KEY}\n`;
    const chunk = block.repeat(Math.ceil((64 * 1024) / block.length)).slice(0, 64 * 1024);
    const s = new StreamScrubber();
    let peak = 0;
    let written = 0;
    for (let i = 0; i < 1024; i++) {
      written += s.push(chunk).length;
      peak = Math.max(peak, s.buffered);
    }
    written += s.end().length;
    expect(written).toBeGreaterThan(60 * 1024 * 1024);
    expect(peak).toBeLessThanOrEqual(3 * DEFAULT_WINDOW + chunk.length);
    expect(Object.keys(s.map).length).toBeLessThanOrEqual(4);
  }, 60_000);

  it('scrubStream reads an async iterable and fills in the map', async () => {
    async function* source() {
      yield `${FAKE.EMAIL.slice(0, 4)}`;
      yield new TextEncoder().encode(`${FAKE.EMAIL.slice(4)} and ${FAKE.SLACK_TOKEN}`);
    }
    const { text, map } = scrubStream(source(), { window: 64 });
    let out = '';
    for await (const part of text) out += part;
    expect(out).toBe('[EMAIL_1] and [SLACK_TOKEN_1]');
    expect(map).toEqual({ '[EMAIL_1]': FAKE.EMAIL, '[SLACK_TOKEN_1]': FAKE.SLACK_TOKEN });
  });

  it('masks the longest card the smallest window allows, cut anywhere (Qodo review of PR #29)', () => {
    // 19 digits in six groups, joined by a no-break space escaped three layers deep: 64 characters, `MIN_WINDOW`.
    const digits = j('4111111111', '111111110');
    let at = 0;
    const groups = [4, 3, 3, 3, 3, 3].map((n) => digits.slice(at, (at += n)));
    const card = groups.join('\\'.repeat(4) + 'u00a0');
    expect(card).toHaveLength(MIN_WINDOW);
    // Four layers deep the card would be 84 characters, longer than the window: it is not read as a card at all
    // (README "Known limits"), so a stream and `scrub` still agree.
    const tooLong = groups.join('\\'.repeat(8) + 'u00a0');
    for (const [c, masked] of [[card, true], [tooLong, false]] as const) {
      const x = `${filler(100)}${c} ${filler(100)}`;
      const whole = scrub(x);
      expect(whole.text.includes(c), c).toBe(!masked);
      for (let cut = 1; cut < x.length; cut++) {
        const { text, map } = run([x.slice(0, cut), x.slice(cut)], { window: MIN_WINDOW });
        expect({ text, map }, `cut at ${cut}`).toEqual({ text: whole.text, map: whole.map });
      }
    }
  });

  it('refuses a bad window and use after end', () => {
    expect(() => new StreamScrubber({ window: MIN_WINDOW - 1 })).toThrow(RangeError);
    expect(() => new StreamScrubber({ window: MIN_WINDOW + 0.5 })).toThrow(RangeError);
    const s = new StreamScrubber();
    s.end();
    expect(() => s.push('x')).toThrow();
    expect(() => s.end()).toThrow();
  });
});
