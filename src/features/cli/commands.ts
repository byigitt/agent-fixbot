import path from 'node:path';
import { loadConfig } from '../config/loadConfig.js';
import type { AutoDispatchConfig, AutoLabelConfig } from '../config/config.js';
import { parseIssueRef, type IssueRef } from '../github/ref.js';
import { GhCliClient } from '../github/ghClient.js';
import { FixtureGitHubClient } from '../github/fixtureClient.js';
import type { GitHubClient, IssueContext, PullRequestContext, PullRequestResult, RecentIssue } from '../github/githubClient.js';
import { createRepairJob, type RepairMode } from '../jobs/job.js';
import { acquireJobLock, releaseJobLock } from '../jobs/jobLock.js';
import { clearRunningJob, readRunningJob, recordRunningJob, stopRunningJob } from '../jobs/runningJobs.js';
import { writeJobFiles } from '../jobs/jobStore.js';
import { renderRepairPrompt } from '../prompts/renderPrompt.js';
import { NoopAgentRunner } from '../agents/noopAgentRunner.js';
import { CommandAgentRunner } from '../agents/commandAgentRunner.js';
import { publishRepair } from '../publisher/publisher.js';
import { publishArtifactComment } from '../publisher/artifactPublisher.js';
import { applyStatusLabels, postStatusComment, type StatusCommentStatus } from '../publisher/statusComments.js';
import { resolveReviewThreadsFromArtifact } from '../publisher/reviewThreads.js';
import { preparePullRequestWorkspace, prepareWorkspace } from '../workspaces/workspaceService.js';
import { profileProject, type ProjectProfile } from '../reproduction/projectProfiler.js';
import { runReproductionPlan, writeReproductionReport } from '../reproduction/reproductionRunner.js';
import { pathExists, readJson, writeJson, writeText } from '../../shared/fs.js';
import { execFile } from '../../shared/exec.js';
import { debugLog } from '../../shared/debug.js';
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

