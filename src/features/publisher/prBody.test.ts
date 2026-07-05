import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPr } from './prBody.js';
import type { RepairJob } from '../jobs/job.js';

const job = { issueNumber: 5 } as RepairJob;

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fixbot-prbody-'));
  await mkdir(join(dir, '.fixbot'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, '.fixbot', name), content);
  }
  return dir;
}

test('buildPr', async (t) => {
  await t.test('takes title from pr.md line 1 and appends Fixes when no closing keyword exists', async () => {
    const dir = await makeWorkspace({ 'pr.md': 'docs: add root README (#5)\n\n## Fix\nAdds README.md.\n' });
    try {
      const pr = await buildPr(dir, job);
      assert.equal(pr.title, 'docs: add root README (#5)');
      // "(#5)" in the Fix section is a mention, not a closing keyword — Fixes must be appended.
      assert.ok(pr.body.includes('## Fix'));
      assert.ok(/Fixes #5\n$/.test(pr.body), pr.body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('does not duplicate an existing closing keyword, including a digit-boundary match', async () => {
    const dir = await makeWorkspace({ 'pr.md': 'fix(cli): handle empty names (#5)\n\nBody.\n\nCloses #5\n' });
    try {
      const pr = await buildPr(dir, job);
      assert.equal(pr.body.match(/#5(?!\d)/g)?.length, 1, pr.body); // only the existing "Closes #5"
      assert.ok(!pr.body.includes('Fixes #5'), pr.body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('"Fixes #52" does not satisfy issue #5', async () => {
    const dir = await makeWorkspace({ 'pr.md': 'fix: other ref\n\nFixes #52\n' });
    try {
      const pr = await buildPr(dir, job);
      assert.ok(pr.body.includes('Fixes #52'));
      assert.ok(pr.body.includes('Fixes #5\n'), pr.body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('falls back to result.md body and a generic title when pr.md is missing', async () => {
    const dir = await makeWorkspace({ 'result.md': '## Summary\nInternal report.\n' });
    try {
      const pr = await buildPr(dir, job);
      assert.equal(pr.title, 'fix: address issue #5');
      assert.ok(pr.body.includes('Internal report.'));
      assert.ok(pr.body.includes('Fixes #5'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
