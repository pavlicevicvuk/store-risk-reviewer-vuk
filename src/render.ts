import { REVIEW_BASIS, type Finding, type FindingCategory, type ReportInput, type ReviewBasis, type RiskLevel } from './types.ts';

// Each basis posts its own PR comment; the marker keeps the two comments distinct so the
// upsert in CI edits the right one instead of clobbering the other.
export const reportMarker = (basis: ReviewBasis): string => `<!-- ai-review-report-${basis} -->`;

const BASIS_HEADING: Record<ReviewBasis, string> = {
  rules: 'AI App Store Rejection Risk Review (Predefined Rules)',
  docs: 'AI App Store Rejection Risk Review (Official Guidelines)',
};

const basisSourceLine = (basis: ReviewBasis, rulesVersion: string, corpusVersion: string): string =>
  basis === REVIEW_BASIS.rules
    ? `- Basis: predefined rule pack \`${rulesVersion}\``
    : `- Basis: official Apple/Google guideline corpus \`${corpusVersion}\``;

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

const header = (basis: ReviewBasis): string =>
  `${reportMarker(basis)}\n## ${BASIS_HEADING[basis]}`;

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
    basisSourceLine(input.basis, input.rulesVersion, input.corpusVersion),
    `- Changed files reviewed: ${input.filesAnalyzed}`,
    ...(input.overflowCount > 0
      ? [`- Large diff: ${input.overflowCount} file(s) handed to the agent to read directly`]
      : []),
    `- Cursor requests: ${input.agentRequests}`,
    `- Served from cache: ${input.fromCache ? 'yes' : 'no'}`,
    '',
    'The agent reads the full checked-out repository for context, not just the diff.',
    'Usage is billed to the configured Cursor account; results are cached per commit to avoid re-running the agent.',
    'Report-only (v1). Build-artifact and submission-log analysis are planned for later phases.',
    '</details>',
  ].join('\n');

export const renderReport = (input: ReportInput): string => {
  const body = [header(input.basis), '', riskTable(input), ''];
  if (input.findings.length === 0) {
    body.push('No app store rejection risks detected in the changed files.');
  } else {
    body.push(`Found ${input.findings.length} potential issue(s):`, '', renderFindings(input.findings));
  }
  body.push('', runDetails(input));
  return `${body.join('\n')}\n`;
};

export const renderFailure = (
  basis: ReviewBasis,
  model: string,
  rulesVersion: string,
  corpusVersion: string,
  message: string,
): string =>
  [
    header(basis),
    '',
    ':warning: The AI review could not complete, so no risk assessment is available for this commit.',
    '',
    '<details>',
    '<summary>Failure details</summary>',
    '',
    `- Engine: Cursor agent (\`${model}\`)`,
    basisSourceLine(basis, rulesVersion, corpusVersion),
    `- Error: ${message}`,
    '',
    'This is a tooling failure, not a review result. Re-run the job or check the workflow logs.',
    '</details>',
    '',
  ].join('\n');

export const renderNoRelevantFiles = (
  basis: ReviewBasis,
  rulesVersion: string,
  corpusVersion: string,
  model: string,
): string =>
  [
    header(basis),
    '',
    'No store-relevant files changed in this merge, so no risk analysis was run.',
    '',
    '<details>',
    '<summary>Run details</summary>',
    '',
    `- Engine: Cursor agent (\`${model}\`)`,
    basisSourceLine(basis, rulesVersion, corpusVersion),
    '- Cursor requests: 0',
    '</details>',
    '',
  ].join('\n');
