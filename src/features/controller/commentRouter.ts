import type { IssueRef } from '../github/ref.js';

export type RoutedCommand = {
  command: 'fix' | 'fix-ci' | 'address-review' | 'triage' | 'review' | 'stop';
  ref: IssueRef;
  actor: string;
} | undefined;

export type CommentEvent = {
  action?: string;
  comment?: { body?: string; user?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  repository?: { full_name?: string; default_branch?: string };
};

function escapeRegex(value: string): string {
  return value.replace(/[.+*^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(botName: string): string {
  return `(^|[^a-z0-9_-])@${escapeRegex(botName.toLowerCase())}(?![a-z0-9_-])`;
}

// True when the body mentions the bot as a whole word (`@fixbot`, not `@fixbotter`).
export function mentionsBot(body: string, botName = 'fixbot'): boolean {
  return new RegExp(mentionPattern(botName)).test(body.toLowerCase());
}

export function routeComment(event: CommentEvent, botName = 'fixbot'): RoutedCommand {
  const body = event.comment?.body ?? '';
  const repo = event.repository?.full_name;
  const number = event.issue?.number;
  const actor = event.comment?.user?.login ?? 'unknown';
  if (!repo || !number) return undefined;
  const normalized = body.toLowerCase();
  if (!mentionsBot(body, botName)) return undefined;
  const instruction = normalized.replace(new RegExp(mentionPattern(botName), 'g'), ' ');
  if (/\bfix\s+ci\b/.test(instruction)) return { command: 'fix-ci', ref: { repo, number }, actor };
  if (/\baddress\s+review\b/.test(instruction) || /\bresolve\s+codex\s+reviews?\b/.test(instruction)) return { command: 'address-review', ref: { repo, number }, actor };
  if (/\bstop\b/.test(instruction)) return { command: 'stop', ref: { repo, number }, actor };
  if (/\breview\b/.test(instruction)) return { command: 'review', ref: { repo, number }, actor };
  if (/\btriage\b/.test(instruction)) return { command: 'triage', ref: { repo, number }, actor };
  if (/\bfix\b/.test(instruction)) return { command: 'fix', ref: { repo, number }, actor };
  return undefined;
}
