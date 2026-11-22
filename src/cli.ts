#!/usr/bin/env node
/**
 * `scrubline`: masks stdin (or a file) to stdout, and puts the originals back with `scrubline restore`.
 *
 * Messages never include input text, map values, arguments or file names (AGENTS.md rule 3). A JSON parse error
 * quotes the text it failed on, and `scrubline "$(pbpaste)"` passes the clipboard as a file name, so errors say what
 * failed, never with what.
 */
import { spawnSync } from 'node:child_process';
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
/** How long a run waits for another live run that holds the map file. */
const LOCK_WAIT_MS = 5 * 60_000;

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
  let beforeDashDash = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!options || a === '-' || !a.startsWith('-')) {
      positional.push(a);
      if (options) beforeDashDash++;
    } else if (a === '--') options = false;
    else if (a === '-h' || a === '--help') return { command: 'help', summary: false };
    else if (a === '--summary') args.summary = true;
    else if (a === '--map' || a.startsWith('--map=')) {
      const value = a === '--map' ? argv[++i] : a.slice('--map='.length);
      // `--map --summary` would otherwise write every secret to a file named `--summary`.
      if (!value || value.startsWith('-')) throw new UsageError('--map needs a file name');
      args.map = value;
    } else throw new UsageError('unknown option (see --help)');
  }
  // After `--`, `restore` is a file name.
  if (positional[0] === 'restore' && beforeDashDash > 0) {
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
    // A dangling link, maybe through other links: follow each hop to the file that does not exist yet.
    let target = file;
    for (let hops = 0; hops < 40; hops++) {
      try {
        if (!lstatSync(target).isSymbolicLink()) break;
        target = resolve(dirname(target), readlinkSync(target));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw new UsageError('cannot read the map file');
      }
    }
    throw new UsageError('cannot read the map file');
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * How old a lock whose holder cannot be identified may be before it counts as stale. No run holds the map this long:
 * Node strings stop near 512 MB, which scrubs in under a minute.
 */
const LOCK_MAX_AGE_MS = 10 * 60_000;
/** How long an empty or unreadable lock is given to get its process id (a run writes it right after creating it). */
const LOCK_WRITE_GRACE_MS = 5_000;

/** When process `pid` started, as `ps` prints it, or '' where `ps` is not available. */
function startedAt(pid: number): string {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** This run's lock content: its process id and start time, so a later process that reuses the id is told apart. */
const ownLock = () => `${process.pid} ${startedAt(process.pid)}\n`;

/**
 * Whether `lock` (as stat'ed in `info`) may still belong to a live run. It does not when its process is gone (Ctrl-C,
 * `kill -9`), belongs to another user (EPERM), started at another time than the lock records (a reused id: a
 * container's `node` often gets the same low id on every start), or when it holds no process id after the grace
 * period (a run stopped between creating and writing it). A live holder is waited for however long it holds the lock,
 * also when it is paused (Ctrl-Z, a sleeping laptop): only a lock whose holder cannot be identified expires by age.
 */
function holderAlive(lock: string, info: { mtimeMs: number }): boolean {
  const age = Date.now() - info.mtimeMs;
  let text = '';
  try {
    text = readFileSync(lock, 'utf8').trim();
  } catch {
    // Gone or unreadable: decided by age below.
  }
  const space = text.indexOf(' ');
  const pid = Number(space === -1 ? text : text.slice(0, space));
  const recorded = space === -1 ? '' : text.slice(space + 1);
  if (!Number.isInteger(pid) || pid <= 0) return age < LOCK_WRITE_GRACE_MS;
  try {
    process.kill(pid, 0);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
  }
  const now = recorded ? startedAt(pid) : '';
  if (recorded && now) return now === recorded;
  return age < LOCK_MAX_AGE_MS;
}

/** A takeover guard older than this, whose process is gone, was left by a run stopped inside its takeover. */
const GUARD_MAX_AGE_MS = 10_000;

/**
 * Removes `lock` if it is still stale, holding `<lock>.takeover` while it checks and removes. Without the guard, a
 * waiter could judge the old lock stale, pause, and then remove the fresh lock another waiter had made meanwhile;
 * with it, the check and the removal happen with no other takeover in between, and removing is the only way the lock
 * path is freed, so a live run's lock is never removed. Trade-off: a guard left by a run killed inside its takeover
 * (a few microseconds) blocks takeovers for ten seconds; two waiters could then both remove it at the same moment.
 * A run also checks it still holds the lock before it writes the map (`stillHeld`), so even then no map is
 * overwritten by a run that lost its lock.
 */
function takeOver(lock: string): void {
  const guard = `${lock}.takeover`;
  try {
    writeFileSync(guard, ownLock(), { flag: 'wx', mode: 0o600 });
  } catch {
    try {
      const info = lstatSync(guard);
      if (Date.now() - info.mtimeMs > GUARD_MAX_AGE_MS && !holderAlive(guard, info)) rmSync(guard, { force: true });
    } catch {
      // Released meanwhile.
    }
    return;
  }
  try {
    if (!holderAlive(lock, lstatSync(lock))) rmSync(lock, { force: true });
  } catch {
    // Released meanwhile.
  } finally {
    rmSync(guard, { force: true });
  }
}

/** Set while this run holds a map lock: the lock's path and the content this run wrote to it. */
let held: { lock: string; mine: string } | undefined;

/** Whether this run still holds its lock. It may not, if it was paused long enough to be judged gone. */
function stillHeld(): boolean {
  try {
    return held !== undefined && readFileSync(held.lock, 'utf8') === held.mine;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` holding `<map>.lock`, so two runs sharing a map cannot both number from the same old map and then
 * overwrite each other's entries (a placeholder would restore to another run's value). The lock holds the run's
 * process id and start time, so a lock left by a run that was stopped (Ctrl-C, `kill -9`) is taken over by the next
 * run. A run waits while the holder is alive, up to five minutes, and removes the lock only while it still holds it.
 */
function withLock<T>(target: string, fn: () => T): T {
  const lock = `${target}.lock`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    throw new UsageError('cannot write the map file');
  }
  const mine = ownLock();
  for (const start = Date.now(); ; sleep(25)) {
    try {
      writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new UsageError('cannot write the map file');
      let info;
      try {
        info = lstatSync(lock);
      } catch {
        continue; // released meanwhile
      }
      if (!holderAlive(lock, info)) {
        takeOver(lock);
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new UsageError('the map file is still in use by another scrubline run');
    }
  }
  held = { lock, mine };
  try {
    return fn();
  } finally {
    if (stillHeld()) rmSync(lock, { force: true });
    held = undefined;
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
  } catch {
    rmSync(tmp, { force: true });
    throw new UsageError('cannot write the map file');
  }
  // A run paused long enough to lose its lock must not replace a map another run has written since.
  if (!stillHeld()) {
    rmSync(tmp, { force: true });
    throw new UsageError('another scrubline run took over the map while this one was paused; nothing was written');
  }
  try {
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
