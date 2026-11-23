import { openUrlStart } from './detectors.js';
import { collect, Numbering, PLACEHOLDER, type ScrubMap, type Span } from './scrub.js';

/**
 * How far past the start of a match the text must have arrived before the match is known: a private key block's END
 * line can come up to 64 KiB after its BEGIN line. Twice that, for room to spare.
 */
export const DEFAULT_WINDOW = 128 * 1024;
/**
 * Smallest window: longer than any placeholder a stream gives out (`[DIGITALOCEAN_TOKEN_n]`, `[PLACEHOLDER_n]`), so
 * placeholder-shaped text that could collide with one is always seen whole before any of it is written out.
 */
export const MIN_WINDOW = 64;

export interface StreamOptions {
  /** The map from earlier runs, as in `scrub`. The stream's map holds these entries plus the new ones. */
  readonly map?: ScrubMap;
  /**
   * How many characters are held back before they are written out, and kept before the next ones for context. It
   * must be longer than a key block's 64 KiB for the result to equal `scrub`'s; tests use less, down to `MIN_WINDOW`.
   * A match still open at the end of the window holds back everything from its start, and a URL whose authority is
   * still open keeps everything from its scheme as context, so memory is about three windows, plus the longest such
   * match or URL, plus the map.
   */
  readonly window?: number;
}

/**
 * Masks text that arrives in chunks, with the same output and map as `scrub` of the whole text (README "Streaming"
 * names the exceptions). Text is written out only once no later character can change how it is masked: the last
 * `window` characters are held back, and a cut never falls inside a match. The `window` characters before each cut
 * are scanned again with the next chunk, so lookbehinds and escape runs see what came before.
 */
export class StreamScrubber {
  private readonly numbers: Numbering;
  private readonly window: number;
  private readonly decoder = new TextDecoder();
  /** Text already written out, kept for context: `window` characters, or from the scheme of a URL still open. */
  private context = '';
  /** Text not yet written out. */
  private pending = '';
  private ended = false;
  /** Pending length at which the next scan runs, so that each scan covers at least as much new text as old. */
  private scanAt: number;

  constructor(options: StreamOptions = {}) {
    this.numbers = new Numbering(options.map);
    this.window = options.window ?? DEFAULT_WINDOW;
    if (!Number.isSafeInteger(this.window) || this.window < MIN_WINDOW)
      throw new RangeError(`StreamScrubber: window must be an integer of at least ${MIN_WINDOW}`);
    this.scanAt = 2 * this.window;
  }

  /** Placeholder → original value, for everything masked so far. */
  get map(): ScrubMap {
    return this.numbers.map;
  }

  /** Characters held in memory, not counting the map. */
  get buffered(): number {
    return this.context.length + this.pending.length;
  }

  /** Adds a chunk and returns the scrubbed text that is now final (often `''`). Bytes are decoded as UTF-8. */
  push(chunk: string | Uint8Array): string {
    if (this.ended) throw new Error('StreamScrubber: push after end');
    // Before a string, bytes left over from an unfinished character are decoded (as U+FFFD), so the text keeps the
    // order it arrived in. Found by Qodo in the review of PR #22.
    this.pending +=
      typeof chunk === 'string' ? this.decoder.decode() + chunk : this.decoder.decode(chunk, { stream: true });
    // Scan only once a full window can be written out. A match still open holds everything from its start, and a URL
    // still open keeps its scheme as context, so the next scan waits until the new text is at least as long as what
    // it scans again: total scanning stays linear.
    if (this.pending.length < this.scanAt) return '';
    const out = this.flush(false);
    this.scanAt = out ? Math.max(2 * this.window, this.context.length) : 2 * this.pending.length;
    return out;
  }

  /** Returns the rest of the scrubbed text. */
  end(): string {
    if (this.ended) throw new Error('StreamScrubber: end called twice');
    this.pending += this.decoder.decode();
    this.ended = true;
    return this.flush(true);
  }

  private flush(final: boolean): string {
    const text = this.context + this.pending;
    const from = this.context.length;
    const spans = collect(text);
    // The whole text, not just `pending`: a placeholder can straddle the last cut when it was not yet whole at that
    // scan (`aaa[EMAI` + `L_1]`). Found by Qodo in the review of PR #22.
    this.numbers.reserve(text);
    let cut = final ? text.length : text.length - this.window;
    for (const s of spans) if (s.start < cut && cut < s.end) cut = s.start;
    // A placeholder-shaped literal is not cut either: it would be reserved only after its first half was written.
    for (const m of text.matchAll(PLACEHOLDER)) if (m.index < cut && cut < m.index + m[0].length) cut = m.index;
    if (cut <= from) return '';

    let out = '';
    let last = from;
    for (const s of this.masked(text, spans, from, cut)) {
      out += text.slice(last, s.start) + this.numbers.assign(s.kind, text.slice(s.start, s.end));
      last = s.end;
    }
    out += text.slice(last, cut);
    // The URL password detector needs the scheme, however long the user name before the password is. Found by Qodo
    // in the review of PR #22: a user name longer than the window left the password visible.
    const url = openUrlStart(text, cut);
    const keep = Math.max(0, cut - this.window);
    this.context = text.slice(url === -1 ? keep : Math.min(keep, url), cut);
    this.pending = text.slice(cut);
    return out;
  }

  /**
   * The spans to mask between `from` and `cut`. `scrub` reserves placeholder-shaped text anywhere in its input
   * before numbering; a stream can only reserve what has arrived. Literal text equal to a placeholder this stream
   * already assigned would restore to that value, so it is masked as `[PLACEHOLDER_n]`, which restores to the
   * literal text.
   */
  private *masked(text: string, spans: readonly Span[], from: number, cut: number): Iterable<Span> {
    const literals: Span[] = [];
    for (const m of text.slice(from, cut).matchAll(PLACEHOLDER)) {
      const start = from + m.index;
      if (this.numbers.assigned.has(m[0])) literals.push({ kind: 'PLACEHOLDER', start, end: start + m[0].length });
    }
    let i = 0;
    for (const s of spans) {
      if (s.start < from || s.end > cut) continue;
      while (i < literals.length && literals[i]!.end <= s.start) yield literals[i++]!;
      while (i < literals.length && literals[i]!.start < s.end) i++; // inside a match: masked with it
      yield s;
    }
    while (i < literals.length) yield literals[i++]!;
  }
}

/**
 * Scrubs a stream (a log tail, a file, stdin) without loading it whole. Read `map` once the text is fully read.
 *
 * ```ts
 * const { text, map } = scrubStream(process.stdin);
 * for await (const part of text) process.stdout.write(part);
 * ```
 */
export function scrubStream(
  source: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>,
  options: StreamOptions = {},
): { text: AsyncIterable<string>; map: ScrubMap } {
  const scrubber = new StreamScrubber(options);
  async function* text(): AsyncGenerator<string> {
    for await (const chunk of source) {
      const out = scrubber.push(chunk);
      if (out) yield out;
    }
    const rest = scrubber.end();
    if (rest) yield rest;
  }
  return { text: text(), map: scrubber.map };
}
