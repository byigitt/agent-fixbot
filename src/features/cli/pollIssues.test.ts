import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from '../../shared/fs.js';
import { runCommand } from './commands.js';
import type { ParsedArgs } from './args.js';

const REPO = 'acme/widgets';
const NEWEST = '2026-07-02T09:00:00Z';

// Project-specific auto-label rules written to `.fixbot.json` in the harness
// cwd, so assertions pin this configuration rather than shipped defaults.
const fixbotConfig = {
  autoLabel: {
    enabled: true,
    defaultLabels: [],
    rules: [
      { label: 'crash-report', keywords: ['crash', 'segfault'] },
      { label: 'docs', keywords: ['readme', 'typo'] }
    ]
  }
};

const autoDispatchConfig = {
  autoLabel: fixbotConfig.autoLabel,
  autoDispatch: {
    enabled: true,
    mode: 'triage',
    maxPerPoll: 1,
    skipWhenLabels: ['triaged'],
    requireLabels: ['crash-report']
  }
};

// One page of `gh api repos/acme/widgets/issues`:
// #12 matches both rules but already carries `docs`, so only `crash-report`
// may be added; #30 matches nothing and defaultLabels is empty; #33 already
// carries every label its rule would add; #41 is a PR row that the client
// must drop even though its title matches the crash rule.
const recentIssues = [
  {
    number: 12,
    title: 'Editor crash on save',
    body: 'Also the README has a typo in the save section.',
    url: 'https://github.com/acme/widgets/issues/12',
    labels: [{ name: 'docs' }],
    created_at: '2026-07-01T10:00:00Z',
    updated_at: NEWEST
  },
  {
    number: 30,
    title: 'Widget palette feels slow',
    body: 'Dragging feels sluggish on large boards.',
    url: 'https://github.com/acme/widgets/issues/30',
    labels: [],
    created_at: '2026-07-01T11:00:00Z',
    updated_at: '2026-07-01T11:00:00Z'
  },
  {
    number: 33,
    title: 'readme: outdated install steps',
    body: 'The README still references npm.',
    url: 'https://github.com/acme/widgets/issues/33',
    labels: [{ name: 'docs' }],
    created_at: '2026-07-01T12:00:00Z',
    updated_at: '2026-07-01T12:00:00Z'
  },
  {
    number: 41,
    title: 'fix: crash guard',
    body: 'Closes #12',
    url: 'https://github.com/acme/widgets/pull/41',
    labels: [],
    created_at: '2026-07-01T13:00:00Z',
    updated_at: '2026-07-01T13:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/41' }
  }
];

type Harness = { root: string; cwd: string; callsFile: string };

