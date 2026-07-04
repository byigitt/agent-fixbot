import { minimatchLike } from './minimatchLike.js';
import { changedFiles, diffLineCount } from '../../shared/git.js';
import type { PolicyConfig } from '../config/config.js';

export type GuardReport = {
  ok: boolean;
  changedFiles: string[];
  diffLines: number;
  reasons: string[];
};

export async function evaluateDiffGuards(cwd: string, policy: PolicyConfig): Promise<GuardReport> {
  const files = await changedFiles(cwd);
  const lines = await diffLineCount(cwd);
  const reasons: string[] = [];
  if (files.length > policy.maxChangedFiles) reasons.push(`Changed files ${files.length} exceeds ${policy.maxChangedFiles}`);
  if (lines > policy.maxDiffLines) reasons.push(`Diff lines ${lines} exceeds ${policy.maxDiffLines}`);
  for (const file of files) {
    if (policy.blockedPaths.some((pattern) => minimatchLike(file, pattern))) reasons.push(`Blocked path changed: ${file}`);
  }
  return { ok: reasons.length === 0, changedFiles: files, diffLines: lines, reasons };
}
