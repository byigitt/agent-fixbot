export type AgentRunInput = {
  cwd: string;
  promptFile: string;
  onSpawn?: (pid: number) => void | Promise<void>;
};

export type AgentRunResult = {
  exitCode: number;
  command: string;
  stdout: string;
  stderr: string;
};

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
