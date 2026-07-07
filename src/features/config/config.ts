export type AgentConfig = {
  command: string;
  args: string[];
  // Optional model handed to the agent CLI. Delivered either through a
  // `{model}` placeholder in `args`, or by appending `modelArgs` when no
  // placeholder is present.
  model?: string;
  // How the chosen agent receives the model — must match that CLI's flag
  // syntax. `{model}` is replaced with `model`. Default matches `omp`/`pi`.
  modelArgs: string[];
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
  // "Name <email>" entries appended as Co-authored-by trailers on published commits.
  coAuthors: string[];
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
    args: ['-p', '@{prompt}'],
    modelArgs: ['--model', '{model}'],
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
    authorEmail: 'fixbot@users.noreply.github.com',
    coAuthors: []
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
    // No `started` label: the opener comment already says the bot is on it.
    // The remaining labels are terminal states and double as autoDispatch skip guards.
    statusLabels: {
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
