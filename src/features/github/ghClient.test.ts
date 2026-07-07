import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhCliClient } from './ghClient.js';
import type { GitHubClient, PullRequestContext } from './githubClient.js';

const REPO = 'acme/widgets';
const PR_NUMBER = 41;

// Realistic `gh pr view --json ...` payload for the bot's own fix PR.
const prView = {
  title: 'fix: guard save path',
  body: 'Closes #12\n\nRepro: saving with an empty name crashed the widget editor.',
  url: 'https://github.com/acme/widgets/pull/41',
  author: { login: 'fixbot' },
  baseRefName: 'main',
  headRefName: 'fixbot/issue-12-save-path',
  headRepository: { name: 'widgets', nameWithOwner: 'acme/widgets' },
  comments: [{ author: { login: 'dave' }, body: 'please also update the changelog' }],
  reviews: [
    { author: { login: 'carol' }, state: 'CHANGES_REQUESTED', body: 'guard the null case in save()' },
    { author: { login: 'erin' }, state: 'APPROVED', body: '' }
  ],
  commits: [{ oid: 'abc1234', messageHeadline: 'fix: guard empty save name' }],
  files: [{ path: 'src/save.ts' }],
  statusCheckRollup: [
    { name: 'ci', state: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/runs/7' },
    { name: 'lint', state: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/runs/8' }
  ]
};

const prDiff = [
  'diff --git a/src/save.ts b/src/save.ts',
  'index 0000000..1111111 100644',
  '--- a/src/save.ts',
  '+++ b/src/save.ts',
  '@@ -1,2 +1,3 @@',
  ' export function save(name: string) {',
  "+  if (!name) throw new Error('name required');",
  '   persist(name);',
  ''
].join('\n');

// Realistic `gh api repos/.../pulls/41/comments` payload (inline review comments).
const inlineComments = [
  { path: 'src/save.ts', line: 10, body: 'use optional chaining here', user: { login: 'carol' } }
];

// Open PRs on the repo: a human PR that mentions the issue, the bot's PR for a
// neighboring issue whose number shares a prefix (#123), and the bot's PR for #12.
const prList = [
  {
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    body: 'refactor: widget rename groundwork (relates to #12)',
    author: { login: 'dave' },
    headRefName: 'dave/rename-widgets',
    headRepository: { name: 'widgets', nameWithOwner: 'acme/widgets' }
  },
  {
    number: 55,
    url: 'https://github.com/acme/widgets/pull/55',
    body: 'Closes #123\n\nAutomated fix.',
    author: { login: 'fixbot' },
    headRefName: 'fixbot/issue-123-widget-resize',
    headRepository: { name: 'widgets', nameWithOwner: 'acme/widgets' }
  },
  {
    number: 41,
    url: 'https://github.com/acme/widgets/pull/41',
    body: 'Closes #12\n\nAutomated fix.',
    author: { login: 'fixbot' },
    headRefName: 'fixbot/issue-12-save-path',
    headRepository: { name: 'widgets', nameWithOwner: 'acme/widgets' }
  }
];

// Builds a fake `gh` binary that validates repo/PR targeting and serves the
// fixtures above, so no live GitHub access ever happens.
async function makeFakeGh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-fake-gh-'));
  const fixtures = join(root, 'fixtures');
  const bin = join(root, 'bin');
  await mkdir(fixtures, { recursive: true });
  await mkdir(bin, { recursive: true });
  const viewFile = join(fixtures, 'pr-view.json');
  const diffFile = join(fixtures, 'pr-diff.txt');
  const listFile = join(fixtures, 'pr-list.json');
  const inlineFile = join(fixtures, 'inline-comments.json');
  await writeFile(viewFile, JSON.stringify(prView));
  await writeFile(diffFile, prDiff);
  await writeFile(listFile, JSON.stringify(prList));
  await writeFile(inlineFile, JSON.stringify(inlineComments));
  const script = `#!/bin/sh
all="$*"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$all" in *"--repo ${REPO}"*) ;; *) fail "pr view must target --repo ${REPO}" ;; esac
  case "$all" in *" ${PR_NUMBER} "*|*" ${PR_NUMBER}") ;; *) fail "pr view must target PR ${PR_NUMBER}" ;; esac
  cat "${viewFile}"
elif [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  case "$all" in *"--repo ${REPO}"*) ;; *) fail "pr diff must target --repo ${REPO}" ;; esac
  case "$all" in *" ${PR_NUMBER} "*|*" ${PR_NUMBER}") ;; *) fail "pr diff must target PR ${PR_NUMBER}" ;; esac
  cat "${diffFile}"
elif [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "$all" in *"--repo ${REPO}"*) ;; *) fail "pr list must target --repo ${REPO}" ;; esac
  case "$all" in *"--state open"*) ;; *) fail "pr list must filter --state open" ;; esac
  cat "${listFile}"
elif [ "$1" = "api" ]; then
  case "$2" in *"pulls/${PR_NUMBER}/comments"*) cat "${inlineFile}" ;; *) fail "unexpected api path: $2" ;; esac
else
  fail "unexpected gh invocation"
fi
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return root;
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `expected entry at index ${index}, got ${list.length} entries`);
  return value;
}

test('GhCliClient pull request lifecycle', async (t) => {
  const root = await makeFakeGh();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const client: GitHubClient = new GhCliClient(root);
  try {
    await t.test('getPullRequestContext maps PR view, diff, and inline comments into the context', async () => {
      const context: PullRequestContext = await client.getPullRequestContext(REPO, PR_NUMBER);
      assert.strictEqual(context.repo, REPO);
      assert.strictEqual(context.number, PR_NUMBER);
      assert.strictEqual(context.title, 'fix: guard save path');
      assert.strictEqual(context.body, prView.body);
      assert.strictEqual(context.url, 'https://github.com/acme/widgets/pull/41');
      assert.strictEqual(context.author, 'fixbot');
      assert.strictEqual(context.baseRefName, 'main');
      assert.strictEqual(context.headRefName, 'fixbot/issue-12-save-path');
      assert.strictEqual(context.headRepository, 'acme/widgets');

      assert.strictEqual(context.comments.length, 1);
      assert.ok(at(context.comments, 0).includes('please also update the changelog'), at(context.comments, 0));

      // The empty-body APPROVED review must be dropped; the substantive one keeps
      // reviewer, verdict, and feedback for the review-resolver prompt.
      assert.strictEqual(context.reviews.length, 1);
      const review = at(context.reviews, 0);
      for (const expected of ['guard the null case in save()', 'CHANGES_REQUESTED', 'carol']) {
        assert.ok(review.includes(expected), `review entry missing ${JSON.stringify(expected)}: ${review}`);
      }

      assert.strictEqual(context.reviewComments.length, 1);
      const inline = at(context.reviewComments, 0);
      for (const expected of ['use optional chaining here', 'src/save.ts', 'carol']) {
        assert.ok(inline.includes(expected), `inline comment entry missing ${JSON.stringify(expected)}: ${inline}`);
      }

      assert.strictEqual(context.commits.length, 1);
      assert.ok(at(context.commits, 0).includes('fix: guard empty save name'), at(context.commits, 0));

      assert.deepStrictEqual(context.checks, [
        { name: 'ci', state: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/runs/7' },
        { name: 'lint', state: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/runs/8' }
      ]);
      assert.deepStrictEqual(context.changedFiles, ['src/save.ts']);
      assert.ok(context.diff.startsWith('diff --git a/src/save.ts'), context.diff.slice(0, 80));
      assert.ok(context.diff.includes("+  if (!name) throw new Error('name required');"), context.diff);
    });

    await t.test('findOpenBotPrForIssue returns the bot PR for the issue with head branch data for continuation', async () => {
      const result = await client.findOpenBotPrForIssue(REPO, 12, 'fixbot');
      assert.ok(result, 'expected the open bot PR for issue #12');
      // Must pick the bot-authored PR for #12 — not the human PR that merely
      // mentions #12, and not the bot PR for neighboring issue #123 whose
      // branch fixbot/issue-123-* shares the fixbot/issue-12 prefix.
      assert.strictEqual(result.number, 41);
      assert.strictEqual(result.url, 'https://github.com/acme/widgets/pull/41');
      // Continuation needs the head branch, not just a URL.
      assert.strictEqual(result.headRefName, 'fixbot/issue-12-save-path');
      assert.strictEqual(result.headRepository, 'acme/widgets');
    });

    await t.test('findOpenBotPrForIssue matches a multi-digit issue by branch and marker', async () => {
      const result = await client.findOpenBotPrForIssue(REPO, 123, 'fixbot');
      assert.ok(result, 'expected the open bot PR for issue #123');
      assert.strictEqual(result.number, 55);
      assert.strictEqual(result.headRefName, 'fixbot/issue-123-widget-resize');
    });

    await t.test('findOpenBotPrForIssue returns undefined when the bot has no PR for that issue', async () => {
      // An open bot PR exists, but it belongs to issue #12 — issue #999 must not
      // be continued on it.
      const result = await client.findOpenBotPrForIssue(REPO, 999, 'fixbot');
      assert.strictEqual(result, undefined);
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Stateful fake `gh` for the normal-user lifecycle APIs: labels, status
// comment upsert, review-thread resolution, and the CI check-run read model.
// Unlike makeFakeGh above, this fake keeps JSON state on disk and mutates it
// the way GitHub would, so tests observe outcomes through the client's own
// read APIs. It also mirrors real `gh api` semantics that bite PAT users:
// -f/-F fields flip a request to POST unless --method GET is passed, and any
// write to check-runs is rejected (a plain user token cannot write check runs).
// ---------------------------------------------------------------------------

const LIFECYCLE_ISSUE = 34;
const LIFECYCLE_PR = 77;
const LIFECYCLE_HEAD_SHA = 'abc1234deadbeef';

const lifecycleIssue = {
  title: 'Save crashes on empty name',
  body: 'Saving a widget with an empty name crashes the editor.',
  url: `https://github.com/${REPO}/issues/${LIFECYCLE_ISSUE}`,
  author: { login: 'dana-reporter' },
  comments: [{ body: 'same here on 2.3.1' }],
  labels: [
    { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
    { name: 'help wanted' },
    { color: 'ffffff' } // nameless label payloads must be dropped, not crash
  ]
};

const lifecycleIssueComments = [
  { id: 301, body: 'unrelated human comment', user: { login: 'dave' } }
];

const lifecyclePr = {
  title: 'fix: guard save path',
  body: 'Closes #34',
  url: `https://github.com/${REPO}/pull/${LIFECYCLE_PR}`,
  author: { login: 'fixbot' },
  baseRefName: 'main',
  headRefName: 'fixbot/issue-34-save-path',
  headRefOid: LIFECYCLE_HEAD_SHA,
  headRepository: { name: 'widgets', nameWithOwner: REPO },
  comments: [],
  reviews: [],
  commits: [{ oid: 'fedcba9', messageHeadline: 'fix: guard empty save name' }],
  files: [{ path: 'src/save.ts' }],
  labels: [{ name: 'automated-fix' }],
  // Deliberately different from the check-runs payload: if the client falls
  // back to the rollup (e.g. because the check-runs read failed or attempted
  // a write), the checks assertions below turn red.
  statusCheckRollup: [{ name: 'stale-rollup-only', state: 'COMPLETED', conclusion: 'NEUTRAL' }]
};

const lifecycleCheckRuns = {
  check_runs: [
    {
      name: 'ci/test',
      status: 'completed',
      conclusion: 'failure',
      details_url: 'https://github.com/acme/widgets/runs/901',
      output: { title: '2 tests failed', summary: 'save.test.ts failed', text: 'expected save() to throw on empty name' }
    },
    { name: 'ci/lint', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/runs/902' }
  ]
};

const lifecycleThreads = [
  {
    id: 'PRRT_alpha',
    isResolved: false,
    path: 'src/save.ts',
    line: 10,
    comments: { nodes: [{ body: 'guard the empty name here', author: { login: 'carol' } }] }
  },
  { id: 'PRRT_beta', isResolved: true, path: 'src/save.ts', comments: { nodes: [] } }
];

async function makeLifecycleGh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-lifecycle-gh-'));
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(state, 'issue.json'), JSON.stringify(lifecycleIssue));
  await writeFile(join(state, 'issue-comments.json'), JSON.stringify(lifecycleIssueComments));
  await writeFile(join(state, 'pr.json'), JSON.stringify(lifecyclePr));
  await writeFile(join(state, 'pr-diff.txt'), 'diff --git a/src/save.ts b/src/save.ts\n');
  await writeFile(join(state, 'inline-comments.json'), JSON.stringify([]));
  await writeFile(join(state, 'check-runs.json'), JSON.stringify(lifecycleCheckRuns));
  await writeFile(join(state, 'threads.json'), JSON.stringify(lifecycleThreads));
  const script = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const STATE = ${JSON.stringify(state)};
const REPO = ${JSON.stringify(REPO)};
const ISSUE = ${JSON.stringify(String(LIFECYCLE_ISSUE))};
const PR = ${JSON.stringify(String(LIFECYCLE_PR))};
const HEAD_SHA = ${JSON.stringify(LIFECYCLE_HEAD_SHA)};
const args = process.argv.slice(2);
const all = args.join(' ');
function fail(msg) { process.stderr.write('fake gh: ' + msg + ' (argv: ' + all + ')\\n'); process.exit(64); }
function ghError(msg) { process.stderr.write(msg + '\\n'); process.exit(1); }
function load(name) { return JSON.parse(fs.readFileSync(path.join(STATE, name), 'utf8')); }
function store(name, value) { fs.writeFileSync(path.join(STATE, name), JSON.stringify(value)); }
function emit(value) { process.stdout.write(JSON.stringify(value)); }
function flagValue(flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }
function fieldMap() {
  const map = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-f' && args[i] !== '-F' && args[i] !== '--field' && args[i] !== '--raw-field') continue;
    const raw = args[i + 1] === undefined ? '' : args[i + 1];
    const eq = raw.indexOf('=');
    if (eq === -1) fail('malformed field: ' + raw);
    const key = raw.slice(0, eq);
    if (!map[key]) map[key] = [];
    map[key].push(raw.slice(eq + 1));
    i += 1;
  }
  return map;
}
function requireRepoFlag(label) { if (flagValue('--repo') !== REPO) fail(label + ' must target --repo ' + REPO); }
function pick(source, jsonFields) {
  const picked = {};
  for (const field of jsonFields.split(',')) { if (field in source) picked[field] = source[field]; }
  return picked;
}
function nextCommentId(comments) {
  let id = 300;
  for (const comment of comments) { if (comment.id > id) id = comment.id; }
  return id + 1;
}
const cmd = args[0];
if (cmd === 'issue' && args[1] === 'view') {
  requireRepoFlag('issue view');
  if (args[2] !== ISSUE) fail('issue view must target issue ' + ISSUE);
  const jsonFields = flagValue('--json');
  if (!jsonFields) fail('issue view must request --json fields');
  emit(pick(load('issue.json'), jsonFields));
} else if (cmd === 'issue' && args[1] === 'comment') {
  requireRepoFlag('issue comment');
  if (args[2] !== ISSUE) fail('issue comment must target issue ' + ISSUE);
  const body = flagValue('--body');
  if (body === undefined) fail('issue comment requires --body');
  const comments = load('issue-comments.json');
  const id = nextCommentId(comments);
  comments.push({ id: id, body: body, user: { login: 'fixbot' } });
  store('issue-comments.json', comments);
  process.stdout.write('https://github.com/' + REPO + '/issues/' + ISSUE + '#issuecomment-' + id + '\\n');
} else if (cmd === 'pr' && args[1] === 'view') {
  requireRepoFlag('pr view');
  if (args[2] !== PR) fail('pr view must target PR ' + PR);
  const jsonFields = flagValue('--json');
  if (!jsonFields) fail('pr view must request --json fields');
  emit(pick(load('pr.json'), jsonFields));
} else if (cmd === 'pr' && args[1] === 'diff') {
  requireRepoFlag('pr diff');
  if (args[2] !== PR) fail('pr diff must target PR ' + PR);
  process.stdout.write(fs.readFileSync(path.join(STATE, 'pr-diff.txt'), 'utf8'));
} else if (cmd === 'api' && args[1] === 'graphql') {
  const map = fieldMap();
  const query = (map.query || [''])[0];
  if (query.indexOf('resolveReviewThread(') !== -1) {
    const id = (map.id || [])[0];
    if (!id) fail('resolveReviewThread mutation requires -F id=...');
    const threads = load('threads.json');
    const thread = threads.find(function (entry) { return entry.id === id; });
    if (!thread) ghError("GraphQL: Could not resolve to a node with the global id of '" + id + "' (resolveReviewThread)");
    thread.isResolved = true;
    store('threads.json', threads);
    emit({ data: { resolveReviewThread: { thread: { id: id, isResolved: true } } } });
  } else if (query.indexOf('reviewThreads(') !== -1) {
    if ((map.owner || [])[0] !== 'acme' || (map.name || [])[0] !== 'widgets') fail('reviewThreads query must target acme/widgets');
    if ((map.number || [])[0] !== PR) fail('reviewThreads query must target PR ' + PR);
    emit({ data: { repository: { pullRequest: { reviewThreads: { nodes: load('threads.json') } } } } });
  } else {
    fail('unexpected graphql operation');
  }
} else if (cmd === 'api') {
  // The endpoint is the first positional argument; value-taking flags like
  // --method and -f may precede it (gh accepts flags in any position).
  const valueFlags = ['--method', '-X', '-f', '-F', '--field', '--raw-field', '-H', '--header', '--hostname', '-q', '--jq', '--input'];
  let apiPath = '';
  for (let i = 1; i < args.length; i += 1) {
    if (valueFlags.indexOf(args[i]) !== -1) { i += 1; continue; }
    if (args[i].indexOf('-') === 0) continue;
    apiPath = args[i];
    break;
  }
  const prefix = 'repos/' + REPO + '/';
  if (apiPath.indexOf(prefix) !== 0) fail('api path must target ' + prefix + '*: ' + apiPath);
  const rest = apiPath.slice(prefix.length).split('?')[0];
  const parts = rest.split('/');
  const map = fieldMap();
  const explicit = flagValue('--method') || flagValue('-X');
  // Real gh api flips the request to POST when -f/-F fields are present and
  // no --method was given; list reads therefore MUST pass --method GET.
  const method = (explicit || (Object.keys(map).length > 0 ? 'POST' : 'GET')).toUpperCase();
  if (rest === 'issues/' + ISSUE + '/comments') {
    if (method === 'GET') {
      emit(load('issue-comments.json'));
    } else if (method === 'POST' && map.body) {
      const comments = load('issue-comments.json');
      const created = { id: nextCommentId(comments), body: map.body[0], user: { login: 'fixbot' } };
      comments.push(created);
      store('issue-comments.json', comments);
      emit(created);
    } else {
      fail('refusing ' + method + ' on ' + rest + ' without a body; list reads need --method GET because -f fields imply POST');
    }
  } else if (parts.length === 3 && parts[0] === 'issues' && parts[1] === 'comments') {
    if (method !== 'PATCH') fail('expected PATCH on ' + rest + ', got ' + method);
    const body = (map.body || [])[0];
    if (body === undefined) fail('comment PATCH requires -f body=...');
    const comments = load('issue-comments.json');
    const target = comments.find(function (entry) { return String(entry.id) === parts[2]; });
    if (!target) ghError('gh: Not Found (HTTP 404)');
    target.body = body;
    store('issue-comments.json', comments);
    emit(target);
  } else if (rest === 'issues/' + ISSUE + '/labels') {
    if (method !== 'POST') fail('labels endpoint expects POST, got ' + method);
    const values = map['labels[]'] || [];
    if (values.length === 0) ghError('gh: Validation Failed (HTTP 422): labels cannot be empty');
    const issue = load('issue.json');
    for (const name of values) {
      if (!issue.labels.some(function (label) { return label.name === name; })) issue.labels.push({ name: name });
    }
    store('issue.json', issue);
    emit(issue.labels);
  } else if (rest === 'pulls/' + PR + '/comments') {
    if (method !== 'GET') fail('inline review comments are read-only here, got ' + method);
    emit(load('inline-comments.json'));
  } else if (parts.length === 3 && parts[0] === 'commits' && parts[2] === 'check-runs') {
    if (method !== 'GET') fail('check runs are read-only for a PAT user, got ' + method + '; reads must pass --method GET');
    if (parts[1] !== HEAD_SHA) fail('check-runs must target head sha ' + HEAD_SHA + ': ' + rest);
    emit(load('check-runs.json'));
  } else {
    fail('unexpected api path: ' + apiPath);
  }
} else {
  fail('unexpected gh invocation');
}
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return root;
}

