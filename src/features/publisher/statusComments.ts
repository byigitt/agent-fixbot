import type { GitHubClient } from '../github/githubClient.js';

export type StatusCommentStatus = 'started' | 'blocked' | 'no-repro' | 'reproduced' | 'pr-opened' | 'review-addressed' | 'triaged' | 'reviewed';

export type StatusCommentInput = {
  repo: string;
  number: number;
  status: StatusCommentStatus;
  summary: string;
  details?: string[];
  label?: string;
  removeLabels?: string[];
  dryRun: boolean;
};

const labels: Record<StatusCommentStatus, string> = {
  started: 'Started',
  blocked: 'Blocked',
  'no-repro': 'No reproduction',
  reproduced: 'Reproduced',
  'pr-opened': 'PR opened',
  'review-addressed': 'Review addressed',
  triaged: 'Triaged',
  reviewed: 'Reviewed'
};

export function statusMarker(status: StatusCommentStatus): string {
  return `<!-- agent-fixbot:status:${status} -->`;
}

export async function postStatusComment(github: GitHubClient, input: StatusCommentInput): Promise<string> {
  const marker = statusMarker(input.status);
  const detailLines = input.details?.length ? ['', 'Details:', ...input.details.map((detail) => `- ${detail}`)] : [];
  const body = [marker, `**FixBot ${labels[input.status]}**`, '', input.summary, ...detailLines].join('\n').trimEnd() + '\n';
  if (!input.dryRun) {
    await github.upsertIssueComment(input.repo, input.number, marker, body);
    for (const label of input.removeLabels ?? []) {
      if (label !== input.label) await github.removeLabel(input.repo, input.number, label);
    }
    if (input.label) await github.addLabels(input.repo, input.number, [input.label]);
  }
  return body;
}
