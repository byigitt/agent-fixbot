import test from 'node:test';
import assert from 'node:assert/strict';
import { postStatusComment } from './statusComments.js';
import type {
  GitHubClient,
  IssueComment,
  IssueContext,
  PullRequestContext,
  PullRequestInput,
  PullRequestResult,
  RecentIssue,
  RecentIssueComment
} from '../github/githubClient.js';

type UpsertedComment = { repo: string; number: number; marker: string; body: string };
type PostedComment = { repo: string; number: number; body: string };
type LabelCall = { repo: string; number: number; labels: string[] };
type RemoveLabelCall = { repo: string; number: number; label: string };

class RecordingGitHubClient implements GitHubClient {
  readonly upserts: UpsertedComment[] = [];
  readonly comments: PostedComment[] = [];
  readonly labelCalls: LabelCall[] = [];
  readonly removeLabelCalls: RemoveLabelCall[] = [];

  async upsertIssueComment(repo: string, number: number, marker: string, body: string): Promise<void> {
    this.upserts.push({ repo, number, marker, body });
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<void> {
    this.comments.push({ repo, number, body });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    this.labelCalls.push({ repo, number, labels });
  }

  async removeLabel(repo: string, number: number, label: string): Promise<void> {
    this.removeLabelCalls.push({ repo, number, label });
  }

  async getIssueContext(): Promise<IssueContext> {
    throw new Error('getIssueContext not expected in this test');
  }

  async getPullRequestContext(): Promise<PullRequestContext> {
    throw new Error('getPullRequestContext not expected in this test');
  }

  async listRecentIssueComments(): Promise<RecentIssueComment[]> {
    throw new Error('listRecentIssueComments not expected in this test');
  }

  async listRecentIssues(): Promise<RecentIssue[]> {
    throw new Error('listRecentIssues not expected in this test');
  }

  async listIssueComments(): Promise<IssueComment[]> {
    throw new Error('listIssueComments not expected in this test');
  }

  async resolveReviewThread(): Promise<void> {
    throw new Error('resolveReviewThread not expected in this test');
  }

  async createPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    throw new Error('createPullRequest not expected in this test');
  }

  async findOpenBotPrForIssue(): Promise<PullRequestResult | undefined> {
    throw new Error('findOpenBotPrForIssue not expected in this test');
  }
}

test('postStatusComment', async (t) => {
  await t.test('upserts the rendered status body keyed by a stable status marker when not dry-run', async () => {
    const github = new RecordingGitHubClient();
    const body = await postStatusComment(github, {
      repo: 'acme/widgets',
      number: 12,
      status: 'pr-opened',
      summary: 'Opened a fix PR for the empty-name save crash.',
      details: ['pnpm test: previously failing save.test.ts now passes', 'PR: https://github.com/acme/widgets/pull/41'],
      dryRun: false
    });
    assert.strictEqual(github.upserts.length, 1);
    const upserted = github.upserts[0];
    assert.ok(upserted, 'expected an upserted comment');
    assert.strictEqual(upserted.repo, 'acme/widgets');
    assert.strictEqual(upserted.number, 12);
    assert.strictEqual(upserted.body, body);
    // The marker is a persisted wire format: comments already on GitHub carry it,
    // so later runs can find and update them. It must stay stable and be embedded
    // in the body itself.
    assert.strictEqual(upserted.marker, '<!-- agent-fixbot:status:pr-opened -->');
    assert.ok(body.includes(upserted.marker), body);
    assert.ok(body.includes('PR opened'), body);
    assert.ok(body.includes('Opened a fix PR for the empty-name save crash.'), body);
    assert.ok(body.includes('pnpm test: previously failing save.test.ts now passes'), body);
    assert.ok(body.includes('PR: https://github.com/acme/widgets/pull/41'), body);
    // A status update must not stack duplicate comments or touch labels unasked.
    assert.deepStrictEqual(github.comments, []);
    assert.deepStrictEqual(github.labelCalls, []);
  });

  await t.test('applies the status label when one is given', async () => {
    const github = new RecordingGitHubClient();
    await postStatusComment(github, {
      repo: 'acme/widgets',
      number: 12,
      status: 'reproduced',
      summary: 'Reproduced the crash with a focused failing test.',
      label: 'fixbot:reproduced',
      dryRun: false
    });
    assert.strictEqual(github.upserts.length, 1);
    assert.deepStrictEqual(github.labelCalls, [{ repo: 'acme/widgets', number: 12, labels: ['fixbot:reproduced'] }]);
  });

  await t.test('removes stale status labels before adding the current label', async () => {
    const github = new RecordingGitHubClient();
    await postStatusComment(github, {
      repo: 'acme/widgets',
      number: 12,
      status: 'pr-opened',
      summary: 'Opened the fix PR.',
      label: 'fixbot:pr-opened',
      removeLabels: ['fixbot:running', 'fixbot:blocked', 'fixbot:pr-opened'],
      dryRun: false
    });
    assert.deepStrictEqual(github.removeLabelCalls, [
      { repo: 'acme/widgets', number: 12, label: 'fixbot:running' },
      { repo: 'acme/widgets', number: 12, label: 'fixbot:blocked' }
    ]);
    assert.deepStrictEqual(github.labelCalls, [{ repo: 'acme/widgets', number: 12, labels: ['fixbot:pr-opened'] }]);
  });

  await t.test('dry-run renders the outcome body without posting or labeling', async () => {
    const github = new RecordingGitHubClient();
    const body = await postStatusComment(github, {
      repo: 'acme/widgets',
      number: 12,
      status: 'reproduced',
      summary: 'Reproduced the crash with a focused failing test.',
      details: ['node --test dist/save.test.js: 1 failing as expected'],
      label: 'fixbot:reproduced',
      dryRun: true
    });
    assert.deepStrictEqual(github.upserts, []);
    assert.deepStrictEqual(github.comments, []);
    assert.deepStrictEqual(github.labelCalls, []);
    assert.ok(body.includes('Reproduced'), body);
    assert.ok(body.includes('Reproduced the crash with a focused failing test.'), body);
    assert.ok(body.includes('node --test dist/save.test.js: 1 failing as expected'), body);
  });

  await t.test('omits the details block when no details are given', async () => {
    for (const details of [undefined, [] as string[]]) {
      const github = new RecordingGitHubClient();
      const body = await postStatusComment(github, {
        repo: 'acme/widgets',
        number: 12,
        status: 'started',
        summary: 'Looking into this issue now.',
        ...(details === undefined ? {} : { details }),
        dryRun: false
      });
      assert.strictEqual(github.upserts.length, 1, `details=${JSON.stringify(details)}`);
      assert.ok(body.includes('Looking into this issue now.'), body);
      assert.ok(!body.includes('Details:'), `details=${JSON.stringify(details)} should omit the details block: ${body}`);
    }
  });
});
