import type { PullRequestContext } from '../github/githubClient.js';
import type { RepairJob } from '../jobs/job.js';
import type { ProjectProfile } from '../reproduction/projectProfiler.js';
import { externalReproPolicy } from './externalPolicy.js';

function commentsBlock(comments: string[]): string {
  if (comments.length === 0) return '_No comments._';
  return comments.map((comment, index) => `## Comment ${index + 1}\n\n${comment}`).join('\n\n');
}

function listBlock(items: string[], empty = '- none'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function profileBlock(profile: ProjectProfile | undefined): string {
  if (!profile) return 'No project profile available.';
  return [
    `Kind: ${profile.kind}`,
    profile.packageManager ? `Package manager: ${profile.packageManager}` : undefined,
    '',
    'Test commands:',
    listBlock(profile.testCommands),
    '',
    'Build/typecheck commands:',
    listBlock(profile.buildCommands),
    '',
    'Notes:',
    ...profile.notes.map((note) => `- ${note}`)
  ].filter((line) => line !== undefined).join('\n');
}

function isPullRequestContext(value: RepairJob['issue']): value is PullRequestContext {
  return 'diff' in value;
}

function pullRequestBlock(job: RepairJob): string {
  if (!isPullRequestContext(job.issue)) return 'No pull request context available.';
  const pr = job.issue;
  return [
    `Author: ${pr.author ?? 'unknown'}`,
    `Base: ${pr.baseRefName ?? job.base}`,
    `Head: ${pr.headRepository ?? pr.repo}:${pr.headRefName ?? 'unknown'}`,
    '',
    'Changed files:',
    listBlock(pr.changedFiles),
    '',
    'Commits:',
    listBlock(pr.commits),
    '',
    'Checks:',
    pr.checks.length > 0 ? pr.checks.map((check) => `- ${check.name}: ${check.conclusion ?? check.state ?? 'unknown'}${check.detailsUrl ? ` (${check.detailsUrl})` : ''}${check.summary ? `\n  ${check.summary}` : ''}`).join('\n') : '- none',
    '',
    'Reviews:',
    listBlock(pr.reviews),
    '',
    'Inline review comments:',
    listBlock(pr.reviewComments),
    '',
    'Review threads:',
    pr.reviewThreads.length > 0 ? pr.reviewThreads.map((thread) => `- ${thread.id}: ${thread.isResolved ? 'resolved' : 'unresolved'}${thread.path ? ` ${thread.path}${thread.line ? `:${thread.line}` : ''}` : ''}\n${thread.comments.map((comment) => `  - ${comment}`).join('\n')}`).join('\n') : '- none',
    '',
    'Diff:',
    '```diff',
    pr.diff || '(empty diff)',
    '```'
  ].join('\n');
}

function mission(job: RepairJob): string {
  switch (job.mode) {
    case 'reproduce':
      return 'Create a deterministic failing reproduction for the issue without fixing product/source code.';
    case 'triage':
      return 'Triage the issue. Do not edit product/source code. Produce feasibility, tradeoffs, maintainer decisions, and an implementation/test plan.';
    case 'review':
      return 'Review this pull request in read-only mode without editing source code. Find correctness, security, scope, stub/no-op, convention, changelog, and test-coverage issues.';
    case 'address-review':
      return 'Address review feedback on the existing pull request branch. Keep the patch narrow and explain which review finding each change resolves.';
    case 'fix-ci':
      return 'Fix failing CI/checks for this issue or pull request. Use check output and changed files to separate real regressions from unrelated flakes.';
    case 'prepare':
    case 'fix':
      return 'Fix the issue in this local checkout. Produce a narrow, human-reviewable patch.';
  }
}

function outputContract(job: RepairJob): string {
  if (job.mode === 'reproduce') {
    return [
      'Phase 1 is reproduction-only. Do not fix source code yet.',
      'Only add or edit tests, specs, fixtures, or files under .fixbot/.',
      'Write .fixbot/reproduction.json with this JSON shape:',
      '',
      '{',
      '  "status": "ready",',
      '  "summary": "what fails and why this proves the issue",',
      '  "commands": [',
      '    { "command": "pnpm", "args": ["run", "test", "path/to/test"], "expect": "fail", "description": "new failing regression" }',
      '  ]',
      '}',
      '',
      'Use status "needs-info", "no-repro", or "blocked" when a deterministic local reproduction is not possible.'
    ].join('\n');
  }
  if (job.mode === 'triage') return 'Write .fixbot/triage.md with these headings:';
  if (job.mode === 'review') return 'Write .fixbot/review.md with these headings:';
  if (job.mode === 'address-review') {
    return [
      'Write .fixbot/result.md with these headings.',
      'Optional: when you fully address GitHub review threads and are confident they should be resolved, write .fixbot/resolved-review-threads.json with this JSON shape:',
      '{ "threadIds": ["THREAD_NODE_ID"] }'
    ].join('\n');
  }
  return [
    'Write .fixbot/result.md with these headings.',
    'When source behavior changes, also write .fixbot/evidence.json with passing tests, changelog paths when applicable, and live service evidence only when explicitly allowed.'
  ].join('\n');
}

function resultHeadings(job: RepairJob): string[] {
  switch (job.mode) {
    case 'reproduce':
      return ['## Summary', '## Reproduction Attempt', '## Commands', '## Limitations'];
    case 'triage':
      return ['## Summary', '## Feasibility', '## Maintainer Decisions', '## Implementation Plan', '## Test Plan', '## Limitations'];
    case 'review':
      return ['## Summary', '## Blocking Findings', '## P1 Findings', '## P2 Findings', '## P3 Findings', '## Verification Reviewed', '## Limitations'];
    case 'address-review':
      return ['## Summary', '## Review Findings Addressed', '## Changes', '## Verification', '## Limitations', '## PR Body'];
    case 'fix-ci':
      return ['## Summary', '## CI Failure', '## Cause', '## Fix', '## Verification', '## Limitations', '## PR Body'];
    case 'prepare':
    case 'fix':
      return ['## Summary', '## Repro', '## Cause', '## Fix', '## Verification', '## Limitations', '## PR Body'];
  }
}

export function renderRepairPrompt(job: RepairJob, profile?: ProjectProfile): string {
  return [
    '# Agent Fix Job',
    '',
    `Repository: ${job.repo}`,
    `Issue: #${job.issueNumber}`,
    `Mode: ${job.mode}`,
    `Base: ${job.base}`,
    `Branch: ${job.branch}`,
    job.existingPullRequest ? `Existing PR: ${job.existingPullRequest.url}` : undefined,
    '',
    '# Mission',
    '',
    mission(job),
    '',
    '# Rules',
    '',
    '- Do not push, comment, label, close, or merge. GitHub mutation is handled by the wrapper.',
    '- Reproduce before fixing when feasible.',
    '- Add or update a regression test for source changes.',
    '- Keep the code under suspicion real; mock only external systems.',
    '- Follow DRY, SRP, and KISS. Do not broaden scope.',
    '- Reject unrelated scope creep, placeholders, no-op implementations, and undocumented behavior changes.',
    '- Check repo conventions before adding new patterns.',
    '- Run the narrowest relevant test first, then the adjacent suite when practical.',
    '- If complete verification is blocked, state exactly what is missing.',
    `- Live external services allowed: ${job.config.policy.allowLiveServices ? 'yes' : 'no'}.`,
    '',
    externalReproPolicy.trimEnd(),
    '',
    '# Project Profile',
    '',
    profileBlock(profile),
    '',
    '# Issue',
    '',
    `Title: ${job.issue.title}`,
    `URL: ${job.issue.url}`,
    '',
    job.issue.body,
    '',
    '# Comments',
    '',
    commentsBlock(job.issue.comments),
    '',
    '# Pull Request Context',
    '',
    pullRequestBlock(job),
    '',
    '# Required Output Artifact',
    '',
    outputContract(job),
    '',
    ...resultHeadings(job)
  ].filter((line) => line !== undefined).join('\n') + '\n';
}
