#!/usr/bin/env node
// End-to-end masking checks for a list of cases, against one build of Scrubline.
// Usage: node check.mjs --lib <dist dir> --cases <cases.json> [--window <n>] [--base]
//
// cases.json: { "cases": [ { "name": "...", "kind": "fix" | "guard", "input": "..." | ["part", "part"],
//                            "secrets": ["..." | ["part", "part"]], "expect": "..." (optional) } ] }
// Parts are joined, so a fake value can be written without a key-shaped literal in the file. A `fix` case may name, in
// "shows", the checks it must fail on the base (default ["covered", "expect"]).
// Output names checks and character offsets, never the characters of a value.
//
// For each case it checks:
//   covered  every character of every occurrence of each secret is inside a finding
//   expect   the scrubbed text equals `expect`, when given
//   restore  restore(scrub(x)) === x
//   stream   a stream cut at every position, and one fed a character at a time, gives the same text and map, for the
//            input alone and between filler long enough that every push flushes
//   json     if the input is JSON, the output is too, at every layer of JSON inside a string
// Prints one line per case and a JSON summary; exits 1 if any check fails, 2 on bad input.
// With --base (a run on the commit before the change), a `fix` case that fails none of its `shows` checks is listed
// as `unshown`: it does not show the change. A `guard` case may pass on both.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i++)
  if (process.argv[i] === '--base') args.set('--base', true);
  else args.set(process.argv[i], process.argv[++i]);
const onBase = args.get('--base') === true;
const libDir = args.get('--lib');
const casesFile = args.get('--cases');
if (!libDir || !casesFile) {
  console.error('usage: node check.mjs --lib <dist dir> --cases <cases.json> [--window <n>]');
  process.exit(2);
}
const lib = await import(pathToFileURL(resolve(libDir, 'index.js')).href);
const { scrub, restore, StreamScrubber } = lib;
const window = Number(args.get('--window') ?? lib.MIN_WINDOW ?? 64);
const join = (v) => (Array.isArray(v) ? v.join('') : v);

let cases;
try {
  cases = JSON.parse(readFileSync(casesFile, 'utf8')).cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('no cases');
} catch (e) {
  console.error(`check.mjs: cannot read cases from ${casesFile}: ${e.message}`);
  process.exit(2);
}

const sameMap = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Each string leaf of `orig` that is itself JSON must stay JSON in `out`, at the same path, recursively. */
function jsonLayers(orig, out, depth, path, problems) {
  if (depth > 8) return;
  if (typeof orig === 'string') {
    let inner;
    try {
      inner = JSON.parse(orig);
    } catch {
      return;
    }
    if (typeof inner !== 'object' || inner === null) return;
    let innerOut;
    try {
      innerOut = JSON.parse(out);
    } catch {
      problems.push(`layer ${depth + 1} at ${path || '(root)'} no longer parses`);
      return;
    }
    jsonLayers(inner, innerOut, depth + 1, path, problems);
  } else if (orig && typeof orig === 'object') {
    for (const k of Object.keys(orig))
      if (out && typeof out === 'object' && k in out) jsonLayers(orig[k], out[k], depth, `${path}.${k}`, problems);
  }
}

// Text around each input that is long enough for every push to flush, so a stream is tested across flushes and not
// only in `end()` (found by Qodo in the review of PR #32: an input under two windows never flushed before `end()`).
const pad = 'log line ok\n'.repeat(Math.ceil((2 * window) / 12));
const CHECKS = ['covered', 'expect', 'restore', 'stream', 'json'];

/** Stream checks on `x`: two pushes cut at every position, then one character at a time. Returns the failing cuts. */
function streamCuts(x) {
  const whole = scrub(x);
  const bad = [];
  for (let cut = 0; cut <= x.length && bad.length < 3; cut++) {
    const s = new StreamScrubber({ window });
    const text = s.push(x.slice(0, cut)) + s.push(x.slice(cut)) + s.end();
    if (text !== whole.text || !sameMap(s.map, whole.map)) bad.push(cut);
  }
  const s = new StreamScrubber({ window });
  let text = '';
  for (const ch of x) text += s.push(ch);
  text += s.end();
  if (text !== whole.text || !sameMap(s.map, whole.map)) bad.push('one character at a time');
  return bad;
}

