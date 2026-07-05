import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '../../shared/fs.js';
import { runCommand } from './commands.js';
import type { ParsedArgs } from './args.js';

const REPO = 'acme/widgets';
const NEWEST = '2026-07-01T12:30:00Z';

// One page of `gh api repos/acme/widgets/issues/comments`: two routable
// mentions, a plain comment, and a lookalike login that must not route.
const recentComments = [
  {
    id: 101,
    body: '@fixbot stop',
    user: { login: 'bob' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/9',
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z'
  },
  {
    id: 102,
    body: '@fixbot fix the save path',
    user: { login: 'carol' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/12',
    created_at: '2026-07-01T11:00:00Z',
    // Edited after creation: the newest timestamp on the page, so the poll
    // cursor must land here (updatedAt beats createdAt).
    updated_at: NEWEST
  },
  {
    id: 103,
    body: 'thanks, works now',
    user: { login: 'dave' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/12',
    created_at: '2026-07-01T11:30:00Z',
    updated_at: '2026-07-01T11:30:00Z'
  },
  {
    id: 104,
    body: 'ping @fixbotter about this',
    user: { login: 'erin' },
    issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
    created_at: '2026-07-01T11:45:00Z',
    updated_at: '2026-07-01T11:45:00Z'
  }
];

type Harness = { root: string; cwd: string; callsFile: string };

// Fake `gh` that serves the fixture page when no `since` is sent and an empty
// page otherwise, logging every invocation so tests can assert exactly what
// would have hit the GitHub API.
async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-poll-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const commentsFile = join(root, 'comments.json');
  const callsFile = join(root, 'gh-calls.log');
  await writeFile(commentsFile, JSON.stringify(recentComments));
  await writeFile(callsFile, '');
  const script = `#!/bin/sh
all="$*"
printf '%s\\n' "$all" >> "${callsFile}"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
[ "$1" = "api" ] || fail "poll must only read the issue comments API"
case "$all" in
  *"--method POST"*|*"--method PATCH"*|*"--method PUT"*|*"--method DELETE"*) fail "poll must not mutate GitHub" ;;
esac
case "$all" in
  *"repos/acme/widgets/issues/comments"*) ;;
  *) fail "unexpected api call" ;;
esac
case "$all" in
  *"since="*) echo "[]" ;;
  *) cat "${commentsFile}" ;;
esac
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, cwd, callsFile };
}

function poll(positional: string[], flags: ParsedArgs['flags']): ParsedArgs {
  return { command: 'poll-comments', positional, flags };
}

async function ghCalls(callsFile: string): Promise<string[]> {
  return (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean);
}

function at(list: readonly string[], index: number): string {
  const value = list[index];
  assert.ok(value !== undefined, `expected entry at index ${index}, got ${list.length} entries`);
  return value;
}

test('poll-comments single-pass orchestration', async (t) => {
  const h = await makeHarness();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(h.root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const defaultState = join(h.cwd, '.fixbot', 'poll-state', 'acme-widgets.json');
  const customState = join(h.cwd, 'custom-state.json');
  try {
    await t.test('dry-run pass routes mentions, skips the rest, and leaves no state behind', async () => {
      const out = await runCommand(poll([REPO], { 'dry-run': true }), h.cwd);
      // Stop never waits behind the queue: it runs immediately, even in dry-run.
      assert.ok(out.includes('Dispatched stop for acme/widgets#9'), out);
      assert.match(out, /No running job stopped for acme\/widgets#9/);
      // Work commands are queued, not dispatched inline.
      assert.ok(out.includes('Would queue fix for acme/widgets#12'), out);
      // The plain comment (#12) and the @fixbotter lookalike (#7) must not route.
      assert.equal(out.split('Would queue ').length - 1, 1, out);
      // A preview must not mark comments processed or enqueue jobs.
      assert.equal(await pathExists(defaultState), false, 'dry-run wrote poll state');
      assert.equal(await pathExists(join(h.cwd, '.fixbot', 'queue')), false, 'dry-run wrote the job queue');
      // Exactly one API read and zero mutations: dry-run stayed off GitHub.
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 1, calls.join('\n'));
      assert.ok(!at(calls, 0).includes('since='), at(calls, 0));
    });

    await t.test('real pass persists the newest updatedAt even when nothing routes', async () => {
      const out = await runCommand(poll([REPO], { bot: 'repair-bot', state: customState }), h.cwd);
      assert.ok(out.includes('No bot commands found.'), out);
      assert.ok(!out.includes('Dispatched '), out);
      // Skipped non-mentions still advance the cursor so the next pass never
      // re-reads them.
      assert.deepStrictEqual(JSON.parse(await readFile(customState, 'utf8')), { since: NEWEST });
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 2, calls.join('\n'));
      assert.ok(!at(calls, 1).includes('since='), at(calls, 1));
    });

    await t.test('next pass resumes from the persisted since', async () => {
      const out = await runCommand(poll([REPO], { bot: 'repair-bot', state: customState }), h.cwd);
      assert.ok(out.includes('No bot commands found.'), out);
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 3, calls.join('\n'));
      assert.ok(at(calls, 2).includes(`since=${NEWEST}`), at(calls, 2));
      // An empty page must not lose the resume point.
      const state = JSON.parse(await readFile(customState, 'utf8')) as { since?: string };
      assert.equal(state.since, NEWEST);
    });

    await t.test('--since overrides the persisted value for the pass', async () => {
      const override = '2026-06-01T00:00:00Z';
      await runCommand(poll([REPO], { bot: 'repair-bot', state: customState, since: override, 'dry-run': true }), h.cwd);
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 4, calls.join('\n'));
      assert.ok(at(calls, 3).includes(`since=${override}`), at(calls, 3));
      assert.ok(!at(calls, 3).includes(`since=${NEWEST}`), at(calls, 3));
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(h.root, { recursive: true, force: true });
  }
});
