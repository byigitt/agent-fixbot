import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReproductionPlan } from './reproductionRunner.js';
import type { ReproductionPlan } from './reproductionRunner.js';
import type { ProjectProfile } from './projectProfiler.js';
import { git } from '../../shared/git.js';
import { pathExists } from '../../shared/fs.js';

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

// Fixture: a committed repo with one product file and one test file under src/.
async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'fixbot-repro-'));
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src/app.ts'), 'export const answer = 41;\n');
  await writeFile(join(repo, 'src/app.test.ts'), '// regression placeholder\n');
  await run(repo, ['init']);
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'init']);
  return repo;
}

async function writePlan(repo: string, plan: ReproductionPlan): Promise<void> {
  await mkdir(join(repo, '.fixbot'), { recursive: true });
  await writeFile(join(repo, '.fixbot', 'reproduction.json'), JSON.stringify(plan, null, 2) + '\n');
}

function nodeProfile(allowedExecutables: string[] = ['node']): ProjectProfile {
  return { kind: 'node', testCommands: [], buildCommands: [], allowedExecutables, notes: [] };
}

function nodeCommand(expect: 'fail' | 'pass', script: string): ReproductionPlan['commands'][number] {
  return { command: 'node', args: ['-e', script], expect };
}

function readyPlan(commands: ReproductionPlan['commands']): ReproductionPlan {
  return { status: 'ready', summary: 'Regression test fails on the reported input.', commands };
}

test('runReproductionPlan', async (t) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await t.test('blocks a modified tracked product file without running any command', async () => {
      const repo = await makeRepo();
      try {
        await writeFile(join(repo, 'src/app.ts'), 'export const answer = 42;\n');
        await writePlan(repo, readyPlan([nodeCommand('fail', 'process.exit(1)')]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'blocked');
        assert.deepStrictEqual(report.reasons, ['Non-repro-only file changed: src/app.ts']);
        assert.deepStrictEqual(report.commandResults, []);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('blocks a new untracked product file', async () => {
      const repo = await makeRepo();
      try {
        await writeFile(join(repo, 'src/newFeature.ts'), 'export const fix = true;\n');
        await writePlan(repo, readyPlan([nodeCommand('fail', 'process.exit(1)')]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'blocked');
        assert.deepStrictEqual(report.reasons, ['Non-repro-only file changed: src/newFeature.ts']);
        assert.deepStrictEqual(report.commandResults, []);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('reproduces when only test files changed and the expected failure fails', async () => {
      const repo = await makeRepo();
      try {
        await writeFile(join(repo, 'src/app.test.ts'), '// updated regression\n');
        await writePlan(repo, readyPlan([
          nodeCommand('fail', 'process.exit(1)'),
          nodeCommand('pass', 'process.exit(0)')
        ]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'reproduced');
        assert.deepStrictEqual(report.reasons, []);
        assert.strictEqual(report.commandResults.length, 2);
        assert.ok(report.commandResults.every((entry) => entry.matchedExpectation));
        assert.ok(report.changedFiles.includes('src/app.test.ts'));
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('reports plan-missing when .fixbot/reproduction.json is absent', async () => {
      const repo = await makeRepo();
      try {
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'plan-missing');
        assert.match(report.reasons[0] ?? '', /reproduction\.json/);
        assert.deepStrictEqual(report.commandResults, []);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('passes non-ready plan statuses through without running commands', async () => {
      for (const status of ['needs-info', 'no-repro', 'blocked'] as const) {
        const repo = await makeRepo();
        try {
          await writePlan(repo, { status, summary: `Agent reported ${status}.`, commands: [nodeCommand('fail', 'process.exit(1)')] });
          const report = await runReproductionPlan(repo, nodeProfile());
          assert.strictEqual(report.status, status);
          assert.strictEqual(report.summary, `Agent reported ${status}.`);
          assert.deepStrictEqual(report.commandResults, []);
        } finally {
          await rm(repo, { recursive: true, force: true });
        }
      }
    });

    await t.test('blocks a disallowed executable and never runs it', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          nodeCommand('pass', "require('fs').writeFileSync('marker.txt', 'ran')")
        ]));
        const report = await runReproductionPlan(repo, nodeProfile(['pnpm']));
        assert.strictEqual(report.status, 'blocked');
        assert.ok(report.reasons.some((reason) => reason.includes('node')), report.reasons.join('; '));
        assert.deepStrictEqual(report.commandResults, []);
        assert.strictEqual(await pathExists(join(repo, 'marker.txt')), false, 'disallowed command must not execute');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('blocks a spawn failure (127) even when the plan expects a failure', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          { command: 'fixbot-test-missing-binary', args: [], expect: 'fail' }
        ]));
        const report = await runReproductionPlan(repo, nodeProfile(['fixbot-test-missing-binary']));
        assert.strictEqual(report.status, 'blocked');
        assert.match(report.reasons[0] ?? '', /infrastructure failure \(127\)/);
        assert.strictEqual(report.commandResults[0]?.result.exitCode, 127);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('blocks a timed-out command (124) even when the plan expects a failure', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          // Real 100ms wait: exec's wall-clock kill targets a child process, out of reach of fake timers.
          { ...nodeCommand('fail', 'while (true) {}'), timeoutSeconds: 0.1 }
        ]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'blocked');
        assert.match(report.reasons[0] ?? '', /infrastructure failure \(124\)/);
        assert.strictEqual(report.commandResults[0]?.result.exitCode, 124);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('blocks a command whose cwd does not exist without running it', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          { ...nodeCommand('pass', 'process.exit(0)'), cwd: 'no-such-dir' }
        ]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'blocked');
        assert.deepStrictEqual(report.reasons, ['Command cwd does not exist: no-such-dir']);
        assert.deepStrictEqual(report.commandResults, []);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('blocks a command cwd that escapes the workspace', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          { ...nodeCommand('pass', 'process.exit(0)'), cwd: '../outside' }
        ]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'blocked');
        assert.deepStrictEqual(report.commandResults, []);
        assert.ok(report.reasons.some((reason) => reason.includes('outside the workspace')), report.reasons.join('; '));
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('does not reproduce when the expected failure passes', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([nodeCommand('fail', 'process.exit(0)')]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'not-reproduced');
        assert.strictEqual(report.commandResults[0]?.matchedExpectation, false);
        assert.ok(report.reasons.length > 0);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('does not reproduce when no command expects failure', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([nodeCommand('pass', 'process.exit(0)')]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'not-reproduced');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('does not reproduce when a ready plan lists no commands', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'not-reproduced');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    await t.test('does not reproduce when any other expectation mismatches', async () => {
      const repo = await makeRepo();
      try {
        await writePlan(repo, readyPlan([
          nodeCommand('fail', 'process.exit(1)'),
          nodeCommand('pass', 'process.exit(1)')
        ]));
        const report = await runReproductionPlan(repo, nodeProfile());
        assert.strictEqual(report.status, 'not-reproduced');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
