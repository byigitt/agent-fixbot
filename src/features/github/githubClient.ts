export type IssueContext = {
  repo: string;
  number: number;
  title: string;
  body: string;
  comments: string[];
  url: string;
};

export type PullRequestInput = {
  repo: string;
  title: string;
  body: string;
  base: string;
  head: string;
};

export type PullRequestResult = { url: string; number?: number };

export interface GitHubClient {
  getIssueContext(repo: string, number: number): Promise<IssueContext>;
  commentOnIssue(repo: string, number: number, body: string): Promise<void>;
  createPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  findOpenBotPrForIssue(repo: string, issueNumber: number, botName: string): Promise<PullRequestResult | undefined>;
}
