#!/usr/bin/env node
/**
 * `scrubline`: masks stdin (or a file) to stdout, and puts the originals back with `scrubline restore`.
 *
 * Messages never include input text or map values (AGENTS.md rule 3): a JSON parse error, for one, quotes the text
 * it failed on, so errors are reported by what failed, not by the underlying message.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { restore, scrub, type ScrubMap } from './scrub.js';

const USAGE = `Usage:
  scrubline [file] [--map <file>] [--summary]   mask secrets in a file or stdin; write the result to stdout
  scrubline restore [file] --map <file>         put the originals back into text that holds placeholders

Options:
  --map <file>   where the originals are kept (JSON, mode 0600). Scrubbing adds to it, so a value keeps its
                 placeholder across runs; restore reads it. Keep it on your machine.
  --summary      print how many values of each kind were masked to stderr (never the values)
  -h, --help     show this help

Exit codes: 0 done, 2 usage or file error, 1 unexpected error.`;

const PLACEHOLDER_KEY = /^\[[A-Z][A-Z0-9_]*_\d+\]$/;

/** A failure to report as `scrubline: <message>` and exit 2. The message names what failed, never content. */
class UsageError extends Error {}

interface Args {
  command: 'scrub' | 'restore' | 'help';
  file?: string;
  map?: string;
  summary: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: 'scrub', summary: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') return { command: 'help', summary: false };
    else if (a === '--summary') args.summary = true;
    else if (a === '--map' || a.startsWith('--map=')) {
      const value = a === '--map' ? argv[++i] : a.slice('--map='.length);
      if (!value) throw new UsageError('--map needs a file name');
      args.map = value;
    } else if (a.startsWith('-') && a !== '-') throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional[0] === 'restore') {
    args.command = 'restore';
    positional.shift();
  }
  if (positional.length > 1) throw new UsageError('give at most one input file');
  if (positional[0] !== undefined && positional[0] !== '-') args.file = positional[0];
  if (args.command === 'restore' && args.map === undefined) throw new UsageError('restore needs --map <file>');
  if (args.command === 'restore' && args.summary) throw new UsageError('--summary applies to scrubbing only');
  return args;
}

function readInput(file: string | undefined): string {
  try {
    return readFileSync(file ?? 0, 'utf8');
  } catch {
    throw new UsageError(file === undefined ? 'cannot read stdin' : `cannot read ${file}`);
  }
}

/** The map in `file`, or `undefined` when there is no such file. */
function readMap(file: string): ScrubMap | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new UsageError(`cannot read map file ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`map file ${file} is not valid JSON`);
  }
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.entries(parsed).every(([k, v]) => PLACEHOLDER_KEY.test(k) && typeof v === 'string');
  if (!valid) throw new UsageError(`map file ${file} is not a scrubline map`);
  return parsed as ScrubMap;
}

/** Writes the map with mode 0600 through a temporary file, so an interrupted write never leaves half a map. */
function writeMap(file: string, map: ScrubMap): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
    throw new UsageError(`cannot write map file ${file}`);
  }
}

function run(argv: readonly string[]): void {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.command === 'restore') {
    const map = readMap(args.map!);
    if (map === undefined) throw new UsageError(`map file ${args.map} does not exist`);
    process.stdout.write(restore(readInput(args.file), map));
    return;
  }
  const input = readInput(args.file);
  const previous = args.map === undefined ? undefined : readMap(args.map);
  const result = scrub(input, { map: previous });
  // The map is written before the text, so masked output never exists without the map that restores it.
  if (args.map !== undefined) writeMap(args.map, result.map);
  if (args.summary) {
    const counts = new Map<string, number>();
    for (const f of result.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    const lines = [...counts].map(([kind, n]) => `${kind} ${n}`);
    process.stderr.write(`${lines.length ? lines.join('\n') : 'nothing masked'}\n`);
  }
  process.stdout.write(result.text);
}

try {
  run(process.argv.slice(2));
} catch (e) {
  // Anything else is a bug; its message could hold input text, so only its kind is shown.
  const message = e instanceof UsageError ? e.message : `unexpected ${e instanceof Error ? e.name : 'error'}`;
  process.stderr.write(`scrubline: ${message}\n`);
  if (e instanceof UsageError) process.stderr.write('Run scrubline --help for usage.\n');
  process.exitCode = e instanceof UsageError ? 2 : 1;
}
