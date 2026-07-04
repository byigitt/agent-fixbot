export type AgentConfig = {
  command: string;
  args: string[];
  timeoutSeconds: number;
};

export type PolicyConfig = {
  requireHumanReview: boolean;
  allowLiveServices: boolean;
  allowPush: boolean;
  maxChangedFiles: number;
  maxDiffLines: number;
  blockedPaths: string[];
  allowedCommands: string[];
};

export type FixbotConfig = {
  defaultBase: string;
  botName: string;
  workspaceRoot: string;
  agent: AgentConfig;
  policy: PolicyConfig;
};

export const defaultConfig: FixbotConfig = {
  defaultBase: 'main',
  botName: 'fixbot',
  workspaceRoot: '.workspaces',
  agent: {
    command: 'omp',
    args: ['exec', '--prompt-file', '{prompt}'],
    timeoutSeconds: 2700
  },
  policy: {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 20,
    maxDiffLines: 1200,
    blockedPaths: ['.github/workflows/**', 'scripts/release/**', '**/.env*'],
    allowedCommands: ['pnpm test', 'pnpm typecheck', 'pnpm build', 'bun test', 'npm test']
  }
};
