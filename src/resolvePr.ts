import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfig } from './config.ts';
import { requireEnv } from './env.ts';
import { githubRequest } from './github.ts';

export type PullRequestFacts = {
  baseRef: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  headRepo: string;
  baseRepo: string;
  isFork: boolean;
  draft: boolean;
  state: string;
  labels: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readString = (source: Record<string, unknown>, key: string): string => {
  const value = source[key];
  return typeof value === 'string' ? value : '';
};

const readSide = (
  payload: Record<string, unknown>,
  key: 'base' | 'head',
): { sha: string; ref: string; repo: string } => {
  const side = payload[key];
  if (!isRecord(side)) return { sha: '', ref: '', repo: '' };
  const repo = side.repo;
  return {
    sha: readString(side, 'sha'),
    ref: readString(side, 'ref'),
    repo: isRecord(repo) ? readString(repo, 'full_name') : '',
  };
};

const readLabels = (payload: Record<string, unknown>): string[] => {
  const labels = payload.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (isRecord(entry)) {
      const name = readString(entry, 'name');
      if (name) names.push(name);
    }
  }
  return names;
};

export const parsePullRequest = (payload: unknown): PullRequestFacts => {
  if (!isRecord(payload)) throw new Error('Unexpected pull request payload.');
  const base = readSide(payload, 'base');
  const head = readSide(payload, 'head');
  return {
    baseRef: base.ref,
    baseSha: base.sha,
    headSha: head.sha,
    headRef: head.ref,
    headRepo: head.repo,
    baseRepo: base.repo,
    isFork: head.repo !== '' && base.repo !== '' && head.repo !== base.repo,
    draft: payload.draft === true,
    state: readString(payload, 'state'),
    labels: readLabels(payload),
  };
};

export type ReviewMode = 'docs' | 'audit';

// Branches under the audit prefix get the whole-repository audit; everything else gets the
// diff review. This preserves the head-ref gate the old standalone audit workflow used.
export const selectMode = (
  headRef: string,
  auditBranchPrefix: string,
  override: string,
): ReviewMode => {
  if (override === 'docs' || override === 'audit') return override;
  return headRef.startsWith(auditBranchPrefix) ? 'audit' : 'docs';
};

export type Decision = { run: boolean; reason: string };

export const decide = (
  facts: PullRequestFacts,
  baseBranch: string,
  forkApprovalLabel: string,
): Decision => {
  if (facts.state !== 'open') return { run: false, reason: `pull request is ${facts.state}` };
  if (facts.baseRef !== baseBranch) {
    return { run: false, reason: `base branch is ${facts.baseRef}, expected ${baseBranch}` };
  }
  if (facts.isFork && !facts.labels.includes(forkApprovalLabel)) {
    return {
      run: false,
      reason: `fork pull request from ${facts.headRepo} needs the "${forkApprovalLabel}" label`,
    };
  }
  return { run: true, reason: 'ok' };
};

const emit = (outputs: Record<string, string>): void => {
  const target = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (target) appendFileSync(target, `${lines.join('\n')}\n`);
  for (const line of lines) console.log(line);
};

const main = async (): Promise<void> => {
  const token = requireEnv('GITHUB_TOKEN');
  const config = getConfig();
  const prNumber = Number(requireEnv('AI_REVIEW_PR_NUMBER'));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`AI_REVIEW_PR_NUMBER must be a positive integer, got "${prNumber}".`);
  }

  const payload = await githubRequest(
    token,
    'GET',
    `/repos/${config.targetRepo}/pulls/${prNumber}`,
    undefined,
  );
  const facts = parsePullRequest(payload);
  const decision = decide(facts, config.baseBranch, config.forkApprovalLabel);

  emit({
    run: String(decision.run),
    reason: decision.reason,
    mode: selectMode(
      facts.headRef,
      config.auditBranchPrefix,
      process.env.AI_REVIEW_MODE_OVERRIDE?.trim() ?? '',
    ),
    base_sha: facts.baseSha,
    head_sha: facts.headSha,
    head_ref: facts.headRef,
    is_fork: String(facts.isFork),
    target_repo: config.targetRepo,
  });

  if (!decision.run) console.log(`Skipping review: ${decision.reason}`);
};

// Only run when invoked directly so the pure helpers above stay importable by the selftest.
const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
};

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
