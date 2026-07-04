import path from 'node:path';
import { pathExists, readJson } from '../../shared/fs.js';
import type { GitHubClient } from '../github/githubClient.js';

export type ResolvedReviewThreads = {
  threadIds?: string[];
};

export type ReviewThreadResolveReport = {
  resolved: string[];
  failed: string[];
};

export async function resolveReviewThreadsFromArtifact(github: GitHubClient, workspace: string, repo: string): Promise<ReviewThreadResolveReport> {
  const file = path.join(workspace, '.fixbot', 'resolved-review-threads.json');
  if (!(await pathExists(file))) return { resolved: [], failed: [] };
  const artifact = await readJson<ResolvedReviewThreads>(file);
  const resolved: string[] = [];
  const failed: string[] = [];
  for (const threadId of artifact.threadIds ?? []) {
    try {
      await github.resolveReviewThread(repo, threadId);
      resolved.push(threadId);
    } catch {
      failed.push(threadId);
    }
  }
  return { resolved, failed };
}
