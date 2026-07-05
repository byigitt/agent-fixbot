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

export function statusMarker(status: StatusCommentStatus): string {
  return `<!-- agent-fixbot:status:${status} -->`;
}

// Label lifecycle without a comment: used when the real communication is an artifact comment or PR.
export async function applyStatusLabels(github: GitHubClient, input: Pick<StatusCommentInput, 'repo' | 'number' | 'label' | 'removeLabels' | 'dryRun'>): Promise<void> {
  if (input.dryRun) return;
  for (const label of input.removeLabels ?? []) {
    if (label !== input.label) await github.removeLabel(input.repo, input.number, label);
  }
  if (input.label) await github.addLabels(input.repo, input.number, [input.label]);
}

export async function postStatusComment(github: GitHubClient, input: StatusCommentInput): Promise<string> {
  const marker = statusMarker(input.status);
  const detailLines = input.details?.length ? ['', ...input.details.map((detail) => `- ${detail}`)] : [];
  // The marker is invisible on GitHub; the visible body is just natural prose, no bot-speak headers.
  const body = [marker, input.summary, ...detailLines].join('\n').trimEnd() + '\n';
  if (!input.dryRun) {
    await github.upsertIssueComment(input.repo, input.number, marker, body);
    await applyStatusLabels(github, input);
  }
  return body;
}
