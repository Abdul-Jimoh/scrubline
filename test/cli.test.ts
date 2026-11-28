import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, utimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE, j } from './fixtures.js';

// End to end: the built command, run as a child process with real stdin, stdout, stderr and exit codes.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { cwd: ROOT });
}, 60_000);

// Every folder a test made, removed afterwards (the maps in them hold fake secrets; some are made read-only).
const made: string[] = [];
afterAll(() => {
  for (const d of made) {
    for (const f of readdirSync(d, { recursive: true }) as string[]) chmodSync(join(d, f), 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

// Commands run in an empty folder, so a regression that writes a file by mistake cannot drop one in the repo.
let cwd = '';
function cli(args: string[], input: string | Buffer = '') {
  cwd ||= tmp();
  const r = spawnSync(process.execPath, [CLI, ...args], { input, cwd, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), raw: r.stdout };
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'scrubline-cli-'));
  made.push(d);
  return d;
};

/** Runs the command without waiting, so several can overlap. */
function cliAsync(args: string[], input: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: tmp() });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}
const other = j('ops', '@', 'example.org');

describe('scrubline (issue #4)', () => {
  it('masks stdin to stdout and leaves every other byte as it was', () => {
    // A byte-order mark, CRLF line endings, non-ASCII text and no final newline.
    const input = `﻿token ${FAKE.GITHUB_TOKEN}\r\ncafé ☕ ${FAKE.EMAIL}\r\nend`;
    const r = cli([], Buffer.from(input, 'utf8'));
    expect(r.code).toBe(0);
    expect(r.raw.equals(Buffer.from('﻿token [GITHUB_TOKEN_1]\r\ncafé ☕ [EMAIL_1]\r\nend', 'utf8'))).toBe(true);
    expect(r.stderr).toBe('');
  });

  describe('bytes that are not valid UTF-8 come out unchanged (issue #16)', () => {
    // A stray byte, a lone continuation byte, a cut-off sequence, an overlong `/`, an encoded surrogate, a byte past
    // U+10FFFF and a cut-off four-byte sequence at the very end, around valid text and two values.
    const b = (...bytes: number[]) => Buffer.from(bytes);
    const u = (s: string) => Buffer.from(s, 'utf8');
    const input = Buffer.concat([
      b(0xff), u(`log ${FAKE.EMAIL} `), b(0x80), u('caf\u00E9 '), b(0xe2, 0x82), u(' x'), b(0xc0, 0xaf),
      b(0xed, 0xa0, 0x80), u(` ${FAKE.GITHUB_TOKEN}`), b(0xf5), u(' \u2615 \u{1F600} end'), b(0xf0, 0x9f, 0x98),
    ]);
    const masked = Buffer.concat([
      b(0xff), u('log [EMAIL_1] '), b(0x80), u('caf\u00E9 '), b(0xe2, 0x82), u(' x'), b(0xc0, 0xaf),
      b(0xed, 0xa0, 0x80), u(' [GITHUB_TOKEN_1]'), b(0xf5), u(' \u2615 \u{1F600} end'), b(0xf0, 0x9f, 0x98),
    ]);

    it('outside masked spans, with scrub', () => {
      const r = cli([], input);
      expect(r.code).toBe(0);
      expect(r.raw.equals(masked)).toBe(true);
    });

    it('with restore, also for a value that holds such a byte, and the map stays UTF-8 JSON', () => {
      const dir = tmp();
      const map = join(dir, 'map.json');
      // A private key block that a byte was corrupted in is still masked whole, so the map holds that byte.
      const key = FAKE.PRIVATE_KEY.replace('MIIE', 'MI\u0000IE');
      const withKey = Buffer.concat([input, u('\n'), ...key.split('\u0000').flatMap((part, i) => (i ? [b(0xfe), u(part)] : [u(part)]))]);
      const scrubbed = cli(['--map', map], withKey);
      expect(scrubbed.code).toBe(0);
      expect(scrubbed.raw.equals(Buffer.concat([masked, u('\n[PRIVATE_KEY_1]')]))).toBe(true);
      const raw = readFileSync(map);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['[EMAIL_1]', '[GITHUB_TOKEN_1]', '[PRIVATE_KEY_1]']);
      const restored = cli(['restore', '--map', map], scrubbed.raw);
      expect(restored.code).toBe(0);
      expect(restored.raw.equals(withKey)).toBe(true);
    });

    it('a file with only such bytes, or none at all', () => {
      expect(cli([], b(0xff, 0xfe, 0x80)).raw.equals(b(0xff, 0xfe, 0x80))).toBe(true);
      expect(cli([], b()).raw.length).toBe(0);
    });

    it('a large binary file, through scrub and restore, back to the same bytes', () => {
      // 8 MB of bytes from a fixed seed, mostly not UTF-8.
      const bin = Buffer.alloc(8 * 1024 * 1024);
      for (let i = 0, x = 7; i < bin.length; i++) bin[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
      const map = join(tmp(), 'map.json');
      const scrubbed = cli(['--map', map], bin);
      expect(scrubbed.code).toBe(0);
      const restored = cli(['restore', '--map', map], scrubbed.raw);
      expect(restored.raw.equals(bin)).toBe(true);
    }, 60_000);
  });

  it('reads a file given as an argument, and - as stdin', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'log.txt'), `mail ${FAKE.EMAIL}\n`);
    expect(cli([join(dir, 'log.txt')]).stdout).toBe('mail [EMAIL_1]\n');
    expect(cli(['-'], `key ${FAKE.AWS_KEY}`).stdout).toBe('key [AWS_KEY_1]');
  });

  it('writes the map with mode 0600, and restore puts the originals back', () => {
    const map = join(tmp(), 'nested', 'map.json');
    const input = `key ${FAKE.AWS_KEY} mail ${FAKE.EMAIL}\n`;
    const masked = cli(['--map', map], input);
    expect(masked.code).toBe(0);
    expect(JSON.parse(readFileSync(map, 'utf8'))).toEqual({ '[AWS_KEY_1]': FAKE.AWS_KEY, '[EMAIL_1]': FAKE.EMAIL });
    expect(statSync(map).mode & 0o777).toBe(0o600);
    const restored = cli(['restore', `--map=${map}`], masked.stdout);
    expect(restored).toMatchObject({ code: 0, stdout: input, stderr: '' });
  });

  it('adds to an existing map: earlier placeholders keep their values and are never reassigned', () => {
    const map = join(tmp(), 'map.json');
    cli(['--map', map], `first ${FAKE.EMAIL}`);
    const second = cli(['--map', map], `then ${other}, again ${FAKE.EMAIL}`);
    expect(second.stdout).toBe('then [EMAIL_2], again [EMAIL_1]');
    expect(JSON.parse(readFileSync(map, 'utf8'))).toEqual({ '[EMAIL_1]': FAKE.EMAIL, '[EMAIL_2]': other });
    // An answer that mentions both runs' placeholders restores in one go.
    expect(cli(['restore', '--map', map], 'Write to [EMAIL_1] and [EMAIL_2].').stdout).toBe(`Write to ${FAKE.EMAIL} and ${other}.`);
  });

  it('runs that share a map at the same time never give two values one placeholder (found by the verifier)', async () => {
    const map = join(tmp(), 'map.json');
    const inputs = Array.from({ length: 8 }, (_, i) => j(`user${i}`, '@', 'example.com'));
    const runs = await Promise.all(inputs.map((input) => cliAsync(['--map', map], input)));
    expect(runs.map((r) => r.code)).toEqual(inputs.map(() => 0));
    const saved = JSON.parse(readFileSync(map, 'utf8'));
    expect(Object.keys(saved)).toHaveLength(8);
    runs.forEach((r, i) => expect(cli(['restore', '--map', map], r.stdout).stdout).toBe(inputs[i]));
  });

  it('writes through a symlinked map to its target (found by the verifier)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'private'));
    symlinkSync(join(dir, 'private', 'map.json'), join(dir, 'link.json'));
    // A chain of links whose last target does not exist yet.
    symlinkSync(join(dir, 'link2.json'), join(dir, 'chain.json'));
    symlinkSync(join(dir, 'deep', 'end.json'), join(dir, 'link2.json'));
    cli(['--map', join(dir, 'chain.json')], other);
    expect(JSON.parse(readFileSync(join(dir, 'deep', 'end.json'), 'utf8'))).toEqual({ '[EMAIL_1]': other });
    rmSync(join(dir, 'deep'), { recursive: true });
    rmSync(join(dir, 'chain.json'));
    rmSync(join(dir, 'link2.json'));
    cli(['--map', join(dir, 'link.json')], FAKE.EMAIL);
    expect(statSync(join(dir, 'link.json'), { throwIfNoEntry: false })).toBeDefined();
    expect(readdirSync(dir).sort()).toEqual(['link.json', 'private']);
    expect(JSON.parse(readFileSync(join(dir, 'private', 'map.json'), 'utf8'))).toEqual({ '[EMAIL_1]': FAKE.EMAIL });
  });

  it('rewrites an existing map with mode 0600, and removes temporary files a crashed run left', () => {
    const dir = tmp();
    const map = join(dir, 'map.json');
    writeFileSync(map, '{}', { mode: 0o644 });
    writeFileSync(join(dir, 'map.json.12345.tmp'), '{"[EMAIL_1]": "left over"}');
    cli(['--map', map], FAKE.EMAIL);
    expect(statSync(map).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['map.json']);
  });

  it('placeholder text typed in the input keeps its meaning in later runs (found by the verifier)', () => {
    const map = join(tmp(), 'map.json');
    const first = cli(['--map', map], `use [EMAIL_2] as a template; mine is ${FAKE.EMAIL}`);
    cli(['--map', map], other);
    expect(cli(['restore', '--map', map], first.stdout).stdout).toBe(`use [EMAIL_2] as a template; mine is ${FAKE.EMAIL}`);
  });

  it('a quoted look-alike of a CARD_NUMBER_JSON placeholder typed in the input keeps its quotes (Qodo, PR #29)', () => {
    const map = join(tmp(), 'map.json');
    const typed = 'the docs write it as "[CARD_NUMBER_JSON_1]"';
    const first = cli(['--map', map], typed);
    expect(cli(['restore', '--map', map], first.stdout).stdout).toBe(typed);
  });

  it('a placeholder from an earlier run in a later paste restores to its value', () => {
    const map = join(tmp(), 'map.json');
    cli(['--map', map], FAKE.EMAIL);
    const next = cli(['--map', map], `as I said, [EMAIL_1] and ${other}`);
    expect(next.stdout).toBe('as I said, [EMAIL_1] and [EMAIL_2]');
    expect(cli(['restore', '--map', map], next.stdout).stdout).toBe(`as I said, ${FAKE.EMAIL} and ${other}`);
  });

  it('-- ends the options, so a file name may start with - or be named restore', () => {
    const dir = tmp();
    writeFileSync(join(dir, '-notes.txt'), FAKE.EMAIL);
    writeFileSync(join(dir, 'restore'), FAKE.AWS_KEY);
    expect(spawnSync(process.execPath, [CLI, '--', '-notes.txt'], { cwd: dir }).stdout.toString()).toBe('[EMAIL_1]');
    expect(spawnSync(process.execPath, [CLI, '--', 'restore'], { cwd: dir }).stdout.toString()).toBe('[AWS_KEY_1]');
  });

  it('a lock left by a run that was stopped is taken over (found by the verifier)', () => {
    const map = join(tmp(), 'map.json');
    // A process id that is not running: a finished child's.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    writeFileSync(`${map}.lock`, `${dead}\n`);
    const t = Date.now();
    const r = cli(['--map', map], FAKE.EMAIL);
    expect(r).toMatchObject({ code: 0, stdout: '[EMAIL_1]', stderr: '' });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(readdirSync(dirname(map))).toEqual(['map.json']);
  });

  it('a lock no live run can own is taken over: empty and old, garbage and old, or another user\'s process (found by the verifier)', () => {
    const dir = tmp();
    const old = new Date(Date.now() - 60_000);
    const locks: [string, string][] = [['empty', ''], ['garbage', 'garbage'], ['pid1', '1\n']]; // pid 1 is launchd/init, not ours
    for (const [name, content] of locks) {
      const map = join(dir, `${name}.json`);
      writeFileSync(`${map}.lock`, content);
      if (name !== 'pid1') utimesSync(`${map}.lock`, old, old);
      const t = Date.now();
      expect(cli(['--map', map], FAKE.EMAIL)).toMatchObject({ code: 0, stdout: '[EMAIL_1]' });
      expect(Date.now() - t).toBeLessThan(5000);
    }
    expect(readdirSync(dir).filter((f) => f.includes('.lock'))).toEqual([]);
  });

  const startedAt = (pid: number) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

  it('a lock whose process id was reused by another process is taken over (found by Qodo in the review of PR #15)', () => {
    const map = join(tmp(), 'map.json');
    // This test process is alive, but it is not the process that wrote the lock: the start time differs.
    writeFileSync(`${map}.lock`, `${process.pid} Mon Jan  1 00:00:00 2001\n`);
    const t = Date.now();
    expect(cli(['--map', map], FAKE.EMAIL)).toMatchObject({ code: 0, stdout: '[EMAIL_1]' });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('a live holder is waited for however old its lock is, as a paused run would be (found by Qodo in the review of PR #15)', async () => {
    const map = join(tmp(), 'map.json');
    writeFileSync(`${map}.lock`, `${process.pid} ${startedAt(process.pid)}\n`);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(`${map}.lock`, old, old);
    const pending = cliAsync(['--map', map], FAKE.EMAIL);
    await new Promise((r) => setTimeout(r, 1000));
    expect(readdirSync(dirname(map))).toEqual(['map.json.lock']);
    rmSync(`${map}.lock`);
    expect(await pending).toMatchObject({ code: 0, stdout: '[EMAIL_1]' });
  });

  it('a run that lost its lock while paused writes nothing (found by Qodo in the review of PR #15)', async () => {
    const dir = tmp();
    const map = join(dir, 'map.json');
    writeFileSync(map, JSON.stringify({ '[EMAIL_1]': other }));
    const child = spawn(process.execPath, [CLI, '--map', map], { cwd: dir });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const done = new Promise<number | null>((r) => child.on('close', r));
    // Big enough that the run is still scrubbing when it is paused.
    child.stdin.end(`${FAKE.EMAIL}\n`.repeat(1_500_000));
    for (let i = 0; i < 400 && !readdirSync(dir).includes('map.json.lock'); i++) await new Promise((r) => setTimeout(r, 10));
    child.kill('SIGSTOP');
    // Meanwhile another run takes the lock over and writes the map.
    writeFileSync(`${map}.lock`, `${process.pid} ${startedAt(process.pid)}\n`);
    writeFileSync(map, JSON.stringify({ '[EMAIL_1]': other, '[EMAIL_2]': 'newer' }));
    child.kill('SIGCONT');
    expect(await done).toBe(2);
    expect(stderr).toContain('took over the map while this one was paused; nothing was written');
    expect(JSON.parse(readFileSync(map, 'utf8'))).toEqual({ '[EMAIL_1]': other, '[EMAIL_2]': 'newer' });
    rmSync(`${map}.lock`);
  }, 30_000);

  it('a lock held by a live run is waited for, not taken over', async () => {
    const map = join(tmp(), 'map.json');
    writeFileSync(`${map}.lock`, `${process.pid}\n`); // this test process, which is alive
    const pending = cliAsync(['--map', map], FAKE.EMAIL);
    await new Promise((r) => setTimeout(r, 500));
    expect(readdirSync(dirname(map))).toEqual(['map.json.lock']);
    rmSync(`${map}.lock`);
    expect(await pending).toMatchObject({ code: 0, stdout: '[EMAIL_1]' });
  });

  it('a reader that closes early is not an error (found by the verifier)', () => {
    const big = `${FAKE.EMAIL}\n`.repeat(200_000);
    const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${CLI}" | head -c 20`], { input: big });
    expect(r.stdout.toString()).toBe('[EMAIL_1]\n[EMAIL_1]\n');
    expect(r.stderr.toString()).toBe('');
  });

  it('restore leaves placeholders it does not know', () => {
    const map = join(tmp(), 'map.json');
    cli(['--map', map], FAKE.EMAIL);
    expect(cli(['restore', '--map', map], '[EMAIL_1] [EMAIL_9] [OTHER_1]').stdout).toBe(`${FAKE.EMAIL} [EMAIL_9] [OTHER_1]`);
  });

  it('--summary prints a count per kind to stderr, never a value', () => {
    const r = cli(['--summary'], `${FAKE.EMAIL} ${other} ${FAKE.GITHUB_TOKEN} ${FAKE.EMAIL}`);
    expect(r.stderr).toBe('EMAIL 3\nGITHUB_TOKEN 1\n');
    expect(r.stdout).toBe('[EMAIL_1] [EMAIL_2] [GITHUB_TOKEN_1] [EMAIL_1]');
    expect(cli(['--summary'], 'nothing here').stderr).toBe('nothing masked\n');
  });

  it('--help prints usage and exits 0', () => {
    const r = cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('scrubline restore [file] --map <file>');
  });

  describe('errors exit 2 and never show input text or map values', () => {
    const secret = FAKE.GITHUB_TOKEN;

    function expectError(r: ReturnType<typeof cli>, message: string) {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^scrubline: /);
      expect(r.stderr).toContain(message);
      // Not even a fragment: Node's JSON errors quote about ten characters of the text.
      expect(r.stderr).not.toContain(secret.slice(0, 8));
    }

    it('an unknown option, or too many files', () => {
      expectError(cli(['--nope'], secret), 'unknown option (see --help)');
      expectError(cli(['a', 'b'], secret), 'give at most one input file');
      expectError(cli(['--map'], secret), '--map needs a file name');
      // The next option is not a file name: it once received every secret, in a file named `--summary`.
      expectError(cli(['--map', '--summary'], secret), '--map needs a file name');
    });

    it('an argument is never echoed: it may be text pasted in place of a file name (found by the verifier)', () => {
      expectError(cli([`deploy with ${secret}`]), 'cannot read the input file');
      expectError(cli([`-${secret}`]), 'unknown option');
      // A lowercase passphrase looks like an option name; it is not echoed either.
      const r = cli(['--correct-horse-battery']);
      expect(r.code).toBe(2);
      expect(r.stderr).not.toContain('horse');
      expectError(cli(['--map', join(tmp(), `${secret}.json`), 'restore']), 'the map file does not exist');
    });

    it('restore without a map, with a missing one, or with --summary', () => {
      expectError(cli(['restore'], secret), 'restore needs --map <file>');
      expectError(cli(['restore', '--map', join(tmp(), 'none.json')], secret), 'does not exist');
      expectError(cli(['restore', '--map', join(tmp(), 'm.json'), '--summary'], secret), '--summary applies to scrubbing only');
    });

    it('a map file that is not valid JSON or not a scrubline map', () => {
      const dir = tmp();
      // Node's JSON.parse error quotes the text it failed on; the message must not pass that on.
      writeFileSync(join(dir, 'bad.json'), `{"[EMAIL_1]": ${secret}}`);
      writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ token: secret }));
      writeFileSync(join(dir, 'array.json'), JSON.stringify([secret]));
      for (const args of [[], ['restore']]) {
        expectError(cli([...args, '--map', join(dir, 'bad.json')], secret), 'is not valid JSON');
        expectError(cli([...args, '--map', join(dir, 'wrong.json')], secret), 'is not a scrubline map');
        expectError(cli([...args, '--map', join(dir, 'array.json')], secret), 'is not a scrubline map');
      }
    });

    it('an input file that cannot be read, or a map that cannot be written', () => {
      const dir = tmp();
      expectError(cli([join(dir, 'missing.txt')]), 'cannot read');
      // A read-only folder: the map cannot be written, and the masked text is not printed without its map.
      mkdirSync(join(dir, 'locked'), { mode: 0o500 });
      expectError(cli(['--map', join(dir, 'locked', 'map.json')], secret), 'cannot write the map file');
    });
  });
});
