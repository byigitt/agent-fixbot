import { execFile } from '../../shared/exec.js';
import type { GitHubClient, IssueContext, PullRequestInput, PullRequestResult } from './githubClient.js';

type GhIssue = { title?: string; body?: string; url?: string; comments?: { body?: string }[] };
type GhPr = { url?: string; number?: number; body?: string; author?: { login?: string } };

export class GhCliClient implements GitHubClient {
  constructor(private readonly cwd: string) {}

  async getIssueContext(repo: string, number: number): Promise<IssueContext> {
    const result = await execFile('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'title,body,url,comments'], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue view failed');
    const issue = JSON.parse(result.stdout) as GhIssue;
    return {
      repo,
      number,
      title: issue.title ?? `Issue #${number}`,
      body: issue.body ?? '',
      comments: (issue.comments ?? []).map((comment) => comment.body ?? ''),
      url: issue.url ?? `https://github.com/${repo}/issues/${number}`
    };
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<void> {
    const result = await execFile('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', body], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue comment failed');
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const result = await execFile('gh', [
      'pr', 'create',
      '--repo', input.repo,
      '--base', input.base,
      '--head', input.head,
      '--title', input.title,
      '--body', input.body
    ], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh pr create failed');
    return { url: result.stdout.trim() };
  }

  async findOpenBotPrForIssue(repo: string, issueNumber: number, botName: string): Promise<PullRequestResult | undefined> {
    const result = await execFile('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,url,body,author'], { cwd: this.cwd });
    if (result.exitCode !== 0) return undefined;
    const prs = JSON.parse(result.stdout) as GhPr[];
    const marker = `#${issueNumber}`;
    const match = prs.find((pr) => pr.author?.login?.includes(botName) || pr.body?.includes(marker));
    if (!match?.url) return undefined;
    return match.number === undefined ? { url: match.url } : { url: match.url, number: match.number };
  }
}
