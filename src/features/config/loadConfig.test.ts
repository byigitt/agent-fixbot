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

// A repo picking only agent.model must inherit the default modelArgs — that
// pair is what delivers the model to the CLI. A shallow merge
// (`override.agent ?? base.agent`) would drop modelArgs (and command/args),
// making buildAgentArgs reject the config downstream.
test('loadConfig keeps default agent.modelArgs when only agent.model is overridden', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-config-'));
  try {
    await writeFile(join(cwd, '.fixbot.json'), JSON.stringify({ agent: { model: 'claude-fable-5' } }));
    const config = await loadConfig(cwd);
    assert.strictEqual(config.agent.model, 'claude-fable-5');
    assert.deepStrictEqual(config.agent.modelArgs, ['--model', '{model}'], 'default modelArgs must survive the merge');
    assert.strictEqual(config.agent.command, defaultConfig.agent.command);
    assert.deepStrictEqual(config.agent.args, defaultConfig.agent.args);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// A repo turning on autoDispatch with just an author allowlist must keep the
// default skip/require label guards. A shallow merge (`override.autoDispatch
// ?? base.autoDispatch`) would drop them, and old configs without the key
// must keep dispatching for every author (allowedAuthors defaults to []).
test('loadConfig merges autoDispatch.allowedAuthors and keeps default label guards', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fixbot-config-'));
  try {
    await writeFile(join(cwd, '.fixbot.json'), JSON.stringify({ autoDispatch: { enabled: true, allowedAuthors: ['alice'] } }));
    const config = await loadConfig(cwd);
    assert.strictEqual(config.autoDispatch.enabled, true);
    assert.deepStrictEqual(config.autoDispatch.allowedAuthors, ['alice']);
    assert.deepStrictEqual(config.autoDispatch.skipWhenLabels, defaultConfig.autoDispatch.skipWhenLabels, 'label guards absent from the override must survive the merge');
    assert.deepStrictEqual(defaultConfig.autoDispatch.allowedAuthors, [], 'default allowlist must stay open');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
