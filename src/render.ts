import type { Finding, FindingCategory, ReportInput, RiskLevel } from './types.ts';

const REPORT_MARKER = '<!-- ai-review-report-docs -->';
const REPORT_HEADING = 'AI App Store Rejection Risk Review (Official Guidelines)';

const corpusSourceLine = (corpusVersion: string): string =>
  `- Basis: official Apple/Google guideline corpus \`${corpusVersion}\``;

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

const header = (): string => `${REPORT_MARKER}\n## ${REPORT_HEADING}`;

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
    `- Engine: Cursor agent (\`${input.model}\`), whole-repository context`,
    corpusSourceLine(input.corpusVersion),
    `- Changed files reviewed: ${input.filesAnalyzed}`,
    ...(input.overflowCount > 0
      ? [`- Large diff: ${input.overflowCount} file(s) handed to the agent to read directly`]
      : []),
    `- Cursor requests: ${input.agentRequests}`,
    '',
    'The agent reads the full checked-out repository for context, not just the diff.',
    'Usage is billed to the configured Cursor account.',
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

export const renderFailure = (
  model: string,
  corpusVersion: string,
  message: string,
): string =>
  [
    header(),
    '',
    ':warning: The AI review could not complete, so no risk assessment is available for this commit.',
    '',
    '<details>',
    '<summary>Failure details</summary>',
    '',
    `- Engine: Cursor agent (\`${model}\`)`,
    corpusSourceLine(corpusVersion),
    `- Error: ${message}`,
    '',
    'This is a tooling failure, not a review result. Re-run the job or check the workflow logs.',
    '</details>',
    '',
  ].join('\n');

export const renderNoRelevantFiles = (
  corpusVersion: string,
  model: string,
): string =>
  [
    header(),
    '',
    'No store-relevant files changed in this merge, so no risk analysis was run.',
    '',
    '<details>',
    '<summary>Run details</summary>',
    '',
    `- Engine: Cursor agent (\`${model}\`)`,
    corpusSourceLine(corpusVersion),
    '- Cursor requests: 0',
    '</details>',
    '',
  ].join('\n');
