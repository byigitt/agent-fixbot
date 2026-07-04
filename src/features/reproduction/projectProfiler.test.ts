import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileProject } from './projectProfiler.js';

async function withWorkspace(files: Record<string, string>, run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'fixbot-profiler-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(workspace, name), contents);
    }
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const nodePackageJson = JSON.stringify({
  scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc', lint: 'eslint .' }
});

test('profileProject', async (t) => {
  await t.test('derives pnpm commands from the scripts a Node project declares', async () => {
    await withWorkspace({ 'package.json': nodePackageJson, 'pnpm-lock.yaml': '' }, async (workspace) => {
      const profile = await profileProject(workspace);
      assert.strictEqual(profile.kind, 'node');
      assert.strictEqual(profile.packageManager, 'pnpm');
      assert.deepStrictEqual(profile.testCommands, ['pnpm run test']);
      assert.deepStrictEqual(profile.buildCommands, ['pnpm run typecheck', 'pnpm run build']);
      assert.ok(profile.allowedExecutables.includes('pnpm'), 'detected package manager must be executable');
    });
  });

  await t.test('derives no commands when the project declares no matching scripts', async () => {
    await withWorkspace({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }), 'pnpm-lock.yaml': '' }, async (workspace) => {
      const profile = await profileProject(workspace);
      assert.deepStrictEqual(profile.testCommands, []);
      assert.deepStrictEqual(profile.buildCommands, []);
    });
  });

  await t.test('detects the package manager from the lockfile', async () => {
    const cases: Array<{ name: string; files: Record<string, string>; expected: 'pnpm' | 'bun' | 'yarn' }> = [
      { name: 'bun.lockb', files: { 'bun.lockb': '' }, expected: 'bun' },
      { name: 'bun.lock', files: { 'bun.lock': '' }, expected: 'bun' },
      { name: 'yarn.lock', files: { 'yarn.lock': '' }, expected: 'yarn' },
      { name: 'pnpm-lock.yaml wins over yarn.lock', files: { 'pnpm-lock.yaml': '', 'yarn.lock': '' }, expected: 'pnpm' }
    ];
    for (const entry of cases) {
      await withWorkspace({ 'package.json': nodePackageJson, ...entry.files }, async (workspace) => {
        const profile = await profileProject(workspace);
        assert.strictEqual(profile.packageManager, entry.expected, entry.name);
      });
    }
  });

  await t.test('detects the project kind from the manifest', async () => {
    const cases: Array<{ name: string; files: Record<string, string>; expected: 'rust' | 'go' | 'python' | 'unknown' }> = [
      { name: 'Cargo.toml', files: { 'Cargo.toml': '[package]\nname = "demo"\n' }, expected: 'rust' },
      { name: 'go.mod', files: { 'go.mod': 'module demo\n' }, expected: 'go' },
      { name: 'pyproject.toml', files: { 'pyproject.toml': '[project]\nname = "demo"\n' }, expected: 'python' },
      { name: 'pytest.ini alone', files: { 'pytest.ini': '[pytest]\n' }, expected: 'python' },
      { name: 'no manifest', files: {}, expected: 'unknown' }
    ];
    for (const entry of cases) {
      await withWorkspace(entry.files, async (workspace) => {
        const profile = await profileProject(workspace);
        assert.strictEqual(profile.kind, entry.expected, entry.name);
      });
    }
  });

  await t.test('prefers Node detection when package.json and Cargo.toml coexist', async () => {
    await withWorkspace({ 'package.json': nodePackageJson, 'Cargo.toml': '[package]\nname = "demo"\n' }, async (workspace) => {
      const profile = await profileProject(workspace);
      assert.strictEqual(profile.kind, 'node');
    });
  });

  await t.test('restricts a Rust project to cargo', async () => {
    await withWorkspace({ 'Cargo.toml': '[package]\nname = "demo"\n' }, async (workspace) => {
      const profile = await profileProject(workspace);
      assert.deepStrictEqual(profile.allowedExecutables, ['cargo']);
    });
  });

  await t.test('detects no test commands when nothing is recognized', async () => {
    await withWorkspace({}, async (workspace) => {
      const profile = await profileProject(workspace);
      assert.deepStrictEqual(profile.testCommands, []);
    });
  });
});
