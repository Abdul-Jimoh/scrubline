#!/usr/bin/env node
/**
 * `scrubline`: masks stdin (or a file) to stdout, and puts the originals back with `scrubline restore`.
 *
 * Messages never include input text, map values, arguments or file names (AGENTS.md rule 3). A JSON parse error
 * quotes the text it failed on, and `scrubline "$(pbpaste)"` passes the clipboard as a file name, so errors say what
 * failed, never with what.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { restore, scrub, type ScrubMap } from './scrub.js';

const USAGE = `Usage:
  scrubline [file] [--map <file>] [--summary]   mask secrets in a file or stdin; write the result to stdout
  scrubline restore [file] --map <file>         put the originals back into text that holds placeholders

Options:
  --map <file>   where the originals are kept (JSON, mode 0600). Scrubbing adds to it, so a value keeps its
                 placeholder across runs; restore reads it. Keep it on your machine.
  --summary      print how many values of each kind were masked to stderr (never the values)
  -h, --help     show this help
  --             end of options: a file name after it may start with -

Exit codes: 0 done, 2 usage or file error, 1 unexpected error.`;

const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*_\d+\]/g;
const PLACEHOLDER_KEY = /^\[[A-Z][A-Z0-9_]*_\d+\]$/;
const KNOWN_OPTION = /^--?[a-z][a-z-]{0,20}$/;
/** How long a run waits for another run that holds the map file. */
const LOCK_WAIT_MS = 10_000;

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
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!options || a === '-' || !a.startsWith('-')) positional.push(a);
    else if (a === '--') options = false;
    else if (a === '-h' || a === '--help') return { command: 'help', summary: false };
    else if (a === '--summary') args.summary = true;
    else if (a === '--map' || a.startsWith('--map=')) {
      const value = a === '--map' ? argv[++i] : a.slice('--map='.length);
      // `--map --summary` would otherwise write every secret to a file named `--summary`.
      if (!value || value.startsWith('-')) throw new UsageError('--map needs a file name');
      args.map = value;
    } else throw new UsageError(KNOWN_OPTION.test(a) ? `unknown option ${a}` : 'unknown option');
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
    throw new UsageError(file === undefined ? 'cannot read stdin' : 'cannot read the input file');
  }
}

/** The map in `file`, or `undefined` when there is no such file. */
function readMap(file: string): ScrubMap | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new UsageError('cannot read the map file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError('the map file is not valid JSON');
  }
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.entries(parsed).every(([k, v]) => PLACEHOLDER_KEY.test(k) && typeof v === 'string');
  if (!valid) throw new UsageError('the map file is not a scrubline map');
  return parsed as ScrubMap;
}

/**
 * The file a map path names: a symlink's target, also one that does not exist yet, so writing the map does not
 * replace the link with a plain file next to it.
 */
function mapTarget(file: string): string {
  try {
    if (!lstatSync(file).isSymbolicLink()) return file;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return file;
    throw new UsageError('cannot read the map file');
  }
  try {
    return realpathSync(file);
  } catch {
    try {
      return resolve(dirname(file), readlinkSync(file));
    } catch {
      throw new UsageError('cannot read the map file');
    }
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` holding `<map>.lock`, so two runs sharing a map cannot both number from the same old map and then
 * overwrite each other's entries (a placeholder would restore to another run's value).
 */
function withLock<T>(target: string, fn: () => T): T {
  const lock = `${target}.lock`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    throw new UsageError('cannot write the map file');
  }
  for (const start = Date.now(); ; sleep(25)) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new UsageError('cannot write the map file');
      if (Date.now() - start > LOCK_WAIT_MS)
        throw new UsageError('the map file is in use by another scrubline run; if none is running, delete the .lock file next to it');
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Writes the map with mode 0600 through a temporary file, so an interrupted write never leaves half a map. Runs
 * under the lock, so temporary files from runs that crashed before their rename are removed first.
 */
function writeMap(target: string, map: ScrubMap): void {
  const dir = dirname(target);
  const stale = new RegExp(`^${basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.tmp$`);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    for (const name of readdirSync(dir)) if (stale.test(name)) rmSync(join(dir, name), { force: true });
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, target);
  } catch {
    rmSync(tmp, { force: true });
    throw new UsageError('cannot write the map file');
  }
}

/** Writes to stdout. A reader that closes early (`| head`) is not an error; anything else exits 2. */
function output(text: string): void {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') {
      process.stderr.write('scrubline: cannot write the output\n');
      process.exitCode = 2;
    }
  });
  process.stdout.write(text);
}

function run(argv: readonly string[]): void {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    output(`${USAGE}\n`);
    return;
  }
  if (args.command === 'restore') {
    const map = readMap(mapTarget(args.map!));
    if (map === undefined) throw new UsageError('the map file does not exist');
    output(restore(readInput(args.file), map));
    return;
  }
  const input = readInput(args.file);
  const scrubWith = (previous: ScrubMap | undefined) => scrub(input, { map: previous });
  let result: ReturnType<typeof scrub>;
  if (args.map === undefined) result = scrubWith(undefined);
  else {
    const target = mapTarget(args.map);
    // The map is read, extended and written under one lock, and before the text is printed, so masked output never
    // exists without the map that restores it.
    result = withLock(target, () => {
      const r = scrubWith(readMap(target));
      // Placeholder-shaped text typed in the input (`[EMAIL_2]`) is recorded as standing for itself, so a later run
      // cannot give that placeholder a value and change what this run's output restores to.
      const map: ScrubMap = { ...r.map };
      for (const p of input.match(PLACEHOLDER) ?? []) if (!Object.hasOwn(map, p)) map[p] = p;
      writeMap(target, map);
      return { ...r, map };
    });
  }
  if (args.summary) {
    const counts = new Map<string, number>();
    for (const f of result.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    const lines = [...counts].map(([kind, n]) => `${kind} ${n}`);
    process.stderr.write(`${lines.length ? lines.join('\n') : 'nothing masked'}\n`);
  }
  output(result.text);
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
