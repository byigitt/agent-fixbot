import path from 'node:path';
import { loadConfig } from '../config/loadConfig.js';
import type { AutoLabelConfig } from '../config/config.js';
import { parseIssueRef, type IssueRef } from '../github/ref.js';
import { GhCliClient } from '../github/ghClient.js';
import { FixtureGitHubClient } from '../github/fixtureClient.js';
import type { GitHubClient, IssueContext, PullRequestContext, PullRequestResult, RecentIssue } from '../github/githubClient.js';
import { createRepairJob, type RepairMode } from '../jobs/job.js';
import { acquireJobLock, releaseJobLock } from '../jobs/jobLock.js';
import { clearRunningJob, recordRunningJob, stopRunningJob } from '../jobs/runningJobs.js';
import { writeJobFiles } from '../jobs/jobStore.js';
import { renderRepairPrompt } from '../prompts/renderPrompt.js';
import { NoopAgentRunner } from '../agents/noopAgentRunner.js';
import { CommandAgentRunner } from '../agents/commandAgentRunner.js';
import { publishRepair } from '../publisher/publisher.js';
import { publishArtifactComment } from '../publisher/artifactPublisher.js';
import { postStatusComment, type StatusCommentStatus } from '../publisher/statusComments.js';
import { resolveReviewThreadsFromArtifact } from '../publisher/reviewThreads.js';
import { preparePullRequestWorkspace, prepareWorkspace } from '../workspaces/workspaceService.js';
import { profileProject, type ProjectProfile } from '../reproduction/projectProfiler.js';
import { runReproductionPlan, writeReproductionReport } from '../reproduction/reproductionRunner.js';
import { pathExists, readJson, writeJson } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';
import { routeComment, type CommentEvent, type RoutedCommand } from '../controller/commentRouter.js';
import { runDoctor } from './doctor.js';
import { flagBool, flagString, type ParsedArgs } from './args.js';
import { helpText } from './help.js';

type RunContext = {
  parsed: ParsedArgs;
  cwd: string;
  mode: RepairMode;
};

type PollState = { since?: string };
type IssuePollState = { since?: string };

const prModes = new Set<RepairMode>(['review', 'address-review', 'fix-ci']);
const commentOnlyArtifacts: Partial<Record<RepairMode, { file: string; fallback: string; status: 'triaged' | 'reviewed' }>> = {
  triage: { file: '.fixbot/triage.md', fallback: '_Agent did not write `.fixbot/triage.md`._', status: 'triaged' },
  review: { file: '.fixbot/review.md', fallback: '_Agent did not write `.fixbot/review.md`._', status: 'reviewed' }
};

export async function runCommand(parsed: ParsedArgs, cwd: string): Promise<string> {
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') return helpText;
  if (parsed.command === 'doctor') return runDoctor(cwd);
  if (parsed.command === 'route-comment') return routeCommentFile(parsed);
  if (parsed.command === 'dispatch-comment') return dispatchCommentFile(parsed, cwd);
  if (parsed.command === 'poll-comments') return pollComments(parsed, cwd);
  if (parsed.command === 'poll-issues') return pollIssues(parsed, cwd);
  if (parsed.command === 'stop') return stopCommand(parsed, cwd);
  if (parsed.command === 'prepare' || parsed.command === 'fix' || parsed.command === 'reproduce' || parsed.command === 'triage' || parsed.command === 'review' || parsed.command === 'fix-ci' || parsed.command === 'address-review') {
    const mode = parsed.command === 'prepare' ? 'prepare' : parsed.command;
    return runFixLike({ parsed, cwd, mode });
  }
  return helpText;
}

async function routeCommentFile(parsed: ParsedArgs): Promise<string> {
  const eventFile = parsed.positional[0];
  if (!eventFile) throw new Error(`Missing event JSON path.\n\n${helpText}`);
  const botName = flagString(parsed.flags, 'bot') ?? 'fixbot';
  const routed = routeComment(await readJson<CommentEvent>(eventFile), botName);
  return JSON.stringify(routed ?? null, null, 2) + '\n';
}

