import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateEvidenceGate } from './evidenceGate.js';
import type { PolicyConfig } from '../config/config.js';

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    requireHumanReview: true,
    allowLiveServices: false,
    allowPush: false,
    maxChangedFiles: 10,
    maxDiffLines: 100,
    blockedPaths: [],
    allowedCommands: [],
    requireTestEvidence: false,
    requireChangelog: false,
    requireLiveServiceEvidence: false,
    statusLabels: {},
    ...overrides
  };
}

type EvidenceArtifact = {
  tests?: Array<{ command: string; status: string }>;
  changelog?: string[];
  liveServices?: Array<{ service: string; status: string }>;
};

async function makeWorkspace(evidence?: EvidenceArtifact): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'fixbot-evidence-'));
  if (evidence) {
    await mkdir(join(workspace, '.fixbot'), { recursive: true });
    await writeFile(join(workspace, '.fixbot', 'evidence.json'), JSON.stringify(evidence));
  }
  return workspace;
}

function assertReason(report: { reasons: string[] }, expected: string): void {
  assert.ok(
    report.reasons.some((reason) => reason.includes(expected)),
    `missing reason ${JSON.stringify(expected)}: ${report.reasons.join('; ') || '(no reasons)'}`
  );
}

test('evaluateEvidenceGate', async (t) => {
  await t.test('passes without an evidence artifact when the policy demands no evidence', async () => {
    const workspace = await makeWorkspace();
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        requireTestEvidence: false,
        requireChangelog: false,
        requireLiveServiceEvidence: false
      }));
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('demands test evidence when required and no artifact exists', async () => {
    const workspace = await makeWorkspace();
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireTestEvidence: true }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Test evidence required');
      assert.strictEqual(report.reasons.length, 1, report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('demands test evidence when the artifact reports no test runs', async () => {
    const workspace = await makeWorkspace({ tests: [], changelog: ['CHANGELOG.md'] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireTestEvidence: true }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Test evidence required');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('rejects test evidence whose only runs failed', async () => {
    const workspace = await makeWorkspace({ tests: [{ command: 'pnpm test', status: 'failed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireTestEvidence: true }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Passing test evidence required');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('accepts passing test evidence', async () => {
    const workspace = await makeWorkspace({ tests: [{ command: 'pnpm test', status: 'passed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireTestEvidence: true }));
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('demands a changelog entry when required and none is reported', async () => {
    const workspace = await makeWorkspace({ tests: [{ command: 'pnpm test', status: 'passed' }], changelog: [] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireChangelog: true }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Changelog evidence required');
      assert.strictEqual(report.reasons.length, 1, report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('accepts a reported changelog entry when required', async () => {
    const workspace = await makeWorkspace({ changelog: ['CHANGELOG.md'] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ requireChangelog: true }));
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('blocks live service evidence when live services are not allowed, even passing evidence', async () => {
    const workspace = await makeWorkspace({ liveServices: [{ service: 'stripe-api', status: 'passed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({ allowLiveServices: false }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Live service evidence is not allowed');
      assert.strictEqual(report.reasons.length, 1, report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('demands live service evidence when required and none is reported', async () => {
    const workspace = await makeWorkspace({ tests: [{ command: 'pnpm test', status: 'passed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        allowLiveServices: true,
        requireLiveServiceEvidence: true
      }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Live service evidence required');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('rejects live service evidence whose only checks failed', async () => {
    const workspace = await makeWorkspace({ liveServices: [{ service: 'stripe-api', status: 'failed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        allowLiveServices: true,
        requireLiveServiceEvidence: true
      }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Passing live service evidence required');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('allows explicitly reported live evidence when the policy permits live services', async () => {
    const workspace = await makeWorkspace({ liveServices: [{ service: 'stripe-api', status: 'passed' }] });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        allowLiveServices: true,
        requireLiveServiceEvidence: true
      }));
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('accumulates every violated requirement instead of stopping at the first', async () => {
    const workspace = await makeWorkspace({
      tests: [],
      changelog: [],
      liveServices: [{ service: 'stripe-api', status: 'passed' }]
    });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        requireTestEvidence: true,
        requireChangelog: true,
        allowLiveServices: false
      }));
      assert.strictEqual(report.ok, false);
      assertReason(report, 'Test evidence required');
      assertReason(report, 'Changelog evidence required');
      assertReason(report, 'Live service evidence is not allowed');
      assert.strictEqual(report.reasons.length, 3, report.reasons.join('; '));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await t.test('passes the full gate when every required evidence class is present and passing', async () => {
    const workspace = await makeWorkspace({
      tests: [{ command: 'pnpm test', status: 'passed' }],
      changelog: ['CHANGELOG.md'],
      liveServices: [{ service: 'stripe-api', status: 'passed' }]
    });
    try {
      const report = await evaluateEvidenceGate(workspace, policy({
        allowLiveServices: true,
        requireTestEvidence: true,
        requireChangelog: true,
        requireLiveServiceEvidence: true
      }));
      assert.strictEqual(report.ok, true);
      assert.deepStrictEqual(report.reasons, []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
