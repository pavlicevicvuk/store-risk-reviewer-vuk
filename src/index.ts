import { writeFileSync } from 'node:fs';

import { analyzeChanges, getModelLabel, getReviewBasis, mergeFindings, strategySignature } from './analyze.ts';
import { cacheKey, readCache, writeCache } from './cache.ts';
import { collectDiff } from './collectDiff.ts';
import { CORPUS_VERSION, serializeGuidelinesForPrompt } from './corpus.ts';
import { renderFailure, renderNoRelevantFiles, renderReport } from './render.ts';
import { RULES_VERSION, serializeRuleSignalsForPrompt } from './rules.ts';
import { scoreFindings } from './score.ts';
import { selectFiles } from './selectFiles.ts';
import { REVIEW_BASIS, type DiffFile, type Finding, type ReviewBasis } from './types.ts';

const getBaseRef = (): string =>
  process.env.AI_REVIEW_BASE_SHA || process.env.GITHUB_BASE_REF || 'origin/main';

const getHeadRef = (): string => process.env.AI_REVIEW_HEAD_SHA || 'HEAD';

const getOutputPath = (): string => process.env.AI_REVIEW_OUTPUT || 'ai_review_report.md';

const writeReport = (path: string, content: string): void => {
  writeFileSync(path, content);
  console.log(content);
};

// Bump when the cache layout or payload meaning changes so entries from an older scheme are
// never read back under the new logic.
const CACHE_SCHEMA = 'v3-split';

// Code findings are treated as self-contained (they depend on the file they live in), so they
// are cached per file by content. Every other category is absence/config/metadata driven and
// can depend on the wider repository, so those live in the coarser repo-state tier instead.
const isSelfContained = (finding: Finding): boolean => finding.category === 'Code';

// A basis-specific fingerprint of the exact rule/guideline text fed to the prompt. Hashing the
// content (not just the hand-maintained version string) means editing the rules or corpus
// invalidates the cache even if someone forgets to bump the version.
const corpusRulesHash = (basis: ReviewBasis): string =>
  cacheKey([
    RULES_VERSION,
    CORPUS_VERSION,
    basis === REVIEW_BASIS.rules ? serializeRuleSignalsForPrompt() : serializeGuidelinesForPrompt(),
  ]);

const keyPrefix = (basis: ReviewBasis, model: string): string[] => [
  CACHE_SCHEMA,
  basis,
  model,
  corpusRulesHash(basis),
  strategySignature(),
];

const codeCacheKey = (basis: ReviewBasis, model: string, file: DiffFile): string =>
  cacheKey([...keyPrefix(basis, model), 'code', file.path, file.blobSha]);

const repoScanCacheKey = (basis: ReviewBasis, model: string, files: DiffFile[]): string =>
  cacheKey([
    ...keyPrefix(basis, model),
    'reposcan',
    ...files.map((file) => `${file.path}\u0000${file.blobSha}`).sort(),
  ]);

type CodePartition = { hits: Finding[]; misses: DiffFile[] };

const partitionByCodeCache = (
  files: DiffFile[],
  basis: ReviewBasis,
  model: string,
): CodePartition => {
  const hits: Finding[] = [];
  const misses: DiffFile[] = [];
  for (const file of files) {
    const cached = file.blobSha
      ? readCache(codeCacheKey(basis, model, file), file.path)
      : undefined;
    if (cached === undefined) {
      misses.push(file);
    } else {
      hits.push(...cached);
    }
  }
  return { hits, misses };
};

type ReviewOutcome = {
  findings: Finding[];
  filesAnalyzed: number;
  overflowCount: number;
  agentRequests: number;
  fromCache: boolean;
};

const main = async (): Promise<void> => {
  const model = getModelLabel();
  const basis = getReviewBasis();
  const outputPath = getOutputPath();

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

  const outcome = await review(relevantFiles, basis, model);
  const risk = scoreFindings(outcome.findings);

  writeReport(
    outputPath,
    renderReport({
      ...risk,
      findings: outcome.findings,
      filesAnalyzed: outcome.filesAnalyzed,
      overflowCount: outcome.overflowCount,
      agentRequests: outcome.agentRequests,
      fromCache: outcome.fromCache,
      model,
      basis,
      rulesVersion: RULES_VERSION,
      corpusVersion: CORPUS_VERSION,
    }),
  );

  console.log(
    `AI review complete: combined risk ${risk.combinedRisk}, ${outcome.findings.length} finding(s) ` +
      `across ${relevantFiles.length} changed file(s); ` +
      `${outcome.fromCache ? 'served entirely from cache' : `${outcome.agentRequests} live Cursor request(s)`}.`,
  );
};

const review = async (
  relevantFiles: DiffFile[],
  basis: ReviewBasis,
  model: string,
): Promise<ReviewOutcome> => {
  const { hits: cachedCodeFindings, misses: codeMisses } = partitionByCodeCache(
    relevantFiles,
    basis,
    model,
  );
  const scanKey = repoScanCacheKey(basis, model, relevantFiles);
  const cachedScanFindings = readCache(scanKey, '');

  const needsAgent = codeMisses.length > 0 || cachedScanFindings === undefined;
  if (!needsAgent) {
    return {
      findings: mergeFindings([...cachedCodeFindings, ...(cachedScanFindings ?? [])]),
      filesAnalyzed: relevantFiles.length,
      overflowCount: 0,
      agentRequests: 0,
      fromCache: true,
    };
  }

  // When only some files changed we re-review just those; when the repo-state entry is missing
  // but every file's code is cached we still need diffs to seed the scan, so fall back to all.
  const filesToInline = codeMisses.length > 0 ? codeMisses : relevantFiles;
  const analysis = await analyzeChanges(filesToInline, basis);

  writeSplitCaches(analysis.findings, filesToInline, basis, model, scanKey);

  return {
    findings: mergeFindings([...cachedCodeFindings, ...analysis.findings]),
    filesAnalyzed: relevantFiles.length,
    overflowCount: analysis.overflowCount,
    agentRequests: analysis.requests,
    fromCache: false,
  };
};

// Persist the agent's output into both tiers: each inlined file's self-contained (Code)
// findings under its content key (empty array included, so "no risk" is cached too), and every
// remaining finding under the repo-state key.
const writeSplitCaches = (
  findings: Finding[],
  inlined: DiffFile[],
  basis: ReviewBasis,
  model: string,
  scanKey: string,
): void => {
  const inlinedPaths = new Set(inlined.map((file) => file.path));
  const codeByFile = new Map<string, Finding[]>();
  const scanFindings: Finding[] = [];
  for (const finding of findings) {
    if (isSelfContained(finding) && inlinedPaths.has(finding.file)) {
      const bucket = codeByFile.get(finding.file) ?? [];
      bucket.push(finding);
      codeByFile.set(finding.file, bucket);
    } else {
      scanFindings.push(finding);
    }
  }

  for (const file of inlined) {
    if (!file.blobSha) continue;
    writeCache(codeCacheKey(basis, model, file), codeByFile.get(file.path) ?? []);
  }
  writeCache(scanKey, scanFindings);
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
