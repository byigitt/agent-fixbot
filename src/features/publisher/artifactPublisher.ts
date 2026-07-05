import path from 'node:path';
import { pathExists, readText } from '../../shared/fs.js';
import type { GitHubClient } from '../github/githubClient.js';

export async function readArtifact(workspace: string, relativePath: string, fallback: string): Promise<string> {
  const file = path.join(workspace, relativePath);
  return await pathExists(file) ? await readText(file) : fallback;
}

export async function publishArtifactComment(github: GitHubClient, workspace: string, repo: string, number: number, relativePath: string, fallback: string, dryRun: boolean): Promise<string> {
  // Marker-keyed upsert: a re-dispatched job updates its previous artifact comment
  // instead of stacking duplicates on the issue.
  const marker = `<!-- agent-fixbot:artifact:${relativePath} -->`;
  const body = `${marker}\n${await readArtifact(workspace, relativePath, fallback)}`;
  if (!dryRun) await github.upsertIssueComment(repo, number, marker, body);
  return body;
}
