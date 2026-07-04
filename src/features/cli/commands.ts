import { loadConfig } from '../config/loadConfig.js';
import { parseIssueRef } from '../github/ref.js';
import { GhCliClient } from '../github/ghClient.js';
import { FixtureGitHubClient } from '../github/fixtureClient.js';
import { createRepairJob, type RepairMode } from '../jobs/job.js';
import { writeJobFiles } from '../jobs/jobStore.js';
import { renderRepairPrompt } from '../prompts/renderPrompt.js';
import { NoopAgentRunner } from '../agents/noopAgentRunner.js';
import { CommandAgentRunner } from '../agents/commandAgentRunner.js';
import { publishRepair } from '../publisher/publisher.js';
import { prepareWorkspace } from '../workspaces/workspaceService.js';
import { profileProject } from '../reproduction/projectProfiler.js';
import { runReproductionPlan, writeReproductionReport } from '../reproduction/reproductionRunner.js';
import { readJson } from '../../shared/fs.js';
import { routeComment, type CommentEvent } from '../controller/commentRouter.js';
import { runDoctor } from './doctor.js';
import { flagBool, flagString, type ParsedArgs } from './args.js';
import { helpText } from './help.js';

export async function runCommand(parsed: ParsedArgs, cwd: string): Promise<string> {
  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') return helpText;
  if (parsed.command === 'doctor') return runDoctor(cwd);
  if (parsed.command === 'route-comment') return routeCommentFile(parsed);
  if (parsed.command === 'prepare' || parsed.command === 'fix' || parsed.command === 'reproduce') {
    const mode = parsed.command === 'prepare' ? 'prepare' : parsed.command === 'reproduce' ? 'reproduce' : 'fix';
    return runFixLike(parsed, cwd, mode);
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

async function runFixLike(parsed: ParsedArgs, cwd: string, mode: RepairMode): Promise<string> {
  const ref = parsed.positional[0];
  if (!ref) throw new Error(`Missing issue ref.

${helpText}`);
  const dryRun = flagBool(parsed.flags, 'dry-run');
  const parsedRef = parseIssueRef(ref);
  const config = await loadConfig(cwd);
  const github = dryRun ? new FixtureGitHubClient() : new GhCliClient(cwd);
  const issue = await github.getIssueContext(parsedRef.repo, parsedRef.number);
  const base = flagString(parsed.flags, 'base');
  const job = createRepairJob(base ? { issue, config, mode, base } : { issue, config, mode });
  const workspace = await prepareWorkspace(cwd, config.workspaceRoot, job.repo, job.base, dryRun);
  const profile = await profileProject(workspace.workspace);
  const prompt = renderRepairPrompt(job, profile);
  const files = await writeJobFiles(workspace.workspace, job, prompt);
  if (mode === 'prepare') return [`Prepared job ${job.id}`, `Workspace: ${workspace.workspace}`, `Job: ${files.jobFile}`, `Prompt: ${files.promptFile}`].join('\n') + '\n';
  const runner = dryRun ? new NoopAgentRunner() : new CommandAgentRunner(config.agent);
  const run = await runner.run({ cwd: workspace.workspace, promptFile: files.promptFile });
  if (run.exitCode !== 0) return [`Agent failed: ${run.command}`, run.stderr || run.stdout].join('\n') + '\n';
  if (mode === 'reproduce') {
    const report = await runReproductionPlan(workspace.workspace, profile);
    const reportFile = await writeReproductionReport(workspace.workspace, report);
    return [
      `Reproduction status: ${report.status}`,
      report.summary,
      `Report: ${reportFile}`,
      `Workspace: ${workspace.workspace}`,
      ...report.reasons.map((reason) => `Reason: ${reason}`)
    ].join('\n') + '\n';
  }
  const pr = await publishRepair(workspace.workspace, job, github, { dryRun });
  return [`Agent finished: ${run.command}`, run.stdout.trim(), pr ? `PR: ${pr.url}` : 'No diff to publish', `Workspace: ${workspace.workspace}`].filter(Boolean).join('\n') + '\n';
}
