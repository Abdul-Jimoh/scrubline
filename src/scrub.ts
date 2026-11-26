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

export const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*_\d+\]/g;
const PLACEHOLDER_KIND = /^\[([A-Z][A-Z0-9_]*)_\d+\]$/;

export interface ScrubOptions {
  /**
   * The map from earlier runs (a chat that goes on over several pastes). A value already in it keeps its
   * placeholder, and new values are numbered after its placeholders, so none is ever reassigned. The result's map
   * holds these entries plus the new ones. Placeholder text in the input that is in this map stands for that value,
   * so `restore` turns it back into the value rather than leaving it as typed.
   */
  readonly map?: ScrubMap;
}

export interface Span {
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
export function collect(input: string, detectors: readonly Detector[] = DETECTORS): Span[] {
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
  const keepsBackslash = new Set(detectors.filter((d) => d.keepsBackslashBefore).map((d) => d.kind));
  return taken.map((s, k) => (keepsBackslash.has(s.kind) ? s : takeEscape(input, s, k > 0 ? taken[k - 1]!.end : 0)));
}

/**
 * The most backslashes a match that starts on an escape takes with it: half of a stream's smallest window
 * (`MIN_WINDOW`), so a stream has not yet written them out when the match is found. 32 covers JSON six layers deep.
 */
export const MAX_ESCAPE_RUN = 32;

/**
 * Where a match starts once the backslashes before it are settled, so that the output stays decodable at every layer
 * of escaping and `restore` still returns the original exactly.
 *
 * - A match that starts on an escape letter (`\npm_…`, `\r@a.co`) or on an escape (`\u0072@a.co`) takes the whole
 *   run of backslashes before it, up to `MAX_ESCAPE_RUN`. In JSON inside JSON the inner `\n` is written `\\n`, and
 *   keeping any of that run left the inner string ending in `\[…]`, an invalid escape (issues #21 and #24).
 * - After that, or for any other match, a run of odd length means the last backslash escapes the match's first
 *   character (`DOMAIN\jane@…`), so the match takes that one too. The parity is of the whole run, however long; a
 *   stream keeps it by dropping an even number of backslashes when it trims its context.
 */
function takeEscape(input: string, s: Span, prevEnd: number): Span {
  let start = s.start;
  if (input.charCodeAt(start - 1) === 92 && (input.charCodeAt(start) === 92 || ESCAPE_LETTER.test(input[start]!))) {
    const stop = Math.max(prevEnd, start - MAX_ESCAPE_RUN);
    while (start > stop && input.charCodeAt(start - 1) === 92) start--;
  }
  let n = 0;
  while (start - n - 1 >= prevEnd && input.charCodeAt(start - n - 1) === 92) n++;
  if (n % 2 === 1) start--;
  return start === s.start ? s : { ...s, start };
}
/** A letter that ends a one-letter JSON escape (`\n`) and can also start a match (`npm_…`, `r@a.co`). */
const ESCAPE_LETTER = /^[nrtfbv]$/;

/**
 * Masks secrets and personal data in `input`. Each distinct value gets a typed, numbered placeholder
 * (`[AWS_KEY_1]`); the same value always gets the same placeholder. Numbers skip any placeholder-shaped text
 * already in the input, so `restore(result.text, result.map)` returns the input exactly.
 */
export function scrub(input: string, options: ScrubOptions = {}): ScrubResult {
  const spans = collect(input);
  const numbers = new Numbering(options.map);
  numbers.reserve(input);
  const findings: Finding[] = [];
  let text = '';
  let last = 0;

  for (const { kind, start, end } of spans) {
    const placeholder = numbers.assign(kind, input.slice(start, end));
    findings.push({ kind, placeholder, start, end });
    text += input.slice(last, start) + wrapped(input, { kind, start, end }, placeholder);
    last = end;
  }
  text += input.slice(last);
  return { text, findings, map: numbers.map };
}

const WRAP = new Map(DETECTORS.flatMap((d) => (d.wrap ? [[d.kind, d.wrap] as const] : [])));

/** The placeholder as it goes into the text: wrapped for a kind that needs it (`CARD_NUMBER_JSON`), else as is. */
export function wrapped(input: string, s: Span, placeholder: string): string {
  const q = WRAP.get(s.kind)?.(input, s.start);
  return q ? q + placeholder + q : placeholder;
}

/**
 * Placeholder assignment, shared by `scrub` and `StreamScrubber` so both number values the same way. Each distinct
 * value of a kind gets the lowest number not taken by the earlier map or by placeholder-shaped text reserved so far.
 */
export class Numbering {
  readonly map: ScrubMap = {};
  /** Placeholders this instance assigned, as opposed to ones from the earlier map. */
  readonly assigned = new Set<string>();
  private readonly taken = new Set<string>();
  private readonly placeholderOf = new Map<string, string>();
  private readonly nextNumber = new Map<string, number>();

  constructor(earlier: ScrubMap = {}) {
    for (const [placeholder, value] of Object.entries(earlier)) {
      const kind = PLACEHOLDER_KIND.exec(placeholder)?.[1];
      if (kind === undefined || typeof value !== 'string') throw new TypeError('scrub: options.map holds an entry that is not a placeholder and a string');
      this.taken.add(placeholder);
      this.placeholderOf.set(`${kind}\u0000${value}`, placeholder);
      this.map[placeholder] = value;
    }
  }

  /** Keeps every placeholder-shaped text in `text` from being assigned to a value. */
  reserve(text: string): void {
    for (const p of text.match(PLACEHOLDER) ?? []) this.taken.add(p);
  }

  assign(kind: string, value: string): string {
    const key = `${kind}\u0000${value}`;
    let placeholder = this.placeholderOf.get(key);
    if (placeholder === undefined) {
      let n = this.nextNumber.get(kind) ?? 1;
      while (this.taken.has(`[${kind}_${n}]`)) n++;
      this.nextNumber.set(kind, n + 1);
      placeholder = `[${kind}_${n}]`;
      this.taken.add(placeholder);
      this.placeholderOf.set(key, placeholder);
      this.assigned.add(placeholder);
      this.map[placeholder] = value;
    }
    return placeholder;
  }
}

/**
 * A placeholder of a wrapped kind with the same quote on both sides, `"[CARD_NUMBER_JSON_1]"` or `\\"…\\"`, or any
 * placeholder.
 */
const RESTORABLE = new RegExp(`(\\\\*)"(\\[(?:${[...WRAP.keys()].join('|')})_\\d+\\])\\1"|${PLACEHOLDER.source}`, 'g');

/**
 * Puts the original values back. Placeholders that are not in the map are left as they are. A placeholder that
 * `scrub` wrapped in quotes (a card that was a bare JSON number) loses the quotes with it.
 */
export function restore(text: string, map: ScrubMap): string {
  return text.replace(RESTORABLE, (m, _q: string | undefined, wrappedPlaceholder: string | undefined) => {
    const p = wrappedPlaceholder ?? m;
    return Object.hasOwn(map, p) ? map[p]! : m;
  });
}
