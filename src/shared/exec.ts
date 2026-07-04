import { spawn } from 'node:child_process';
import type { ShellResult } from './types.js';

export type ExecOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  stdin?: string;
};

export async function execFile(command: string, args: string[], options: ExecOptions): Promise<ShellResult> {
  const rendered = [command, ...args].join(' ');
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = options.timeoutSeconds
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGTERM');
          resolve({ command: rendered, cwd: options.cwd, exitCode: 124, stdout, stderr: stderr + '\nTimed out' });
        }, options.timeoutSeconds * 1000)
      : undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ command: rendered, cwd: options.cwd, exitCode: 127, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ command: rendered, cwd: options.cwd, exitCode: code ?? 1, stdout, stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export function stripMutationSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) clean[key] = '';
  return clean;
}
