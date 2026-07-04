import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from '../../shared/exec.js';
import { pathExists } from '../../shared/fs.js';
import { acquireJobLock, releaseJobLock } from '../jobs/jobLock.js';
import { runCommand } from './commands.js';
import type { ParsedArgs } from './args.js';

const BLOCKED = 'Job already running for acme/widgets#12.\n';

function args(command: string, positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command, positional, flags };
}

test('same-ref job lock gates dispatch', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-lock-'));
  try {
    await t.test('a held lock turns dispatch into a blocked result, scoped to its ref', async () => {
      const lock = await acquireJobLock(cwd, 'acme/widgets', 12, 'held-by-test');
      assert.ok(lock, 'a fresh directory must grant the lock');
      // While held, a same-ref acquire loses...
      assert.equal(await acquireJobLock(cwd, 'acme/widgets', 12, 'rival'), undefined);
      // ...and a same-ref dispatch reports blocked instead of double-running.
      const blocked = await runCommand(args('fix', ['acme/widgets#12'], { 'dry-run': true }), cwd);
      assert.equal(blocked, BLOCKED);
      // The lock is scoped to repo#number: issue #13 still runs.
      const other = await runCommand(args('fix', ['acme/widgets#13'], { 'dry-run': true }), cwd);
      assert.ok(other.includes('Agent finished: noop-agent'), other);
      assert.ok(!other.includes('Job already running'), other);
      await releaseJobLock(lock);
    });

    await t.test('comment dispatch is gated by the same lock', async () => {
      const lock = await acquireJobLock(cwd, 'acme/widgets', 12, 'held-by-test');
      assert.ok(lock, 'the lock must be grantable again after release');
      const eventFile = join(cwd, 'event.json');
      await writeFile(eventFile, JSON.stringify({
        comment: { body: '@fixbot fix the save path', user: { login: 'alice' } },
        issue: { number: 12 },
        repository: { full_name: 'acme/widgets' }
      }));
      const out = await runCommand(args('dispatch-comment', [eventFile], { 'dry-run': true }), cwd);
      assert.equal(out, BLOCKED);
      await releaseJobLock(lock);
    });

    await t.test('a finished dispatch releases the lock for the next run', async () => {
      const first = await runCommand(args('fix', ['acme/widgets#12'], { 'dry-run': true }), cwd);
      assert.ok(first.includes('Agent finished: noop-agent'), first);
      const second = await runCommand(args('fix', ['acme/widgets#12'], { 'dry-run': true }), cwd);
      assert.ok(second.includes('Agent finished: noop-agent'), `the first run must release the ref lock:\n${second}`);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Fixture served for `gh issue view 12`.
const issueView = {
  title: 'Save crashes on empty name',
  body: 'Steps: save a widget with an empty name.',
  url: 'https://github.com/acme/widgets/issues/12',
  comments: [],
  labels: []
};

type LiveHarness = { root: string; work: string; marker: string; release: string };

// A real (non-dry-run) dispatch harness with no network: `gh` is a fake that
// serves fixtures and clones a local template repo, and the "agent" reports
// that it started (marker file) then blocks on a FIFO until the test releases
// it — so the job stays in flight exactly as long as the test needs.
async function makeLiveHarness(): Promise<LiveHarness> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-inflight-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  const template = join(root, 'template');
  await mkdir(bin, { recursive: true });
  await mkdir(work, { recursive: true });

  // Local template repo standing in for github.com: the fake `gh repo clone`
  // clones it, so `git fetch origin main` works offline.
  const init = await execFile('git', ['init', template], { cwd: root });
  assert.equal(init.exitCode, 0, init.stderr);
  const commit = await execFile('git', ['-C', template, '-c', 'user.email=fixbot@test', '-c', 'user.name=fixbot', 'commit', '--allow-empty', '-m', 'init'], { cwd: root });
  assert.equal(commit.exitCode, 0, commit.stderr);
  const branch = await execFile('git', ['-C', template, 'branch', '-M', 'main'], { cwd: root });
  assert.equal(branch.exitCode, 0, branch.stderr);

  const marker = join(root, 'agent-started');
  const release = join(root, 'agent-release');
  const fifo = await execFile('mkfifo', [release], { cwd: root });
  assert.equal(fifo.exitCode, 0, fifo.stderr);
  const agent = join(root, 'fake-agent.sh');
  await writeFile(agent, `#!/bin/sh
touch "${marker}"
cat "${release}" > /dev/null
exit 0
`);
  await chmod(agent, 0o755);
  // The 15s agent timeout is a hang guard only; the healthy path releases the
  // FIFO within a couple of spawns, and a regression that lets a second agent
  // steal the FIFO should fail the test quickly, not after minutes.
  await writeFile(join(work, '.fixbot.json'), JSON.stringify({ agent: { command: agent, args: [], timeoutSeconds: 15 } }));

  const issueFile = join(root, 'issue-view.json');
  await writeFile(issueFile, JSON.stringify(issueView));
  const gh = `#!/bin/sh
all="$*"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  cat "${issueFile}"
elif [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "https://github.com/acme/widgets/issues/12#issuecomment-1"
elif [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo "[]"
elif [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  git clone -q "${template}" "$4"
elif [ "$1" = "api" ]; then
  case "$all" in
    *"--method POST"*|*"--method PATCH"*) echo "{}" ;;
    *"issues/12/comments"*) echo "[]" ;;
    *) echo "{}" ;;
  esac
else
  fail "unexpected gh invocation"
fi
`;
  await writeFile(join(bin, 'gh'), gh);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, work, marker, release };
}

// Event-driven wait for a file created by the agent process: fs.watch on the
// parent directory, with an existence check to close the started-before-watch
// race. The AbortSignal deadline is a hang guard for a broken harness, not a
// tuned delay — the resolution path is the filesystem event.
async function waitForFile(dir: string, file: string): Promise<void> {
  const watcher = watch(dir, { signal: AbortSignal.timeout(30000) });
  try {
    if (await pathExists(file)) return;
    for await (const _event of watcher) {
      if (await pathExists(file)) return;
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`Timed out waiting for ${file}`);
    throw error;
  }
}

test('an in-flight job holds the ref lock until the agent finishes', async () => {
  const h = await makeLiveHarness();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(h.root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  try {
    type Outcome = { resolved: string } | { rejected: Error };
    let settled: Outcome | undefined;
    const first = runCommand(args('fix', ['acme/widgets#12']), h.work).then(
      (resolved): Outcome => (settled = { resolved }),
      (rejected: Error): Outcome => (settled = { rejected })
    );
    // Either the agent starts (healthy) or the dispatch dies early (bug).
    const raced = await Promise.race([first, waitForFile(h.root, h.marker)]);
    if (raced !== undefined) {
      const detail = 'rejected' in raced ? raced.rejected.stack ?? raced.rejected.message : raced.resolved;
      assert.fail(`the first dispatch finished before its agent started:\n${detail}`);
    }

    // The agent is running, so the ref lock is held: a rival same-ref
    // dispatch must come back blocked without starting a second agent.
    const blocked = await runCommand(args('fix', ['acme/widgets#12']), h.work);
    assert.equal(blocked, BLOCKED);
    assert.equal(settled, undefined, 'the first dispatch must still be in flight when the rival is blocked');

    // Release the agent; the first dispatch runs to completion.
    await writeFile(h.release, 'finish\n');
    const outcome = await first;
    if ('rejected' in outcome) throw outcome.rejected;
    assert.ok(outcome.resolved.includes('Agent finished'), outcome.resolved);
    // The agent changed nothing, so the publisher must decline politely.
    assert.ok(outcome.resolved.includes('No diff to publish'), outcome.resolved);

    // Completion released the lock: the same ref dispatches again.
    const after = await runCommand(args('fix', ['acme/widgets#12'], { 'dry-run': true }), h.work);
    assert.ok(after.includes('Agent finished: noop-agent'), after);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(h.root, { recursive: true, force: true });
  }
});
