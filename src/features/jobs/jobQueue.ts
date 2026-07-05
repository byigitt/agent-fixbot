import path from 'node:path';
import { pathExists, readJson, writeJson } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';

// One FIFO queue file per repo. Every dispatch source (auto-dispatched issues,
// comment commands, the review loop) enqueues here; `process-queue` drains it
// serially — one running job at a time, capacity per drain = autoDispatch.maxPerPoll.
// Work commands only — never 'stop' (immediate) or 'prepare' (local-only).
export type QueuedJobMode = 'fix' | 'triage' | 'reproduce' | 'review' | 'fix-ci' | 'address-review';

export type QueuedJob = {
  number: number;
  mode: QueuedJobMode;
  // Auto-dispatched jobs re-check skip labels at drain time so issues resolved meanwhile drop off.
  auto?: boolean;
  startSummary?: string;
  queuedAt: string;
};

function queueFile(cwd: string, repo: string): string {
  return path.join(cwd, '.fixbot', 'queue', `${repoSlug(repo)}.json`);
}

export async function readQueue(cwd: string, repo: string): Promise<QueuedJob[]> {
  const file = queueFile(cwd, repo);
  if (!(await pathExists(file))) return [];
  return (await readJson<{ items?: QueuedJob[] }>(file)).items ?? [];
}

export async function writeQueue(cwd: string, repo: string, items: QueuedJob[]): Promise<void> {
  await writeJson(queueFile(cwd, repo), { items });
}

// FIFO enqueue, deduped on (number, mode). Returns false when an identical job is already queued.
export async function enqueueJob(cwd: string, repo: string, job: Omit<QueuedJob, 'queuedAt'>): Promise<boolean> {
  const items = await readQueue(cwd, repo);
  if (items.some((item) => item.number === job.number && item.mode === job.mode)) return false;
  items.push({ ...job, queuedAt: new Date().toISOString() });
  await writeQueue(cwd, repo, items);
  return true;
}
