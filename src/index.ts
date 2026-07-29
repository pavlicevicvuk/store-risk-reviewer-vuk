import { writeFileSync } from 'node:fs';

import { analyzeChanges, getModelLabel, getReviewBasis } from './analyze.ts';
import { collectDiff } from './collectDiff.ts';
import { CORPUS_VERSION } from './corpus.ts';
import { refreshCorpus } from './ingestGuidelines.ts';
import { renderFailure, renderNoRelevantFiles, renderReport } from './render.ts';
import { RULES_VERSION } from './rules.ts';
import { scoreFindings } from './score.ts';
import { selectFiles } from './selectFiles.ts';

const getBaseRef = (): string =>
  process.env.AI_REVIEW_BASE_SHA || process.env.GITHUB_BASE_REF || 'origin/main';

const getHeadRef = (): string => process.env.AI_REVIEW_HEAD_SHA || 'HEAD';

const getOutputPath = (): string => process.env.AI_REVIEW_OUTPUT || 'ai_review_report.md';

const writeReport = (path: string, content: string): void => {
  writeFileSync(path, content);
  console.log(content);
};

const maybeRefreshCorpus = async (): Promise<void> => {
  if ((process.env.AI_REVIEW_SKIP_CORPUS_REFRESH || '').trim() === '1') {
    console.log('Corpus refresh skipped (AI_REVIEW_SKIP_CORPUS_REFRESH=1).');
    return;
  }

  try {
    await refreshCorpus();
  } catch (error: unknown) {
    console.warn(
      `Corpus refresh failed; continuing with checked-in excerpts: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
};

const main = async (): Promise<void> => {
  const model = getModelLabel();
  const basis = getReviewBasis();
  const outputPath = getOutputPath();

  await maybeRefreshCorpus();

  const changedFiles = collectDiff(getBaseRef(), getHeadRef());
  const relevantFiles = selectFiles(changedFiles);

  if (relevantFiles.length === 0) {
    writeReport(outputPath, renderNoRelevantFiles(basis, RULES_VERSION, CORPUS_VERSION, model));
    console.log('AI review: no store-relevant files changed.');
    return;
  }

  if (!process.env.CURSOR_API_KEY) {
    throw new Error('CURSOR_API_KEY is not set; cannot run the Cursor agent.');
  }

  const analysis = await analyzeChanges(relevantFiles, basis);
  const risk = scoreFindings(analysis.findings);

  writeReport(
    outputPath,
    renderReport({
      ...risk,
      findings: analysis.findings,
      filesAnalyzed: relevantFiles.length,
      overflowCount: analysis.overflowCount,
      agentRequests: analysis.requests,
      model,
      basis,
      rulesVersion: RULES_VERSION,
      corpusVersion: CORPUS_VERSION,
    }),
  );

  console.log(
    `AI review complete: combined risk ${risk.combinedRisk}, ${analysis.findings.length} finding(s) ` +
      `across ${relevantFiles.length} changed file(s); ${analysis.requests} Cursor request(s).`,
  );
};

// Never fail silently: on any error, leave a clear explanation on the PR (upserted under
// the same basis marker) and still exit non-zero so the check surfaces the failure.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    writeReport(
      getOutputPath(),
      renderFailure(getReviewBasis(), getModelLabel(), RULES_VERSION, CORPUS_VERSION, message),
    );
  } catch (writeError: unknown) {
    console.error(writeError instanceof Error ? writeError.message : writeError);
  }
  console.error(message);
  process.exit(1);
});
