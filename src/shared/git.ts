import { execFile } from './exec.js';
import type { ShellResult } from './types.js';

export async function git(cwd: string, args: string[]): Promise<ShellResult> {
  return execFile('git', args, { cwd });
}

export async function changedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['diff', '--name-only']);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git diff failed');
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function changedOrUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['status', '--porcelain']);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git status failed');
  return Array.from(new Set(result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((line) => line.includes(' -> ') ? line.split(' -> ').at(-1) ?? line : line)));
}

export async function diffLineCount(cwd: string): Promise<number> {
  const result = await git(cwd, ['diff', '--numstat']);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git diff --numstat failed');
  return result.stdout.split('\n').filter(Boolean).reduce((sum, row) => {
    const [add, del] = row.split(/\s+/);
    const a = add === '-' ? 0 : Number(add ?? 0);
    const d = del === '-' ? 0 : Number(del ?? 0);
    return sum + (Number.isFinite(a) ? a : 0) + (Number.isFinite(d) ? d : 0);
  }, 0);
}
