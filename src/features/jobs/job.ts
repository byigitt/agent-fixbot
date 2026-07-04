import type { IssueContext, PullRequestResult } from '../github/githubClient.js';
import type { FixbotConfig } from '../config/config.js';

export type RepairMode = 'fix' | 'fix-ci' | 'address-review' | 'prepare' | 'reproduce' | 'triage' | 'review';

export type RepairJob = {
  id: string;
  repo: string;
  issueNumber: number;
  base: string;
  branch: string;
  mode: RepairMode;
  issue: IssueContext;
  config: FixbotConfig;
  createdAt: string;
  existingPullRequest?: PullRequestResult;
  autoDispatched?: boolean;
};

export function createRepairJob(input: {
  issue: IssueContext;
  config: FixbotConfig;
  mode: RepairMode;
  base?: string;
  branch?: string;
  existingPullRequest?: PullRequestResult;
  autoDispatched?: boolean;
}): RepairJob {
  const safeTitle = input.issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 42);
  const id = `${input.issue.repo.replace('/', '-')}-${input.issue.number}-${Date.now()}`;
  return {
    id,
    repo: input.issue.repo,
    issueNumber: input.issue.number,
    base: input.base ?? input.config.defaultBase,
    branch: input.branch ?? `fixbot/issue-${input.issue.number}${safeTitle ? '-' + safeTitle : ''}`,
    mode: input.mode,
    issue: input.issue,
    config: input.config,
    ...(input.existingPullRequest ? { existingPullRequest: input.existingPullRequest } : {}),
    ...(input.autoDispatched ? { autoDispatched: true } : {}),
    createdAt: new Date().toISOString()
  };
}
