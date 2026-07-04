import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, pathExists, readJson, writeJson } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';

export type RunningJobRecord = {
  repo: string;
  number: number;
  jobId: string;
  pid: number;
  startedAt: string;
};

function runningDir(cwd: string): string {
  return path.join(cwd, '.fixbot', 'running');
}

function runningFile(cwd: string, repo: string, number: number): string {
  return path.join(runningDir(cwd), `${repoSlug(repo)}-${number}.json`);
}

export async function recordRunningJob(cwd: string, record: RunningJobRecord): Promise<void> {
  await writeJson(runningFile(cwd, record.repo, record.number), record);
}

export async function clearRunningJob(cwd: string, repo: string, number: number): Promise<void> {
  await fs.rm(runningFile(cwd, repo, number), { force: true });
}

export async function readRunningJob(cwd: string, repo: string, number: number): Promise<RunningJobRecord | undefined> {
  const file = runningFile(cwd, repo, number);
  if (!(await pathExists(file))) return undefined;
  return readJson<RunningJobRecord>(file);
}

export async function stopRunningJob(cwd: string, repo: string, number: number): Promise<{ stopped: boolean; record?: RunningJobRecord; reason?: string }> {
  await ensureDir(runningDir(cwd));
  const record = await readRunningJob(cwd, repo, number);
  if (!record) return { stopped: false, reason: 'No running job for ref.' };
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    await clearRunningJob(cwd, repo, number);
    return { stopped: false, record, reason: error instanceof Error ? error.message : String(error) };
  }
  await clearRunningJob(cwd, repo, number);
  return { stopped: true, record };
}
