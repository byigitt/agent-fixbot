import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRepair } from './publisher.js';
import { git } from '../../shared/git.js';
import type { GitHubClient } from '../github/githubClient.js';
import type { RepairJob } from '../jobs/job.js';
import type { AutoDispatchConfig, AutoLabelConfig, PolicyConfig } from '../config/config.js';

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 10,
    maxDiffLines: 100,
    blockedPaths: [],
    allowedCommands: [],
    requireTestEvidence: false,
    requireChangelog: false,
    requireLiveServiceEvidence: false,
    statusLabels: {},
    ...overrides
  };
}

const autoLabelConfig: AutoLabelConfig = {
  enabled: true,
  defaultLabels: [],
  rules: []
};

const autoDispatchConfig: AutoDispatchConfig = {
  enabled: false,
  mode: 'triage',
  maxPerPoll: 1,
  skipWhenLabels: ['triaged'],
  requireLabels: []
};

const gitConfig = {
  authorName: 'fixbot',
  authorEmail: 'fixbot@users.noreply.github.com'
};

function makeJob(policyConfig: PolicyConfig, mode: RepairJob['mode']): RepairJob {
  return {
    id: 'acme-widgets-7-1',
    repo: 'acme/widgets',
    issueNumber: 7,
    base: 'main',
    branch: 'fixbot/issue-7-save-crash',
    mode,
    issue: {
      repo: 'acme/widgets',
      number: 7,
      title: 'Crash when saving a draft',
      body: 'Saving a draft throws TypeError in DraftStore.',
      comments: [],
      labels: [],
      url: 'https://github.com/acme/widgets/issues/7'
    },
    config: {
      defaultBase: 'main',
      botName: 'fixbot',
      workspaceRoot: '.workspaces',
      agent: { command: 'true', args: [], timeoutSeconds: 60 },
      autoLabel: autoLabelConfig,
      autoDispatch: autoDispatchConfig,
      git: gitConfig,
      policy: policyConfig
    },
    createdAt: '2026-07-04T00:00:00.000Z'
  };
}

// A dry-run publish must never reach GitHub; every method rejects so any
// contact surfaces as a distinct failure.
function rejectingGitHubClient(): GitHubClient {
  const reject = (method: string) => async () => {
    throw new Error(`unexpected GitHub call: ${method}`);
  };
  return {
    getIssueContext: reject('getIssueContext'),
    getPullRequestContext: reject('getPullRequestContext'),
    listRecentIssueComments: reject('listRecentIssueComments'),
    listRecentIssues: reject('listRecentIssues'),
    listIssueComments: reject('listIssueComments'),
    commentOnIssue: reject('commentOnIssue'),
    upsertIssueComment: reject('upsertIssueComment'),
    addLabels: reject('addLabels'),
    removeLabel: reject('removeLabel'),
    resolveReviewThread: reject('resolveReviewThread'),
    createPullRequest: reject('createPullRequest'),
    findOpenBotPrForIssue: reject('findOpenBotPrForIssue')
  };
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixbot-test',
  GIT_AUTHOR_EMAIL: 'fixbot-test@example.invalid',
  GIT_COMMITTER_NAME: 'fixbot-test',
  GIT_COMMITTER_EMAIL: 'fixbot-test@example.invalid'
} as const;

async function run(cwd: string, args: string[]): Promise<void> {
  const result = await git(cwd, args);
  assert.strictEqual(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

// Fixture: one tracked file with an unstaged one-line edit => 1 changed file,
// 2 diff lines. Evidence artifacts live untracked under .fixbot/ and stay out
// of the diff guard.
async function makeDirtyRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fixbot-publisher-'));
  await writeFile(join(repo, 'a.txt'), 'alpha\nbeta\n');
  await run(repo, ['init']);
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'init']);
  await writeFile(join(repo, 'a.txt'), 'alpha\nBETA\n');
  return repo;
}

