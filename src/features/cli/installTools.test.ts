import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from '../../shared/exec.js';

// dist/features/cli/installTools.test.js -> repo root
const repoRoot = join(import.meta.dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts/install-tools.sh');

test('install-tools.sh is valid bash and executable', async () => {
  const result = await execFile('bash', ['-n', scriptPath], { cwd: repoRoot, timeoutSeconds: 10 });
  assert.equal(result.exitCode, 0, `bash -n failed: ${result.stderr}`);
  assert.ok(statSync(scriptPath).mode & 0o111, 'script must be executable');
});

test('install-tools.sh covers every doctor tool plus the agent CLI', () => {
  const script = readFileSync(scriptPath, 'utf8');
  // keep in sync with the checks in src/features/cli/doctor.ts
  for (const tool of ['node', 'pnpm', 'git', 'gh']) {
    assert.match(script, new RegExp(`\\b${tool}\\b`), `script must handle ${tool}`);
  }
  assert.match(script, /@oh-my-pi\/pi-coding-agent/, 'script must install the default agent CLI package');
  assert.match(script, /\bomp\b/, 'script must verify the omp binary');
});

test('install-tools.sh fails fast instead of half-installing on unsupported platforms', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /unsupported OS/);
});
