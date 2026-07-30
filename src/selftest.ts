import { buildPrompt, mergeFindings, planChunks } from './analyze.ts';
import { buildInvocationArgs, buildReadInstruction, SAFE_ARG_LIMIT } from './agentRunner.ts';
import type { DiffFile, Finding } from './types.ts';

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Selftest failed: ${message}`);
};

const makeFiles = (count: number, patchChars: number): DiffFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    path: `app/feature/module${index}/index.ts`,
    status: 'M',
    patch: `@@ synthetic patch ${index} @@\n${'+ const value = 1;\n'.repeat(Math.ceil(patchChars / 20))}`,
  }));

const makeFinding = (overrides: Partial<Finding>): Finding => ({
  guidelineId: 'apple-5.1.1',
  platform: 'ios',
  category: 'Configuration',
  severity: 'high',
  title: 'Example',
  file: 'app/x.ts',
  evidence: 'e',
  guidelineRef: 'ref',
  remediation: 'fix',
  ...overrides,
});

// A pathological pull request: hundreds of large changed files.
const files = makeFiles(300, 2000);
const maxChunks = 3;
const { chunks, overflow } = planChunks(files, maxChunks);

assert(chunks.length <= maxChunks, `chunk count ${chunks.length} exceeds cap ${maxChunks}`);
assert(overflow.length > 0, 'expected overflow files for a 300-file diff at 3-chunk cap');
assert(
  chunks.flat().length + overflow.length === files.length,
  'every changed file must land in a chunk or overflow',
);

// The invocation argument must stay far below the OS argv limit no matter how big the
// prompt is — this is the invariant that prevents the original `spawn E2BIG` failure.
const hugePrompt = 'x'.repeat(5_000_000);
void hugePrompt; // prompt size is irrelevant to the arg; the agent reads it from a file.
const instruction = buildReadInstruction('/tmp/ai-review-tmp/prompt.txt');
assert(instruction.length < SAFE_ARG_LIMIT, `read-instruction too large: ${instruction.length}`);

const args = buildInvocationArgs(instruction);
const largestArg = Math.max(...args.map((arg) => arg.length));
assert(largestArg < SAFE_ARG_LIMIT, `largest argv value ${largestArg} exceeds ${SAFE_ARG_LIMIT}`);

// Each chunk prompt should be bounded even though it embeds diffs.
for (const chunk of chunks) {
  const prompt = buildPrompt(chunk, files.length, overflow);
  assert(prompt.length < 300_000, `chunk prompt too large: ${prompt.length}`);
}

// Findings from multiple chunks are merged and de-duplicated.
const merged = mergeFindings([
  makeFinding({ title: 'A' }),
  makeFinding({ title: 'A' }),
  makeFinding({ title: 'B' }),
]);
assert(merged.length === 2, `expected 2 merged findings, got ${merged.length}`);

console.log(
  `Selftest passed: ${files.length} files -> ${chunks.length} chunk(s) + ${overflow.length} overflow; ` +
    `max argv value ${largestArg} chars (limit ${SAFE_ARG_LIMIT}).`,
);
