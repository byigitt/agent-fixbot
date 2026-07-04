import { FixbotError } from '../../shared/errors.js';

export type IssueRef = { repo: string; number: number };

export function parseIssueRef(value: string): IssueRef {
  const normalized = value.trim();
  const urlMatch = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  if (urlMatch?.[1] && urlMatch[2]) return { repo: urlMatch[1], number: Number(urlMatch[2]) };
  const shorthand = normalized.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (shorthand?.[1] && shorthand[2]) return { repo: shorthand[1], number: Number(shorthand[2]) };
  throw new FixbotError('Expected issue ref like owner/repo#123 or GitHub issue URL', 'BAD_REF');
}
