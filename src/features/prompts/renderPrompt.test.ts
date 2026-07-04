import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRepairPrompt } from './renderPrompt.js';
import type { ProjectProfile } from '../reproduction/projectProfiler.js';
import { externalReproPolicy } from './externalPolicy.js';
import { defaultConfig } from '../config/config.js';
import type { RepairJob } from '../jobs/job.js';

function makeJob(comments: string[], overrides: Partial<RepairJob> = {}): RepairJob {
  return {
    id: 'acme-widgets-7-1',
    repo: 'acme/widgets',
    issueNumber: 7,
    base: 'release-2.x',
    branch: 'fixbot/issue-7-save-crash',
    mode: 'fix-ci',
    issue: {
      repo: 'acme/widgets',
      number: 7,
      title: 'Crash when saving a draft',
      body: 'Saving a draft throws TypeError in DraftStore.',
      comments,
      labels: [],
      url: 'https://github.com/acme/widgets/issues/7'
    },
    config: defaultConfig,
    createdAt: '2026-07-04T00:00:00.000Z',
    ...overrides
  };
}

test('renderRepairPrompt embeds the external reproduction policy', () => {
  const prompt = renderRepairPrompt(makeJob([]));
  assert.ok(prompt.includes(externalReproPolicy), 'prompt must contain the external reproduction policy block');
});

test('renderRepairPrompt surfaces the job routing facts', () => {
  const prompt = renderRepairPrompt(makeJob([]));
  assert.ok(prompt.includes('Repository: acme/widgets'));
  assert.ok(prompt.includes('Issue: #7'));
  assert.ok(prompt.includes('Mode: fix-ci'));
  assert.ok(prompt.includes('Base: release-2.x'));
  assert.ok(prompt.includes('Branch: fixbot/issue-7-save-crash'));
});

test('renderRepairPrompt includes the issue title, url, and body', () => {
  const prompt = renderRepairPrompt(makeJob([]));
  assert.ok(prompt.includes('Title: Crash when saving a draft'));
  assert.ok(prompt.includes('URL: https://github.com/acme/widgets/issues/7'));
  assert.ok(prompt.includes('Saving a draft throws TypeError in DraftStore.'));
});

test('renderRepairPrompt renders each comment under a numbered heading', () => {
  const prompt = renderRepairPrompt(makeJob(['First observation.', 'Second observation.']));
  assert.ok(prompt.includes('## Comment 1\n\nFirst observation.'));
  assert.ok(prompt.includes('## Comment 2\n\nSecond observation.'));
  assert.ok(!prompt.includes('_No comments._'));
});

test('renderRepairPrompt renders a placeholder when there are no comments', () => {
  const prompt = renderRepairPrompt(makeJob([]));
  assert.ok(prompt.includes('_No comments._'));
  assert.ok(!prompt.includes('## Comment 1'));
});

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    kind: 'node',
    packageManager: 'pnpm',
    testCommands: ['pnpm run test'],
    buildCommands: ['pnpm run typecheck'],
    allowedExecutables: ['pnpm', 'node'],
    notes: ['Detected Node project using pnpm.'],
    ...overrides
  };
}

test('renderRepairPrompt in reproduce mode demands the reproduction plan artifact', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'reproduce' }));
  assert.ok(prompt.includes('Mode: reproduce'));
  assert.ok(prompt.includes('Create a deterministic failing reproduction'));
  assert.ok(prompt.includes('.fixbot/reproduction.json'), 'agent must be told where to persist the plan');
  assert.ok(prompt.includes('"expect": "fail"'), 'plan shape must show the failing-command expectation');
  assert.ok(prompt.includes('## Reproduction Attempt'));
  assert.ok(!prompt.includes('.fixbot/result.md'), 'reproduce mode must not ask for the fix result artifact');
  assert.ok(!prompt.includes('## PR Body'), 'reproduce mode must not ask for a PR body');
});

test('renderRepairPrompt in reproduce mode states the reproduction-only rule', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'reproduce' }));
  assert.ok(prompt.includes('Phase 1 is reproduction-only. Do not fix source code yet.'));
  assert.ok(prompt.includes('Only add or edit tests, specs, fixtures, or files under .fixbot/.'));
  assert.ok(prompt.includes('Use status "needs-info", "no-repro", or "blocked"'), 'agent must know the non-ready escape hatches');
});

test('renderRepairPrompt outside reproduce mode keeps the fix result contract', () => {
  const prompt = renderRepairPrompt(makeJob([]));
  assert.ok(prompt.includes('.fixbot/result.md'));
  assert.ok(prompt.includes('## PR Body'));
  assert.ok(!prompt.includes('.fixbot/reproduction.json'));
  assert.ok(!prompt.includes('Phase 1 is reproduction-only'));
});

test('renderRepairPrompt surfaces the project profile commands', () => {
  const prompt = renderRepairPrompt(makeJob([]), makeProfile());
  assert.ok(prompt.includes('Kind: node'));
  assert.ok(prompt.includes('Package manager: pnpm'));
  assert.ok(prompt.includes('- pnpm run test'));
  assert.ok(prompt.includes('- pnpm run typecheck'));
  assert.ok(prompt.includes('- Detected Node project using pnpm.'));
});

