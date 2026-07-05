import { readFileSync } from 'node:fs';
import type { PullRequestContext } from '../github/githubClient.js';
import type { RepairJob, RepairMode } from '../jobs/job.js';
import type { ProjectProfile } from '../reproduction/projectProfiler.js';

// Templates live next to this module; the build copies src templates into dist.
function readTemplate(name: string): string {
  return readFileSync(new URL(`templates/${name}.md`, import.meta.url), 'utf8');
}

type ModeTemplate = { mission: string; outputContract: string; autoDispatchGuidance?: string };

function modeTemplate(mode: RepairMode): ModeTemplate {
  const file = mode === 'prepare' ? 'fix' : mode;
  const [mission, outputContract, autoDispatchGuidance] = readTemplate(file).split(/\n---\n/).map((part) => part.trim());
  if (!mission || !outputContract) throw new Error(`Prompt template ${file}.md must have mission --- output contract sections.`);
  return { mission, outputContract, ...(autoDispatchGuidance ? { autoDispatchGuidance } : {}) };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

function commentsBlock(comments: string[]): string {
  if (comments.length === 0) return '_No comments._';
  return comments.map((comment, index) => `## Comment ${index + 1}\n\n${comment}`).join('\n\n');
}

function listBlock(items: string[], empty = '- none'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function profileBlock(profile: ProjectProfile | undefined): string {
  if (!profile) return 'No project profile available.';
  return [
    `Kind: ${profile.kind}`,
    profile.packageManager ? `Package manager: ${profile.packageManager}` : undefined,
    '',
    'Test commands:',
    listBlock(profile.testCommands),
    '',
    'Build/typecheck commands:',
    listBlock(profile.buildCommands),
    '',
    'Notes:',
    ...profile.notes.map((note) => `- ${note}`)
  ].filter((line) => line !== undefined).join('\n');
}

function isPullRequestContext(value: RepairJob['issue']): value is PullRequestContext {
  return 'diff' in value;
}

function pullRequestBlock(job: RepairJob): string {
  if (!isPullRequestContext(job.issue)) return 'No pull request context available.';
  const pr = job.issue;
  return [
    `Author: ${pr.author ?? 'unknown'}`,
    `Base: ${pr.baseRefName ?? job.base}`,
    `Head: ${pr.headRepository ?? pr.repo}:${pr.headRefName ?? 'unknown'}`,
    '',
    'Changed files:',
    listBlock(pr.changedFiles),
    '',
    'Commits:',
    listBlock(pr.commits),
    '',
    'Checks:',
    pr.checks.length > 0 ? pr.checks.map((check) => `- ${check.name}: ${check.conclusion ?? check.state ?? 'unknown'}${check.detailsUrl ? ` (${check.detailsUrl})` : ''}${check.summary ? `\n  ${check.summary}` : ''}`).join('\n') : '- none',
    '',
    'Reviews:',
    listBlock(pr.reviews),
    '',
    'Inline review comments:',
    listBlock(pr.reviewComments),
    '',
    'Review threads:',
    pr.reviewThreads.length > 0 ? pr.reviewThreads.map((thread) => `- ${thread.id}: ${thread.isResolved ? 'resolved' : 'unresolved'}${thread.path ? ` ${thread.path}${thread.line ? `:${thread.line}` : ''}` : ''}\n${thread.comments.map((comment) => `  - ${comment}`).join('\n')}`).join('\n') : '- none',
    '',
    'Diff:',
    '```diff',
    pr.diff || '(empty diff)',
    '```'
  ].join('\n');
}

export function renderRepairPrompt(job: RepairJob, profile?: ProjectProfile): string {
  const mode = modeTemplate(job.mode);
  return fill(readTemplate('frame'), {
    repo: job.repo,
    issueNumber: String(job.issueNumber),
    mode: job.mode,
    base: job.base,
    branch: job.branch,
    existingPullRequest: job.existingPullRequest ? `Existing PR: ${job.existingPullRequest.url}` : '',
    mission: mode.mission,
    liveServices: job.config.policy.allowLiveServices ? 'yes' : 'no',
    autoDispatchGuidance: job.autoDispatched && mode.autoDispatchGuidance ? `- ${mode.autoDispatchGuidance}` : '',
    profile: profileBlock(profile),
    issueTitle: job.issue.title,
    issueUrl: job.issue.url,
    issueBody: job.issue.body,
    comments: commentsBlock(job.issue.comments),
    pullRequest: pullRequestBlock(job),
    outputContract: mode.outputContract
  });
}
