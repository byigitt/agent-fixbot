import path from 'node:path';
import { execFile } from '../../shared/exec.js';
import { ensureDir } from '../../shared/fs.js';
import { repoSlug } from '../../shared/paths.js';

export type WorkspaceResult = { workspace: string; cloned: boolean };

export async function prepareWorkspace(root: string, workspaceRoot: string, repo: string, base: string, dryRun: boolean): Promise<WorkspaceResult> {
  const dir = path.resolve(root, workspaceRoot, repoSlug(repo));
  await ensureDir(path.dirname(dir));
  if (dryRun) {
    await ensureDir(dir);
    const init = await execFile('git', ['init'], { cwd: dir });
    if (init.exitCode !== 0) throw new Error(init.stderr || 'git init failed');
    return { workspace: dir, cloned: false };
  }
  const clone = await execFile('gh', ['repo', 'clone', repo, dir], { cwd: root, timeoutSeconds: 600 });
  if (clone.exitCode !== 0 && !clone.stderr.includes('already exists')) throw new Error(clone.stderr || 'gh repo clone failed');
  const fetch = await execFile('git', ['fetch', 'origin', base], { cwd: dir, timeoutSeconds: 600 });
  if (fetch.exitCode !== 0) throw new Error(fetch.stderr || 'git fetch failed');
  const checkout = await execFile('git', ['checkout', '-B', `fixbot/base-${base}`, `origin/${base}`], { cwd: dir });
  if (checkout.exitCode !== 0) throw new Error(checkout.stderr || 'git checkout failed');
  return { workspace: dir, cloned: true };
}
