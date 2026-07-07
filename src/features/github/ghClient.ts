import { execFile } from '../../shared/exec.js';
import type {
  GitHubClient,
  IssueComment,
  IssueContext,
  IssueLabel,
  PullRequestCheck,
  PullRequestContext,
  PullRequestInput,
  PullRequestResult,
  PullRequestReviewThread,
  RecentIssue,
  RecentIssueComment
} from './githubClient.js';

type GhIssue = { title?: string; body?: string; url?: string; author?: { login?: string }; comments?: { body?: string }[]; labels?: { name?: string; color?: string; description?: string }[] };
type GhPrList = { url?: string; number?: number; body?: string; author?: { login?: string }; headRefName?: string; headRepository?: { nameWithOwner?: string } };
type GhPrView = {
  title?: string;
  body?: string;
  url?: string;
  comments?: { body?: string; author?: { login?: string } }[];
  reviews?: { body?: string; state?: string; author?: { login?: string } }[];
  commits?: { oid?: string; messageHeadline?: string }[];
  files?: { path?: string }[];
  statusCheckRollup?: { name?: string; state?: string; conclusion?: string; detailsUrl?: string }[];
  headRefName?: string;
  headRefOid?: string;
  headRepository?: { nameWithOwner?: string };
  baseRefName?: string;
  author?: { login?: string };
};
type GhInlineComment = { body?: string; path?: string; line?: number; user?: { login?: string } };
type GhIssueComment = { id?: number; body?: string; user?: { login?: string }; issue_url?: string; html_url?: string; created_at?: string; updated_at?: string };
type GhRepoIssue = { number?: number; title?: string; body?: string; url?: string; user?: { login?: string }; labels?: { name?: string; color?: string; description?: string }[]; created_at?: string; updated_at?: string; pull_request?: unknown };
type GhCheckRuns = { check_runs?: { name?: string; status?: string; conclusion?: string; details_url?: string; html_url?: string; output?: { title?: string; summary?: string; text?: string } }[] };
type GhReviewThreadResponse = { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: GhReviewThread[] } } } } };
type GhReviewThread = { id?: string; isResolved?: boolean; path?: string; line?: number; comments?: { nodes?: { body?: string; author?: { login?: string } }[] } };

function commentBody(prefix: string, body: string | undefined, author?: string): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return undefined;
  return author ? `${prefix} by @${author}\n\n${trimmed}` : `${prefix}\n\n${trimmed}`;
}

// Colors/descriptions for labels the bot creates on the fly. Priority scale runs red -> green;
// type labels use GitHub's default-label colors so they look native; unknown area labels get a neutral blue.
const labelStyles: Record<string, { color: string; description: string }> = {
  p0: { color: 'b60205', description: 'Critical: drop everything' },
  p1: { color: 'd93f0b', description: 'High priority' },
  p2: { color: 'fbca04', description: 'Normal priority' },
  p3: { color: '0e8a16', description: 'Low priority' },
  bug: { color: 'd73a4a', description: "Something isn't working" },
  enhancement: { color: 'a2eeef', description: 'New feature or request' },
  documentation: { color: '0075ca', description: 'Improvements or additions to documentation' },
  question: { color: 'd876e3', description: 'Further information is requested' },
  triaged: { color: 'bfdadc', description: 'Triage notes posted' },
  reviewed: { color: 'bfdadc', description: 'Review notes posted' }
};

function labelStyle(name: string): { color: string; description: string } {
  if (labelStyles[name]) return labelStyles[name];
  if (name.startsWith('fixbot:')) return { color: 'ededed', description: `FixBot status: ${name.slice('fixbot:'.length)}` };
  return { color: 'c5def5', description: `Area: ${name}` };
}

function parseLabels(labels: { name?: string; color?: string; description?: string }[] | undefined): IssueLabel[] {
  return (labels ?? []).flatMap((label) => label.name ? [{ name: label.name, ...(label.color ? { color: label.color } : {}), ...(label.description ? { description: label.description } : {}) }] : []);
}

function parseChecks(view: GhPrView, checkRuns: GhCheckRuns | undefined): PullRequestCheck[] {
  const rollup = (view.statusCheckRollup ?? []).map((check) => ({
    name: check.name ?? 'unknown',
    ...(check.state ? { state: check.state } : {}),
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {})
  }));
  const runs = (checkRuns?.check_runs ?? []).map((check) => ({
    name: check.name ?? 'unknown',
    ...(check.status ? { state: check.status } : {}),
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(check.details_url ?? check.html_url ? { detailsUrl: check.details_url ?? check.html_url } : {}),
    ...(check.output?.summary ?? check.output?.title ?? check.output?.text ? { summary: [check.output?.title, check.output?.summary, check.output?.text].filter(Boolean).join('\n') } : {})
  }));
  return runs.length > 0 ? runs : rollup;
}