// Fake `gh` that serves the fixture page when no `since` is sent and an empty
// page otherwise, accepts label POSTs, and logs every invocation so tests can
// assert exactly what would have hit the GitHub API.
async function makeHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-poll-issues-'));
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  await mkdir(bin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, '.fixbot.json'), JSON.stringify(fixbotConfig));
  const issuesFile = join(root, 'issues.json');
  const callsFile = join(root, 'gh-calls.log');
  await writeFile(issuesFile, JSON.stringify(recentIssues));
  await writeFile(callsFile, '');
  const script = `#!/bin/sh
all="$*"
printf '%s\\n' "$all" >> "${callsFile}"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
[ "$1" = "api" ] || fail "poll-issues must only use the REST API"
case "$all" in
  *"--method POST"*)
    case "$all" in
      *"repos/acme/widgets/issues/"*"/labels"*) echo "[]" ;;
      *) fail "unexpected POST target" ;;
    esac
    ;;
  *"--method GET"*)
    case "$all" in
      *"repos/acme/widgets/issues -f"*) ;;
      *) fail "unexpected GET target" ;;
    esac
    case "$all" in
      *"since="*) echo "[]" ;;
      *) cat "${issuesFile}" ;;
    esac
    ;;
  *) fail "poll-issues must pass an explicit --method" ;;
esac
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, cwd, callsFile };
}

function poll(positional: string[], flags: ParsedArgs['flags']): ParsedArgs {
  return { command: 'poll-issues', positional, flags };
}

async function ghCalls(callsFile: string): Promise<string[]> {
  return (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean);
}

function at(list: readonly string[], index: number): string {
  const value = list[index];
  assert.ok(value !== undefined, `expected entry at index ${index}, got ${list.length} entries`);
  return value;
}

test('poll-issues auto-label orchestration', async (t) => {
  const h = await makeHarness();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(h.root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const defaultState = join(h.cwd, '.fixbot', 'issue-state', 'acme-widgets.json');
  const customState = join(h.cwd, 'custom-state.json');
  try {
    await t.test('dry-run previews only missing labels and touches nothing', async () => {
      const out = await runCommand(poll([REPO], { 'dry-run': true }), h.cwd);
      // #12 matches crash-report + docs, but docs is already on the issue.
      assert.ok(out.includes('Would label acme/widgets#12: crash-report'), out);
      assert.ok(!out.includes('crash-report, docs'), out);
      // #30 (no match, empty defaults), #33 (fully labeled), and the PR row
      // (#41) must all stay silent.
      assert.equal(out.split('Would label ').length - 1, 1, out);
      assert.ok(!out.includes('Labeled '), out);
      // A preview must not mark issues processed.
      assert.equal(await pathExists(defaultState), false, 'dry-run wrote issue poll state');
      // Exactly one API read and zero mutations: dry-run stayed off GitHub.
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 1, calls.join('\n'));
      assert.ok(!at(calls, 0).includes('--method POST'), at(calls, 0));
      assert.ok(!at(calls, 0).includes('since='), at(calls, 0));
    });

    await t.test('live pass posts only the missing labels and persists the newest cursor', async () => {
      const out = await runCommand(poll([REPO], { state: customState }), h.cwd);
      assert.ok(out.includes('Labeled acme/widgets#12: crash-report'), out);
      assert.equal(out.split('Labeled ').length - 1, 1, out);
      // Exactly one mutation, and it must not re-add the existing `docs` label.
      const calls = await ghCalls(h.callsFile);
      const posts = calls.filter((call) => call.includes('--method POST'));
      assert.equal(posts.length, 1, calls.join('\n'));
      assert.equal(at(posts, 0), 'api --method POST repos/acme/widgets/issues/12/labels -f labels[]=crash-report');
      // Skipped issues still advance the cursor so the next pass never
      // re-reads them.
      assert.deepStrictEqual(JSON.parse(await readFile(customState, 'utf8')), { since: NEWEST });
    });

    await t.test('next pass resumes from the persisted since', async () => {
      const out = await runCommand(poll([REPO], { state: customState }), h.cwd);
      assert.ok(out.includes('No issues labeled or dispatched.'), out);
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 4, calls.join('\n'));
      assert.ok(at(calls, 3).includes(`since=${NEWEST}`), at(calls, 3));
      // An empty page must not lose the resume point.
      assert.deepStrictEqual(JSON.parse(await readFile(customState, 'utf8')), { since: NEWEST });
    });

    await t.test('--since overrides the persisted value for the pass', async () => {
      const override = '2026-06-01T00:00:00Z';
      await runCommand(poll([REPO], { state: customState, since: override, 'dry-run': true }), h.cwd);
      const calls = await ghCalls(h.callsFile);
      assert.equal(calls.length, 5, calls.join('\n'));
      assert.ok(at(calls, 4).includes(`since=${override}`), at(calls, 4));
      assert.ok(!at(calls, 4).includes(`since=${NEWEST}`), at(calls, 4));
    });

    await t.test('auto-dispatch dry-run previews only eligible issues and does not run an agent', async () => {
      await writeFile(join(h.cwd, '.fixbot.json'), JSON.stringify(autoDispatchConfig));
      const before = (await ghCalls(h.callsFile)).length;
      const out = await runCommand(poll([REPO], { 'dry-run': true }), h.cwd);
      assert.ok(out.includes('Would label acme/widgets#12: crash-report'), out);
      assert.ok(out.includes('Would auto-dispatch triage for acme/widgets#12'), out);
      assert.equal(out.split('Would auto-dispatch ').length - 1, 1, out);
      assert.ok(!out.includes('acme/widgets#30'), out);
      assert.ok(!out.includes('acme/widgets#33'), out);
      const passCalls = (await ghCalls(h.callsFile)).slice(before);
      assert.equal(passCalls.length, 1, passCalls.join('\n'));
      assert.ok(!at(passCalls, 0).includes('--method POST'), at(passCalls, 0));
      assert.equal(await pathExists(defaultState), false, 'dry-run wrote issue poll state');
    });

    await t.test('autoLabel.enabled=false disables labeling entirely', async () => {
      await writeFile(join(h.cwd, '.fixbot.json'), JSON.stringify({ autoLabel: { ...fixbotConfig.autoLabel, enabled: false } }));
      const before = (await ghCalls(h.callsFile)).length;
      const out = await runCommand(poll([REPO], { 'dry-run': true }), h.cwd);
      assert.ok(out.includes('No issues labeled or dispatched.'), out);
      assert.ok(!out.includes('Would label'), out);
      // The disabled pass still reads the page but never proposes a mutation.
      const passCalls = (await ghCalls(h.callsFile)).slice(before);
      assert.equal(passCalls.length, 1, passCalls.join('\n'));
      assert.ok(!at(passCalls, 0).includes('--method POST'), at(passCalls, 0));
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(h.root, { recursive: true, force: true });
  }
});
