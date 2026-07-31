import { buildPrompt, mergeFindings, planChunks } from './analyze.ts';
import { buildInvocationArgs, buildReadInstruction, SAFE_ARG_LIMIT } from './agentRunner.ts';
import { AUDIT_REPORT_MARKER, DOCS_REPORT_MARKER, extractMarker } from './markers.ts';
import { decide, selectMode, type PullRequestFacts } from './resolvePr.ts';
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

// Reports must carry their marker as the first line, otherwise a re-run would post a new
// comment instead of updating the existing one.
assert(
  extractMarker(`${DOCS_REPORT_MARKER}\n## Heading`) === DOCS_REPORT_MARKER,
  'docs marker must be recoverable from a rendered report',
);
assert(
  extractMarker(`${AUDIT_REPORT_MARKER}\n## Heading`) === AUDIT_REPORT_MARKER,
  'audit marker must be recoverable from a rendered report',
);
assert(extractMarker('## No marker here') === undefined, 'unmarked body must yield no marker');

// The dispatch gate is the only thing standing between an untrusted fork branch and a job
// holding the Cursor key, so pin its behaviour down.
const BASE_BRANCH = 'reactDev';
const FORK_LABEL = 'ai-review:approved';

const makeFacts = (overrides: Partial<PullRequestFacts>): PullRequestFacts => ({
  baseRef: BASE_BRANCH,
  baseSha: 'aaa',
  headSha: 'bbb',
  headRef: 'feature/x',
  headRepo: 'Trainerize/ReactNativeApp',
  baseRepo: 'Trainerize/ReactNativeApp',
  isFork: false,
  draft: false,
  state: 'open',
  labels: [],
  ...overrides,
});

assert(decide(makeFacts({}), BASE_BRANCH, FORK_LABEL).run, 'same-repo PR onto base branch runs');
assert(
  !decide(makeFacts({ state: 'closed' }), BASE_BRANCH, FORK_LABEL).run,
  'closed PR must not run',
);
assert(
  !decide(makeFacts({ baseRef: 'main' }), BASE_BRANCH, FORK_LABEL).run,
  'PR onto another base branch must not run',
);
assert(
  !decide(
    makeFacts({ isFork: true, headRepo: 'someone/fork' }),
    BASE_BRANCH,
    FORK_LABEL,
  ).run,
  'unlabelled fork PR must not run',
);
assert(
  decide(
    makeFacts({ isFork: true, headRepo: 'someone/fork', labels: [FORK_LABEL] }),
    BASE_BRANCH,
    FORK_LABEL,
  ).run,
  'fork PR runs once a maintainer applies the approval label',
);

const AUDIT_PREFIX = 'ai-audit-demo/';
assert(selectMode('feature/x', AUDIT_PREFIX, '') === 'docs', 'ordinary branch gets diff review');
assert(
  selectMode(`${AUDIT_PREFIX}try`, AUDIT_PREFIX, '') === 'audit',
  'audit-prefixed branch gets the whole-repo audit',
);
assert(
  selectMode(`${AUDIT_PREFIX}try`, AUDIT_PREFIX, 'docs') === 'docs',
  'explicit override beats the branch prefix',
);

console.log(
  `Selftest passed: ${files.length} files -> ${chunks.length} chunk(s) + ${overflow.length} overflow; ` +
    `max argv value ${largestArg} chars (limit ${SAFE_ARG_LIMIT}); dispatch gate and markers verified.`,
);
