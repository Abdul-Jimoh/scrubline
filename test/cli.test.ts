import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FAKE, j } from './fixtures.js';

// End to end: the built command, run as a child process with real stdin, stdout, stderr and exit codes.
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(import.meta.dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: join(import.meta.dirname, '..'),
  });
}, 60_000);

function cli(args: string[], input: string | Buffer = '') {
  const r = spawnSync(process.execPath, [CLI, ...args], { input });
  return { code: r.status, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), raw: r.stdout };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'scrubline-cli-'));
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

  it('known limit: input is read as UTF-8, so a byte that is not valid UTF-8 becomes U+FFFD', () => {
    expect(cli([], Buffer.from([0xff, 0x61])).raw).toEqual(Buffer.from('\uFFFDa', 'utf8'));
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
      expectError(cli(['--nope'], secret), 'unknown option --nope');
      expectError(cli(['a', 'b'], secret), 'give at most one input file');
      expectError(cli(['--map'], secret), '--map needs a file name');
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
      expectError(cli(['--map', join(dir, 'locked', 'map.json')], secret), 'cannot write map file');
    });
  });
});
