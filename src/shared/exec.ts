import { spawn } from 'node:child_process';
import { debugLog } from './debug.js';
import type { ShellResult } from './types.js';

export type ExecOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  stdin?: string;
  onSpawn?: ((pid: number) => void | Promise<void>) | undefined;
  onOutput?: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
};

// ponytail: flags whose next arg is a free-text payload we never want in logs
const PAYLOAD_FLAGS = new Set(['--body', '--body-file', '--title', '-b', '-t']);
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
// ponytail: gh api field keys carrying payloads or queries
const PAYLOAD_FIELD_KEYS = /^(body|query|title|description)=/;

export function renderSafeArgs(command: string, args: string[]): string {
  const parts = args.map((arg, index) => {
    if (PAYLOAD_FLAGS.has(args[index - 1] ?? '')) return '[redacted]';
    if (FIELD_FLAGS.has(args[index - 1] ?? '') && PAYLOAD_FIELD_KEYS.test(arg)) {
      return `${arg.slice(0, arg.indexOf('='))}=[redacted]`;
    }
    // inline variants: --body=..., --title=..., --field body=..., as --flag=key=value collapses into one arg
    const inline = /^(--body|--title|--field|--raw-field|-f|-F)=(.*)$/.exec(arg);
    if (inline) {
      const [, flag, value] = inline;
      if (flag === '--body' || flag === '--title') return `${flag}=[redacted]`;
      if (value !== undefined && PAYLOAD_FIELD_KEYS.test(value)) return `${flag}=${value.slice(0, value.indexOf('='))}=[redacted]`;
    }
    const truncated = arg.length > 120 ? `${arg.slice(0, 120)}…` : arg;
    return truncated
      .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]+/g, '[redacted]')
      .replace(/\/\/[^\/\s]*@/g, '//[redacted]@');
  });
  return [command, ...parts].join(' ');
}

export async function execFile(command: string, args: string[], options: ExecOptions): Promise<ShellResult> {
  const rendered = [command, ...args].join(' ');
  const safeRendered = renderSafeArgs(command, args);
  debugLog(`exec: ${safeRendered} (${args.length} args)`);
  const startedAt = Date.now();
  return await new Promise<ShellResult>((resolve) => {
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
          child.kill('SIGTERM');
          settle({ command: rendered, cwd: options.cwd, exitCode: 124, stdout, stderr: stderr + '\nTimed out' });
        }, options.timeoutSeconds * 1000)
      : undefined;
    const settle = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      debugLog(`exec done (exit ${result.exitCode}, ${Date.now() - startedAt}ms): ${safeRendered}`);
      // ponytail: default logs stderr size only; FIXBOT_DEBUG=2 opts into redacted content
      if (result.exitCode !== 0 && result.stderr) {
        if (process.env.FIXBOT_DEBUG === '2') {
          const redacted = result.stderr.trim().slice(0, 500)
            .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]+/g, '[redacted]')
            .replace(/\/\/[^\/\s]*@/g, '//[redacted]@');
          debugLog(`exec stderr: ${redacted}`);
        } else {
          debugLog(`exec stderr: ${Buffer.byteLength(result.stderr)} bytes (set FIXBOT_DEBUG=2 to print)`);
        }
      }
      resolve(result);
    };

    if (child.pid !== undefined) {
      Promise.resolve(options.onSpawn?.(child.pid)).catch((error: unknown) => {
        child.kill('SIGTERM');
        settle({ command: rendered, cwd: options.cwd, exitCode: 127, stdout, stderr: stderr + (error instanceof Error ? error.message : String(error)) });
      });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; options.onOutput?.(chunk, 'stdout'); });
    child.stderr.on('data', (chunk) => { stderr += chunk; options.onOutput?.(chunk, 'stderr'); });
    child.on('error', (error) => {
      settle({ command: rendered, cwd: options.cwd, exitCode: 127, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code) => {
      settle({ command: rendered, cwd: options.cwd, exitCode: code ?? 1, stdout, stderr });
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