async function writeEvidence(repo: string, evidence: object): Promise<void> {
  await mkdir(join(repo, '.fixbot'), { recursive: true });
  await writeFile(join(repo, '.fixbot', 'evidence.json'), JSON.stringify(evidence));
}

test('publishRepair evidence wiring', async (t) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await t.test('refuses to publish when required test evidence is missing', async () => {
      const repo = await makeDirtyRepo();
      try {
        await assert.rejects(
          publishRepair(repo, makeJob(policy({ requireTestEvidence: true }), 'fix'), rejectingGitHubClient(), { dryRun: true }),
          /Test evidence required/
        );
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('refuses to publish when required changelog evidence is missing', async () => {
      const repo = await makeDirtyRepo();
      try {
        await writeEvidence(repo, { tests: [{ command: 'pnpm test', status: 'passed' }], changelog: [] });
        await assert.rejects(
          publishRepair(repo, makeJob(policy({ requireChangelog: true }), 'fix-ci'), rejectingGitHubClient(), { dryRun: true }),
          /Changelog evidence required/
        );
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('publishes the dry-run PR once the configured evidence is satisfied', async () => {
      const repo = await makeDirtyRepo();
      try {
        await writeEvidence(repo, { tests: [{ command: 'pnpm test', status: 'passed' }], changelog: ['CHANGELOG.md'] });
        const job = makeJob(policy({ requireTestEvidence: true, requireChangelog: true }), 'fix');
        const pr = await publishRepair(repo, job, rejectingGitHubClient(), { dryRun: true });
        assert.ok(pr, 'a dirty workspace with satisfied evidence must produce a publish result');
        assert.strictEqual(pr.url, `dry-run://would-open-pr/${job.repo}/${job.branch}`);
        assert.strictEqual(pr.headRefName, job.branch);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Bot-published commits must carry the configured bot identity — not the
// ambient git identity of whoever runs the daemon — so maintainer commits and
// bot commits stay attributable. The fixture repo's init commit uses a distinct
// "human" identity; a leak of that (or of env identity) into the published
// commit reddens the assertion. GIT_AUTHOR_*/GIT_COMMITTER_* are scrubbed
// because git lets them override `-c user.name`, which is the mechanism under test.
test('publishRepair commits with the configured git author identity', async () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    saved[key] = process.env[key];
    process.env[key] = '/dev/null';
  }
  const root = await mkdtemp(join(tmpdir(), 'fixbot-publisher-author-'));
  try {
    // Local bare repo stands in for origin so the real commit->push path runs
    // without any live remote.
    const remote = join(root, 'remote.git');
    const workspace = join(root, 'work');
    await run(root, ['init', '--bare', 'remote.git']);
    await run(root, ['init', 'work']);
    await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\n');
    await run(workspace, ['add', '-A']);
    await run(workspace, ['-c', 'user.name=Local Maintainer', '-c', 'user.email=maintainer@example.invalid', 'commit', '-m', 'init']);
    await run(workspace, ['remote', 'add', 'origin', remote]);
    await writeFile(join(workspace, 'a.txt'), 'alpha\nBETA\n');

    const job = makeJob(policy({ allowPush: true }), 'fix');
    const github: GitHubClient = {
      ...rejectingGitHubClient(),
      createPullRequest: async () => ({ url: 'https://github.test/acme/widgets/pull/99', number: 99 })
    };
    const pr = await publishRepair(workspace, job, github, { dryRun: false });
    assert.strictEqual(pr?.number, 99, 'publishRepair must surface the PR opened for the pushed branch');

    // Assert on the remote side: this is the identity maintainers see on the
    // pushed commit. Author AND committer must both be the configured bot.
    const log = await git(remote, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce', job.branch]);
    assert.strictEqual(log.exitCode, 0, `branch ${job.branch} must exist on origin: ${log.stderr}`);
    assert.deepStrictEqual(log.stdout.trim().split('\n'), [
      job.config.git.authorName,
      job.config.git.authorEmail,
      job.config.git.authorName,
      job.config.git.authorEmail
    ]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
