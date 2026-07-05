import { execFile } from '../../shared/exec.js';
import type { GitHubClient, PullRequestResult } from '../github/githubClient.js';
import type { RepairJob } from '../jobs/job.js';
import { buildPr } from './prBody.js';
import { evaluateDiffGuards } from './guards.js';
import { evaluateCommandGate } from './commandGate.js';
import { evaluateEvidenceGate } from './evidenceGate.js';

export type PublishOptions = { dryRun: boolean; continueExisting?: boolean };

function commitAuthorArgs(job: RepairJob): string[] {
  return [
    '-c',
    `user.name=${job.config.git.authorName}`,
    '-c',
    `user.email=${job.config.git.authorEmail}`
  ];
}

export async function publishRepair(workspace: string, job: RepairJob, github: GitHubClient, options: PublishOptions): Promise<PullRequestResult | undefined> {
  // New files are invisible to `git diff`; intent-to-add makes untracked files count in the
  // guards and numstat without staging content. `ls-files --others --exclude-standard` skips
  // gitignored paths, and .fixbot/ artifacts are filtered explicitly for repos that do not
  // ignore them — wrapper plumbing must reach neither the guard nor the PR. Explicit paths
  // (not pathspec magic) because `add .` with ignored dirs exits 1 with advice noise.
  const untracked = await execFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspace });
  if (untracked.exitCode !== 0) throw new Error(untracked.stderr || 'git ls-files failed');
  const newFiles = untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((file) => file !== '.fixbot' && !file.startsWith('.fixbot/'));
  if (newFiles.length > 0) {
    const intent = await execFile('git', ['add', '-N', '--', ...newFiles], { cwd: workspace });
    if (intent.exitCode !== 0) throw new Error(intent.stderr || 'git add -N failed');
  }
  const guard = await evaluateDiffGuards(workspace, job.config.policy);
  if (!guard.ok) throw new Error(`Publisher guard failed:\n${guard.reasons.join('\n')}`);
  const commandGate = await evaluateCommandGate(workspace, job.config.policy);
  if (!commandGate.ok) throw new Error(`Prepublish command gate failed:\n${commandGate.reasons.join('\n')}`);
  const evidenceGate = await evaluateEvidenceGate(workspace, job.config.policy);
  if (!evidenceGate.ok) throw new Error(`Evidence gate failed:\n${evidenceGate.reasons.join('\n')}`);
  if (guard.changedFiles.length === 0) return undefined;
  const pr = await buildPr(workspace, job);
  if (options.dryRun || !job.config.policy.allowPush) return { url: `dry-run://would-open-pr/${job.repo}/${job.branch}`, headRefName: job.branch, headRepository: job.repo };
  if (!options.continueExisting) {
    const checkout = await execFile('git', ['checkout', '-B', job.branch], { cwd: workspace });
    if (checkout.exitCode !== 0) throw new Error(checkout.stderr || 'git checkout failed');
  }
  // Stage exactly the guard-approved files; never a blanket `add .` that could pull artifacts in.
  const add = await execFile('git', ['add', '-A', '--', ...guard.changedFiles], { cwd: workspace });
  if (add.exitCode !== 0) throw new Error(add.stderr || 'git add failed');
  const commit = await execFile('git', [...commitAuthorArgs(job), 'commit', '-m', pr.title], { cwd: workspace });
  if (commit.exitCode !== 0) throw new Error(commit.stderr || 'git commit failed');
  const pushRef = options.continueExisting && job.existingPullRequest?.headRefName ? `HEAD:${job.existingPullRequest.headRefName}` : job.branch;
  const push = await execFile('git', ['push', '-u', 'origin', pushRef], { cwd: workspace });
  if (push.exitCode !== 0) throw new Error(push.stderr || 'git push failed');
  if (options.continueExisting && job.existingPullRequest) return job.existingPullRequest;
  return github.createPullRequest({ repo: job.repo, base: job.base, head: job.branch, title: pr.title, body: pr.body });
}
