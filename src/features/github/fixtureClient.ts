import type { GitHubClient, IssueComment, IssueContext, PullRequestContext, PullRequestInput, PullRequestResult, RecentIssue, RecentIssueComment } from './githubClient.js';

export class FixtureGitHubClient implements GitHubClient {
  public readonly comments: { repo: string; number: number; body: string }[] = [];
  public readonly labels: { repo: string; number: number; labels: string[] }[] = [];
  public readonly resolvedThreads: { repo: string; threadId: string }[] = [];

  constructor(
    private readonly issue?: Partial<IssueContext>,
    private readonly pullRequest?: Partial<PullRequestContext>,
    private readonly recentComments: RecentIssueComment[] = [],
    private readonly recentIssues: RecentIssue[] = []
  ) {}

  async getIssueContext(repo: string, number: number): Promise<IssueContext> {
    return {
      repo,
      number,
      title: this.issue?.title ?? `Fixture issue #${number}`,
      body: this.issue?.body ?? 'Dry-run fixture issue. Replace this by running without --dry-run.',
      comments: this.issue?.comments ?? [],
      labels: this.issue?.labels ?? [],
      url: this.issue?.url ?? `https://github.com/${repo}/issues/${number}`
    };
  }

  async getPullRequestContext(repo: string, number: number): Promise<PullRequestContext> {
    const issue = await this.getIssueContext(repo, number);
    return {
      ...issue,
      title: this.pullRequest?.title ?? issue.title,
      body: this.pullRequest?.body ?? issue.body,
      comments: this.pullRequest?.comments ?? issue.comments,
      labels: this.pullRequest?.labels ?? issue.labels,
      url: this.pullRequest?.url ?? `https://github.com/${repo}/pull/${number}`,
      author: this.pullRequest?.author ?? 'fixture-author',
      baseRefName: this.pullRequest?.baseRefName ?? 'main',
      headRefName: this.pullRequest?.headRefName ?? `fixbot/issue-${number}`,
      headRepository: this.pullRequest?.headRepository ?? repo,
      headSha: this.pullRequest?.headSha ?? 'fixture-head-sha',
      reviewComments: this.pullRequest?.reviewComments ?? [],
      reviews: this.pullRequest?.reviews ?? [],
      commits: this.pullRequest?.commits ?? [],
      checks: this.pullRequest?.checks ?? [],
      changedFiles: this.pullRequest?.changedFiles ?? [],
      reviewThreads: this.pullRequest?.reviewThreads ?? [],
      diff: this.pullRequest?.diff ?? ''
    };
  }

  async listRecentIssueComments(repo: string, since?: string): Promise<RecentIssueComment[]> {
    if (!since) return this.recentComments.filter((comment) => comment.repo === repo);
    const sinceTime = Date.parse(since);
    return this.recentComments.filter((comment) => comment.repo === repo && Date.parse(comment.updatedAt ?? comment.createdAt ?? '') > sinceTime);
  }

  async listRecentIssues(repo: string, since?: string): Promise<RecentIssue[]> {
    if (!since) return this.recentIssues.filter((issue) => issue.repo === repo);
    const sinceTime = Date.parse(since);
    return this.recentIssues.filter((issue) => issue.repo === repo && Date.parse(issue.updatedAt ?? issue.createdAt ?? '') > sinceTime);
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    return this.comments
      .map((comment, index) => ({ id: index + 1, body: comment.body, repo: comment.repo, number: comment.number }))
      .filter((comment) => comment.repo === repo && comment.number === number)
      .map((comment) => ({ id: comment.id, body: comment.body, author: 'fixture-author' }));
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<void> {
    this.comments.push({ repo, number, body });
  }

  async upsertIssueComment(repo: string, number: number, marker: string, body: string): Promise<void> {
    const markedBody = body.includes(marker) ? body : `${marker}\n${body}`;
    const prior = this.comments.find((comment) => comment.repo === repo && comment.number === number && comment.body.includes(marker));
    if (prior) prior.body = markedBody;
    else this.comments.push({ repo, number, body: markedBody });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    this.labels.push({ repo, number, labels });
  }

  async removeLabel(repo: string, number: number, label: string): Promise<void> {
    this.labels.push({ repo, number, labels: [`-${label}`] });
  }

  async resolveReviewThread(repo: string, threadId: string): Promise<void> {
    this.resolvedThreads.push({ repo, threadId });
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    return { url: `dry-run://pull-request/${input.repo}/${input.head}`, headRefName: input.head, headRepository: input.repo };
  }

  async findOpenBotPrForIssue(): Promise<PullRequestResult | undefined> {
    return undefined;
  }
}
