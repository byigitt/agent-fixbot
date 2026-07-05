import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, pathExists, readJson, writeJson } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';
import { readRunningJob } from './runningJobs.js';

export type JobLockRecord = {
  repo: string;
  number: number;
  jobId: string;
  createdAt: string;
  pid?: number;
};

export type JobLock = {
  file: string;
  record: JobLockRecord;
};

function lockFile(cwd: string, repo: string, number: number): string {
  return path.join(cwd, '.fixbot', 'locks', repoSlug(repo), `${number}.json`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryCreateLock(file: string, record: JobLockRecord): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

export async function acquireJobLock(cwd: string, repo: string, number: number, jobId: string): Promise<JobLock | undefined> {
  const file = lockFile(cwd, repo, number);
  await ensureDir(path.dirname(file));
  const record: JobLockRecord = { repo, number, jobId, createdAt: new Date().toISOString(), pid: process.pid };
  if (await tryCreateLock(file, record)) return { file, record };
  const existing = await readJson<JobLockRecord>(file).catch(() => undefined);
  if (existing?.pid !== undefined && isProcessAlive(existing.pid)) return undefined;
  // The lock pid is the wrapper; the spawned agent outlives a dead wrapper. If the recorded child is alive, the job is still running.
  const running = await readRunningJob(cwd, repo, number).catch(() => undefined);
  if (running !== undefined && isProcessAlive(running.pid)) return undefined;
  // Stale lock: holder crashed without releasing (no pid, or pid no longer alive). Same-host assumption matches `stop`.
  // The steal itself is serialized behind a wx reclaim-mutex so two reclaimers cannot unlink each other's fresh lock.
  let reclaim: fs.FileHandle;
  try {
    reclaim = await fs.open(`${file}.reclaim`, 'wx');
  } catch {
    // Someone else is reclaiming right now — unless they crashed mid-steal.
    // ponytail: 60s is far longer than any healthy steal; expired mutex is deleted and the next poll retries.
    const stat = await fs.stat(`${file}.reclaim`).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > 60_000) await fs.unlink(`${file}.reclaim`).catch(() => undefined);
    return undefined;
  }
  try {
    // Re-check under the mutex: only unlink the exact stale record we saw.
    const current = await readJson<JobLockRecord>(file).catch(() => undefined);
    if (current !== undefined && (current.jobId !== existing?.jobId || current.createdAt !== existing?.createdAt)) return undefined;
    await fs.unlink(file).catch(() => undefined);
    if (await tryCreateLock(file, record)) return { file, record };
    return undefined;
  } finally {
    await reclaim.close();
    await fs.unlink(`${file}.reclaim`).catch(() => undefined);
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
