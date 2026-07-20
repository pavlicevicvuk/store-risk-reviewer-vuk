import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AGENT_BIN = process.env.AI_REVIEW_AGENT_BIN || 'cursor-agent';
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600000;

// The OS caps a single argv string (~128KB MAX_ARG_STRLEN on Linux). The real prompt
// travels in a file the agent reads itself, so the invocation stays far below this; the
// guard exists to fail loudly if a future change tries to inline a large prompt again.
export const SAFE_ARG_LIMIT = 100000;

export const getRepoRoot = (): string => process.env.AI_REVIEW_REPO_ROOT || process.cwd();

// Undefined means "let the Cursor account default model decide".
export const getModelId = (): string | undefined => process.env.AI_REVIEW_MODEL || undefined;

export const getModelLabel = (): string => getModelId() ?? 'Cursor account default';

export const getTimeoutMs = (): number => {
  const raw = Number(process.env.AI_REVIEW_AGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
};

export type AgentResult = { ok: true; stdout: string } | { ok: false; error: string };

// cursor-agent takes the prompt as an argv value and ignores piped stdin, so we hand it a
// short instruction to open the prompt file instead of inlining the whole prompt.
export const buildReadInstruction = (promptPath: string): string =>
  `Read the file at ${promptPath} in full using your file-reading tool. ` +
  'It contains your complete instructions and all the context you need. ' +
  'Follow it exactly and respond with ONLY the single JSON object it requests ' +
  '(no prose, no markdown, no code fences).';

export const buildInvocationArgs = (instruction: string): string[] => {
  const args = ['--print', '--output-format', 'text', '--mode', 'ask', '--trust'];
  const model = getModelId();
  if (model) args.push('--model', model);
  args.push(instruction);
  return args;
};

export const runAgent = async (prompt: string): Promise<AgentResult> => {
  const dir = mkdtempSync(join(getRepoRoot(), '.ai-review-tmp-'));
  const promptPath = join(dir, 'prompt.txt');
  const instruction = buildReadInstruction(promptPath);
  if (instruction.length > SAFE_ARG_LIMIT) {
    rmSync(dir, { recursive: true, force: true });
    return {
      ok: false,
      error: `Agent invocation argument too large (${instruction.length} chars); refusing to spawn.`,
    };
  }
  try {
    writeFileSync(promptPath, prompt, 'utf8');
    const { stdout } = await execFileAsync(AGENT_BIN, buildInvocationArgs(instruction), {
      cwd: getRepoRoot(),
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: getTimeoutMs(),
    });
    return { ok: true, stdout };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
