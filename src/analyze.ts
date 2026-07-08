import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { serializeRulesForPrompt } from './rules.ts';
import type { DiffFile, FileAnalysis } from './types.ts';
import { extractFindingsPayload } from './validate.ts';

const execFileAsync = promisify(execFile);

const AGENT_BIN = process.env.AI_REVIEW_AGENT_BIN || 'cursor-agent';
const MAX_PATCH_CHARS = 24000;
const MAX_TOTAL_DIFF_CHARS = 120000;
const MAX_BUFFER = 32 * 1024 * 1024;
// Repo exploration takes longer than a single-file read, so allow more headroom.
const DEFAULT_TIMEOUT_MS = 600000;

// Bump when the review strategy changes so cached results are invalidated.
export const REVIEW_STRATEGY = 'whole-repo-v1';

const getTimeoutMs = (): number => {
  const raw = Number(process.env.AI_REVIEW_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

const getRepoRoot = (): string => process.env.AI_REVIEW_REPO_ROOT || process.cwd();

// Undefined means "let the Cursor account default model decide".
const getModelId = (): string | undefined => process.env.AI_REVIEW_MODEL || undefined;

export const getModelLabel = (): string => getModelId() ?? 'Cursor account default';

const INSTRUCTIONS = [
  'You are a mobile release compliance reviewer for a React Native app.',
  'The full repository for this pull request is checked out in your current working directory and you have READ access to all of it.',
  'Decide whether the pull request introduces iOS App Store or Google Play rejection risk, using ONLY the provided rule pack.',
  'The changed files and their unified diffs are listed below as your starting point.',
  'Do NOT restrict yourself to the diff: open and read any other files in the repository you need for context',
  '(feature implementations, Info.plist, AndroidManifest.xml, PrivacyInfo.xcprivacy, entitlements, package.json, sibling screens, etc.).',
  'For absence-based rules (e.g. missing account deletion, missing Sign in with Apple, missing usage-description strings),',
  'search the repository first and only report a finding after confirming the required mitigation is genuinely absent.',
  'Correlate configuration with usage: a permission, background mode, or SDK is lower risk when the code clearly uses it for a qualifying feature.',
  'Be precise and conservative: only report a finding when you have concrete evidence. Do not modify anything.',
  'Respond with ONLY a single JSON object and nothing else (no prose, no markdown, no code fences):',
  '{"findings": Finding[]} where each Finding has ruleId, platform ("ios"|"android"|"both"),',
  'category ("Code"|"Configuration"|"Metadata"|"Compliance"),',
  'severity ("low"|"medium"|"high"|"critical"), title, file (the repository path the risk lives in),',
  'evidence (short quote or specific description of what you found), guidelineRef, and remediation.',
  'If there is no risk, return {"findings": []}.',
].join(' ');

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

const renderChangedFiles = (files: DiffFile[]): string => {
  const blocks: string[] = [];
  const omitted: string[] = [];
  let total = 0;
  for (const file of files) {
    const block = renderChangedFile(file);
    if (total + block.length > MAX_TOTAL_DIFF_CHARS) {
      omitted.push(file.path);
      continue;
    }
    blocks.push(block);
    total += block.length;
  }
  if (omitted.length > 0) {
    blocks.push(
      `Diffs for these changed files were omitted for length; open them directly in the working tree to review:\n- ${omitted.join('\n- ')}`,
    );
  }
  return blocks.join('\n\n');
};

const buildPrompt = (files: DiffFile[]): string =>
  [
    INSTRUCTIONS,
    '',
    'Rule pack (only flag issues that match one of these rules).',
    'Lines marked "Official" quote the current Apple/Google guideline text and are authoritative:',
    serializeRulesForPrompt(),
    '',
    `Changed files in this pull request (${files.length}):`,
    renderChangedFiles(files),
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

const parseContent = (content: string, fallbackFile: string) => {
  const json = extractJsonObject(stripCodeFences(content));
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return extractFindingsPayload(parsed, fallbackFile);
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

export const analyzeChanges = async (files: DiffFile[]): Promise<FileAnalysis> => {
  const fallbackFile = files[0]?.path ?? '';
  try {
    const { stdout } = await execFileAsync(AGENT_BIN, buildArgs(buildPrompt(files)), {
      cwd: getRepoRoot(),
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: getTimeoutMs(),
    });
    return { findings: parseContent(stdout, fallbackFile) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor agent analysis failed: ${detail}`);
  }
};
