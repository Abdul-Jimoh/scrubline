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

/** Index of the first span whose end is after `pos` (spans sorted and disjoint). */
function firstEndingAfter(spans: Span[], pos: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid]!.end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Matches from every detector, in priority order; a match that overlaps one already taken is dropped. */
function collect(input: string, detectors: readonly Detector[]): Span[] {
  const spans: Span[] = [];
  for (const d of detectors) {
    for (const m of input.matchAll(d.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start || (d.accept && !d.accept(m[0]))) continue;
      const i = firstEndingAfter(spans, start);
      if (i < spans.length && spans[i]!.start < end) continue;
      spans.splice(i, 0, { kind: d.kind, start, end });
    }
  }
  return spans;
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
