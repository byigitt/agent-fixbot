import type { GitHubClient, IssueContext, PullRequestInput, PullRequestResult } from './githubClient.js';

export class FixtureGitHubClient implements GitHubClient {
  constructor(private readonly issue?: Partial<IssueContext>) {}

  async getIssueContext(repo: string, number: number): Promise<IssueContext> {
    return {
      repo,
      number,
      title: this.issue?.title ?? `Fixture issue #${number}`,
      body: this.issue?.body ?? 'Dry-run fixture issue. Replace this by running without --dry-run.',
      comments: this.issue?.comments ?? [],
      url: this.issue?.url ?? `https://github.com/${repo}/issues/${number}`
    };
  }

  async commentOnIssue(): Promise<void> {
    return;
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    return { url: `dry-run://pull-request/${input.repo}/${input.head}` };
  }

  async findOpenBotPrForIssue(): Promise<PullRequestResult | undefined> {
    return undefined;
  }
}