/** Character ranges as `a-b`, from sorted offsets. */
function ranges(offsets) {
  const out = [];
  for (const k of offsets) {
    const last = out.at(-1);
    if (last && last[1] === k - 1) last[1] = k;
    else out.push([k, k]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

const results = [];
for (const c of cases) {
  const name = c.name ?? '(unnamed)';
  const kind = c.kind;
  if (kind !== 'fix' && kind !== 'guard') {
    console.error(`check.mjs: case "${name}": kind must be "fix" or "guard"`);
    process.exit(2);
  }
  // The checks a `fix` case must fail on the base to show the change; by default, a value visible or a wrong output.
  const shows = c.shows ?? ['covered', 'expect'];
  if (!Array.isArray(shows) || shows.length === 0 || shows.some((k) => !CHECKS.includes(k))) {
    console.error(`check.mjs: case "${name}": shows must list checks from ${CHECKS.join(', ')}`);
    process.exit(2);
  }
  const x = join(c.input);
  const secrets = (c.secrets ?? []).map(join);
  // Output names checks and character offsets, never the characters of a value (AGENTS.md rule 3; found by Qodo in
  // the review of PR #32).
  const failed = [];
  const fail = (check, message) => failed.push({ check, message });
  const r = scrub(x);

  secrets.forEach((s, n) => {
    if (!s || !x.includes(s)) {
      console.error(`check.mjs: case "${name}": secret ${n + 1} is not in the input`);
      process.exit(2);
    }
    for (let i = x.indexOf(s); i !== -1; i = x.indexOf(s, i + 1)) {
      const visible = [];
      for (let k = i; k < i + s.length; k++) if (!r.findings.some((f) => f.start <= k && k < f.end)) visible.push(k);
      if (visible.length)
        fail('covered', `${visible.length} of ${s.length} characters of secret ${n + 1} stay visible (offsets ${ranges(visible)})`);
    }
  });
  const leaks = failed.some((f) => f.check === 'covered');
  if (c.expect !== undefined && r.text !== join(c.expect))
    fail('expect', leaks ? 'the output differs from expect (withheld: part of a value is visible)' : `got ${JSON.stringify(r.text)}`);
  if (restore(r.text, r.map) !== x) fail('restore', 'restore(scrub(x)) differs from x');

  if (typeof StreamScrubber === 'function') {
    for (const [label, text] of [['alone', x], ['between filler', pad + x + pad]]) {
      const bad = streamCuts(text);
      if (bad.length)
        fail('stream', `${label}: differs from scrub at cut ${bad.join(', ')} (window ${window}; if README Known limits lists this input under Streams, report that limit)`);
    }
  } else {
    fail('stream', 'this build has no StreamScrubber');
  }

  let parsed;
  try {
    parsed = JSON.parse(x);
  } catch {}
  if (parsed !== undefined) {
    try {
      const problems = [];
      jsonLayers(parsed, JSON.parse(r.text), 0, '', problems);
      for (const p of problems) fail('json', p);
    } catch {
      fail('json', 'the output no longer parses');
    }
  }

  const shown = failed.some((f) => shows.includes(f.check));
  results.push({ name, kind, pass: failed.length === 0, shown, checks: [...new Set(failed.map((f) => f.check))] });
  console.log(`${failed.length ? 'FAIL' : 'PASS'}  [${kind}] ${name}`);
  console.log(`      scrubbed: ${leaks ? '(withheld: part of a value is visible)' : JSON.stringify(r.text)}`);
  for (const f of failed) console.log(`      ${f.check}: ${f.message}`);
}

const failedCount = results.filter((r) => !r.pass).length;
const summary = { lib: resolve(libDir), window, cases: results.length, failed: failedCount };
// On the base, a `fix` case shows the change only when a check it names in `shows` fails; another failure alone
// (a stream difference, say) does not (found by Qodo in the review of PR #32).
if (onBase)
  summary.unshown = results
    .filter((r) => r.kind === 'fix' && !r.shown)
    .map((r) => (r.checks.length ? `${r.name} (failed only: ${r.checks.join(', ')})` : r.name));
console.log(JSON.stringify(summary));
process.exit(failedCount ? 1 : 0);
