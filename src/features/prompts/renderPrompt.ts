import type { RepairJob } from '../jobs/job.js';
import type { ProjectProfile } from '../reproduction/projectProfiler.js';
import { externalReproPolicy } from './externalPolicy.js';

function commentsBlock(comments: string[]): string {
  if (comments.length === 0) return '_No comments._';
  return comments.map((comment, index) => `## Comment ${index + 1}\n\n${comment}`).join('\n\n');
}

function profileBlock(profile: ProjectProfile | undefined): string {
  if (!profile) return 'No project profile available.';
  const tests = profile.testCommands.length > 0 ? profile.testCommands.map((command) => `- ${command}`).join('\n') : '- none detected';
  const builds = profile.buildCommands.length > 0 ? profile.buildCommands.map((command) => `- ${command}`).join('\n') : '- none detected';
  return [
    `Kind: ${profile.kind}`,
    profile.packageManager ? `Package manager: ${profile.packageManager}` : undefined,
    '',
    'Test commands:',
    tests,
    '',
    'Build/typecheck commands:',
    builds,
    '',
    'Notes:',
    ...profile.notes.map((note) => `- ${note}`)
  ].filter((line) => line !== undefined).join('\n');
}

function reproductionContract(job: RepairJob): string {
  if (job.mode !== 'reproduce') return 'Write .fixbot/result.md with these headings:';
  return [
    'Phase 1 is reproduction-only. Do not fix source code yet.',
    'Only add or edit tests, specs, fixtures, or files under .fixbot/.',
    'Write .fixbot/reproduction.json with this JSON shape:',
    '',
    '{',
    '  \"status\": \"ready\",',
    '  \"summary\": \"what fails and why this proves the issue\",',
    '  \"commands\": [',
    '    { \"command\": \"pnpm\", \"args\": [\"run\", \"test\", \"path/to/test\"], \"expect\": \"fail\", \"description\": \"new failing regression\" }',
    '  ]',
    '}',
    '',
    'Use status \"needs-info\", \"no-repro\", or \"blocked\" when a deterministic local reproduction is not possible.'
  ].join('\n');
}

function resultHeadings(job: RepairJob): string[] {
  return job.mode === 'reproduce'
    ? ['## Summary', '## Reproduction Attempt', '## Commands', '## Limitations']
    : ['## Summary', '## Repro', '## Cause', '## Fix', '## Verification', '## Limitations', '## PR Body'];
}

export function renderRepairPrompt(job: RepairJob, profile?: ProjectProfile): string {
  const mission = job.mode === 'reproduce'
    ? 'Create a deterministic failing reproduction for the issue without fixing product/source code.'
    : 'Fix the issue in this local checkout. Produce a narrow, human-reviewable patch.';
  return [
    '# Agent Fix Job',
    '',
    `Repository: ${job.repo}`,
    `Issue: #${job.issueNumber}`,
    `Mode: ${job.mode}`,
    `Base: ${job.base}`,
    `Branch: ${job.branch}`,
    '',
    '# Mission',
    '',
    mission,
    '',
    '# Rules',
    '',
    '- Do not push, comment, label, close, or merge. GitHub mutation is handled by the wrapper.',
    '- Reproduce before fixing when feasible.',
    '- Add or update a regression test.',
    '- Keep the code under suspicion real; mock only external systems.',
    '- Follow DRY, SRP, and KISS. Do not broaden scope.',
    '- Run the narrowest relevant test first, then the adjacent suite when practical.',
    '- If complete verification is blocked, state exactly what is missing.',
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
    '# Required Output Artifact',
    '',
    reproductionContract(job),
    '',
    ...resultHeadings(job)
  ].join('\n') + '\n';
}
