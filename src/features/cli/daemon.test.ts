import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '../../shared/fs.js';
import { runCommand } from './commands.js';
import type { ParsedArgs } from './args.js';

const REPO = 'acme/widgets';
const BOT = 'roboomp';

// One page of `gh api repos/acme/widgets/issues/comments`: a mention of the
// daemon's bot that must dispatch, and a mention of a DIFFERENT bot that must
// not — this pins that the daemon forwards --bot to the comments pass.
const recentComments = [
  {
    id: 201,
    body: '@roboomp stop',
    user: { login: 'bob' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/9',
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z'
  },
  {
    id: 202,
    body: '@fixbot fix the save path',
    user: { login: 'carol' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/12',
    created_at: '2026-07-01T11:00:00Z',
    updated_at: '2026-07-01T11:00:00Z'
  }
];

// One page of `gh api repos/acme/widgets/issues`: a single issue matching the
// crash rule below, so a real issues pass produces a visible label preview.
const recentIssues = [
  {
    number: 12,
    title: 'Editor crash on save',
    body: 'Segfault when saving large boards.',
    url: 'https://github.com/acme/widgets/issues/12',
    labels: [],
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T12:00:00Z'
  }
];

const fixbotConfig = {
  autoLabel: {
    enabled: true,
    defaultLabels: [],
    rules: [{ label: 'crash-report', keywords: ['crash', 'segfault'] }]
  }
};

type Harness = { root: string; cwd: string; callsFile: string };

// Fake `gh` that serves one comments page and one issues page, refuses every
// mutation (the daemon tests only run --dry-run passes), and logs each
// invocation so tests can assert exactly what would have hit the GitHub API.
async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-daemon-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, '.fixbot.json'), JSON.stringify(fixbotConfig));
  const commentsFile = join(root, 'comments.json');
  const issuesFile = join(root, 'issues.json');
  const callsFile = join(root, 'gh-calls.log');
  await writeFile(commentsFile, JSON.stringify(recentComments));
  await writeFile(issuesFile, JSON.stringify(recentIssues));
  await writeFile(callsFile, '');
  const script = `#!/bin/sh
all="$*"
printf '%s\\n' "$all" >> "${callsFile}"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
[ "$1" = "api" ] || fail "daemon passes must only use the REST API"
case "$all" in
  *"--method POST"*|*"--method PATCH"*|*"--method PUT"*|*"--method DELETE"*) fail "dry-run daemon pass must not mutate GitHub" ;;
esac
case "$all" in
  *"repos/acme/widgets/issues/comments"*) cat "${commentsFile}" ;;
  *"repos/acme/widgets/issues "*) cat "${issuesFile}" ;;
  *) fail "unexpected api call" ;;
esac
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, cwd, callsFile };
}

function daemon(command: string, positional: string[], flags: ParsedArgs['flags']): ParsedArgs {
  return { command, positional, flags };
}

async function ghCalls(callsFile: string): Promise<string[]> {
  return (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean);
}

// The daemon reports pass results via process.stdout, not its return value;
// capture that boundary for the duration of one call and always restore it.
async function captureStdout<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = process.stdout.write;
  let logged = '';
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown): boolean => {
    logged += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const callback = typeof encoding === 'function' ? encoding : cb;
    if (typeof callback === 'function') callback();
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await run();
    return { result, logged };
  } finally {
    process.stdout.write = original;
  }
}

test('daemon one-pass orchestration', async (t) => {
  const h = await makeHarness();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(h.root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  try {
    await t.test('--once --dry-run runs one comments pass and one issues pass, then stops', async () => {
      const sigint = process.listenerCount('SIGINT');
      const sigterm = process.listenerCount('SIGTERM');
      const { result, logged } = await captureStdout(() =>
        runCommand(daemon('daemon', [REPO], { bot: BOT, 'dry-run': true, once: true }), h.cwd)
      );
      assert.equal(result, 'Daemon stopped.\n');
      // The comments pass ran with the daemon's bot name: the @roboomp mention
      // dispatched (through the real stop path), the @fixbot one did not.
      assert.ok(logged.includes('Dispatched stop for acme/widgets#9'), logged);
      assert.match(logged, /No running job stopped for acme\/widgets#9/);
      assert.ok(!logged.includes('Dispatched fix'), logged);
      // The issues pass ran with --dry-run forwarded: label preview, no mutation.
      assert.ok(logged.includes('Would label acme/widgets#12: crash-report'), logged);
      assert.ok(!logged.includes('Labeled '), logged);
      // Exactly one read per pass and zero writes hit the API (the fake gh
      // exits 64 on any mutation, so a POST would also surface as a failure).
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 2, calls.join('\n'));
      assert.equal(calls.filter((call) => call.includes('repos/acme/widgets/issues/comments')).length, 1, calls.join('\n'));
      assert.equal(calls.filter((call) => /repos\/acme\/widgets\/issues /.test(call)).length, 1, calls.join('\n'));
      // A dry-run pass must not mark comments or issues processed.
      assert.equal(await pathExists(join(h.cwd, '.fixbot', 'poll-state')), false, 'dry-run wrote comment poll state');
      assert.equal(await pathExists(join(h.cwd, '.fixbot', 'issue-state')), false, 'dry-run wrote issue poll state');
      // The daemon unhooks its signal handlers once it stops.
      assert.equal(process.listenerCount('SIGINT'), sigint);
      assert.equal(process.listenerCount('SIGTERM'), sigterm);
    });

    await t.test('watch alias reaches the same one-pass path', async () => {
      const before = (await ghCalls(h.callsFile)).length;
      const { result, logged } = await captureStdout(() =>
        runCommand(daemon('watch', [REPO], { bot: BOT, 'dry-run': true, once: true }), h.cwd)
      );
      assert.equal(result, 'Daemon stopped.\n');
      assert.ok(logged.includes('Dispatched stop for acme/widgets#9'), logged);
      assert.ok(logged.includes('Would label acme/widgets#12: crash-report'), logged);
      assert.equal((await ghCalls(h.callsFile)).length - before, 2);
    });

    await t.test('invalid intervals reject before any API traffic', async (t2) => {
      const cases = [
        { flag: 'comments-interval', value: '0' },
        { flag: 'comments-interval', value: '-30' },
        { flag: 'comments-interval', value: 'soon' },
        { flag: 'issues-interval', value: '0' }
      ];
      for (const { flag, value } of cases) {
        await t2.test(`--${flag} ${value}`, async () => {
          const before = (await ghCalls(h.callsFile)).length;
          await assert.rejects(
            runCommand(daemon('daemon', [REPO], { bot: BOT, 'dry-run': true, once: true, [flag]: value }), h.cwd),
            new RegExp(`--${flag} must be a positive number of seconds`)
          );
          assert.equal((await ghCalls(h.callsFile)).length, before, 'rejected daemon still called gh');
        });
      }
    });

    await t.test('daemon without a repo rejects with a usage error', async () => {
      await assert.rejects(runCommand(daemon('daemon', [], {}), h.cwd), /Missing repo for daemon/);
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(h.root, { recursive: true, force: true });
  }
});

test('help output documents the daemon workflow', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-daemon-help-'));
  try {
    const output = await runCommand(daemon('help', [], {}), cwd);
    assert.match(output, /daemon <owner\/repo>/);
    assert.match(output, /Alias: watch/);
    assert.match(output, /pnpm dev -- <owner\/repo>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
