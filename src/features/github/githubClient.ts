export type IssueLabel = {
  name: string;
  color?: string;
  description?: string;
};

export type IssueContext = {
  repo: string;
  number: number;
  title: string;
  body: string;
  comments: string[];
  labels: IssueLabel[];
  url: string;
};

export type PullRequestCheck = {
  name: string;
  state?: string;
  conclusion?: string;
  detailsUrl?: string;
  summary?: string;
};

export type PullRequestReviewThread = {
  id: string;
  isResolved: boolean;
  path?: string;
  line?: number;
  comments: string[];
};

export type PullRequestContext = IssueContext & {
  author?: string;
  baseRefName?: string;
  headRefName?: string;
  headRepository?: string;
  headSha?: string;
  reviewComments: string[];
  reviews: string[];
  commits: string[];
  checks: PullRequestCheck[];
  changedFiles: string[];
  reviewThreads: PullRequestReviewThread[];
  diff: string;
};

export type PullRequestInput = {
  repo: string;
  title: string;
  body: string;
  base: string;
  head: string;
};

export type PullRequestResult = {
  url: string;
  number?: number;
  headRefName?: string;
  headRepository?: string;
};

export type IssueComment = {
  id: number;
  body: string;
  author?: string;
};

export type RecentIssueComment = IssueComment & {
  repo: string;
  issueNumber: number;
  issueUrl: string;
  createdAt?: string;
  updatedAt?: string;
};

export type RecentIssue = IssueContext & {
  createdAt?: string;
  updatedAt?: string;
};

export type StatusCommentInput = {
  repo: string;
  number: number;
  body: string;
  dryRun: boolean;
};

export interface GitHubClient {
  getIssueContext(repo: string, number: number): Promise<IssueContext>;
  getPullRequestContext(repo: string, number: number): Promise<PullRequestContext>;
  listRecentIssueComments(repo: string, since?: string): Promise<RecentIssueComment[]>;
  listRecentIssues(repo: string, since?: string): Promise<RecentIssue[]>;
  listIssueComments(repo: string, number: number): Promise<IssueComment[]>;
  commentOnIssue(repo: string, number: number, body: string): Promise<void>;
  upsertIssueComment(repo: string, number: number, marker: string, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  resolveReviewThread(repo: string, threadId: string): Promise<void>;
  createPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  findOpenBotPrForIssue(repo: string, issueNumber: number, botName: string): Promise<PullRequestResult | undefined>;
}
