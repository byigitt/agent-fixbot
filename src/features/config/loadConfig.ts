import path from 'node:path';
import { pathExists, readJson } from '../../shared/fs.js';
import { defaultConfig, type FixbotConfig } from './config.js';

function mergeConfig(base: FixbotConfig, override: Partial<FixbotConfig>): FixbotConfig {
  return {
    ...base,
    ...override,
    agent: { ...base.agent, ...override.agent },
    policy: { ...base.policy, ...override.policy }
  };
}

export async function loadConfig(cwd: string): Promise<FixbotConfig> {
  const file = path.join(cwd, '.fixbot.json');
  if (!(await pathExists(file))) return defaultConfig;
  const override = await readJson<Partial<FixbotConfig>>(file);
  return mergeConfig(defaultConfig, override);
}
