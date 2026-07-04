import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, pathExists, readJson, writeJson } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';

export type JobLockRecord = {
  repo: string;
  number: number;
  jobId: string;
  createdAt: string;
};

export type JobLock = {
  file: string;
  record: JobLockRecord;
};

function lockFile(cwd: string, repo: string, number: number): string {
  return path.join(cwd, '.fixbot', 'locks', repoSlug(repo), `${number}.json`);
}

export async function acquireJobLock(cwd: string, repo: string, number: number, jobId: string): Promise<JobLock | undefined> {
  const file = lockFile(cwd, repo, number);
  await ensureDir(path.dirname(file));
  const record: JobLockRecord = { repo, number, jobId, createdAt: new Date().toISOString() };
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n');
    await handle.close();
    return { file, record };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return undefined;
  }
}

export async function readJobLock(cwd: string, repo: string, number: number): Promise<JobLockRecord | undefined> {
  const file = lockFile(cwd, repo, number);
  if (!(await pathExists(file))) return undefined;
  return readJson<JobLockRecord>(file);
}

export async function releaseJobLock(lock: JobLock | undefined): Promise<void> {
  if (!lock) return;
  try {
    await fs.unlink(lock.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function forceWriteJobLock(cwd: string, record: JobLockRecord): Promise<void> {
  await writeJson(lockFile(cwd, record.repo, record.number), record);
}
