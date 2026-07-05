export type AgentConfig = {
  command: string;
  args: string[];
  timeoutSeconds: number;
};

export type AutoLabelRule = {
  label: string;
  keywords: string[];
};

export type AutoLabelConfig = {
  enabled: boolean;
  defaultLabels: string[];
  rules: AutoLabelRule[];
};

export type AutoDispatchMode = 'triage' | 'reproduce' | 'fix';

export type AutoDispatchConfig = {
  enabled: boolean;
  mode: AutoDispatchMode;
  maxPerPoll: number;
  skipWhenLabels: string[];
  requireLabels: string[];
};

export type GitConfig = {
  authorName: string;
  authorEmail: string;
};

export type PolicyConfig = {
  requireHumanReview: boolean;
  allowLiveServices: boolean;
  allowPush: boolean;
  maxChangedFiles: number;
  maxDiffLines: number;
  blockedPaths: string[];
  allowedCommands: string[];
  requireTestEvidence: boolean;
  requireChangelog: boolean;
  requireLiveServiceEvidence: boolean;
  statusLabels: Partial<Record<string, string>>;
};

export type FixbotConfig = {
  defaultBase: string;
  botName: string;
  workspaceRoot: string;
  agent: AgentConfig;
  autoLabel: AutoLabelConfig;
  autoDispatch: AutoDispatchConfig;
  git: GitConfig;
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
  autoLabel: {
    enabled: true,
    defaultLabels: [],
    rules: [
      { label: 'bug', keywords: ['bug', 'crash', 'error', 'exception', 'regression', 'broken', 'fail'] },
      { label: 'documentation', keywords: ['docs', 'documentation', 'readme'] },
      { label: 'enhancement', keywords: ['feature', 'enhancement', 'improve', 'request'] },
      { label: 'question', keywords: ['question', 'how do i', 'how to', 'help'] }
    ]
  },
  autoDispatch: {
    enabled: false,
    mode: 'triage',
    maxPerPoll: 1,
    skipWhenLabels: ['triaged'],
    requireLabels: []
  },
  git: {
    authorName: 'fixbot',
    authorEmail: 'fixbot@users.noreply.github.com'
  },
  policy: {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 20,
    maxDiffLines: 1200,
    blockedPaths: ['.github/workflows/**', 'scripts/release/**', '**/.env*'],
    allowedCommands: ['pnpm test', 'pnpm typecheck', 'pnpm build', 'bun test', 'npm test'],
    requireTestEvidence: false,
    requireChangelog: false,
    requireLiveServiceEvidence: false,
    statusLabels: {
      started: 'fixbot:running',
      blocked: 'fixbot:blocked',
      reproduced: 'fixbot:reproduced',
      'no-repro': 'fixbot:no-repro',
      'pr-opened': 'fixbot:pr-opened',
      'review-addressed': 'fixbot:review-addressed',
      triaged: 'triaged',
      reviewed: 'reviewed'
    }
  }
};