async function dispatchCommentFile(parsed: ParsedArgs, cwd: string): Promise<string> {
  const eventFile = parsed.positional[0];
  if (!eventFile) throw new Error(`Missing event JSON path.\n\n${helpText}`);
  const botName = flagString(parsed.flags, 'bot') ?? 'fixbot';
  const routed = routeComment(await readJson<CommentEvent>(eventFile), botName);
  if (!routed) return 'No bot command routed.\n';
  return dispatchRoutedCommand(routed, cwd, flagBool(parsed.flags, 'dry-run'));
}

async function pollComments(parsed: ParsedArgs, cwd: string): Promise<string> {
  const repo = parsed.positional[0];
  if (!repo) throw new Error(`Missing repo for poll-comments.\n\n${helpText}`);
  const botName = flagString(parsed.flags, 'bot') ?? 'fixbot';
  const dryRun = flagBool(parsed.flags, 'dry-run');
  const stateFile = flagString(parsed.flags, 'state') ?? path.join(cwd, '.fixbot', 'poll-state', `${repoSlug(repo)}.json`);
  const state = await pathExists(stateFile) ? await readJson<PollState>(stateFile) : {};
  const since = flagString(parsed.flags, 'since') ?? state.since;
  const github = new GhCliClient(cwd);
  const comments = await github.listRecentIssueComments(repo, since);
  const outputs: string[] = [];
  let newest = since;
  for (const comment of comments) {
    const timestamp = comment.updatedAt ?? comment.createdAt;
    if (timestamp && (!newest || Date.parse(timestamp) > Date.parse(newest))) newest = timestamp;
    const routed = routeComment({
      action: 'created',
      comment: { body: comment.body, user: { login: comment.author ?? 'unknown' } },
      issue: { number: comment.issueNumber },
      repository: { full_name: repo }
    }, botName);
    if (!routed) continue;
    const output = await dispatchRoutedCommand(routed, cwd, dryRun);
    outputs.push(`Dispatched ${routed.command} for ${repo}#${routed.ref.number}\n${output.trimEnd()}`);
  }
  if (newest && !dryRun) await writeJson(stateFile, { since: newest });
  return outputs.length > 0 ? outputs.join('\n') + '\n' : 'No bot commands found.\n';
}

function labelsForIssue(issue: RecentIssue, config: AutoLabelConfig): string[] {
  if (!config.enabled) return [];
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  const matched = config.rules
    .filter((rule) => rule.keywords.some((keyword) => text.includes(keyword.toLowerCase())))
    .map((rule) => rule.label);
  const labels = matched.length > 0 ? matched : config.defaultLabels;
  const existing = new Set(issue.labels.map((label) => label.name));
  return Array.from(new Set(labels)).filter((label) => !existing.has(label));
}

async function pollIssues(parsed: ParsedArgs, cwd: string): Promise<string> {
  const repo = parsed.positional[0];
  if (!repo) throw new Error(`Missing repo for poll-issues.\n\n${helpText}`);
  const dryRun = flagBool(parsed.flags, 'dry-run');
  const stateFile = flagString(parsed.flags, 'state') ?? path.join(cwd, '.fixbot', 'issue-state', `${repoSlug(repo)}.json`);
  const state = await pathExists(stateFile) ? await readJson<IssuePollState>(stateFile) : {};
  const since = flagString(parsed.flags, 'since') ?? state.since;
  const config = await loadConfig(cwd);
  const github = new GhCliClient(cwd);
  const issues = await github.listRecentIssues(repo, since);
  const outputs: string[] = [];
  let newest = since;
  for (const issue of issues) {
    const timestamp = issue.updatedAt ?? issue.createdAt;
    if (timestamp && (!newest || Date.parse(timestamp) > Date.parse(newest))) newest = timestamp;
    const labels = labelsForIssue(issue, config.autoLabel);
    if (labels.length === 0) continue;
    if (!dryRun) await github.addLabels(repo, issue.number, labels);
    outputs.push(`${dryRun ? 'Would label' : 'Labeled'} ${repo}#${issue.number}: ${labels.join(', ')}`);
  }
  if (newest && !dryRun) await writeJson(stateFile, { since: newest });
  return outputs.length > 0 ? outputs.join('\n') + '\n' : 'No issues labeled.\n';
}

