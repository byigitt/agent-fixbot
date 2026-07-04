import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateDiffGuards } from './guards.js';
import { git } from '../../shared/git.js';
import type { PolicyConfig } from '../config/config.js';

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 10,
    maxDiffLines: 100,
    blockedPaths: [],
    allowedCommands: [],
    ...overrides
  };
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixbot-test',
  GIT_AUTHOR_EMAIL: 'fixbot-test@example.invalid',
  GIT_COMMITTER_NAME: 'fixbot-test',
  GIT_COMMITTER_EMAIL: 'fixbot-test@example.invalid'
} as const;

async function run(cwd: string, args: string[]): Promise<void> {
  const result = await git(cwd, args);
  assert.strictEqual(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

// Fixture: two tracked files with unstaged edits of one added + one removed
// line each => 2 changed files, 4 diff lines total.
async function makeDirtyRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fixbot-guards-'));
  await mkdir(join(repo, '.github/workflows'), { recursive: true });
  await writeFile(join(repo, 'a.txt'), 'alpha\nbeta\n');
  await writeFile(join(repo, '.github/workflows/ci.yml'), 'name: ci\non: push\n');
  await run(repo, ['init']);
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'init']);
  await writeFile(join(repo, 'a.txt'), 'alpha\nBETA\n');
  await writeFile(join(repo, '.github/workflows/ci.yml'), 'name: ci\non: pull_request\n');
  return repo;
}

test('evaluateDiffGuards', async (t) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const repo = await makeDirtyRepo();
  try {
    await t.test('passes a diff exactly at the limits with no blocked paths', async () => {
      const report = await evaluateDiffGuards(repo, policy({ maxChangedFiles: 2, maxDiffLines: 4 }));
      assert.deepStrictEqual(report.reasons, []);
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual([...report.changedFiles].sort(), ['.github/workflows/ci.yml', 'a.txt']);
      assert.strictEqual(report.diffLines, 4);
    });

    await t.test('flags a diff exceeding maxChangedFiles', async () => {
      const report = await evaluateDiffGuards(repo, policy({ maxChangedFiles: 1 }));
      assert.strictEqual(report.ok, false);
      assert.ok(report.reasons.some((reason) => /Changed files 2 exceeds 1/.test(reason)), report.reasons.join('; '));
    });

    await t.test('flags a diff exceeding maxDiffLines', async () => {
      const report = await evaluateDiffGuards(repo, policy({ maxDiffLines: 3 }));
      assert.strictEqual(report.ok, false);
      assert.ok(report.reasons.some((reason) => /Diff lines 4 exceeds 3/.test(reason)), report.reasons.join('; '));
    });

    await t.test('flags only the files matching a blocked path pattern', async () => {
      const report = await evaluateDiffGuards(repo, policy({ blockedPaths: ['.github/workflows/**'] }));
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(report.reasons, ['Blocked path changed: .github/workflows/ci.yml']);
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
