import { execFile } from '../../shared/exec.js';
import type { GitHubClient, PullRequestResult } from '../github/githubClient.js';
import type { RepairJob } from '../jobs/job.js';
import { buildPrBody } from './prBody.js';
import { evaluateDiffGuards } from './guards.js';
import { evaluateCommandGate } from './commandGate.js';
import { evaluateEvidenceGate } from './evidenceGate.js';

export type PublishOptions = { dryRun: boolean; continueExisting?: boolean };

export async function publishRepair(workspace: string, job: RepairJob, github: GitHubClient, options: PublishOptions): Promise<PullRequestResult | undefined> {
  const guard = await evaluateDiffGuards(workspace, job.config.policy);
  if (!guard.ok) throw new Error(`Publisher guard failed:\n${guard.reasons.join('\n')}`);
  const commandGate = await evaluateCommandGate(workspace, job.config.policy);
  if (!commandGate.ok) throw new Error(`Prepublish command gate failed:\n${commandGate.reasons.join('\n')}`);
  const evidenceGate = await evaluateEvidenceGate(workspace, job.config.policy);
  if (!evidenceGate.ok) throw new Error(`Evidence gate failed:\n${evidenceGate.reasons.join('\n')}`);
  if (guard.changedFiles.length === 0) return undefined;
  const body = await buildPrBody(workspace, job, guard);
  if (options.dryRun || !job.config.policy.allowPush) return { url: `dry-run://would-open-pr/${job.repo}/${job.branch}`, headRefName: job.branch, headRepository: job.repo };
  if (!options.continueExisting) {
    const checkout = await execFile('git', ['checkout', '-B', job.branch], { cwd: workspace });
    if (checkout.exitCode !== 0) throw new Error(checkout.stderr || 'git checkout failed');
  }
  const add = await execFile('git', ['add', '.'], { cwd: workspace });
  if (add.exitCode !== 0) throw new Error(add.stderr || 'git add failed');
  const commit = await execFile('git', ['commit', '-m', `fix: address issue #${job.issueNumber}`], { cwd: workspace });
  if (commit.exitCode !== 0) throw new Error(commit.stderr || 'git commit failed');
  const pushRef = options.continueExisting && job.existingPullRequest?.headRefName ? `HEAD:${job.existingPullRequest.headRefName}` : job.branch;
  const push = await execFile('git', ['push', '-u', 'origin', pushRef], { cwd: workspace });
  if (push.exitCode !== 0) throw new Error(push.stderr || 'git push failed');
  if (options.continueExisting && job.existingPullRequest) return job.existingPullRequest;
  return github.createPullRequest({ repo: job.repo, base: job.base, head: job.branch, title: `fix: address issue #${job.issueNumber}`, body });
}
