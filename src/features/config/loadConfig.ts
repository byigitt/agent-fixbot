import path from 'node:path';
import { pathExists, readJson } from '../../shared/fs.js';
import { defaultConfig, type FixbotConfig } from './config.js';

function mergeConfig(base: FixbotConfig, override: Partial<FixbotConfig>): FixbotConfig {
  return {
    ...base,
    ...override,
    agent: { ...base.agent, ...override.agent },
    autoLabel: { ...base.autoLabel, ...override.autoLabel, rules: override.autoLabel?.rules ?? base.autoLabel.rules, defaultLabels: override.autoLabel?.defaultLabels ?? base.autoLabel.defaultLabels },
    autoDispatch: { ...base.autoDispatch, ...override.autoDispatch, skipWhenLabels: override.autoDispatch?.skipWhenLabels ?? base.autoDispatch.skipWhenLabels, requireLabels: override.autoDispatch?.requireLabels ?? base.autoDispatch.requireLabels },
    git: { ...base.git, ...override.git },
    policy: { ...base.policy, ...override.policy, statusLabels: { ...base.policy.statusLabels, ...override.policy?.statusLabels } }
  };
}

export async function loadConfig(cwd: string): Promise<FixbotConfig> {
  const file = path.join(cwd, '.fixbot.json');
  if (!(await pathExists(file))) return defaultConfig;
  const override = await readJson<Partial<FixbotConfig>>(file);
  return mergeConfig(defaultConfig, override);
}
