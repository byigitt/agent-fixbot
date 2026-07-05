import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './loadConfig.js';
import { defaultConfig } from './config.js';

// A repo overriding only git.authorName must keep the base authorEmail. A
// shallow merge (`override.git ?? base.git`) would drop it and publisher
// commits downstream would run with `user.email=undefined`.
test('loadConfig deep-merges a partial git override with the base config', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-config-'));
  try {
    await writeFile(join(cwd, '.fixbot.json'), JSON.stringify({ git: { authorName: 'acme-bot' } }));
    const config = await loadConfig(cwd);
    assert.strictEqual(config.git.authorName, 'acme-bot');
    assert.strictEqual(config.git.authorEmail, defaultConfig.git.authorEmail, 'fields absent from the override must survive the merge');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
