import { readWebhook, shouldForward, verifySignature } from './index.ts';

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Worker selftest failed: ${message}`);
};

const TARGET_REPO = 'Trainerize/ReactNativeApp';
const BASE_BRANCH = 'reactDev';
const SECRET = 'test-webhook-secret';

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
};

const makePayload = (overrides: {
  action?: string;
  repo?: string;
  baseRef?: string;
  label?: string;
}): string =>
  JSON.stringify({
    action: overrides.action ?? 'opened',
    repository: { full_name: overrides.repo ?? TARGET_REPO },
    pull_request: { number: 42, base: { ref: overrides.baseRef ?? BASE_BRANCH } },
    installation: { id: 12345 },
    ...(overrides.label === undefined ? {} : { label: { name: overrides.label } }),
  });

const body = makePayload({});

// Signature verification is the only thing preventing anyone from triggering paid review
// runs, so cover the accept and reject paths explicitly.
assert(await verifySignature(SECRET, body, await sign(SECRET, body)), 'valid signature accepted');
assert(
  !(await verifySignature(SECRET, body, await sign('wrong-secret', body))),
  'signature from the wrong secret rejected',
);
assert(
  !(await verifySignature(SECRET, `${body} `, await sign(SECRET, body))),
  'tampered body rejected',
);
assert(!(await verifySignature(SECRET, body, null)), 'missing signature header rejected');
assert(!(await verifySignature(SECRET, body, 'sha256=zz')), 'malformed signature rejected');
assert(!(await verifySignature(SECRET, body, 'sha1=abcd')), 'wrong algorithm prefix rejected');

const facts = readWebhook(JSON.parse(body));
assert(facts !== undefined, 'well-formed payload parses');
assert(facts?.prNumber === 42, 'pull request number read');
assert(facts?.installationId === 12345, 'installation id read');
assert(readWebhook({ action: 'opened' }) === undefined, 'payload without a pull request rejected');

const forwardOf = (overrides: Parameters<typeof makePayload>[0]): boolean => {
  const parsed = readWebhook(JSON.parse(makePayload(overrides)));
  if (!parsed) return false;
  return shouldForward(parsed, TARGET_REPO, BASE_BRANCH).forward;
};

assert(forwardOf({}), 'opened PR onto the base branch forwards');
assert(forwardOf({ action: 'synchronize' }), 'synchronize forwards');
assert(!forwardOf({ action: 'closed' }), 'closed does not forward');
assert(!forwardOf({ baseRef: 'main' }), 'other base branches do not forward');
assert(!forwardOf({ repo: 'someone/else' }), 'other repositories do not forward');
assert(
  forwardOf({ action: 'labeled', label: 'ai-review:approved' }),
  'the approval label forwards so fork PRs can be released',
);
assert(
  !forwardOf({ action: 'labeled', label: 'needs-design' }),
  'unrelated labels do not forward',
);

console.log('Worker selftest passed: signature verification, payload parsing, and filters.');
