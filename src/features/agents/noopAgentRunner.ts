import type { AgentRunner, AgentRunInput, AgentRunResult } from './agentRunner.js';

export class NoopAgentRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return { exitCode: 0, command: 'noop-agent', stdout: `Dry run prepared prompt at ${input.promptFile}
`, stderr: '' };
  }
}
