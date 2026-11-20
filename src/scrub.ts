import { DETECTORS, type Detector } from './detectors.js';

/** Where a value was found in the input. The value itself is only in the map, so findings are safe to log. */
export interface Finding {
  readonly kind: string;
  readonly placeholder: string;
  /** Offsets into the original text: `input.slice(start, end)` is the masked value. */
  readonly start: number;
  readonly end: number;
}

/** Placeholder → original value. Keep it local: it holds every secret that was masked. */
export type ScrubMap = Record<string, string>;

export interface ScrubResult {
  readonly text: string;
  readonly findings: readonly Finding[];
  readonly map: ScrubMap;
}

const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*_\d+\]/g;

interface Span {
  kind: string;
  start: number;
  end: number;
}

/** `text` with each span's characters replaced by `\0`, so the length and every offset stay the same. */
function blank(text: string, spans: readonly Span[]): string {
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start) + '\0'.repeat(s.end - s.start);
    last = s.end;
  }
  return out + text.slice(last);
}

/**
 * Matches from every detector, in priority order. Each detector searches the text with every span already taken
 * replaced by `\0`, which no pattern matches, so a lower-priority match can neither overlap a taken span nor swallow
 * a value next to one (`npm_…%3Djane@…` once hid the address inside an email-shaped match that started at `npm_`).
 * Each detector's spans arrive sorted and disjoint and are merged in one linear pass (inserting one at a time was
 * quadratic in the number of findings).
 */
function collect(input: string, detectors: readonly Detector[]): Span[] {
  let taken: Span[] = [];
  let work = input;
  for (const d of detectors) {
    const found: Span[] = [];
    for (const [start, end] of d.find(work)) if (end > start) found.push({ kind: d.kind, start, end });
    if (!found.length) continue;
    work = blank(work, found);
    const merged: Span[] = [];
    let i = 0;
    for (const s of found) {
      while (i < taken.length && taken[i]!.start < s.start) merged.push(taken[i++]!);
      merged.push(s);
    }
    while (i < taken.length) merged.push(taken[i++]!);
    taken = merged;
  }
  return taken;
}

/**
 * Masks secrets and personal data in `input`. Each distinct value gets a typed, numbered placeholder
 * (`[AWS_KEY_1]`); the same value always gets the same placeholder. Numbers skip any placeholder-shaped text
 * already in the input, so `restore(result.text, result.map)` returns the input exactly.
 */
export function scrub(input: string): ScrubResult {
  const spans = collect(input, DETECTORS);
  const taken = new Set(input.match(PLACEHOLDER));
  const placeholderOf = new Map<string, string>();
  const nextNumber = new Map<string, number>();
  const map: ScrubMap = {};
  const findings: Finding[] = [];
  let text = '';
  let last = 0;

  for (const { kind, start, end } of spans) {
    const value = input.slice(start, end);
    const key = `${kind}\u0000${value}`;
    let placeholder = placeholderOf.get(key);
    if (placeholder === undefined) {
      let n = nextNumber.get(kind) ?? 1;
      while (taken.has(`[${kind}_${n}]`)) n++;
      nextNumber.set(kind, n + 1);
      placeholder = `[${kind}_${n}]`;
      placeholderOf.set(key, placeholder);
      map[placeholder] = value;
    }
    findings.push({ kind, placeholder, start, end });
    text += input.slice(last, start) + placeholder;
    last = end;
  }
  text += input.slice(last);
  return { text, findings, map };
}

/** Puts the original values back. Placeholders that are not in the map are left as they are. */
export function restore(text: string, map: ScrubMap): string {
  return text.replace(PLACEHOLDER, (p) => (Object.hasOwn(map, p) ? map[p]! : p));
}
