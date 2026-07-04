import { execFile, stripMutationSecrets } from '../../shared/exec.js';
import type { AgentConfig } from '../config/config.js';
import type { AgentRunner, AgentRunInput, AgentRunResult } from './agentRunner.js';

export class CommandAgentRunner implements AgentRunner {
  constructor(private readonly config: AgentConfig) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const args = this.config.args.map((arg) => arg.replaceAll('{prompt}', input.promptFile));
    const result = await execFile(this.config.command, args, {
      cwd: input.cwd,
      env: stripMutationSecrets(process.env),
      timeoutSeconds: this.config.timeoutSeconds,
      onSpawn: input.onSpawn
    });
    return { exitCode: result.exitCode, command: result.command, stdout: result.stdout, stderr: result.stderr };
  }
}
