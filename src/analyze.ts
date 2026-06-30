import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { serializeRulesForPrompt } from './rules.ts';
import type { DiffFile, FileAnalysis } from './types.ts';
import { extractFindingsPayload } from './validate.ts';

const execFileAsync = promisify(execFile);

const AGENT_BIN = process.env.AI_REVIEW_AGENT_BIN || 'cursor-agent';
const MAX_PATCH_CHARS = 24000;
const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 240000;

const getTimeoutMs = (): number => {
  const raw = Number(process.env.AI_REVIEW_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

// Undefined means "let the Cursor account default model decide".
const getModelId = (): string | undefined => process.env.AI_REVIEW_MODEL || undefined;

export const getModelLabel = (): string => getModelId() ?? 'Cursor account default';

const INSTRUCTIONS = [
  'You are a mobile release compliance reviewer for React Native apps.',
  'Inspect ONLY the single changed file below from a merged pull request and decide whether it',
  'introduces iOS App Store or Google Play rejection risk, using ONLY the provided rule pack.',
  'Be precise and conservative: only report a finding when the diff shows concrete evidence.',
  'Never invent file paths or code that is not in the diff.',
  'Base your answer solely on the diff text provided; do not read other files or modify anything.',
  'Respond with ONLY a single JSON object and nothing else (no prose, no markdown, no code fences):',
  '{"findings": Finding[]} where each Finding has ruleId, platform ("ios"|"android"|"both"),',
  'category ("Code"|"Configuration"|"Metadata"|"Compliance"),',
  'severity ("low"|"medium"|"high"|"critical"), title, file, evidence (short quote from the diff),',
  'guidelineRef, and remediation. If there is no risk, return {"findings": []}.',
].join(' ');

const truncatePatch = (patch: string): string =>
  patch.length > MAX_PATCH_CHARS
    ? `${patch.slice(0, MAX_PATCH_CHARS)}\n... [diff truncated for length] ...`
    : patch;

const buildPrompt = (file: DiffFile): string =>
  [
    INSTRUCTIONS,
    '',
    'Rule pack (only flag issues that match one of these rules).',
    'Lines marked "Official" quote the current Apple/Google guideline text and are authoritative:',
    serializeRulesForPrompt(),
    '',
    `Changed file: ${file.path} (git status: ${file.status})`,
    'Unified diff:',
    '```diff',
    truncatePatch(file.patch),
    '```',
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

export const analyzeFile = async (file: DiffFile): Promise<FileAnalysis> => {
  try {
    const { stdout } = await execFileAsync(AGENT_BIN, buildArgs(buildPrompt(file)), {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: getTimeoutMs(),
    });
    return { findings: parseContent(stdout, file.path) };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor agent analysis failed for ${file.path}: ${detail}`);
  }
};
