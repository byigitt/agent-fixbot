import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentArgs } from './commandAgentRunner.js';
import { defaultConfig, type AgentConfig } from '../config/config.js';
import { FixbotError } from '../../shared/errors.js';

const agent = (override: Partial<AgentConfig> = {}): AgentConfig => ({ ...defaultConfig.agent, ...override });

const modelConfigError = (error: unknown): boolean =>
  error instanceof FixbotError && error.code === 'AGENT_MODEL_CONFIG';

// The default config sets modelArgs but no model. Without a model the runner
// must only substitute {prompt} — appending modelArgs here would hand the CLI
// a literal `--model {model}`.
test('buildAgentArgs without a model substitutes {prompt} and never appends modelArgs', () => {
  const args = buildAgentArgs(agent(), '/tmp/prompt.md');
  assert.deepStrictEqual(args, ['-p', '@/tmp/prompt.md']);
});

// With a model and no inline placeholder, modelArgs is the delivery channel:
// it must land after args with {model} resolved. Dropping the append would
// silently run the agent on its default model.
test('buildAgentArgs appends default modelArgs with {model} substituted', () => {
  const args = buildAgentArgs(agent({ model: 'claude-fable-5' }), '/tmp/prompt.md');
  assert.deepStrictEqual(args, ['-p', '@/tmp/prompt.md', '--model', 'claude-fable-5']);
});

// An inline {model} placeholder in args is the explicit wiring; appending
// modelArgs on top would pass the model flag twice to the agent CLI.
test('buildAgentArgs substitutes an inline {model} placeholder without appending modelArgs', () => {
  const config = agent({ model: 'gpt-5', args: ['--model={model}', '-p', '@{prompt}'] });
  const args = buildAgentArgs(config, '/tmp/prompt.md');
  assert.deepStrictEqual(args, ['--model=gpt-5', '-p', '@/tmp/prompt.md']);
});

// A model with no {model} anywhere (args or modelArgs) has no way to reach
// the CLI. Returning args anyway would silently drop the configured model.
test('buildAgentArgs throws AGENT_MODEL_CONFIG when the model has nowhere to go', () => {
  assert.throws(
    () => buildAgentArgs(agent({ model: 'gpt-5', modelArgs: [] }), '/tmp/prompt.md'),
    modelConfigError
  );
});

// {model} in args without agent.model set would leak the literal `{model}`
// string into the spawned command; it must fail at build time instead.
test('buildAgentArgs throws AGENT_MODEL_CONFIG when args reference {model} but no model is set', () => {
  assert.throws(
    () => buildAgentArgs(agent({ args: ['--model={model}', '-p', '@{prompt}'] }), '/tmp/prompt.md'),
    modelConfigError
  );
});
