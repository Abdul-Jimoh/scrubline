#!/usr/bin/env node
// End-to-end masking checks for a list of cases, against one build of Scrubline.
// Usage: node check.mjs --lib <dist dir> --cases <cases.json> [--window <n>]
//
// cases.json: { "cases": [ { "name": "...", "input": "..." | ["part", "part"],
//                            "secrets": ["..." | ["part", "part"]], "expect": "..." (optional) } ] }
// Parts are joined, so a fake value can be written without a key-shaped literal in the file.
//
// For each case it checks:
//   covered  every character of every occurrence of each secret is inside a finding
//   expect   the scrubbed text equals `expect`, when given
//   restore  restore(scrub(x)) === x
//   stream   a stream cut at every position, and one fed a character at a time, gives the same text and map
//   json     if the input is JSON, the output is too, at every layer of JSON inside a string
// Prints one line per case and a JSON summary; exits 1 if any check fails, 2 on bad input.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
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

const results = [];
for (const c of cases) {
  const name = c.name ?? '(unnamed)';
  const x = join(c.input);
  const secrets = (c.secrets ?? []).map(join);
  const failed = [];
  const r = scrub(x);

  for (const s of secrets) {
    if (!s || !x.includes(s)) {
      console.error(`check.mjs: case "${name}": secret ${JSON.stringify(s)} is not in the input`);
      process.exit(2);
    }
    for (let i = x.indexOf(s); i !== -1; i = x.indexOf(s, i + 1)) {
      let visible = '';
      for (let k = i; k < i + s.length; k++)
        if (!r.findings.some((f) => f.start <= k && k < f.end)) visible += x[k];
      if (visible) failed.push(`covered: ${JSON.stringify(visible)} of a secret at ${i} stays visible`);
    }
  }
  if (c.expect !== undefined && r.text !== join(c.expect))
    failed.push(`expect: got ${JSON.stringify(r.text)}`);
  if (restore(r.text, r.map) !== x) failed.push('restore: restore(scrub(x)) differs from x');

  if (typeof StreamScrubber === 'function') {
    const bad = [];
    for (let cut = 0; cut <= x.length && bad.length < 3; cut++) {
      const s = new StreamScrubber({ window });
      const text = s.push(x.slice(0, cut)) + s.push(x.slice(cut)) + s.end();
      if (text !== r.text || !sameMap(s.map, r.map)) bad.push(cut);
    }
    const s = new StreamScrubber({ window });
    let text = '';
    for (const ch of x) text += s.push(ch);
    text += s.end();
    if (text !== r.text || !sameMap(s.map, r.map)) bad.push('one character at a time');
    if (bad.length) failed.push(`stream: differs from scrub at cut ${bad.join(', ')} (window ${window})`);
  } else {
    failed.push('stream: this build has no StreamScrubber');
  }

  let parsed;
  try {
    parsed = JSON.parse(x);
  } catch {}
  if (parsed !== undefined) {
    let parsedOut;
    try {
      parsedOut = JSON.parse(r.text);
      const problems = [];
      jsonLayers(parsed, parsedOut, 0, '', problems);
      for (const p of problems) failed.push(`json: ${p}`);
    } catch {
      failed.push('json: the output no longer parses');
    }
  }

  results.push({ name, pass: failed.length === 0, failed, scrubbed: r.text });
  console.log(`${failed.length ? 'FAIL' : 'PASS'}  ${name}`);
  console.log(`      scrubbed: ${JSON.stringify(r.text)}`);
  for (const f of failed) console.log(`      ${f}`);
}

const failedCount = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ lib: resolve(libDir), window, cases: results.length, failed: failedCount }));
process.exit(failedCount ? 1 : 0);
