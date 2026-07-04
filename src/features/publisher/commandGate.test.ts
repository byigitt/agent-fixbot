import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCommandGate, type CommandGateEntry, type CommandGateExec, type CommandGateReport, type PrepublishCommand } from './commandGate.js';
import type { PolicyConfig } from '../config/config.js';
import type { ShellResult } from '../../shared/types.js';

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 10,
    maxDiffLines: 100,
    blockedPaths: [],
    allowedCommands: [],
    requireTestEvidence: false,
    requireChangelog: false,
    requireLiveServiceEvidence: false,
    statusLabels: {},
    ...overrides
  };
}

type ExecCall = { command: string; args: string[]; cwd: string };

function fakeExec(results: Record<string, Partial<ShellResult>> = {}): { calls: ExecCall[]; execFn: CommandGateExec } {
  const calls: ExecCall[] = [];
  const execFn: CommandGateExec = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const rendered = [command, ...args].join(' ');
    return { command: rendered, cwd: options.cwd, exitCode: 0, stdout: '', stderr: '', ...results[rendered] };
  };
  return { calls, execFn };
}

async function makeWorkspace(plan?: { commands: PrepublishCommand[] }): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'fixbot-gate-'));
  if (plan) {
    await mkdir(join(workspace, '.fixbot'), { recursive: true });
    await writeFile(join(workspace, '.fixbot', 'prepublish.json'), JSON.stringify(plan));
  }
  return workspace;
}

function entryAt(report: CommandGateReport, index: number): CommandGateEntry {
  const entry = report.commands[index];
  assert.ok(entry, `expected command entry at index ${index}, got ${report.commands.length}`);
  return entry;
}

test('evaluateCommandGate', async (t) => {
  await t.test('runs allowlisted commands in plan order and reports their results', async () => {
    const workspace = await makeWorkspace({
      commands: [{ command: 'pnpm', args: ['test'] }, { command: 'make' }]
    });
    const { calls, execFn } = fakeExec({ 'pnpm test': { exitCode: 0, stdout: '42 passing' } });
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test', 'make'] }), execFn);
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
      assert.strictEqual(report.commands.length, 2);
      const first = entryAt(report, 0);
      assert.strictEqual(first.command, 'pnpm');
      assert.deepStrictEqual(first.args, ['test']);
      assert.strictEqual(first.rendered, 'pnpm test');
      assert.strictEqual(first.allowed, true);
      assert.strictEqual(first.exitCode, 0);
      assert.strictEqual(first.stdout, '42 passing');
      const second = entryAt(report, 1);
      assert.deepStrictEqual(second.args, []);
      assert.strictEqual(second.rendered, 'make');
      assert.strictEqual(second.allowed, true);
      assert.strictEqual(second.exitCode, 0);
      assert.deepStrictEqual(calls, [
        { command: 'pnpm', args: ['test'], cwd: workspace },
        { command: 'make', args: [], cwd: workspace }
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('blocks a command missing from the allowlist without executing it', async () => {
    const workspace = await makeWorkspace({
      commands: [{ command: 'curl', args: ['https://evil.example'] }]
    });
    const { calls, execFn } = fakeExec();
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test'] }), execFn);
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(calls, []);
      const entry = entryAt(report, 0);
      assert.strictEqual(entry.allowed, false);
      assert.strictEqual(entry.exitCode, undefined);
      assert.ok(
        report.reasons.some((reason) => reason.includes('curl https://evil.example')),
        report.reasons.join('; ')
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('requires an exact rendered match — extra args do not ride an allowlist entry', async () => {
    const workspace = await makeWorkspace({
      commands: [{ command: 'pnpm', args: ['test', '--watch'] }]
    });
    const { calls, execFn } = fakeExec();
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test'] }), execFn);
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(entryAt(report, 0).allowed, false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('fails the gate when an allowed command exits nonzero and surfaces the result', async () => {
    const workspace = await makeWorkspace({ commands: [{ command: 'pnpm', args: ['test'] }] });
    const { execFn } = fakeExec({ 'pnpm test': { exitCode: 2, stderr: '1 test failed' } });
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test'] }), execFn);
      assert.strictEqual(report.ok, false);
      const entry = entryAt(report, 0);
      assert.strictEqual(entry.allowed, true);
      assert.strictEqual(entry.exitCode, 2);
      assert.strictEqual(entry.stderr, '1 test failed');
      assert.ok(report.reasons.some((reason) => reason.includes('pnpm test')), report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('mixed plan executes only the allowed command but reports every entry', async () => {
    const workspace = await makeWorkspace({
      commands: [{ command: 'pnpm', args: ['test'] }, { command: 'rm', args: ['-rf', 'node_modules'] }]
    });
    const { calls, execFn } = fakeExec();
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test'] }), execFn);
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(calls, [{ command: 'pnpm', args: ['test'], cwd: workspace }]);
      assert.strictEqual(report.commands.length, 2);
      assert.strictEqual(entryAt(report, 0).allowed, true);
      assert.strictEqual(entryAt(report, 1).allowed, false);
      assert.ok(report.reasons.some((reason) => reason.includes('rm -rf node_modules')), report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('passes with no commands when the workspace has no prepublish plan', async () => {
    const workspace = await makeWorkspace();
    const { calls, execFn } = fakeExec();
    try {
      const report = await evaluateCommandGate(workspace, policy({ allowedCommands: ['pnpm test'] }), execFn);
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.commands, []);
      assert.deepStrictEqual(calls, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