test('renderRepairPrompt marks missing profile data explicitly', () => {
  const withoutProfile = renderRepairPrompt(makeJob([]));
  assert.ok(withoutProfile.includes('No project profile available.'));

  const withoutCommands = renderRepairPrompt(makeJob([]), makeProfile({ testCommands: [], buildCommands: [] }));
  assert.match(withoutCommands, /Test commands:\n- none/, 'empty command lists must carry an explicit none marker');
});

test('renderRepairPrompt in triage mode demands the triage report and forbids source edits', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'triage' }));
  assert.ok(prompt.includes('Mode: triage'));
  assert.ok(prompt.includes('.fixbot/triage.md'), 'agent must be told where to persist the triage report');
  assert.match(prompt, /do not[^\n]*source/i, 'triage must forbid source edits');
  assert.ok(!prompt.includes('.fixbot/result.md'), 'triage must not ask for the fix result artifact');
  assert.ok(!prompt.includes('.fixbot/review.md'), 'triage must not ask for the review artifact');
  assert.ok(!prompt.includes('.fixbot/reproduction.json'), 'triage must not ask for the reproduction plan');
  assert.ok(!prompt.includes('## PR Body'), 'triage produces no patch, so no PR body');
});

test('renderRepairPrompt in review mode demands a read-only review artifact', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'review' }));
  assert.ok(prompt.includes('Mode: review'));
  assert.ok(prompt.includes('.fixbot/review.md'), 'agent must be told where to persist the review');
  assert.match(prompt, /read.only/i, 'review must be framed as read-only');
  assert.ok(!prompt.includes('.fixbot/result.md'), 'review must not ask for the fix result artifact');
  assert.ok(!prompt.includes('.fixbot/triage.md'), 'review must not ask for the triage artifact');
  assert.ok(!prompt.includes('## PR Body'), 'review produces no patch, so no PR body');
});

test('renderRepairPrompt in address-review mode targets the review findings', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'address-review' }));
  assert.ok(prompt.includes('Mode: address-review'));
  assert.match(prompt, /review (findings|feedback|comments)/i, 'mission must aim at the review findings');
  assert.ok(prompt.includes('.fixbot/result.md'), 'address-review still delivers the fix result artifact');
});

test('renderRepairPrompt in address-review mode offers the optional resolved-review-thread artifact', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'address-review' }));
  assert.ok(prompt.includes('.fixbot/resolved-review-threads.json'), 'agent must know where to record resolved review threads');
  assert.ok(prompt.includes('threadIds'), 'artifact shape must name the threadIds key');
  assert.match(prompt, /optional/i, 'resolving review threads must be framed as optional, not demanded');
});

test('renderRepairPrompt keeps the resolved-review-thread artifact out of every other mode', () => {
  const otherModes: Array<RepairJob['mode']> = ['fix', 'fix-ci', 'triage', 'review', 'reproduce', 'prepare'];
  for (const mode of otherModes) {
    const prompt = renderRepairPrompt(makeJob([], { mode }));
    assert.ok(!prompt.includes('resolved-review-threads'), `${mode} must not mention the resolved-review-thread artifact`);
    assert.ok(!prompt.includes('threadIds'), `${mode} must not mention the threadIds artifact key`);
  }
});

test('renderRepairPrompt in fix-ci mode aims the mission at the failing checks', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'fix-ci' }));
  assert.ok(prompt.includes('Mode: fix-ci'));
  assert.match(prompt, /failing (ci|checks?)/i, 'fix-ci must direct the agent at the failing CI checks');
  assert.ok(prompt.includes('.fixbot/result.md'), 'fix-ci delivers a patch and the fix result artifact');
});

test('renderRepairPrompt in fix mode keeps the repair contract free of parity artifacts', () => {
  const prompt = renderRepairPrompt(makeJob([], { mode: 'fix' }));
  assert.ok(prompt.includes('Mode: fix\n'));
  assert.ok(prompt.includes('.fixbot/result.md'));
  assert.ok(prompt.includes('## PR Body'));
  assert.ok(!prompt.includes('.fixbot/triage.md'));
  assert.ok(!prompt.includes('.fixbot/review.md'));
  assert.ok(!prompt.includes('.fixbot/reproduction.json'));
});

test('renderRepairPrompt gives every mode a distinct contract beyond the mode label', () => {
  const modes: Array<RepairJob['mode']> = ['fix', 'fix-ci', 'address-review', 'triage', 'review', 'reproduce'];
  const prompts = modes.map((mode) => ({
    mode,
    prompt: renderRepairPrompt(makeJob([], { mode })).replace(`Mode: ${mode}\n`, 'Mode: <mode>\n')
  }));
  for (const [index, a] of prompts.entries()) {
    for (const b of prompts.slice(index + 1)) {
      assert.notEqual(a.prompt, b.prompt, `${a.mode} and ${b.mode} must not render the same contract`);
    }
  }
});
