import { readFileSync, writeFileSync } from 'node:fs';

import type { RiskLevel } from './types.ts';

export type RunKind = 'docs' | 'audit';
export type RunStatus = 'ok' | 'failed' | 'skipped';

// Written by the review entrypoints and read back by postReport, so the check run can
// describe the outcome without re-parsing the rendered markdown.
export type RunSummary = {
  kind: RunKind;
  status: RunStatus;
  combinedRisk: RiskLevel | 'Unknown';
  findings: number;
};

export const getSummaryPath = (): string =>
  process.env.AI_REVIEW_SUMMARY || 'ai_review_summary.json';

export const writeSummary = (summary: RunSummary): void => {
  try {
    writeFileSync(getSummaryPath(), `${JSON.stringify(summary, null, 2)}\n`);
  } catch (error: unknown) {
    console.warn(
      `Could not write run summary: ${error instanceof Error ? error.message : error}`,
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isKind = (value: unknown): value is RunKind => value === 'docs' || value === 'audit';

const isStatus = (value: unknown): value is RunStatus =>
  value === 'ok' || value === 'failed' || value === 'skipped';

const isRisk = (value: unknown): value is RiskLevel | 'Unknown' =>
  value === 'Low' ||
  value === 'Medium' ||
  value === 'High' ||
  value === 'Critical' ||
  value === 'Unknown';

export const readSummary = (): RunSummary | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getSummaryPath(), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { kind, status, combinedRisk, findings } = parsed;
  if (!isKind(kind) || !isStatus(status) || !isRisk(combinedRisk)) return undefined;
  return {
    kind,
    status,
    combinedRisk,
    findings: typeof findings === 'number' ? findings : 0,
  };
};