test('GhCliClient normal-user lifecycle APIs', async (t) => {
  const root = await makeLifecycleGh();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const client: GitHubClient = new GhCliClient(root);
  const startedMarker = '<!-- agent-fixbot:status:started -->';
  let startedCommentId: number | undefined;
  try {
    await t.test('getIssueContext reads author and labels through gh issue view', async () => {
      const context = await client.getIssueContext(REPO, LIFECYCLE_ISSUE);
      assert.equal(context.author, 'dana-reporter');
      assert.deepStrictEqual(context.labels, [
        { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
        { name: 'help wanted' }
      ]);
    });

    await t.test('addLabels adds via the REST labels endpoint, visible on re-read', async () => {
      await client.addLabels(REPO, LIFECYCLE_ISSUE, ['fixbot:started', 'regression']);
      const context = await client.getIssueContext(REPO, LIFECYCLE_ISSUE);
      assert.deepStrictEqual(
        context.labels.map((label) => label.name),
        ['bug', 'help wanted', 'fixbot:started', 'regression']
      );
    });

    await t.test('addLabels with an empty list is a no-op instead of an invalid POST', async () => {
      await client.addLabels(REPO, LIFECYCLE_ISSUE, []);
      const context = await client.getIssueContext(REPO, LIFECYCLE_ISSUE);
      assert.deepStrictEqual(
        context.labels.map((label) => label.name),
        ['bug', 'help wanted', 'fixbot:started', 'regression']
      );
    });

    await t.test('upsertIssueComment creates the marker comment when none exists', async () => {
      await client.upsertIssueComment(REPO, LIFECYCLE_ISSUE, startedMarker, `${startedMarker}\n**FixBot Started**\n\nLooking into the crash.\n`);
      const comments = await client.listIssueComments(REPO, LIFECYCLE_ISSUE);
      assert.strictEqual(comments.length, 2, JSON.stringify(comments));
      const unrelated = comments.find((comment) => comment.id === 301);
      assert.ok(unrelated !== undefined && unrelated.body === 'unrelated human comment', 'the unrelated human comment must be untouched');
      const started = comments.find((comment) => comment.body.includes(startedMarker));
      assert.ok(started, 'expected a comment carrying the status marker');
      assert.ok(started.body.includes('Looking into the crash.'), started.body);
      startedCommentId = started.id;
    });

    await t.test('upsertIssueComment updates the marker comment in place instead of duplicating', async () => {
      await client.upsertIssueComment(REPO, LIFECYCLE_ISSUE, startedMarker, `${startedMarker}\n**FixBot Started**\n\nRepro found; writing the failing test.\n`);
      const comments = await client.listIssueComments(REPO, LIFECYCLE_ISSUE);
      assert.strictEqual(comments.length, 2, JSON.stringify(comments));
      const marked = comments.filter((comment) => comment.body.includes(startedMarker));
      assert.strictEqual(marked.length, 1, 'a repost must not duplicate the status comment');
      const started = marked[0];
      assert.ok(started);
      assert.strictEqual(started.id, startedCommentId, 'the update must PATCH the existing comment, not recreate it');
      assert.ok(started.body.includes('Repro found; writing the failing test.'), started.body);
      assert.ok(!started.body.includes('Looking into the crash.'), started.body);
    });

    await t.test('upsertIssueComment keeps distinct markers as distinct comments', async () => {
      const openedMarker = '<!-- agent-fixbot:status:pr-opened -->';
      await client.upsertIssueComment(REPO, LIFECYCLE_ISSUE, openedMarker, `${openedMarker}\nOpened PR #${LIFECYCLE_PR}.\n`);
      const comments = await client.listIssueComments(REPO, LIFECYCLE_ISSUE);
      assert.strictEqual(comments.length, 3, JSON.stringify(comments));
      assert.strictEqual(comments.filter((comment) => comment.body.includes(startedMarker)).length, 1);
      assert.strictEqual(comments.filter((comment) => comment.body.includes(openedMarker)).length, 1);
    });

    await t.test('upsertIssueComment injects the marker when the body omits it, so reposts still dedupe', async () => {
      const lockMarker = '<!-- agent-fixbot:lock -->';
      await client.upsertIssueComment(REPO, LIFECYCLE_ISSUE, lockMarker, 'Job lock note v1\n');
      await client.upsertIssueComment(REPO, LIFECYCLE_ISSUE, lockMarker, 'Job lock note v2\n');
      const comments = await client.listIssueComments(REPO, LIFECYCLE_ISSUE);
      const locks = comments.filter((comment) => comment.body.includes('Job lock note'));
      assert.strictEqual(locks.length, 1, JSON.stringify(comments));
      const lock = locks[0];
      assert.ok(lock);
      assert.ok(lock.body.includes(lockMarker), `stored body must carry the marker for future upserts: ${lock.body}`);
      assert.ok(lock.body.includes('Job lock note v2'), lock.body);
    });

    await t.test('getPullRequestContext captures the CI read model without writing check runs', async () => {
      const context = await client.getPullRequestContext(REPO, LIFECYCLE_PR);
      assert.strictEqual(context.headSha, LIFECYCLE_HEAD_SHA);
      // Checks must come from the commit check-runs read (which carries the
      // failure summary), not from the stale statusCheckRollup fixture.
      assert.deepStrictEqual(context.checks, [
        {
          name: 'ci/test',
          state: 'completed',
          conclusion: 'failure',
          detailsUrl: 'https://github.com/acme/widgets/runs/901',
          summary: '2 tests failed\nsave.test.ts failed\nexpected save() to throw on empty name'
        },
        { name: 'ci/lint', state: 'completed', conclusion: 'success', detailsUrl: 'https://github.com/acme/widgets/runs/902' }
      ]);
      assert.deepStrictEqual(context.labels, [{ name: 'automated-fix' }]);

      assert.strictEqual(context.reviewThreads.length, 2, JSON.stringify(context.reviewThreads));
      const [alpha, beta] = context.reviewThreads;
      assert.ok(alpha !== undefined && beta !== undefined);
      assert.strictEqual(alpha.id, 'PRRT_alpha');
      assert.strictEqual(alpha.isResolved, false);
      assert.strictEqual(alpha.path, 'src/save.ts');
      assert.strictEqual(alpha.line, 10);
      assert.strictEqual(alpha.comments.length, 1);
      const threadComment = at(alpha.comments, 0);
      for (const expected of ['guard the empty name here', 'carol']) {
        assert.ok(threadComment.includes(expected), threadComment);
      }
      assert.strictEqual(beta.id, 'PRRT_beta');
      assert.strictEqual(beta.isResolved, true);
      assert.deepStrictEqual(beta.comments, []);
    });

    await t.test('resolveReviewThread resolves via the GraphQL mutation, visible on re-read', async () => {
      await client.resolveReviewThread(REPO, 'PRRT_alpha');
      const context = await client.getPullRequestContext(REPO, LIFECYCLE_PR);
      const alpha = context.reviewThreads.find((thread) => thread.id === 'PRRT_alpha');
      assert.ok(alpha, 'thread PRRT_alpha must survive resolution');
      assert.strictEqual(alpha.isResolved, true);
    });

    await t.test('resolveReviewThread reports a missing thread id in the error', async () => {
      await assert.rejects(
        client.resolveReviewThread(REPO, 'PRRT_missing'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('PRRT_missing'), error.message);
          return true;
        }
      );
      // The failed mutation must not disturb existing thread state.
      const context = await client.getPullRequestContext(REPO, LIFECYCLE_PR);
      assert.strictEqual(context.reviewThreads.length, 2);
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// listRecentIssues: the poll-issues read model. GitHub's REST issues endpoint
// interleaves pull requests with issues (PR rows carry a `pull_request` key),
// so the client must drop PR rows and map the rest. The fake logs argv so the
// test pins the exact request that would hit GitHub.
// ---------------------------------------------------------------------------

const RECENT_SINCE = '2026-06-30T00:00:00Z';

const repoIssues = [
  {
    number: 12,
    title: 'Crash when saving with empty name',
    body: 'Steps: save a widget without a name -> crash.',
    url: 'https://github.com/acme/widgets/issues/12',
    user: { login: 'erin-reporter' },
    labels: [{ name: 'bug', color: 'd73a4a', description: 'Something broken' }],
    created_at: '2026-06-30T10:00:00Z',
    updated_at: '2026-07-01T08:15:00Z'
  },
  {
    number: 41,
    title: 'fix: guard save path',
    body: 'Closes #12',
    url: 'https://github.com/acme/widgets/pull/41',
    labels: [],
    created_at: '2026-06-30T11:00:00Z',
    updated_at: '2026-07-01T09:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/41' }
  }
];

async function makeIssuesGh(): Promise<{ root: string; callsFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fixbot-fake-gh-issues-'));
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const issuesFile = join(root, 'issues.json');
  const callsFile = join(root, 'gh-calls.log');
  await writeFile(issuesFile, JSON.stringify(repoIssues));
  await writeFile(callsFile, '');
  const script = `#!/bin/sh
all="$*"
printf '%s\\n' "$all" >> "${callsFile}"
fail() { echo "fake gh: $1 (argv: $all)" >&2; exit 64; }
[ "$1" = "api" ] || fail "recent-issues read must go through gh api"
case "$all" in
  *"--method GET"*) ;;
  *) fail "recent-issues read must not mutate GitHub" ;;
esac
cat "${issuesFile}"
`;
  await writeFile(join(bin, 'gh'), script);
  await chmod(join(bin, 'gh'), 0o755);
  return { root, callsFile };
}

test('GhCliClient recent-issues read model', async (t) => {
  const { root, callsFile } = await makeIssuesGh();
  const savedPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}${savedPath ? `:${savedPath}` : ''}`;
  const client: GitHubClient = new GhCliClient(root);
  try {
    await t.test('maps issue rows and drops PR rows from the issues endpoint', async () => {
      const issues = await client.listRecentIssues(REPO);
      // The PR-shaped row (#41) must vanish; the real issue arrives fully mapped.
      assert.equal(issues.length, 1, JSON.stringify(issues));
      assert.deepStrictEqual(at(issues, 0), {
        repo: REPO,
        number: 12,
        title: 'Crash when saving with empty name',
        body: 'Steps: save a widget without a name -> crash.',
        comments: [],
        labels: [{ name: 'bug', color: 'd73a4a', description: 'Something broken' }],
        url: 'https://github.com/acme/widgets/issues/12',
        author: 'erin-reporter',
        createdAt: '2026-06-30T10:00:00Z',
        updatedAt: '2026-07-01T08:15:00Z'
      });
      // Pin the exact request: open issues, oldest-updated first, full page.
      const calls = (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean);
      assert.equal(calls.length, 1, calls.join('\n'));
      assert.equal(at(calls, 0), 'api --method GET repos/acme/widgets/issues -f state=open -f sort=updated -f direction=asc -f per_page=100');
    });

    await t.test('forwards since= so polls resume from a cursor', async () => {
      const issues = await client.listRecentIssues(REPO, RECENT_SINCE);
      assert.equal(issues.length, 1, JSON.stringify(issues));
      const calls = (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean);
      assert.equal(calls.length, 2, calls.join('\n'));
      assert.equal(at(calls, 1), `api --method GET repos/acme/widgets/issues -f state=open -f sort=updated -f direction=asc -f per_page=100 -f since=${RECENT_SINCE}`);
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
});
