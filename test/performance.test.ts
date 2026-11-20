import { describe, expect, it } from 'vitest';
import { scrub } from '../src/index.js';
import { j } from './fixtures.js';

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
];

describe('scan time stays linear on crafted input', () => {
  for (const [name, input] of adversarial)
    it(name, () => {
      const t = Date.now();
      scrub(input);
      expect(Date.now() - t).toBeLessThan(1500);
    });
});
