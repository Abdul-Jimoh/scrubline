/**
 * Built-in detectors. Each one names the mask it produces (`AWS_KEY` → `[AWS_KEY_1]`).
 *
 * Order is priority: when two matches overlap, the detector listed first wins. Specific formats come before the
 * generic ones that would also match them (`sk-ant-…` is an Anthropic key before it is an `sk-…` OpenAI-style key).
 *
 * Patterns adapted from a redactor in an earlier tool by the same author.
 */
export interface Detector {
  /** Mask label: upper snake case, used as `[KIND_N]`. */
  readonly kind: string;
  /** Must carry the `g` flag. */
  readonly pattern: RegExp;
  /** Optional second look at a match; returning false keeps the text as it is. */
  readonly accept?: (match: string) => boolean;
}

export const DETECTORS: readonly Detector[] = [
  {
    kind: 'PRIVATE_KEY',
    // PEM and PGP blocks. An unterminated block (a truncated paste) is masked to the end of the text.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  // The lookbehind (not \b) lets a match start only where a token can: with \b, every `-eyJ` inside a long run was a
  // fresh start that rescanned the run, which made the scan quadratic. Same for EMAIL below.
  { kind: 'JWT', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'ANTHROPIC_KEY', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'OPENAI_KEY', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'GITHUB_TOKEN', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: 'GITLAB_TOKEN', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'SLACK_TOKEN', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'AWS_KEY', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GOOGLE_API_KEY', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Secret and restricted keys only: Stripe publishable keys (pk_) are public by design.
  { kind: 'STRIPE_KEY', pattern: /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,})\b/g },
  { kind: 'NPM_TOKEN', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: 'HUGGINGFACE_TOKEN', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: 'SENDGRID_KEY', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'DIGITALOCEAN_TOKEN', pattern: /\bdo[opr]_v1_[0-9a-f]{64}\b/g },
  { kind: 'TELEGRAM_BOT_TOKEN', pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  {
    kind: 'EMAIL',
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // `git@github.com:org/repo` is an SSH remote, not a person.
    accept: (m) => !/^git@/i.test(m),
  },
];
