import { writeFileSync } from 'node:fs';

import { analyzeFile, getModelLabel } from './analyze.ts';
import { cacheKey, readCache, writeCache } from './cache.ts';
import { collectDiff } from './collectDiff.ts';
import { CORPUS_VERSION } from './corpus.ts';
import { renderNoRelevantFiles, renderReport } from './render.ts';
import { RULES_VERSION } from './rules.ts';
import { scoreFindings } from './score.ts';
import { selectFiles } from './selectFiles.ts';
import type { Finding } from './types.ts';

const getBaseRef = (): string =>
  process.env.AI_REVIEW_BASE_SHA || process.env.GITHUB_BASE_REF || 'origin/main';

const getHeadRef = (): string => process.env.AI_REVIEW_HEAD_SHA || 'HEAD';

const getOutputPath = (): string => process.env.AI_REVIEW_OUTPUT || 'ai_review_report.md';

const writeReport = (path: string, content: string): void => {
  writeFileSync(path, content);
  console.log(content);
};

const main = async (): Promise<void> => {
  const model = getModelLabel();
  const outputPath = getOutputPath();

  const changedFiles = collectDiff(getBaseRef(), getHeadRef());
  const relevantFiles = selectFiles(changedFiles);

  if (relevantFiles.length === 0) {
    writeReport(outputPath, renderNoRelevantFiles(RULES_VERSION, model));
    console.log('AI review: no store-relevant files changed.');
    return;
  }

  if (!process.env.CURSOR_API_KEY) {
    throw new Error('CURSOR_API_KEY is not set; cannot run the Cursor agent.');
  }

  const findings: Finding[] = [];
  let filesCached = 0;

  for (const file of relevantFiles) {
    const key = cacheKey([RULES_VERSION, CORPUS_VERSION, model, file.path, file.patch]);
    const cached = readCache(key, file.path);
    if (cached) {
      findings.push(...cached);
      filesCached += 1;
      continue;
    }

    const analysis = await analyzeFile(file);
    writeCache(key, analysis.findings);
    findings.push(...analysis.findings);
  }

  const risk = scoreFindings(findings);

  writeReport(
    outputPath,
    renderReport({
      ...risk,
      findings,
      filesAnalyzed: relevantFiles.length,
      filesCached,
      model,
      rulesVersion: RULES_VERSION,
    }),
  );

  console.log(
    `AI review complete: combined risk ${risk.combinedRisk}, ${findings.length} finding(s), ` +
      `${relevantFiles.length - filesCached} Cursor request(s) / ${filesCached} cached.`,
  );
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
