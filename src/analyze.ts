import { serializeGuidelinesForPrompt } from './corpus.ts';
import { runAgent, getModelLabel } from './agentRunner.ts';
import { serializeRuleSignalsForPrompt } from './rules.ts';
import { REVIEW_BASIS, type DiffFile, type FileAnalysis, type Finding, type ReviewBasis } from './types.ts';
import { extractFindingsPayload } from './validate.ts';

export { getModelLabel };

const MAX_PATCH_CHARS = 24000;
// Per-request budget for inlined diff text. Keeps each prompt bounded regardless of how
// large the pull request is; anything beyond it is either chunked or handed to the agent
// to read directly from the checked-out repository.
const INLINE_BUDGET_CHARS = 48000;

const getMaxChunks = (): number => {
  const raw = Number(process.env.AI_REVIEW_MAX_CHUNKS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
};

// Bump when the review strategy changes so cached results are invalidated.
export const REVIEW_STRATEGY = 'bounded-chunked-v2';

const isReviewBasis = (value: string): value is ReviewBasis =>
  value === REVIEW_BASIS.rules || value === REVIEW_BASIS.docs;

export const getReviewBasis = (): ReviewBasis => {
  const raw = (process.env.AI_REVIEW_BASIS || '').trim().toLowerCase();
  return isReviewBasis(raw) ? raw : REVIEW_BASIS.rules;
};

const COMMON_INSTRUCTIONS = [
  'You are a mobile release compliance reviewer for a React Native app.',
  'The full repository for this pull request is checked out in your current working directory and you have READ access to all of it.',
  'The changed files and their unified diffs are listed below as your starting point.',
  'Do NOT restrict yourself to the diff: open and read any other files in the repository you need for context',
  '(feature implementations, Info.plist, AndroidManifest.xml, PrivacyInfo.xcprivacy, entitlements, package.json, sibling screens, etc.).',
  'For absence-based issues (e.g. missing account deletion, missing Sign in with Apple, missing usage-description strings),',
  'search the repository first and only report a finding after confirming the required mitigation is genuinely absent.',
  'Correlate configuration with usage: a permission, background mode, or SDK is lower risk when the code clearly uses it for a qualifying feature.',
  'Be precise and conservative: only report a finding when you have concrete evidence. Do not modify anything.',
  'Respond with ONLY a single JSON object and nothing else (no prose, no markdown, no code fences):',
  '{"findings": Finding[]} where each Finding has ruleId, platform ("ios"|"android"|"both"),',
  'category ("Code"|"Configuration"|"Metadata"|"Compliance"),',
  'severity ("low"|"medium"|"high"|"critical"), title, file (the repository path the risk lives in),',
  'evidence (short quote or specific description of what you found), guidelineRef, and remediation.',
  'If there is no risk, return {"findings": []}.',
];

const BASIS_INSTRUCTION: Record<ReviewBasis, string> = {
  rules:
    'Decide whether the pull request introduces iOS App Store or Google Play rejection risk, using ONLY the predefined rule pack below. ' +
    "Set each finding's ruleId to the matching rule id and guidelineRef to that rule's reference.",
  docs:
    'Decide whether the pull request introduces iOS App Store or Google Play rejection risk, using ONLY the official Apple/Google guideline excerpts below. ' +
    'Set each finding\'s guidelineRef to the guideline section it violates (e.g. "Apple 5.1.2") and ruleId to the excerpt id it maps to.',
};

const buildInstructions = (basis: ReviewBasis): string =>
  [BASIS_INSTRUCTION[basis], ...COMMON_INSTRUCTIONS].join(' ');

const buildBasisSection = (basis: ReviewBasis): string =>
  basis === REVIEW_BASIS.rules
    ? ['Predefined rule pack (only flag issues that match one of these rules):', serializeRuleSignalsForPrompt()].join(
        '\n',
      )
    : [
        'Official Apple/Google guideline excerpts (only flag issues that violate one of these):',
        serializeGuidelinesForPrompt(),
      ].join('\n');

const truncatePatch = (patch: string): string =>
  patch.length > MAX_PATCH_CHARS
    ? `${patch.slice(0, MAX_PATCH_CHARS)}\n... [diff truncated for length; open the file to see the rest] ...`
    : patch;

const renderChangedFile = (file: DiffFile): string =>
  [
    `Changed file: ${file.path} (git status: ${file.status})`,
    '```diff',
    truncatePatch(file.patch),
    '```',
  ].join('\n');

// Greedily pack changed files into chunks whose inlined diff stays under the budget, then
// cap the number of chunks so the number of agent requests (and CI time) stays bounded.
// Files that do not fit are returned as "overflow" for the agent to read directly.
export const planChunks = (
  files: DiffFile[],
  maxChunks: number,
): { chunks: DiffFile[][]; overflow: DiffFile[] } => {
  const chunks: DiffFile[][] = [];
  let current: DiffFile[] = [];
  let size = 0;
  for (const file of files) {
    const blockLen = renderChangedFile(file).length;
    if (current.length > 0 && size + blockLen > INLINE_BUDGET_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += blockLen;
  }
  if (current.length > 0) chunks.push(current);

  if (chunks.length <= maxChunks) return { chunks, overflow: [] };
  return { chunks: chunks.slice(0, maxChunks), overflow: chunks.slice(maxChunks).flat() };
};

export const buildPrompt = (
  chunk: DiffFile[],
  basis: ReviewBasis,
  totalFiles: number,
  overflow: DiffFile[],
): string => {
  const lines = [
    buildInstructions(basis),
    '',
    buildBasisSection(basis),
    '',
    `Changed files in this pull request (${totalFiles} total; ${chunk.length} inlined below):`,
    chunk.map(renderChangedFile).join('\n\n'),
  ];
  if (overflow.length > 0) {
    lines.push(
      '',
      'These additional changed files are NOT inlined here. Open and read them directly in the ' +
        'checked-out repository to review their current contents before finalizing findings:',
      `- ${overflow.map((file) => file.path).join('\n- ')}`,
    );
  }
  return lines.join('\n');
};

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

const parseContent = (content: string, fallbackFile: string): Finding[] => {
  const json = extractJsonObject(stripCodeFences(content));
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return extractFindingsPayload(parsed, fallbackFile);
  } catch {
    return [];
  }
};

const findingKey = (finding: Finding): string =>
  `${finding.ruleId}\u0000${finding.file}\u0000${finding.title}`;

export const mergeFindings = (findings: Finding[]): Finding[] => {
  const seen = new Set<string>();
  const merged: Finding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
};

export const analyzeChanges = async (
  files: DiffFile[],
  basis: ReviewBasis,
): Promise<FileAnalysis> => {
  const { chunks, overflow } = planChunks(files, getMaxChunks());
  const findings: Finding[] = [];
  const errors: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? [];
    // Only the last chunk carries the overflow read-list so it is mentioned exactly once.
    const chunkOverflow = index === chunks.length - 1 ? overflow : [];
    const result = await runAgent(buildPrompt(chunk, basis, files.length, chunkOverflow));
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    findings.push(...parseContent(result.stdout, chunk[0]?.path ?? ''));
  }

  if (errors.length > 0 && findings.length === 0) {
    throw new Error(`Cursor agent analysis failed: ${errors[0]}`);
  }
  if (errors.length > 0) {
    console.warn(`AI review: ${errors.length} of ${chunks.length} chunk(s) failed; reporting partial results.`);
  }

  return { findings: mergeFindings(findings), overflowCount: overflow.length };
};
