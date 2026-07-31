import { readFileSync } from 'node:fs';

import { requireEnv } from './env.ts';
import { createCheckRun, upsertMarkerComment, type CheckConclusion } from './github.ts';
import { DOCS_REPORT_MARKER, extractMarker } from './markers.ts';
import { readSummary, type RunSummary } from './summary.ts';

const getReportPath = (): string => requireEnv('AI_REVIEW_REPORT_FILE');

const readReport = (path: string): string => {
  try {
    const body = readFileSync(path, 'utf8');
    return body.trim() ? body : '';
  } catch {
    return '';
  }
};

const describe = (summary: RunSummary | undefined): { title: string; conclusion: CheckConclusion } => {
  if (!summary) return { title: 'AI review completed', conclusion: 'neutral' };
  if (summary.status === 'failed') {
    return { title: 'AI review could not complete', conclusion: 'failure' };
  }
  if (summary.status === 'skipped') {
    return { title: 'No store-relevant files changed', conclusion: 'neutral' };
  }
  // Findings are advisory: never fail a pull request on them.
  return {
    title: `Combined risk: ${summary.combinedRisk} — ${summary.findings} finding(s)`,
    conclusion: 'neutral',
  };
};

const main = async (): Promise<void> => {
  const token = requireEnv('GITHUB_TOKEN');
  const repo = requireEnv('AI_REVIEW_TARGET_REPO');
  const prNumber = Number(requireEnv('AI_REVIEW_PR_NUMBER'));
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`AI_REVIEW_PR_NUMBER must be a positive integer, got "${prNumber}".`);
  }

  const reportPath = getReportPath();
  const report = readReport(reportPath);
  if (!report) {
    console.log(`No report produced at ${reportPath}; nothing to post.`);
    return;
  }

  const marker = extractMarker(report) ?? DOCS_REPORT_MARKER;
  const action = await upsertMarkerComment(token, repo, prNumber, marker, report);
  console.log(`${action} comment on ${repo}#${prNumber} (marker ${marker}).`);

  const headSha = process.env.AI_REVIEW_HEAD_SHA?.trim();
  const checkName = process.env.AI_REVIEW_CHECK_NAME?.trim();
  if (!headSha || !checkName) {
    console.log('No head SHA or check name provided; skipping check run.');
    return;
  }

  const { title, conclusion } = describe(readSummary());
  await createCheckRun(token, repo, headSha, checkName, conclusion, title, report);
  console.log(`Created check run "${checkName}" (${conclusion}) on ${headSha}.`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
