import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReviewerConfig = {
  targetRepo: string;
  baseBranch: string;
  auditBranchPrefix: string;
  // Pull requests from forks only run once a maintainer applies this label, because the
  // review job checks out head code while holding the Cursor key and an app token.
  forkApprovalLabel: string;
};

const CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'reviewer.config.json',
);

const FALLBACK: ReviewerConfig = {
  targetRepo: 'Trainerize/ReactNativeApp',
  baseBranch: 'reactDev',
  auditBranchPrefix: 'ai-audit-demo/',
  forkApprovalLabel: 'ai-review:approved',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readString = (source: Record<string, unknown>, key: string, fallback: string): string => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
};

const readConfigFile = (): ReviewerConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return FALLBACK;
  }
  if (!isRecord(parsed)) return FALLBACK;
  return {
    targetRepo: readString(parsed, 'targetRepo', FALLBACK.targetRepo),
    baseBranch: readString(parsed, 'baseBranch', FALLBACK.baseBranch),
    auditBranchPrefix: readString(parsed, 'auditBranchPrefix', FALLBACK.auditBranchPrefix),
    forkApprovalLabel: readString(parsed, 'forkApprovalLabel', FALLBACK.forkApprovalLabel),
  };
};

// Env wins over the file so a dispatch payload can retarget a run without a commit.
export const getConfig = (): ReviewerConfig => {
  const file = readConfigFile();
  return {
    targetRepo: process.env.AI_REVIEW_TARGET_REPO?.trim() || file.targetRepo,
    baseBranch: process.env.AI_REVIEW_BASE_BRANCH?.trim() || file.baseBranch,
    auditBranchPrefix: process.env.AI_REVIEW_AUDIT_PREFIX?.trim() || file.auditBranchPrefix,
    forkApprovalLabel: process.env.AI_REVIEW_FORK_LABEL?.trim() || file.forkApprovalLabel,
  };
};
