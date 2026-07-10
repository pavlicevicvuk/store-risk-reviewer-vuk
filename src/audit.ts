import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { serializeRulesForPrompt, RULES_VERSION } from './rules.ts';
import { scoreFindings } from './score.ts';
import type { Finding } from './types.ts';
import { extractFindingsPayload } from './validate.ts';

const execFileAsync = promisify(execFile);

const AGENT_BIN = process.env.AI_REVIEW_AGENT_BIN || 'cursor-agent';
const MAX_BUFFER = 64 * 1024 * 1024;
// A full-repo agentic scan can run long; default to 25 minutes.
const DEFAULT_TIMEOUT_MS = 1_500_000;

const AUDIT_MARKER = '<!-- ai-audit-report -->';

const getTimeoutMs = (): number => {
  const raw = Number(process.env.AI_REVIEW_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

const getRepoRoot = (): string => process.env.AI_REVIEW_REPO_ROOT || process.cwd();

const getModelId = (): string | undefined => process.env.AI_REVIEW_MODEL || undefined;

const getModelLabel = (): string => getModelId() ?? 'Cursor account default';

const getOutputPath = (): string => process.env.AI_AUDIT_OUTPUT || 'ai_audit_report.md';

const INSTRUCTIONS = [
  'You are a mobile release compliance reviewer for a React Native app.',
  'The full repository is checked out in your current working directory and you have READ access to all of it.',
  'This is a WHOLE-REPOSITORY audit, not a diff review: assess the entire app for iOS App Store',
  'or Google Play rejection risk using ONLY the provided rule pack.',
  'Explore the repository as needed: Info.plist files, entitlements, PrivacyInfo.xcprivacy,',
  'AndroidManifest.xml, build.gradle, Podfile, package.json, and the app source under app/.',
  'For absence-based rules, confirm the mitigation is genuinely absent across the repo before flagging.',
  'Be precise and conservative: only report concrete evidence. Do not modify anything.',
  'Respond with ONLY a single JSON object and nothing else (no prose, no markdown, no code fences):',
  '{"findings": Finding[]} where each Finding has ruleId, platform ("ios"|"android"|"both"),',
  'category ("Code"|"Configuration"|"Metadata"|"Compliance"),',
  'severity ("low"|"medium"|"high"|"critical"), title, file, evidence, guidelineRef, and remediation.',
  'If there is no risk, return {"findings": []}.',
].join(' ');

const buildPrompt = (): string =>
  [
    INSTRUCTIONS,
    '',
    'Rule pack (only flag issues that match one of these rules).',
    'Lines marked "Official" quote the current Apple/Google guideline text and are authoritative:',
    serializeRulesForPrompt(),
  ].join('\n');

const stripCodeFences = (content: string): string => {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
};

const extractJsonObject = (text: string): string => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return '';
  return text.slice(start, end + 1);
};

const parseContent = (content: string): Finding[] => {
  const json = extractJsonObject(stripCodeFences(content));
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return extractFindingsPayload(parsed, '');
  } catch {
    return [];
  }
};

const buildArgs = (prompt: string): string[] => {
  const args = ['--print', '--output-format', 'text', '--mode', 'ask', '--trust'];
  const model = getModelId();
  if (model) args.push('--model', model);
  args.push(prompt);
  return args;
};

const SEVERITY_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PLATFORM_LABEL: Record<Finding['platform'], string> = {
  ios: 'iOS',
  android: 'Android',
  both: 'iOS + Android',
};

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

const renderReport = (findings: Finding[], elapsedMs: number): string => {
  const risk = scoreFindings(findings);
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const body = [
    AUDIT_MARKER,
    '## AI Whole-Repository Store Rejection Risk Audit',
    '',
    '> Scans the **entire repository**, independent of any diff. Findings may include pre-existing issues and require human triage.',
    '',
    '| Platform | Risk |',
    '| --- | --- |',
    `| iOS | ${risk.iosRisk} |`,
    `| Android | ${risk.androidRisk} |`,
    `| Combined | ${risk.combinedRisk} |`,
    '',
  ];
  if (sorted.length === 0) {
    body.push('No app store rejection risks detected across the repository.');
  } else {
    body.push(`Found ${sorted.length} potential issue(s):`, '', sorted.map(renderFinding).join('\n'));
  }
  body.push(
    '',
    '<details>',
    '<summary>Run details</summary>',
    '',
    `- Engine: Cursor agent (\`${getModelLabel()}\`), whole-repository audit`,
    `- Rule pack: \`${RULES_VERSION}\``,
    `- Scan time: ${(elapsedMs / 1000).toFixed(1)}s`,
    '</details>',
    '',
  );
  return body.join('\n');
};

const main = async (): Promise<void> => {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error('CURSOR_API_KEY is not set; cannot run the Cursor agent.');
  }

  const startedAt = Date.now();
  const { stdout } = await execFileAsync(AGENT_BIN, buildArgs(buildPrompt()), {
    cwd: getRepoRoot(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: getTimeoutMs(),
  });
  const elapsedMs = Date.now() - startedAt;
  const findings = parseContent(stdout);
  const report = renderReport(findings, elapsedMs);

  writeFileSync(getOutputPath(), report);
  console.log(report);
  console.log(`AUDIT_AGENT_ELAPSED_MS=${elapsedMs}`);
  console.log(`AUDIT_FINDINGS=${findings.length}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