async function dispatchRoutedCommand(routed: NonNullable<RoutedCommand>, cwd: string, dryRun: boolean): Promise<string> {
  const ref = `${routed.ref.repo}#${routed.ref.number}`;
  if (routed.command === 'stop') return stopRef(routed.ref, cwd);
  return runCommand({ command: routed.command, positional: [ref], flags: dryRun ? { 'dry-run': true } : {} }, cwd);
}

async function stopCommand(parsed: ParsedArgs, cwd: string): Promise<string> {
  const ref = parsed.positional[0];
  if (!ref) throw new Error(`Missing issue ref.\n\n${helpText}`);
  return stopRef(parseIssueRef(ref), cwd);
}

async function stopRef(ref: IssueRef, cwd: string): Promise<string> {
  const stopped = await stopRunningJob(cwd, ref.repo, ref.number);
  if (stopped.stopped) return `Stopped job ${stopped.record?.jobId ?? ''} for ${ref.repo}#${ref.number}.\n`;
  return `No running job stopped for ${ref.repo}#${ref.number}: ${stopped.reason ?? 'not found'}\n`;
}

async function issueForMode(github: GitHubClient, ref: IssueRef, mode: RepairMode): Promise<IssueContext> {
  if (!prModes.has(mode)) return github.getIssueContext(ref.repo, ref.number);
  try {
    return await github.getPullRequestContext(ref.repo, ref.number);
  } catch {
    return github.getIssueContext(ref.repo, ref.number);
  }
}

function existingForMode(mode: RepairMode, issue: IssueContext, found: PullRequestResult | undefined): PullRequestResult | undefined {
  if (mode === 'address-review' && 'headRefName' in issue) {
    const pr = issue as PullRequestContext;
    return { url: pr.url, number: pr.number, ...(pr.headRefName ? { headRefName: pr.headRefName } : {}), ...(pr.headRepository ? { headRepository: pr.headRepository } : {}) };
  }
  return found;
}

function statusLabelInput(config: { policy: { statusLabels: Partial<Record<string, string>> } }, status: StatusCommentStatus): { label?: string; removeLabels: string[] } {
  const label = config.policy.statusLabels[status];
  const removeLabels = Array.from(new Set(Object.values(config.policy.statusLabels).filter((value): value is string => value !== undefined)));
  return label ? { label, removeLabels } : { removeLabels };
}

