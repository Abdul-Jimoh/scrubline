import { describe, expect, it } from 'vitest';
import { scrub } from '../src/index.js';
import { FAKE, j } from './fixtures.js';

// Scrubline runs on untrusted text (logs, pastes), so a crafted input must not stall it. Each input here is
// 200,000 characters. Before the fix, the email case took about 1.6 s at 32,000 characters and grew with the square
// of the size (about a minute at this length). A linear scan takes milliseconds; the 1.5 s budget leaves room for
// slow CI machines while still failing on a quadratic pattern.
const N = 200_000;
const adversarial: [string, string][] = [
  ['dotted run with no domain', 'a.'.repeat(N / 2) + '@'],
  ['dotted domain with no TLD', 'a@' + 'a.'.repeat(N / 2)],
  ['hyphenated domain with no TLD', 'a@' + 'a-'.repeat(N / 2)],
  ['repeated JWT headers with no dots', 'eyJ-'.repeat(N / 4)],
  ['repeated private key headers with no end', j('-----BEGIN ', 'PRIVATE KEY-----\n').repeat(N / 28)],
  ['one long token-shaped run', 'sk-' + 'a-'.repeat(N / 2)],
  // Runs where a lower-priority pattern could start again after every key and rescan to the end (about 7 s at
  // 1 MB before keys were blanked out for later detectors and `%` left the email local part).
  ['URL-encoded keys joined into one run, an @ at the end', j(FAKE.NPM_TOKEN, '%3D').repeat(N / 43) + 'x@a.co'],
  ['Anthropic keys joined by hyphens', j(FAKE.ANTHROPIC_KEY, '-').repeat(N / 46)],
];

describe('scan time stays linear on crafted input', () => {
  for (const [name, input] of adversarial)
    it(name, () => {
      const t = Date.now();
      scrub(input);
      expect(Date.now() - t).toBeLessThan(1500);
    });
});

describe('scrub time stays linear in the number of findings', () => {
  // About 4 MB with 160,000 findings. Emails are detected after AWS keys but appear before them in the text, so
  // each email span lands in front of every key span. Inserting spans one at a time took about 4 s at 2.6 MB.
  it('160,000 findings in reversed priority order', () => {
    const n = 80_000;
    const input = `mail ${FAKE.EMAIL}\n`.repeat(n) + `key ${FAKE.AWS_KEY}\n`.repeat(n);
    const t = Date.now();
    const { findings } = scrub(input);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(findings).toHaveLength(2 * n);
  });
});
