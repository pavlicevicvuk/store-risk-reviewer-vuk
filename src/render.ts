import type { Finding, FindingCategory, ReportInput, RiskLevel } from './types.ts';

export const REPORT_MARKER = '<!-- ai-review-report -->';

const RISK_BADGE: Record<RiskLevel, string> = {
  Low: 'Low',
  Medium: 'Medium',
  High: 'High',
  Critical: 'Critical',
};

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CATEGORY_ORDER: readonly FindingCategory[] = [
  'Compliance',
  'Configuration',
  'Code',
  'Metadata',
];

const PLATFORM_LABEL: Record<Finding['platform'], string> = {
  ios: 'iOS',
  android: 'Android',
  both: 'iOS + Android',
};

const header = (): string =>
  `${REPORT_MARKER}\n## AI App Store Rejection Risk Review`;

const riskTable = (input: ReportInput): string =>
  [
    '| Platform | Risk |',
    '| --- | --- |',
    `| iOS | ${RISK_BADGE[input.iosRisk]} |`,
    `| Android | ${RISK_BADGE[input.androidRisk]} |`,
    `| Combined | ${RISK_BADGE[input.combinedRisk]} |`,
  ].join('\n');

const sortFindings = (findings: Finding[]): Finding[] =>
  [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

const renderFinding = (finding: Finding): string => {
  const lines = [
    `- **${finding.title}** — ${finding.severity.toUpperCase()} (${PLATFORM_LABEL[finding.platform]})`,
    `  - File: \`${finding.file}\``,
  ];
  if (finding.evidence) lines.push(`  - Evidence: ${finding.evidence}`);
  if (finding.guidelineRef) lines.push(`  - Guideline: ${finding.guidelineRef}`);
  if (finding.remediation) lines.push(`  - Fix: ${finding.remediation}`);
  return lines.join('\n');
};

const renderCategory = (category: FindingCategory, findings: Finding[]): string =>
  [`### ${category}`, sortFindings(findings).map(renderFinding).join('\n')].join('\n');

const renderFindings = (findings: Finding[]): string => {
  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const inCategory = findings.filter((finding) => finding.category === category);
    if (inCategory.length > 0) sections.push(renderCategory(category, inCategory));
  }
  return sections.join('\n\n');
};

const runDetails = (input: ReportInput): string =>
  [
    '<details>',
    '<summary>Run details &amp; usage</summary>',
    '',
    `- Engine: Cursor agent (\`${input.model}\`)`,
    `- Rule pack: \`${input.rulesVersion}\``,
    `- Cursor requests: ${input.filesAnalyzed - input.filesCached}`,
    `- Files served from cache: ${input.filesCached}`,
    '',
    'Usage is billed to the configured Cursor account; unchanged files are cached to avoid re-running the agent.',
    'Report-only (v1). Build-artifact and submission-log analysis are planned for later phases.',
    '</details>',
  ].join('\n');

export const renderReport = (input: ReportInput): string => {
  const body = [header(), '', riskTable(input), ''];
  if (input.findings.length === 0) {
    body.push('No app store rejection risks detected in the changed files.');
  } else {
    body.push(`Found ${input.findings.length} potential issue(s):`, '', renderFindings(input.findings));
  }
  body.push('', runDetails(input));
  return `${body.join('\n')}\n`;
};

export const renderNoRelevantFiles = (rulesVersion: string, model: string): string =>
  [
    header(),
    '',
    'No store-relevant files changed in this merge, so no risk analysis was run.',
    '',
    '<details>',
    '<summary>Run details</summary>',
    '',
    `- Engine: Cursor agent (\`${model}\`)`,
    `- Rule pack: \`${rulesVersion}\``,
    '- Cursor requests: 0',
    '</details>',
    '',
  ].join('\n');