async function runFixLike(input: RunContext): Promise<string> {
  const ref = input.parsed.positional[0];
  if (!ref) throw new Error(`Missing issue ref.\n\n${helpText}`);
  const dryRun = flagBool(input.parsed.flags, 'dry-run');
  const parsedRef = parseIssueRef(ref);
  const config = await loadConfig(input.cwd);
  const github: GitHubClient = dryRun ? new FixtureGitHubClient() : new GhCliClient(input.cwd);
  const issue = await issueForMode(github, parsedRef, input.mode);
  const base = flagString(input.parsed.flags, 'base');
  const foundExisting = await github.findOpenBotPrForIssue(parsedRef.repo, parsedRef.number, config.botName);
  const existingPullRequest = existingForMode(input.mode, issue, foundExisting);
  const jobInput = { issue, config, mode: input.mode, ...(base ? { base } : {}), ...(existingPullRequest?.headRefName ? { branch: existingPullRequest.headRefName } : {}), ...(existingPullRequest ? { existingPullRequest } : {}) };
  const job = createRepairJob(jobInput);
  const lock = await acquireJobLock(input.cwd, job.repo, job.issueNumber, job.id);
  if (!lock) return `Job already running for ${job.repo}#${job.issueNumber}.\n`;
  try {
    const shouldCheckoutPullRequest = input.mode === 'review' || input.mode === 'address-review' || (existingPullRequest?.number !== undefined && existingPullRequest.headRefName !== undefined);
    const workspace = shouldCheckoutPullRequest
      ? await preparePullRequestWorkspace(input.cwd, config.workspaceRoot, job.repo, existingPullRequest?.number ?? parsedRef.number, dryRun)
      : await prepareWorkspace(input.cwd, config.workspaceRoot, job.repo, job.base, dryRun);
    const profile = await profileProject(workspace.workspace);
    const prompt = renderRepairPrompt(job, profile);
    const files = await writeJobFiles(workspace.workspace, job, prompt);
    if (input.mode === 'prepare') return [`Prepared job ${job.id}`, `Workspace: ${workspace.workspace}`, `Job: ${files.jobFile}`, `Prompt: ${files.promptFile}`].join('\n') + '\n';
    await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status: 'started', summary: `Started ${input.mode} job ${job.id}.`, ...statusLabelInput(config, 'started'), dryRun });
    const runner = dryRun ? new NoopAgentRunner() : new CommandAgentRunner(config.agent);
    const run = await runner.run({
      cwd: workspace.workspace,
      promptFile: files.promptFile,
      onSpawn: async (pid) => recordRunningJob(input.cwd, { repo: job.repo, number: job.issueNumber, jobId: job.id, pid, startedAt: new Date().toISOString() })
    });
    await clearRunningJob(input.cwd, job.repo, job.issueNumber);
    if (run.exitCode !== 0) {
      await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status: 'blocked', summary: `Agent failed for ${input.mode} job ${job.id}.`, details: [run.stderr || run.stdout], ...statusLabelInput(config, 'blocked'), dryRun });
      return [`Agent failed: ${run.command}`, run.stderr || run.stdout].join('\n') + '\n';
    }
    if (input.mode === 'reproduce') return finishReproduction(workspace.workspace, profile, github, config, job.repo, job.issueNumber, dryRun);
    const commentArtifact = commentOnlyArtifacts[input.mode];
    if (commentArtifact) {
      const body = await publishArtifactComment(github, workspace.workspace, job.repo, job.issueNumber, commentArtifact.file, commentArtifact.fallback, dryRun);
      await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status: commentArtifact.status, summary: `${input.mode} completed for job ${job.id}.`, ...statusLabelInput(config, commentArtifact.status), dryRun });
      return [`Agent finished: ${run.command}`, run.stdout.trim(), `Comment artifact: ${commentArtifact.file}`, `Comment body length: ${body.length}`, `Workspace: ${workspace.workspace}`].filter(Boolean).join('\n') + '\n';
    }
    const pr = await publishRepair(workspace.workspace, job, github, { dryRun, continueExisting: Boolean(existingPullRequest?.headRefName) });
    if (input.mode === 'address-review' && !dryRun) await resolveReviewThreadsFromArtifact(github, workspace.workspace, job.repo);
    if (pr) {
      const status = input.mode === 'address-review' ? 'review-addressed' : 'pr-opened';
      await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status, summary: `${input.mode} completed: ${pr.url}`, ...statusLabelInput(config, status), dryRun });
    }
    return [`Agent finished: ${run.command}`, run.stdout.trim(), pr ? `PR: ${pr.url}` : 'No diff to publish', `Workspace: ${workspace.workspace}`].filter(Boolean).join('\n') + '\n';
  } finally {
    await releaseJobLock(lock);
  }
}

async function finishReproduction(workspace: string, profile: ProjectProfile, github: GitHubClient, config: { policy: { statusLabels: Partial<Record<string, string>> } }, repo: string, number: number, dryRun: boolean): Promise<string> {
  const report = await runReproductionPlan(workspace, profile);
  const reportFile = await writeReproductionReport(workspace, report);
  const status = report.status === 'reproduced' ? 'reproduced' : report.status === 'no-repro' ? 'no-repro' : 'blocked';
  await postStatusComment(github, {
    repo,
    number,
    status,
    summary: report.summary,
    details: report.reasons,
    ...statusLabelInput(config, status),
    dryRun
  });
  return [
    `Reproduction status: ${report.status}`,
    report.summary,
    `Report: ${reportFile}`,
    `Workspace: ${workspace}`,
    ...report.reasons.map((reason) => `Reason: ${reason}`)
  ].join('\n') + '\n';
}
