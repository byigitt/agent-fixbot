import path from 'node:path';
import { execFile } from '../../shared/exec.js';
import { pathExists, readJson } from '../../shared/fs.js';
import type { ShellResult } from '../../shared/types.js';
import type { PolicyConfig } from '../config/config.js';

export type PrepublishCommand = {
  command: string;
  args?: string[];
  description?: string;
  timeoutSeconds?: number;
};

export type CommandGateEntry = PrepublishCommand & {
  args: string[];
  rendered: string;
  allowed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export type CommandGateReport = {
  ok: boolean;
  commands: CommandGateEntry[];
  reasons: string[];
};

export type CommandGateExec = (command: string, args: string[], options: { cwd: string; timeoutSeconds?: number }) => Promise<ShellResult>;

type PrepublishPlan = { commands?: PrepublishCommand[] };


export async function evaluateCommandGate(cwd: string, policy: PolicyConfig, execFn: CommandGateExec = execFile): Promise<CommandGateReport> {
  const planFile = path.join(cwd, '.fixbot', 'prepublish.json');
  if (!(await pathExists(planFile))) return { ok: true, commands: [], reasons: [] };
  const plan = await readJson<PrepublishPlan>(planFile);
  const entries: CommandGateEntry[] = [];
  const reasons: string[] = [];
  for (const command of plan.commands ?? []) {
    const args = command.args ?? [];
    const rendered = [command.command, ...args].join(' ');
    const allowed = policy.allowedCommands.includes(rendered);
    const entry: CommandGateEntry = { ...command, args, rendered, allowed };
    if (!allowed) {
      reasons.push(`Prepublish command not allowed: ${rendered}`);
      entries.push(entry);
      continue;
    }
    const result = await execFn(command.command, args, { cwd, timeoutSeconds: command.timeoutSeconds ?? 600 });
    entry.exitCode = result.exitCode;
    entry.stdout = result.stdout;
    entry.stderr = result.stderr;
    if (result.exitCode !== 0) reasons.push(`Prepublish command failed: ${rendered}`);
    entries.push(entry);
  }
  return { ok: reasons.length === 0, commands: entries, reasons };
}