function parseReviewThreads(response: GhReviewThreadResponse | undefined): PullRequestReviewThread[] {
  return (response?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).flatMap((thread) => {
    if (!thread.id) return [];
    return [{
      id: thread.id,
      isResolved: thread.isResolved ?? false,
      ...(thread.path ? { path: thread.path } : {}),
      ...(thread.line !== undefined ? { line: thread.line } : {}),
      comments: (thread.comments?.nodes ?? []).map((comment) => commentBody('Review thread comment', comment.body, comment.author?.login)).filter((body): body is string => body !== undefined)
    }];
  });
}

function splitRepo(repo: string): { owner: string; name: string } | undefined {
  const [owner, name] = repo.split('/');
  return owner && name ? { owner, name } : undefined;
}

function issueNumberFromUrl(issueUrl: string | undefined): number | undefined {
  const match = issueUrl?.match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export class GhCliClient implements GitHubClient {
  constructor(private readonly cwd: string) {}

  async getIssueContext(repo: string, number: number): Promise<IssueContext> {
    const result = await execFile('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'title,body,url,author,comments,labels'], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue view failed');
    const issue = JSON.parse(result.stdout) as GhIssue;
    return {
      repo,
      number,
      title: issue.title ?? `Issue #${number}`,
      body: issue.body ?? '',
      comments: (issue.comments ?? []).map((comment) => comment.body ?? ''),
      labels: parseLabels(issue.labels),
      url: issue.url ?? `https://github.com/${repo}/issues/${number}`,
      ...(issue.author?.login ? { author: issue.author.login } : {})
    };
  }

  async getPullRequestContext(repo: string, number: number): Promise<PullRequestContext> {
    const fields = 'title,body,url,comments,reviews,commits,files,statusCheckRollup,headRefName,headRefOid,headRepository,baseRefName,author,labels';
    const viewResult = await execFile('gh', ['pr', 'view', String(number), '--repo', repo, '--json', fields], { cwd: this.cwd });
    if (viewResult.exitCode !== 0) throw new Error(viewResult.stderr || 'gh pr view failed');
    const view = JSON.parse(viewResult.stdout) as GhPrView & { labels?: { name?: string; color?: string; description?: string }[] };

    const diffResult = await execFile('gh', ['pr', 'diff', String(number), '--repo', repo], { cwd: this.cwd, timeoutSeconds: 120 });
    const diff = diffResult.exitCode === 0 ? diffResult.stdout : '';

    const repoParts = splitRepo(repo);
    const inlineResult = repoParts
      ? await execFile('gh', ['api', `repos/${repoParts.owner}/${repoParts.name}/pulls/${number}/comments`], { cwd: this.cwd, timeoutSeconds: 120 })
      : undefined;
    const inlineComments = inlineResult?.exitCode === 0 ? JSON.parse(inlineResult.stdout) as GhInlineComment[] : [];
    const checkRunsResult = repoParts && view.headRefOid
      ? await execFile('gh', ['api', '--method', 'GET', `repos/${repoParts.owner}/${repoParts.name}/commits/${view.headRefOid}/check-runs`, '-f', 'per_page=50'], { cwd: this.cwd, timeoutSeconds: 120 })
      : undefined;
    const checkRuns = checkRunsResult?.exitCode === 0 ? JSON.parse(checkRunsResult.stdout) as GhCheckRuns : undefined;
    const threadResult = repoParts
      ? await execFile('gh', ['api', 'graphql', '-F', `owner=${repoParts.owner}`, '-F', `name=${repoParts.name}`, '-F', `number=${number}`, '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50){nodes{id isResolved path line comments(first:10){nodes{body author{login}}}}}}}}'], { cwd: this.cwd, timeoutSeconds: 120 })
      : undefined;
    const reviewThreads = threadResult?.exitCode === 0 ? parseReviewThreads(JSON.parse(threadResult.stdout) as GhReviewThreadResponse) : [];

    const comments = (view.comments ?? []).map((comment) => comment.body ?? '').filter(Boolean);
    const reviews = (view.reviews ?? [])
      .map((review) => commentBody(`Review${review.state ? ` (${review.state})` : ''}`, review.body, review.author?.login))
      .filter((body): body is string => body !== undefined);
    const reviewComments = inlineComments
      .map((comment) => commentBody(`Inline comment${comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}` : ''}`, comment.body, comment.user?.login))
      .filter((body): body is string => body !== undefined);
    const commits = (view.commits ?? []).map((commit) => [commit.oid, commit.messageHeadline].filter(Boolean).join(' ')).filter(Boolean);

    return {
      repo,
      number,
      title: view.title ?? `Pull request #${number}`,
      body: view.body ?? '',
      comments,
      labels: parseLabels(view.labels),
      url: view.url ?? `https://github.com/${repo}/pull/${number}`,
      ...(view.author?.login ? { author: view.author.login } : {}),
      ...(view.baseRefName ? { baseRefName: view.baseRefName } : {}),
      ...(view.headRefName ? { headRefName: view.headRefName } : {}),
      ...(view.headRefOid ? { headSha: view.headRefOid } : {}),
      ...(view.headRepository?.nameWithOwner ? { headRepository: view.headRepository.nameWithOwner } : {}),
      reviewComments,
      reviews,
      commits,
      checks: parseChecks(view, checkRuns),
      changedFiles: (view.files ?? []).map((file) => file.path ?? '').filter(Boolean),
      reviewThreads,
      diff
    };
  }

  async listRecentIssueComments(repo: string, since?: string): Promise<RecentIssueComment[]> {
    const repoParts = splitRepo(repo);
    if (!repoParts) return [];
    const args = ['api', '--method', 'GET', `repos/${repoParts.owner}/${repoParts.name}/issues/comments`, '-f', 'per_page=100'];
    if (since) args.push('-f', `since=${since}`);
    const result = await execFile('gh', args, { cwd: this.cwd, timeoutSeconds: 120 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue comments list failed');
    const comments = JSON.parse(result.stdout) as GhIssueComment[];
    return comments.flatMap((comment) => {
      if (comment.id === undefined || !comment.issue_url) return [];
      const issueNumber = issueNumberFromUrl(comment.issue_url);
      if (issueNumber === undefined) return [];
      return [{
        id: comment.id,
        body: comment.body ?? '',
        repo,
        issueNumber,
        issueUrl: comment.issue_url,
        ...(comment.user?.login ? { author: comment.user.login } : {}),
        ...(comment.created_at ? { createdAt: comment.created_at } : {}),
        ...(comment.updated_at ? { updatedAt: comment.updated_at } : {})
      }];
    });
  }

  async listRecentIssues(repo: string, since?: string): Promise<RecentIssue[]> {
    const repoParts = splitRepo(repo);
    if (!repoParts) return [];
    const args = ['api', '--method', 'GET', `repos/${repoParts.owner}/${repoParts.name}/issues`, '-f', 'state=open', '-f', 'sort=updated', '-f', 'direction=asc', '-f', 'per_page=100'];
    if (since) args.push('-f', `since=${since}`);
    const result = await execFile('gh', args, { cwd: this.cwd, timeoutSeconds: 120 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue list failed');
    const issues = JSON.parse(result.stdout) as GhRepoIssue[];
    return issues.flatMap((issue) => {
      if (issue.number === undefined || issue.pull_request !== undefined) return [];
      return [{
        repo,
        number: issue.number,
        title: issue.title ?? `Issue #${issue.number}`,
        body: issue.body ?? '',
        comments: [],
        labels: parseLabels(issue.labels),
        url: issue.url ?? `https://github.com/${repo}/issues/${issue.number}`,
        ...(issue.user?.login ? { author: issue.user.login } : {}),
        ...(issue.created_at ? { createdAt: issue.created_at } : {}),
        ...(issue.updated_at ? { updatedAt: issue.updated_at } : {})
      }];
    });
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    const repoParts = splitRepo(repo);
    if (!repoParts) return [];
    const result = await execFile('gh', ['api', '--method', 'GET', `repos/${repoParts.owner}/${repoParts.name}/issues/${number}/comments`, '-f', 'per_page=100'], { cwd: this.cwd, timeoutSeconds: 120 });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue comments list failed');
    const comments = JSON.parse(result.stdout) as GhIssueComment[];
    return comments.flatMap((comment) => comment.id === undefined ? [] : [{ id: comment.id, body: comment.body ?? '', ...(comment.user?.login ? { author: comment.user.login } : {}) }]);
  }

  async commentOnIssue(repo: string, number: number, body: string): Promise<void> {
    const result = await execFile('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', body], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue comment failed');
  }

  async upsertIssueComment(repo: string, number: number, marker: string, body: string): Promise<void> {
    const repoParts = splitRepo(repo);
    const markedBody = body.includes(marker) ? body : `${marker}\n${body}`;
    const prior = (await this.listIssueComments(repo, number)).find((comment) => comment.body.includes(marker));
    if (!prior || !repoParts) return this.commentOnIssue(repo, number, markedBody);
    const result = await execFile('gh', ['api', '--method', 'PATCH', `repos/${repoParts.owner}/${repoParts.name}/issues/comments/${prior.id}`, '-f', `body=${markedBody}`], { cwd: this.cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr || 'gh issue comment update failed');
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    const repoParts = splitRepo(repo);
    if (!repoParts || labels.length === 0) return;
    const args = ['api', '--method', 'POST', `repos/${repoParts.owner}/${repoParts.name}/issues/${number}/labels`, ...labels.flatMap((label) => ['-f', `labels[]=${label}`])];
    const result = await execFile('gh', args, { cwd: this.cwd });
    if (result.exitCode === 0) return;
    // ponytail: GitHub 422s on unknown labels; create them (idempotent) and retry once — but only for that error
    if (!/422|does not exist/i.test(result.stderr)) throw new Error(result.stderr || 'gh issue labels add failed');
    for (const label of labels) {
      const style = labelStyle(label);
      await execFile('gh', ['api', '--method', 'POST', `repos/${repoParts.owner}/${repoParts.name}/labels`, '-f', `name=${label}`, '-f', `color=${style.color}`, '-f', `description=${style.description}`], { cwd: this.cwd });
    }
    const retry = await execFile('gh', args, { cwd: this.cwd });
    if (retry.exitCode !== 0) throw new Error(retry.stderr || result.stderr || 'gh issue labels add failed');
  }

  async removeLabel(repo: string, number: number, label: string): Promise<void> {
    const repoParts = splitRepo(repo);
    if (!repoParts) return;
    const result = await execFile('gh', ['api', '--method', 'DELETE', `repos/${repoParts.owner}/${repoParts.name}/issues/${number}/labels/${encodeURIComponent(label)}`], { cwd: this.cwd });
    // ponytail: removing an absent label is a no-op; gh reports it as HTTP 404 ("Not Found" or "Label does not exist")
    if (result.exitCode !== 0 && !result.stderr.includes('HTTP 404')) throw new Error(result.stderr || 'gh issue label remove failed');
  }

  async resolveReviewThread(repo: string, threadId: string): Promise<void> {
    const result = await execFile('gh', ['api', 'graphql', '-F', `id=${threadId}`, '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}'], { cwd: this.cwd, timeoutSeconds: 120 });
    if (result.exitCode !== 0) throw new Error(`gh review thread resolve failed for ${threadId}: ${result.stderr}`);
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
    return { url: result.stdout.trim(), headRefName: input.head, headRepository: input.repo };
  }

  async findOpenBotPrForIssue(repo: string, issueNumber: number, botName: string): Promise<PullRequestResult | undefined> {
    const result = await execFile('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,url,body,author,headRefName,headRepository'], { cwd: this.cwd });
    if (result.exitCode !== 0) return undefined;
    const prs = JSON.parse(result.stdout) as GhPrList[];
    const marker = new RegExp(`(^|[^0-9])#${issueNumber}(?![0-9])`);
    const branchPrefix = `fixbot/issue-${issueNumber}`;
    const botLogin = botName.toLowerCase();
    const match = prs.find((pr) => {
      const botAuthored = pr.author?.login?.toLowerCase().includes(botLogin) ?? false;
      const botBranch = pr.headRefName === branchPrefix || pr.headRefName?.startsWith(`${branchPrefix}-`) === true;
      return (botAuthored || botBranch) && (botBranch || marker.test(pr.body ?? ''));
    });
    if (!match?.url) return undefined;
    return {
      url: match.url,
      ...(match.number !== undefined ? { number: match.number } : {}),
      ...(match.headRefName ? { headRefName: match.headRefName } : {}),
      ...(match.headRepository?.nameWithOwner ? { headRepository: match.headRepository.nameWithOwner } : {})
    };
  }
}
