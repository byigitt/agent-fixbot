import path from 'node:path';
import { pathExists, readJson } from '../../shared/fs.js';

export type ProjectProfile = {
  kind: 'node' | 'rust' | 'go' | 'python' | 'unknown';
  packageManager?: 'pnpm' | 'npm' | 'bun' | 'yarn';
  testCommands: string[];
  buildCommands: string[];
  allowedExecutables: string[];
  notes: string[];
};

type PackageJson = { scripts?: Record<string, string> };

export async function profileProject(workspace: string): Promise<ProjectProfile> {
  const packageJson = path.join(workspace, 'package.json');
  if (await pathExists(packageJson)) {
    const pkg = await readJson<PackageJson>(packageJson);
    const packageManager = await detectNodePackageManager(workspace);
    const testCommands = nodeScriptCommands(packageManager, pkg.scripts ?? {}, ['test']);
    const buildCommands = nodeScriptCommands(packageManager, pkg.scripts ?? {}, ['typecheck', 'build']);
    return {
      kind: 'node',
      packageManager,
      testCommands,
      buildCommands,
      allowedExecutables: Array.from(new Set([packageManager, 'node', 'npx'])),
      notes: [`Detected Node project using ${packageManager}.`]
    };
  }

  if (await pathExists(path.join(workspace, 'Cargo.toml'))) {
    return {
      kind: 'rust',
      testCommands: ['cargo test'],
      buildCommands: ['cargo check'],
      allowedExecutables: ['cargo'],
      notes: ['Detected Rust project.']
    };
  }

  if (await pathExists(path.join(workspace, 'go.mod'))) {
    return {
      kind: 'go',
      testCommands: ['go test ./...'],
      buildCommands: ['go test ./...'],
      allowedExecutables: ['go'],
      notes: ['Detected Go project.']
    };
  }

  if (await pathExists(path.join(workspace, 'pyproject.toml')) || await pathExists(path.join(workspace, 'pytest.ini'))) {
    return {
      kind: 'python',
      testCommands: ['python -m pytest'],
      buildCommands: [],
      allowedExecutables: ['python', 'python3', 'pytest'],
      notes: ['Detected Python project.']
    };
  }

  return {
    kind: 'unknown',
    testCommands: [],
    buildCommands: [],
    allowedExecutables: ['node', 'python', 'python3'],
    notes: ['No supported project manifest detected. Agent must inspect the repository for test commands.']
  };
}

async function detectNodePackageManager(workspace: string): Promise<'pnpm' | 'npm' | 'bun' | 'yarn'> {
  if (await pathExists(path.join(workspace, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(workspace, 'bun.lock')) || await pathExists(path.join(workspace, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(workspace, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function nodeScriptCommands(packageManager: 'pnpm' | 'npm' | 'bun' | 'yarn', scripts: Record<string, string>, names: string[]): string[] {
  return names.filter((name) => scripts[name]).map((name) => `${packageManager} run ${name}`);
}
