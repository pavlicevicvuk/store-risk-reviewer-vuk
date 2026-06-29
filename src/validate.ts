import type { Finding, FindingCategory, Platform, Severity } from './types.ts';

const PLATFORMS: readonly Platform[] = ['ios', 'android', 'both'];
const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
const CATEGORIES: readonly FindingCategory[] = ['Code', 'Configuration', 'Metadata', 'Compliance'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const includesValue = (allowed: readonly string[], value: string): boolean =>
  allowed.includes(value);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  isString(value) && includesValue(allowed, value);

const stringField = (value: unknown): string => (isString(value) ? value : '');

export const toFinding = (value: unknown, fallbackFile: string): Finding | undefined => {
  if (!isRecord(value)) return undefined;
  const title = stringField(value.title).trim();
  if (!title) return undefined;
  const file = stringField(value.file).trim();
  return {
    ruleId: stringField(value.ruleId).trim() || 'unknown',
    platform: oneOf(value.platform, PLATFORMS) ? value.platform : 'both',
    category: oneOf(value.category, CATEGORIES) ? value.category : 'Compliance',
    severity: oneOf(value.severity, SEVERITIES) ? value.severity : 'medium',
    title,
    file: file || fallbackFile,
    evidence: stringField(value.evidence).trim(),
    guidelineRef: stringField(value.guidelineRef).trim(),
    remediation: stringField(value.remediation).trim(),
  };
};

export const toFindings = (value: unknown, fallbackFile: string): Finding[] => {
  if (!Array.isArray(value)) return [];
  const findings: Finding[] = [];
  for (const item of value) {
    const finding = toFinding(item, fallbackFile);
    if (finding) findings.push(finding);
  }
  return findings;
};

export const extractFindingsPayload = (parsed: unknown, fallbackFile: string): Finding[] => {
  if (isRecord(parsed) && 'findings' in parsed) {
    return toFindings(parsed.findings, fallbackFile);
  }
  return toFindings(parsed, fallbackFile);
};