type DaemonSchedule = {
  commentsNextAt: number;
  issuesNextAt: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intervalMs(flags: ParsedArgs['flags'], key: string, defaultSeconds: number): number {
  const raw = flagString(flags, key);
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--${key} must be a positive number of seconds.`);
  return seconds * 1000;
}

function daemonFlags(parsed: ParsedArgs, botName: string): ParsedArgs['flags'] {
  return flagBool(parsed.flags, 'dry-run') ? { bot: botName, 'dry-run': true } : { bot: botName };
}

function issueDaemonFlags(parsed: ParsedArgs): ParsedArgs['flags'] {
  return flagBool(parsed.flags, 'dry-run') ? { 'dry-run': true } : {};
}

function botFlag(parsed: ParsedArgs): string {
  return flagString(parsed.flags, 'bot') ?? 'fixbot';
}

function daemonLog(message: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

export async function runCommand(parsed: ParsedArgs, cwd: string): Promise<string> {
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') return helpText;
  if (parsed.command === 'doctor') return runDoctor(cwd);
  if (parsed.command === 'route-comment') return routeCommentFile(parsed);
  if (parsed.command === 'dispatch-comment') return dispatchCommentFile(parsed, cwd);
  if (parsed.command === 'poll-comments') return pollComments(parsed, cwd);
  if (parsed.command === 'poll-issues') return pollIssues(parsed, cwd);
  if (parsed.command === 'poll-reviews') return pollReviews(parsed, cwd);
  if (parsed.command === 'daemon' || parsed.command === 'watch') return runDaemon(parsed, cwd);
  if (parsed.command === 'stop') return stopCommand(parsed, cwd);
  if (parsed.command === 'prepare' || parsed.command === 'fix' || parsed.command === 'reproduce' || parsed.command === 'triage' || parsed.command === 'review' || parsed.command === 'fix-ci' || parsed.command === 'address-review') {
    const mode = parsed.command === 'prepare' ? 'prepare' : parsed.command;
    return runFixLike({ parsed, cwd, mode });
  }
  return helpText;
}

async function routeCommentFromFile(parsed: ParsedArgs): Promise<RoutedCommand> {
  const eventFile = parsed.positional[0];
  if (!eventFile) throw new Error(`Missing event JSON path.\n\n${helpText}`);
  return routeComment(await readJson<CommentEvent>(eventFile), botFlag(parsed));
}

async function routeCommentFile(parsed: ParsedArgs): Promise<string> {
  const routed = await routeCommentFromFile(parsed);
  return JSON.stringify(routed ?? null, null, 2) + '\n';
}

async function dispatchCommentFile(parsed: ParsedArgs, cwd: string): Promise<string> {
  const routed = await routeCommentFromFile(parsed);
  if (!routed) return 'No bot command routed.\n';
  return dispatchRoutedCommand(routed, cwd, flagBool(parsed.flags, 'dry-run'));
}

async function pollComments(parsed: ParsedArgs, cwd: string): Promise<string> {
  const repo = parsed.positional[0];
  if (!repo) throw new Error(`Missing repo for poll-comments.\n\n${helpText}`);
  const botName = botFlag(parsed);
  const dryRun = flagBool(parsed.flags, 'dry-run');
  const stateFile = flagString(parsed.flags, 'state') ?? path.join(cwd, '.fixbot', 'poll-state', `${repoSlug(repo)}.json`);
  const state = await pathExists(stateFile) ? await readJson<PollState>(stateFile) : {};
  const since = flagString(parsed.flags, 'since') ?? state.since;
  const github = new GhCliClient(cwd);
  debugLog(`poll-comments ${repo}: since=${since ?? 'none'} state=${stateFile}`);
  const comments = await github.listRecentIssueComments(repo, since);
  debugLog(`poll-comments ${repo}: fetched ${comments.length} comment(s)`);
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
    debugLog(`comment on #${comment.issueNumber} by @${comment.author ?? 'unknown'}: ${routed ? `routed to ${routed.command}` : 'no bot command'}`);
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

// Returns a skip reason, or undefined when the issue should be auto-dispatched.
function autoDispatchSkipReason(issue: RecentIssue, plannedLabels: string[], config: AutoDispatchConfig): string | undefined {
  if (!config.enabled) return 'autoDispatch.enabled is false in .fixbot.json';
  const labels = new Set([...issue.labels.map((label) => label.name), ...plannedLabels]);
  const skipLabel = config.skipWhenLabels.find((label) => labels.has(label));
  if (skipLabel) return `has skip label "${skipLabel}"`;
  if (config.requireLabels.length > 0 && !config.requireLabels.some((label) => labels.has(label)))
    return `missing required label (one of: ${config.requireLabels.join(', ')})`;
  return undefined;
}

function autoDispatchStartSummary(mode: AutoDispatchConfig['mode']): string {
  if (mode === 'fix') return 'Looking into this — will report back, with a PR if it pans out.';
  if (mode === 'reproduce') return 'Looking into this — starting with a reproduction.';
  return 'Looking into this — triage notes to follow.';
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
  debugLog(`poll-issues ${repo}: since=${since ?? 'none'} state=${stateFile}`);
  const issues = await github.listRecentIssues(repo, since);
  debugLog(`poll-issues ${repo}: fetched ${issues.length} issue(s)`);
  const outputs: string[] = [];
  let newest = since;
  let dispatched = 0;
  for (const issue of issues) {
    const timestamp = issue.updatedAt ?? issue.createdAt;
    if (timestamp && (!newest || Date.parse(timestamp) > Date.parse(newest))) newest = timestamp;
    const labels = labelsForIssue(issue, config.autoLabel);
    debugLog(`saw ${repo}#${issue.number} (updated ${timestamp ?? 'unknown'})`);
    if (labels.length > 0) {
      if (!dryRun) await github.addLabels(repo, issue.number, labels);
      outputs.push(`${dryRun ? 'Would label' : 'Labeled'} ${repo}#${issue.number}: ${labels.join(', ')}`);
    }
    const skipReason = dispatched >= config.autoDispatch.maxPerPoll
      ? `maxPerPoll (${config.autoDispatch.maxPerPoll}) reached this poll`
      : autoDispatchSkipReason(issue, labels, config.autoDispatch);
    if (skipReason) {
      debugLog(`skipping auto-dispatch for ${repo}#${issue.number}: ${skipReason}`);
    } else {
      dispatched += 1;
      const ref = `${repo}#${issue.number}`;
      if (dryRun) {
        outputs.push(`Would auto-dispatch ${config.autoDispatch.mode} for ${ref}`);
      } else {
        const output = await runCommand({
          command: config.autoDispatch.mode,
          positional: [ref],
          flags: { 'start-summary': autoDispatchStartSummary(config.autoDispatch.mode), 'auto-dispatched': true }
        }, cwd);
        outputs.push(`Auto-dispatched ${config.autoDispatch.mode} for ${ref}\n${output.trimEnd()}`);
      }
    }
  }
  if (newest && !dryRun) await writeJson(stateFile, { since: newest });
  return outputs.length > 0 ? outputs.join('\n') + '\n' : 'No issues labeled or dispatched.\n';
}

type ReviewPollState = { prs?: Record<string, string> };

// Open PRs owned by the bot (author or fixbot/ branch), the ones a review loop can update.
async function listOpenBotPrNumbers(repo: string, botName: string, cwd: string): Promise<number[]> {
  const result = await execFile('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,author,headRefName'], { cwd, timeoutSeconds: 120 });
  if (result.exitCode !== 0) return [];
  const prs = JSON.parse(result.stdout) as { number?: number; author?: { login?: string }; headRefName?: string }[];
  return prs
    .filter((pr) => pr.number !== undefined && (pr.author?.login === botName || (pr.headRefName ?? '').startsWith('fixbot/')))
    .map((pr) => pr.number as number);
}

// Newest non-bot review activity (submitted reviews + inline comments) on a PR.
async function latestReviewActivity(repo: string, number: number, botName: string, cwd: string): Promise<string | undefined> {
  const repoParts = repo.split('/');
  const base = `repos/${repoParts[0]}/${repoParts[1]}/pulls/${number}`;
  const [reviews, comments] = await Promise.all([
    execFile('gh', ['api', '--method', 'GET', `${base}/reviews`, '-f', 'per_page=100'], { cwd, timeoutSeconds: 120 }),
    execFile('gh', ['api', '--method', 'GET', `${base}/comments`, '-f', 'per_page=100'], { cwd, timeoutSeconds: 120 })
  ]);
  const timestamps: number[] = [];
  if (reviews.exitCode === 0) {
    for (const review of JSON.parse(reviews.stdout) as { user?: { login?: string }; state?: string; body?: string; submitted_at?: string }[]) {
      if (review.user?.login === botName || !review.submitted_at) continue;
      // Only actionable feedback counts: approvals and empty reviews must not restart the loop.
      const actionable = review.state === 'CHANGES_REQUESTED' || (review.state === 'COMMENTED' && (review.body ?? '').trim().length > 0);
      if (actionable) timestamps.push(Date.parse(review.submitted_at));
    }
  }
  if (comments.exitCode === 0) {
    for (const comment of JSON.parse(comments.stdout) as { user?: { login?: string }; body?: string; updated_at?: string }[]) {
      if (comment.user?.login !== botName && (comment.body ?? '').trim().length > 0 && comment.updated_at) timestamps.push(Date.parse(comment.updated_at));
    }
  }
  const latest = timestamps.filter(Number.isFinite).sort((a, b) => b - a)[0];
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

// Review loop: new human/agent review activity on an open bot PR auto-dispatches
// address-review, which commits follow-ups onto the same PR branch (roboomp-style).
async function pollReviews(parsed: ParsedArgs, cwd: string): Promise<string> {
  const repo = parsed.positional[0];
  if (!repo) throw new Error(`Missing repo for poll-reviews.\n\n${helpText}`);
  const botName = botFlag(parsed);
  const dryRun = flagBool(parsed.flags, 'dry-run');
  const config = await loadConfig(cwd);
  if (!config.autoDispatch.enabled) return 'autoDispatch.enabled is false; review loop off.\n';
  const stateFile = flagString(parsed.flags, 'state') ?? path.join(cwd, '.fixbot', 'review-state', `${repoSlug(repo)}.json`);
  const state: ReviewPollState = await pathExists(stateFile) ? await readJson<ReviewPollState>(stateFile) : {};
  const prs = state.prs ?? {};
  const outputs: string[] = [];
  for (const number of await listOpenBotPrNumbers(repo, botName, cwd)) {
    const latest = await latestReviewActivity(repo, number, botName, cwd);
    if (!latest) continue;
    // A bot PR starts review-free, so any non-bot activity newer than the cursor is fresh feedback.
    const seen = prs[String(number)];
    if (seen && Date.parse(latest) <= Date.parse(seen)) continue;
    if (dryRun) {
      outputs.push(`Would address review feedback on ${repo}#${number} (activity ${latest})`);
      continue;
    }
    const output = await runCommand({
      command: 'address-review',
      positional: [`${repo}#${number}`],
      flags: { 'start-summary': 'New review feedback — on it.', 'auto-dispatched': true }
    }, cwd);
    // Keep the cursor when the ref is locked so the feedback is retried next poll.
    if (!output.includes('Job already running')) prs[String(number)] = latest;
    outputs.push(`Auto-dispatched address-review for ${repo}#${number}\n${output.trimEnd()}`);
  }
  if (!dryRun) await writeJson(stateFile, { prs });
  return outputs.length > 0 ? outputs.join('\n') + '\n' : 'No new review activity.\n';
}

async function runDaemon(parsed: ParsedArgs, cwd: string): Promise<string> {
  const repo = parsed.positional[0];
  if (!repo) throw new Error(`Missing repo for daemon.\n\n${helpText}`);
  const botName = botFlag(parsed);
  const commentsInterval = intervalMs(parsed.flags, 'comments-interval', 60);
  const issuesInterval = intervalMs(parsed.flags, 'issues-interval', 180);
  const once = flagBool(parsed.flags, 'once');
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const schedule: DaemonSchedule = { commentsNextAt: 0, issuesNextAt: 0 };
  daemonLog(`Watching ${repo} as @${botName}; comments every ${commentsInterval / 1000}s, issues every ${issuesInterval / 1000}s.`);
  try {
    while (!stopping) {
      const now = Date.now();
      if (now >= schedule.commentsNextAt) {
        daemonLog('Polling comments.');
        try {
          const output = await runCommand({ command: 'poll-comments', positional: [repo], flags: daemonFlags(parsed, botName) }, cwd);
          daemonLog(output.trimEnd());
        } catch (error) {
          daemonLog(`poll-comments failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        schedule.commentsNextAt = Date.now() + commentsInterval;
        try {
          const reviews = await runCommand({ command: 'poll-reviews', positional: [repo], flags: daemonFlags(parsed, botName) }, cwd);
          if (!reviews.startsWith('No new review activity')) daemonLog(reviews.trimEnd());
        } catch (error) {
          daemonLog(`poll-reviews failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (stopping) break;
      if (now >= schedule.issuesNextAt) {
        daemonLog('Polling issues.');
        try {
          const output = await runCommand({ command: 'poll-issues', positional: [repo], flags: issueDaemonFlags(parsed) }, cwd);
          daemonLog(output.trimEnd());
        } catch (error) {
          daemonLog(`poll-issues failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        schedule.issuesNextAt = Date.now() + issuesInterval;
      }
      if (once) break;
      const nextAt = Math.min(schedule.commentsNextAt, schedule.issuesNextAt);
      await sleep(Math.min(1000, Math.max(250, nextAt - Date.now())));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return 'Daemon stopped.\n';
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
  const startSummary = flagString(input.parsed.flags, 'start-summary');
  const autoDispatched = flagBool(input.parsed.flags, 'auto-dispatched');
  const parsedRef = parseIssueRef(ref);
  const config = await loadConfig(input.cwd);
  const github: GitHubClient = dryRun ? new FixtureGitHubClient() : new GhCliClient(input.cwd);
  const issue = await issueForMode(github, parsedRef, input.mode);
  const base = flagString(input.parsed.flags, 'base');
  const foundExisting = await github.findOpenBotPrForIssue(parsedRef.repo, parsedRef.number, config.botName);
  const existingPullRequest = existingForMode(input.mode, issue, foundExisting);
  const jobInput = { issue, config, mode: input.mode, ...(base ? { base } : {}), ...(existingPullRequest?.headRefName ? { branch: existingPullRequest.headRefName } : {}), ...(existingPullRequest ? { existingPullRequest } : {}), ...(autoDispatched ? { autoDispatched: true } : {}) };
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
    // Both agent children (labeler + main run) register their PID so `stop` can kill them
    // and stale-lock reclaim sees a live child even if the wrapper dies mid-phase.
    let labelerSpawned = false;
    const trackSpawn = async (pid: number) => {
      labelerSpawned = true;
      await recordRunningJob(input.cwd, { repo: job.repo, number: job.issueNumber, jobId: job.id, pid, startedAt: new Date().toISOString() });
    };
    // The quick agent call runs FIRST: it classifies the issue (labels) and writes the opener
    // in its own words, so the first visible comment is agent-authored, not a canned template.
    let opener = startSummary ?? 'Taking a look at this now.';
    if (autoDispatched && !prModes.has(input.mode) && !dryRun) {
      const quick = await quickLabelIssue(github, config.agent, workspace.workspace, job.repo, job.issueNumber, issue, trackSpawn);
      daemonLog(quick.note);
      // `stop` SIGTERMs the tracked child and clears its running record. A spawned
      // labeler whose record is gone means the job was stopped: do not start the main agent.
      const stillTracked = await readRunningJob(input.cwd, job.repo, job.issueNumber);
      await clearRunningJob(input.cwd, job.repo, job.issueNumber);
      if (labelerSpawned && !stillTracked) return `Job stopped during labeling for ${job.repo}#${job.issueNumber}.\n`;
      if (quick.opener) opener = quick.opener;
    }
    // Opener only — no label lifecycle at start. Terminal transitions (pr-opened/triaged/blocked)
    // clear stale status labels themselves via their removeLabels list.
    await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status: 'started', summary: opener, dryRun });
    const runner = dryRun ? new NoopAgentRunner() : new CommandAgentRunner(config.agent);
    const run = await runner.run({
      cwd: workspace.workspace,
      promptFile: files.promptFile,
      onSpawn: trackSpawn
    });
    await clearRunningJob(input.cwd, job.repo, job.issueNumber);
    if (run.exitCode !== 0) {
      await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status: 'blocked', summary: `Hit a blocker on the ${input.mode} run:`, details: [run.stderr || run.stdout], ...statusLabelInput(config, 'blocked'), dryRun });
      return [`Agent failed: ${run.command}`, run.stderr || run.stdout].join('\n') + '\n';
    }
    if (input.mode === 'reproduce') return finishReproduction(workspace.workspace, profile, github, config, job.repo, job.issueNumber, dryRun);
    const commentArtifact = commentOnlyArtifacts[input.mode];
    if (commentArtifact) {
      const labelNote = input.mode === 'triage' ? await applyAgentLabels(github, workspace.workspace, job.repo, job.issueNumber, dryRun) : undefined;
      if (labelNote) daemonLog(labelNote);
      const body = await publishArtifactComment(github, workspace.workspace, job.repo, job.issueNumber, commentArtifact.file, commentArtifact.fallback, dryRun);
      // The artifact comment IS the completion message; only the label lifecycle runs here.
      await applyStatusLabels(github, { repo: job.repo, number: job.issueNumber, ...statusLabelInput(config, commentArtifact.status), dryRun });
      return [`Agent finished: ${run.command}`, run.stdout.trim(), `Comment artifact: ${commentArtifact.file}`, `Comment body length: ${body.length}`, `Workspace: ${workspace.workspace}`].filter(Boolean).join('\n') + '\n';
    }
    // Roboomp-style progressive updates: a short findings comment lands on the issue before the PR link.
    if (await pathExists(path.join(workspace.workspace, '.fixbot', 'findings.md'))) {
      await publishArtifactComment(github, workspace.workspace, job.repo, job.issueNumber, '.fixbot/findings.md', '', dryRun);
    }
    const pr = await publishRepair(workspace.workspace, job, github, { dryRun, continueExisting: Boolean(existingPullRequest?.headRefName) });
    if (input.mode === 'address-review' && !dryRun) await resolveReviewThreadsFromArtifact(github, workspace.workspace, job.repo);
    if (pr) {
      const status = input.mode === 'address-review' ? 'review-addressed' : 'pr-opened';
      const summary = status === 'review-addressed' ? `Addressed the review feedback in ${pr.url}.` : `Fix up at ${pr.url}.`;
      await postStatusComment(github, { repo: job.repo, number: job.issueNumber, status, summary, ...statusLabelInput(config, status), dryRun });
    } else if (input.mode === 'fix') {
      // No diff means findings-only. Mark the issue triaged so the bot's own comment bumping
      // updatedAt does not auto-dispatch the same no-op job forever.
      await applyStatusLabels(github, { repo: job.repo, number: job.issueNumber, ...statusLabelInput(config, 'triaged'), dryRun });
    }
    return [`Agent finished: ${run.command}`, run.stdout.trim(), pr ? `PR: ${pr.url}` : 'No diff to publish', `Workspace: ${workspace.workspace}`].filter(Boolean).join('\n') + '\n';
  } finally {
    await releaseJobLock(lock);
  }
}

// Enforces the label contract shape: at most one priority, one type, three area labels.
function sanitizeIssueLabels(raw: unknown): string[] {
  const typeLabels = ['bug', 'enhancement', 'documentation', 'question'];
  const sanitized = Array.from(new Set((Array.isArray(raw) ? raw : [])
    .filter((label): label is string => typeof label === 'string')
    .map((label) => label.trim().toLowerCase())
    .filter((label) => /^[a-z0-9][a-z0-9:-]{0,29}$/.test(label))));
  const priority = sanitized.find((label) => /^p[0-3]$/.test(label));
  const type = sanitized.find((label) => typeLabels.includes(label));
  const areas = sanitized.filter((label) => !/^p[0-3]$/.test(label) && !typeLabels.includes(label)).slice(0, 3);
  return [priority, type, ...areas].filter((label): label is string => label !== undefined);
}

// Quick labeling-only agent call at dispatch time; labels land alongside the opener comment.
// Best-effort: any failure returns a note and the main job proceeds unlabeled.
// Existing repo labels, so the labeler reuses them instead of inventing near-duplicates
// (e.g. adding "documentation" when the repo already has "docs"). Best-effort.
async function listRepoLabels(repo: string, cwd: string): Promise<string[]> {
  const result = await execFile('gh', ['label', 'list', '--repo', repo, '--limit', '100', '--json', 'name', '--jq', '.[].name'], { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function quickLabelIssue(github: GitHubClient, agent: { command: string; args: string[]; timeoutSeconds: number }, workspace: string, repo: string, number: number, issue: IssueContext, onSpawn: (pid: number) => Promise<void>): Promise<{ note: string; opener?: string }> {
  const promptFile = path.join(workspace, '.fixbot', 'label-prompt.md');
  const existing = await listRepoLabels(repo, workspace);
  const prompt = [
    'You are a maintainer bot triaging a newly opened GitHub issue. Respond with ONLY a JSON object, no prose, shaped:',
    '{ "labels": ["bug", "p1"], "opener": "one short sentence" }',
    'Label rules: include exactly one priority label from p0 (critical) / p1 (high) / p2 (normal) / p3 (low); include one type label (bug, enhancement, documentation, question); optionally add up to 3 short lowercase area labels (e.g. cli, auth, ci). Lowercase, max 30 chars each.',
    existing.length > 0
      ? `Existing repo labels: ${existing.join(', ')}. Reuse an existing label whenever one fits the meaning (never create a near-duplicate like "documentation" next to "docs"); invent a new area label only when nothing existing matches.`
      : '',
    'Opener rules: one casual first-person sentence, posted as the first comment on the issue, saying you are picking this up and will follow up (with a PR if the change pans out). Vary the wording naturally — never a template phrase. Reference the specific issue topic. Write it in the language the issue is written in. No emojis, no sign-off.',
    '',
    `# Issue: ${issue.title}`,
    '',
    issue.body
  ].join('\n');
  try {
    await writeText(promptFile, prompt);
    // ponytail: reuse the configured agent with a tight cap; labeling should take seconds, not the fix budget
    const runner = new CommandAgentRunner({ ...agent, timeoutSeconds: Math.min(agent.timeoutSeconds, 300) });
    const run = await runner.run({ cwd: workspace, promptFile, onSpawn });
    if (run.exitCode !== 0) return { note: `quick-label agent failed: ${(run.stderr || run.stdout).slice(0, 200)}` };
    const json = run.stdout.match(/\{[\s\S]*?"labels"[\s\S]*?\}/g)?.at(-1);
    if (!json) return { note: 'quick-label: no labels JSON in agent output; skipping.' };
    const parsed = JSON.parse(json) as { labels?: unknown; opener?: unknown };
    const rawOpener = typeof parsed.opener === 'string' ? parsed.opener.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    const opener = rawOpener.length > 0 ? { opener: rawOpener } : {};
    const labels = sanitizeIssueLabels(parsed.labels);
    if (labels.length === 0) return { note: 'quick-label: no valid labels; skipping.', ...opener };
    await github.addLabels(repo, number, labels);
    return { note: `Labeled ${repo}#${number}: ${labels.join(', ')}`, ...opener };
  } catch (error) {
    return { note: `quick-label failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Reads agent-written .fixbot/labels.json and applies sanitized labels to the issue.
async function applyAgentLabels(github: GitHubClient, workspace: string, repo: string, number: number, dryRun: boolean): Promise<string | undefined> {
  const file = path.join(workspace, '.fixbot', 'labels.json');
  if (!(await pathExists(file))) return 'Agent wrote no labels.json; skipping labels.';
  let raw: { labels?: unknown };
  try {
    raw = await readJson<{ labels?: unknown }>(file);
  } catch {
    return 'labels.json is not valid JSON; skipping labels.';
  }
  const labels = sanitizeIssueLabels(raw.labels);
  if (labels.length === 0) return 'labels.json had no valid labels; skipping.';
  if (dryRun) return `Would label ${repo}#${number}: ${labels.join(', ')}`;
  await github.addLabels(repo, number, labels);
  return `Labeled ${repo}#${number}: ${labels.join(', ')}`;
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
