import { execFile } from '../../shared/exec.js';

export async function runDoctor(cwd: string): Promise<string> {
  const checks = [
    ['node', ['--version']],
    ['pnpm', ['--version']],
    ['git', ['--version']],
    ['gh', ['--version']]
  ] as const;
  const lines: string[] = [];
  for (const [cmd, args] of checks) {
    const result = await execFile(cmd, [...args], { cwd, timeoutSeconds: 10 });
    const firstLine = (result.stdout || result.stderr).split('\n')[0] ?? '';
    lines.push(`${cmd}: ${result.exitCode === 0 ? 'ok' : 'missing'} ${firstLine}`.trim());
  }
  return lines.join('\n') + '\n';
}
