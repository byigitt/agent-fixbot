import path from 'node:path';
import { ensureDir, writeJson, writeText } from '../../shared/fs.js';
import type { RepairJob } from './job.js';

export async function writeJobFiles(workspace: string, job: RepairJob, prompt: string): Promise<{ dir: string; jobFile: string; promptFile: string }> {
  const dir = path.join(workspace, '.fixbot');
  await ensureDir(dir);
  const jobFile = path.join(dir, 'job.json');
  const promptFile = path.join(dir, 'prompt.md');
  await writeJson(jobFile, job);
  await writeText(promptFile, prompt);
  return { dir, jobFile, promptFile };
}
