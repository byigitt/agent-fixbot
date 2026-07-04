import path from 'node:path';
import { changedOrUntrackedFiles } from '../../shared/git.js';
import { execFile } from '../../shared/exec.js';
import { pathExists, readJson, writeJson } from '../../shared/fs.js';
import { resolveInside } from '../../shared/paths.js';
import type { ShellResult } from '../../shared/types.js';
import type { ProjectProfile } from './projectProfiler.js';

export type ReproductionExpectation = 'fail' | 'pass';

export type ReproductionCommand = {
  command: string;
  args: string[];
  expect: ReproductionExpectation;
  description?: string;
  cwd?: string;
  timeoutSeconds?: number;
};

export type ReproductionPlan = {
  status: 'ready' | 'needs-info' | 'no-repro' | 'blocked';
  summary: string;
  commands: ReproductionCommand[];
};

export type ReproductionCommandResult = {
  command: ReproductionCommand;
  result: ShellResult;
  matchedExpectation: boolean;
};

export type ReproductionReport = {
  status: 'reproduced' | 'not-reproduced' | 'needs-info' | 'blocked' | 'plan-missing' | 'no-repro';
  summary: string;
  changedFiles: string[];
  commandResults: ReproductionCommandResult[];
  reasons: string[];
};

const REPRO_PLAN_PATH = path.join('.fixbot', 'reproduction.json');

export async function runReproductionPlan(workspace: string, profile: ProjectProfile): Promise<ReproductionReport> {
  const changed = await changedOrUntrackedFiles(workspace);
  const unsafeFiles = changed.filter((file) => !isReproOnlyPath(file));
  if (unsafeFiles.length > 0) {
    return {
      status: 'blocked',
      summary: 'Reproduction phase changed non-test files before proving the bug.',
      changedFiles: changed,
      commandResults: [],
      reasons: unsafeFiles.map((file) => `Non-repro-only file changed: ${file}`)
    };
  }

  const planFile = path.join(workspace, REPRO_PLAN_PATH);
  if (!(await pathExists(planFile))) {
    return {
      status: 'plan-missing',
      summary: `Missing ${REPRO_PLAN_PATH}.`,
      changedFiles: changed,
      commandResults: [],
      reasons: [`Agent must write ${REPRO_PLAN_PATH} before reproduction can be verified.`]
    };
  }

  const plan = await readJson<ReproductionPlan>(planFile);
  if (plan.status !== 'ready') {
    return { status: plan.status, summary: plan.summary, changedFiles: changed, commandResults: [], reasons: [plan.summary] };
  }

  const commandResults: ReproductionCommandResult[] = [];
  const reasons: string[] = [];
  for (const command of plan.commands) {
    if (!isAllowedExecutable(command.command, profile)) {
      reasons.push(`Command executable is not allowed by project profile: ${command.command}`);
      continue;
    }
    let commandCwd: string;
    try {
      commandCwd = command.cwd ? resolveInside(workspace, command.cwd) : workspace;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`Command cwd is outside the workspace: ${message}`);
      continue;
    }
    if (command.cwd && !(await pathExists(commandCwd))) {
      reasons.push(`Command cwd does not exist: ${command.cwd}`);
      continue;
    }
    const result = await execFile(command.command, command.args, {
      cwd: commandCwd,
      timeoutSeconds: boundedTimeout(command.timeoutSeconds)
    });
    commandResults.push({ command, result, matchedExpectation: matchesExpectation(command.expect, result.exitCode) });
    if (result.exitCode === 124 || result.exitCode === 127) {
      reasons.push(`Command infrastructure failure (${result.exitCode}) for ${command.command}: ${result.stderr || result.stdout}`);
    }
  }

  if (reasons.length > 0) {
    return { status: 'blocked', summary: 'Reproduction plan could not be safely executed.', changedFiles: changed, commandResults, reasons };
  }

  const failedExpectedFailure = commandResults.some((entry) => entry.command.expect === 'fail' && entry.result.exitCode !== 0 && entry.result.exitCode !== 124 && entry.result.exitCode !== 127);
  const allMatched = commandResults.length > 0 && commandResults.every((entry) => entry.matchedExpectation);
  const status = failedExpectedFailure && allMatched ? 'reproduced' : 'not-reproduced';
  return {
    status,
    summary: status === 'reproduced' ? 'A failing reproduction was verified.' : 'The stated reproduction commands did not fail as expected.',
    changedFiles: changed,
    commandResults,
    reasons: status === 'reproduced' ? [] : ['No command with expect="fail" exited non-zero while all expectations matched.']
  };
}

export async function writeReproductionReport(workspace: string, report: ReproductionReport): Promise<string> {
  const file = path.join(workspace, '.fixbot', 'reproduction-report.json');
  await writeJson(file, report);
  return file;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 600;
  return Math.min(600, Math.max(1, Math.trunc(value)));
}

function isReproOnlyPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.startsWith('.fixbot/')) return true;
  if (normalized.includes('/__tests__/') || normalized.includes('/fixtures/')) return true;
  return /(^|\/)(test|tests|spec|e2e)\//.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

function isAllowedExecutable(command: string, profile: ProjectProfile): boolean {
  return profile.allowedExecutables.includes(command);
}

function matchesExpectation(expectation: ReproductionExpectation, exitCode: number): boolean {
  return expectation === 'fail' ? exitCode !== 0 : exitCode === 0;
}
