import path from 'node:path';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { execFile, stripMutationSecrets } from '../../shared/exec.js';
import { debugLog } from '../../shared/debug.js';
import { FixbotError } from '../../shared/errors.js';
import type { AgentConfig } from '../config/config.js';
import type { AgentRunner, AgentRunInput, AgentRunResult } from './agentRunner.js';

// Resolves the final agent argv. The model, when configured, is delivered in
// the syntax the chosen agent understands: through a `{model}` placeholder in
// `args`, or by appending `modelArgs` (default `--model {model}`, matching
// `omp`/`pi`). Miswired configs fail here instead of leaking `{model}`
// literals into — or silently dropping the model from — the agent command.
export function buildAgentArgs(config: AgentConfig, promptFile: string): string[] {
  const { model } = config;
  const inlineModel = config.args.some((arg) => arg.includes('{model}'));
  if (model === undefined) {
    if (inlineModel) throw new FixbotError('agent.args references {model} but agent.model is not set', 'AGENT_MODEL_CONFIG');
    return config.args.map((arg) => arg.replaceAll('{prompt}', promptFile));
  }
  const args = inlineModel ? config.args : [...config.args, ...config.modelArgs];
  if (!inlineModel && !config.modelArgs.some((arg) => arg.includes('{model}'))) {
    throw new FixbotError('agent.model is set but neither agent.args nor agent.modelArgs references {model}', 'AGENT_MODEL_CONFIG');
  }
  return args.map((arg) => arg.replaceAll('{prompt}', promptFile).replaceAll('{model}', model));
}

type RunLog = { write: (text: string) => void; end: (text: string) => void };

// ponytail: best-effort log; any disk/permission error (sync or async) silences logging, never the agent run
function openRunLog(cwd: string): RunLog | undefined {
  let stream: WriteStream;
  try {
    const dir = path.join(cwd, '.fixbot', 'agent-logs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `run-${new Date().toISOString().replaceAll(':', '-')}.log`);
    debugLog(`agent log: ${file}`);
    stream = createWriteStream(file, { flags: 'a' });
  } catch (error) {
    debugLog(`agent log unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  let usable = true;
  stream.on('error', (error) => {
    if (usable) debugLog(`agent log write failed: ${error.message}`);
    usable = false;
  });
  stream.on('close', () => { usable = false; });
  return {
    write: (text) => { if (usable) stream.write(text); },
    end: (text) => { if (usable) stream.end(text); usable = false; }
  };
}

export class CommandAgentRunner implements AgentRunner {
  constructor(private readonly config: AgentConfig) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const args = buildAgentArgs(this.config, input.promptFile);
    const log = openRunLog(input.cwd);
    log?.write(`# ${[this.config.command, ...args].join(' ')}\n# started ${new Date().toISOString()}\n\n`);
    const result = await execFile(this.config.command, args, {
      cwd: input.cwd,
      env: stripMutationSecrets(process.env),
      timeoutSeconds: this.config.timeoutSeconds,
      onSpawn: input.onSpawn,
      // raw output as it arrives; stderr chunks tagged so the two streams stay tellable apart
      onOutput: (chunk, stream) => log?.write(stream === 'stderr' ? `[stderr] ${chunk}` : chunk)
    });
    log?.end(`\n# exit ${result.exitCode} at ${new Date().toISOString()}\n`);
    return { exitCode: result.exitCode, command: result.command, stdout: result.stdout, stderr: result.stderr };
  }
}
