import { pathExists, readText } from '../../shared/fs.js';
import path from 'node:path';
import type { RepairJob } from '../jobs/job.js';

export type PrContent = { title: string; body: string };

// Agent-authored PR: .fixbot/pr.md carries the title on the first line
// (conventional-commit style, says what the change solves) and the body below —
// roboomp style: Repro / Cause / Fix / Verification, no wrapper boilerplate.
export async function buildPr(workspace: string, job: RepairJob): Promise<PrContent> {
  const prFile = path.join(workspace, '.fixbot', 'pr.md');
  let title = `fix: address issue #${job.issueNumber}`;
  let body = '';
  if (await pathExists(prFile)) {
    const raw = (await readText(prFile)).trim();
    const newline = raw.indexOf('\n');
    const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).replace(/^#+\s*/, '').trim();
    if (firstLine) title = firstLine.slice(0, 256);
    body = newline === -1 ? '' : raw.slice(newline + 1).trim();
  }
  if (!body) {
    const resultFile = path.join(workspace, '.fixbot', 'result.md');
    body = await pathExists(resultFile)
      ? (await readText(resultFile)).trim()
      : '_Agent did not write `.fixbot/pr.md` or `.fixbot/result.md`._';
  }
  // GitHub only auto-closes on a closing keyword + ref; a bare "(#5)" mention is not enough.
  // Digit boundary so "Fixes #52" does not satisfy "#5".
  if (!new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${job.issueNumber}(?!\\d)`, 'i').test(body)) {
    body += `\n\nFixes #${job.issueNumber}`;
  }
  return { title, body: body + '\n' };
}
