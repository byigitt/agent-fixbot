import path from 'node:path';
import { pathExists, readJson } from '../../shared/fs.js';
import type { PolicyConfig } from '../config/config.js';

export type EvidenceEntry = {
  command?: string;
  path?: string;
  service?: string;
  status?: string;
};

export type EvidenceFile = {
  tests?: EvidenceEntry[];
  changelog?: string[];
  liveServices?: EvidenceEntry[];
  scope?: EvidenceEntry;
};

export type EvidenceGateReport = {
  ok: boolean;
  reasons: string[];
};

function passed(entries: EvidenceEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) => entry.status === 'passed');
}

export async function evaluateEvidenceGate(workspace: string, policy: PolicyConfig): Promise<EvidenceGateReport> {
  const file = path.join(workspace, '.fixbot', 'evidence.json');
  const evidence = await pathExists(file) ? await readJson<EvidenceFile>(file) : {};
  const reasons: string[] = [];
  const liveServices = evidence.liveServices ?? [];
  if (evidence.scope?.status === 'failed') reasons.push('Semantic scope evidence failed');
  if (policy.requireTestEvidence && !passed(evidence.tests)) reasons.push((evidence.tests?.length ?? 0) > 0 ? 'Passing test evidence required' : 'Test evidence required');
  if (policy.requireChangelog && (evidence.changelog?.length ?? 0) === 0) reasons.push('Changelog evidence required');
  if (!policy.allowLiveServices && liveServices.length > 0) reasons.push('Live service evidence is not allowed');
  if (policy.requireLiveServiceEvidence && !passed(liveServices)) reasons.push(liveServices.length > 0 ? 'Passing live service evidence required' : 'Live service evidence required');
  return { ok: reasons.length === 0, reasons };
}
